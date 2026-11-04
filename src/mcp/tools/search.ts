/**
 * `rw_search` (docs/PLAN.md section 7.3): queries the source adapters in
 * parallel, merges duplicates across sources and records the round as `search`
 * evidence in the ledger.
 *
 * One failing source never fails the call: its `SourceMeta` explains why, and
 * only sources that actually answered are credited in `evidence.sources` (the
 * `build` decision rule counts distinct answering sources).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { redactGithubToken } from '../../auth/github-token.js';
import { checkSearchBudget, hardLimit } from '../../core/budget.js';
import type { SearchBudgetReport } from '../../core/budget.js';
import { planComponent, queryMode } from '../../core/decompose.js';
import { mergeSearchResults, refKey } from '../../core/dedupe.js';
import { findComponent } from '../../core/ledger.js';
import { clampInput, codeSpan, cut, oneLine, softLine, stripControlChars, wrapUntrusted } from '../../core/sanitize.js';
import { CandidateSchema, EcosystemSchema, SourceMetaSchema, SourceSchema, newId } from '../../types.js';
import type {
  AppContext,
  Candidate,
  Component,
  Ecosystem,
  Evidence,
  Provenance,
  Source,
  SourceMeta,
  ToolModule,
} from '../../types.js';

export const TOOL_NAME = 'rw_search';

/** Evidence component id used when `rw_search` runs with `query` and no `component_id`. */
export const UNSCOPED_COMPONENT_ID = '_unscoped';

const DEFAULT_LIMIT_PER_SOURCE = 8;
const DEFAULT_PUSHED_WITHIN_DAYS = 730;
const MAX_TABLE_ROWS = 15;
const MAX_QUERY_LABEL_CHARS = 500;
/**
 * A source's results are "thin" below `ceil(limit / THIN_RESULTS_DIVISOR)` unique
 * candidates; only then is the next planned query alternative run (PLAN §7.3).
 * Keeps GitHub's unauthenticated 10 searches/minute for the components that need them.
 */
export const THIN_RESULTS_DIVISOR = 2;
/** An `eager` source keeps up to `limit x this` merged candidates before the cross-source dedupe and the overall cap. */
export const EAGER_SOURCE_CAP_FACTOR = 2;

/** A source that produced a usable response (possibly with zero hits). */
const ANSWERED: ReadonlySet<SourceMeta['status']> = new Set(['ok', 'cached', 'partial']);

const MANUAL_FALLBACK =
  'Use WebSearch, `gh search repos "<query>"` or `npm search --json <query>` manually, then call rw_record_evidence (kind "web" or "manual") with what you found.';
const CODE_SEARCH_FALLBACK =
  'GitHub code search needs a token (GITHUB_TOKEN, GH_TOKEN or `gh auth login`); consider a Grep MCP server (grep.app) for code snippets.';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const searchInputShape = {
  component_id: z
    .string()
    .optional()
    .describe('Component to search for (from rw_decompose). Needed for the planned queries and the search budget.'),
  query: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Free-text query. Without it, the component search plan from rw_decompose is used. At least one of component_id and query is required.'),
  sources: z
    .array(SourceSchema)
    .min(1)
    .optional()
    .describe('Sources to query: github_repo | github_code | npm | pypi | mcp_registry | hf_models (model weights). Default: the planned sources (github_code only when listed here).'),
  ecosystem: EcosystemSchema.optional().describe('Ecosystem filter. Default: the component ecosystem.'),
  limit_per_source: z.number().int().min(1).max(20).optional().describe('Results per source, 1-20. Default 8.'),
  language: z.string().optional().describe('GitHub language qualifier, e.g. "Python".'),
  min_stars: z.number().int().min(0).optional().describe('Minimum GitHub stars. Default 0.'),
  pushed_within_days: z.number().int().min(1).optional().describe('Only repositories pushed within this many days. Default 730.'),
  name_hints: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe('Package name guesses for registries without a search API (PyPI probes these names).'),
  force: z.boolean().optional().describe('Continue past the hard search budget; requires force_reason.'),
  force_reason: z.string().optional().describe('Why more rounds are justified (recorded in the budget warning).'),
  project_root: z
    .string()
    .optional()
    .describe('Project directory that holds .recyclewheel/ledger.jsonl. Default: RECYCLEWHEEL_PROJECT_ROOT or the working directory.'),
};
export const SearchInputSchema = z.object(searchInputShape);
export type SearchToolInput = z.infer<typeof SearchInputSchema>;

export const SearchOutputSchema = z.object({
  evidence_id: z.string(),
  candidates: z.array(CandidateSchema),
  per_source: z.array(SourceMetaSchema),
  degraded: z.boolean(),
  fallback_hint: z.string().optional(),
  budget: z.object({
    rounds_used: z.number().int(),
    rounds_limit: z.number().int(),
    hard_limit: z.number().int(),
    warning: z.string().optional(),
  }),
});
export type SearchOutput = z.infer<typeof SearchOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Error text that is safe to show or log: GitHub tokens and secret query
 * parameters are masked. Shared with `rw_evaluate`.
 */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactGithubToken(raw).replace(/\b(api_key|access_token|client_secret|token)=[^&\s"']+/gi, '$1=REDACTED');
}

/** One table cell inside the untrusted fence: input cut first, one line, at most `max` characters, `\` and `|` escaped. */
function cell(text: string, max = 300): string {
  const flat = cut(stripControlChars(clampInput(text, max)).replace(/\r?\n/g, ' ').trim(), max);
  return flat.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

interface Target {
  source: Source;
  /** Queries to try in order: the primary first, then the planned alternatives (run only while results are thin). */
  queries: string[];
  nameHints?: string[];
}

interface TargetOutcome {
  meta: SourceMeta;
  candidates: Candidate[];
  /** True when an adapter was actually invoked. */
  searched: boolean;
  /** Queries that were actually sent, in order. */
  ran: string[];
}

/**
 * Decides which (source, queries) pairs to run. With `query`, every selected
 * source gets that single query; otherwise each source uses its planned query
 * and alternatives, or the component keywords for a source the plan does not
 * cover (e.g. github_code).
 */
function resolveTargets(
  input: SearchToolInput,
  component: Component | undefined,
  projectEcosystems: readonly Ecosystem[],
  enabled: readonly Source[],
): { targets: Target[] } | { error: string } {
  const plan = component ? planComponent(component, projectEcosystems, { enabledSources: enabled }) : undefined;
  const requested = input.sources !== undefined ? [...new Set(input.sources)] : undefined;

  if (input.query !== undefined) {
    const query = input.query.trim();
    const sources =
      requested ??
      (plan && plan.queries.length > 0 ? plan.queries.map((p) => p.source) : enabled.filter((s) => s !== 'github_code'));
    return {
      targets: sources.map((source) => ({
        source,
        queries: [query],
        ...(input.name_hints !== undefined ? { nameHints: input.name_hints } : {}),
      })),
    };
  }

  if (component === undefined || plan === undefined) {
    return { error: `${TOOL_NAME}: pass query, or component_id so the planned queries can be used.` };
  }
  if (plan.skip_reason === 'trivial') {
    return {
      error: `${TOOL_NAME}: component "${component.id}" is marked trivial, so it has no planned searches. Decide it with rw_decide (build, build_reason "trivial"), or pass query to search anyway.`,
    };
  }
  if (plan.queries.length === 0 && requested === undefined) {
    return {
      error: `${TOOL_NAME}: no search is planned for component "${component.id}" with the enabled sources. Pass sources=[...] and/or query.`,
    };
  }
  const planned = new Map(plan.queries.map((p) => [p.source, p]));
  const keywordQuery = component.keywords.slice(0, 6).join(' ');
  const sources = requested ?? plan.queries.map((p) => p.source);
  return {
    targets: sources.map((source) => {
      const p = planned.get(source);
      const nameHints = input.name_hints ?? p?.params?.nameHints;
      const queries = p !== undefined ? [p.query, ...(p.alternatives ?? [])] : [keywordQuery];
      return { source, queries, ...(nameHints !== undefined ? { nameHints } : {}) };
    }),
  };
}

function skipped(source: Source, query: string, message: string): TargetOutcome {
  return { meta: { source, status: 'skipped', count: 0, query, message }, candidates: [], searched: false, ran: [] };
}

/** Unique candidates below which the next query alternative of a source is worth running. */
export function thinThreshold(limit: number): number {
  return Math.ceil(limit / THIN_RESULTS_DIVISOR);
}

/** One adapter call: valid candidates (at most `limit`) and the source meta, never throws. */
async function runQuery(
  ctx: AppContext,
  target: Target,
  query: string,
  input: SearchToolInput,
  component: Component | undefined,
  limit: number,
): Promise<{ meta: SourceMeta; candidates: Candidate[] }> {
  const { source } = target;
  const adapter = ctx.adapters[source]!;
  const ecosystem = input.ecosystem ?? component?.ecosystem;
  try {
    const result = await adapter.search({
      query,
      limit,
      ...(ecosystem !== undefined ? { ecosystem } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
      pushedWithinDays: input.pushed_within_days ?? DEFAULT_PUSHED_WITHIN_DAYS,
      minStars: input.min_stars ?? 0,
      ...(target.nameHints !== undefined ? { nameHints: target.nameHints } : {}),
    });
    const offered = result.candidates.slice(0, limit);
    const candidates = offered.filter((c) => CandidateSchema.safeParse(c).success);
    const dropped = offered.length - candidates.length;
    const meta: SourceMeta = { ...result.meta, source, count: candidates.length, query };
    if (dropped > 0) {
      meta.message = `${meta.message ? `${meta.message} ` : ''}${dropped} malformed candidate(s) dropped.`;
      if (meta.status === 'ok' || meta.status === 'cached') meta.status = 'partial';
    }
    return { meta, candidates };
  } catch (err) {
    return {
      meta: {
        source,
        status: 'error',
        count: 0,
        query,
        message: `${source} search failed unexpectedly: ${safeErrorMessage(err)}. ${MANUAL_FALLBACK}`,
      },
      candidates: [],
    };
  }
}

/**
 * Combines the metas of the queries run for one source. Any answering query
 * makes the source answered: `ok` when every run was live and clean, `cached`
 * when every run came from a cache, `partial` otherwise (a failed or partial
 * run among answered ones). With no answering run, the first failure stands.
 */
function combineMetas(source: Source, metas: readonly SourceMeta[], count: number, extraNotes: readonly string[]): SourceMeta {
  const first = metas[0]!;
  const answered = metas.filter((m) => ANSWERED.has(m.status));
  const query = metas.map((m) => m.query ?? '').filter((q) => q !== '').join(' | ');
  const messages = [...new Set([...metas.flatMap((m) => (m.message ? [m.message] : [])), ...extraNotes])];
  let status: SourceMeta['status'];
  if (answered.length === 0) status = first.status;
  else if (answered.length < metas.length || answered.some((m) => m.status === 'partial')) status = 'partial';
  else if (answered.every((m) => m.status === 'cached')) status = 'cached';
  else status = 'ok';
  const rate = metas.find((m) => m.rate_limit !== undefined)?.rate_limit;
  return {
    source,
    status,
    count,
    ...(query !== '' ? { query } : {}),
    ...(rate !== undefined ? { rate_limit: rate } : {}),
    ...(messages.length > 0 ? { message: messages.join(' ') } : {}),
  };
}

/** Distinct lowercase words (2+ characters) of a component's keywords. */
function keywordTokens(component: Component | undefined): string[] {
  if (component === undefined) return [];
  return [...new Set(component.keywords.flatMap((k) => k.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 2))];
}

/**
 * How many keyword words the candidate's name and description mention
 * (substring match, so "stations" counts for "station"). A tiebreaker among
 * candidates that the same number of queries returned: a package that matches
 * only the one word several keywords share (e.g. "radio" in a radio-button
 * widget) sorts after one that matches the others too.
 */
export function keywordOverlap(candidate: Pick<Candidate, 'name' | 'description'>, tokens: readonly string[]): number {
  const text = `${candidate.name} ${candidate.description ?? ''}`.toLowerCase();
  return tokens.filter((t) => text.includes(t)).length;
}

/** Round-robin over several ranked lists: every list's first hit, then every list's second hit, and so on. */
function roundRobin(lists: readonly (readonly Candidate[])[]): Candidate[] {
  const out: Candidate[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let r = 0; r < longest; r++) for (const list of lists) if (list[r] !== undefined) out.push(list[r]!);
  return out;
}

/**
 * Runs the planned query variants of one source and merges their candidates by
 * ref (`matched_via.hits` counts the queries that returned a candidate, ranks are
 * reassigned 1..n; at most `limit` candidates for adaptive sources, `limit x
 * EAGER_SOURCE_CAP_FACTOR` for eager ones):
 * - `adaptive` sources run the primary, then one alternative at a time while the
 *   unique candidates so far stay below `thinThreshold(limit)`; a run that did
 *   not answer (rate limit, offline, error) stops the alternatives, because the
 *   next query would fail the same way and spend the same rate limit;
 * - `eager` sources run every variant at once and interleave the results by rank.
 */
async function runTarget(
  ctx: AppContext,
  target: Target,
  input: SearchToolInput,
  component: Component | undefined,
  limit: number,
): Promise<TargetOutcome> {
  const { source } = target;
  const label = target.queries[0] ?? '';
  if (!ctx.config.sources.includes(source)) {
    return skipped(
      source,
      label,
      `Source ${source} is disabled (RECYCLEWHEEL_SOURCES lists: ${ctx.config.sources.join(', ') || 'none'}).`,
    );
  }
  if (ctx.adapters[source] === undefined) return skipped(source, label, `No adapter is registered for ${source}.`);

  const metas: SourceMeta[] = [];
  const ran: string[] = [];
  const merged: Candidate[] = [];
  const byKey = new Map<string, Candidate>();
  const absorb = (candidates: readonly Candidate[], cap: number): void => {
    for (const c of candidates) {
      const key = refKey(c.ref);
      const seen = byKey.get(key);
      if (seen !== undefined) {
        seen.matched_via = { ...seen.matched_via, hits: (seen.matched_via.hits ?? 1) + 1 };
        continue;
      }
      if (merged.length >= cap) continue;
      const copy: Candidate = { ...c, matched_via: { query: c.matched_via.query, rank: merged.length + 1 } };
      byKey.set(key, copy);
      merged.push(copy);
    }
  };

  const mode = queryMode(source);
  if (mode === 'eager') {
    const runs = await Promise.all(target.queries.map((query) => runQuery(ctx, target, query, input, component, limit)));
    ran.push(...target.queries);
    metas.push(...runs.map((r) => r.meta));
    // Several keyword queries return more than one query would: keep up to twice the limit so that the cross-source
    // dedupe still sees a package whose GitHub repository another source ranked high (the merged row inherits that
    // rank; the overall cap of rw_search trims the rest). Candidates several keywords returned come first.
    absorb(roundRobin(runs.map((r) => r.candidates)), limit * EAGER_SOURCE_CAP_FACTOR);
    const tokens = keywordTokens(component);
    const overlap = new Map(merged.map((c) => [c, keywordOverlap(c, tokens)]));
    merged.sort((a, b) => (b.matched_via.hits ?? 1) - (a.matched_via.hits ?? 1) || (overlap.get(b) ?? 0) - (overlap.get(a) ?? 0));
    merged.forEach((c, i) => {
      c.matched_via = { ...c.matched_via, rank: i + 1 };
    });
  } else {
    const threshold = thinThreshold(limit);
    for (const [i, query] of target.queries.entries()) {
      if (i > 0 && merged.length >= threshold) break;
      const run = await runQuery(ctx, target, query, input, component, limit);
      ran.push(query);
      metas.push(run.meta);
      absorb(run.candidates, limit);
      if (!ANSWERED.has(run.meta.status)) break;
    }
  }
  const notes =
    ran.length > 1
      ? [mode === 'eager' ? `${ran.length} keyword queries run and merged by rank.` : `${ran.length} query variants run (results were thin).`]
      : [];
  return { meta: combineMetas(source, metas, merged.length, notes), candidates: merged, searched: true, ran };
}

function uniqueProvenance(candidates: readonly Candidate[]): Provenance[] {
  return [...new Set(candidates.map((c) => c.provenance))];
}

function formatCount(n: number | undefined): string {
  return n === undefined ? '-' : String(n);
}

/**
 * Candidate table inside the untrusted fence (names, licenses and descriptions
 * come from third parties), or a one-line "none" note. Shared with rw_decompose.
 */
export function candidateTableLines(candidates: readonly Candidate[], maxRows = MAX_TABLE_ROWS): string[] {
  if (candidates.length === 0) return ['No candidates found.'];
  const table: string[] = [
    '| # | Candidate | Source | Stars | Weekly downloads | License | Last activity | Description |',
    '|---|---|---|---|---|---|---|---|',
  ];
  candidates.slice(0, maxRows).forEach((c, i) => {
    const alias = c.also_known_as && c.also_known_as.length > 0 ? ` (+${c.also_known_as.join(', ')})` : '';
    const hits = c.matched_via.hits !== undefined && c.matched_via.hits > 1 ? ` [${c.matched_via.hits} hits]` : '';
    const flags = [c.archived ? 'archived' : '', c.deprecated ? 'deprecated' : ''].filter(Boolean).join(', ');
    table.push(
      `| ${i + 1} | \`${cell(c.ref, 1100)}\`${cell(alias, 600)}${hits}${flags ? ` [${flags}]` : ''} | ${c.source} | ${formatCount(c.stars)} | ${formatCount(c.downloads_weekly)} | ${cell(c.license_spdx ?? (c.license_spdx === null ? 'none' : '-'))} | ${c.last_activity?.slice(0, 10) ?? '-'} | ${cell(c.description ?? '')} |`,
    );
  });
  const lines = wrapUntrusted(table);
  if (candidates.length > maxRows) {
    lines.push('', `_... and ${candidates.length - maxRows} more candidate(s); see structuredContent._`);
  }
  return lines;
}

/** `- source: status, N result(s) (queries: ...) - message` lines. Shared with rw_decompose. */
export function perSourceLines(perSource: readonly SourceMeta[]): string[] {
  return perSource.map((m) => {
    const queries = m.query ? ` (${m.query.split(' | ').length > 1 ? 'queries' : 'query'}: ${m.query.split(' | ').map((q) => codeSpan(q, 200)).join(', ')})` : '';
    return `- ${m.source}: ${m.status}, ${m.count} result(s)${queries}${m.message ? ` - ${softLine(m.message, 400)}` : ''}`;
  });
}

function summaryText(args: {
  output: SearchOutput;
  component: Component | undefined;
  targets: readonly Target[];
}): string {
  const { output, component, targets } = args;
  const lines: string[] = [];
  // Component names, ids and keyword-derived queries come from the ledger: never raw outside the fence.
  lines.push(`## rw_search${component ? `: ${oneLine(component.name, 100)} (${codeSpan(component.id, 64)})` : ' (unscoped)'}`, '');
  const planned = targets.map((t) => {
    const extra = t.queries.length > 1 ? ` (+${t.queries.length - 1} alternative${t.queries.length > 2 ? 's' : ''} when thin)` : '';
    return `${t.source}: ${codeSpan(t.queries[0] ?? '')}${extra}`;
  });
  lines.push(`Evidence ${codeSpan(output.evidence_id)} recorded. Planned queries: ${planned.join('; ')}`, '');
  lines.push(...candidateTableLines(output.candidates));

  lines.push('', 'Sources:', ...perSourceLines(output.per_source));
  if (output.degraded && output.fallback_hint) lines.push('', `Degraded: ${output.fallback_hint}`);
  const b = output.budget;
  lines.push('', `Search rounds before this call: ${b.rounds_used}/${b.rounds_limit} (hard limit ${b.hard_limit}).`);
  if (b.warning) lines.push(`Budget warning: ${softLine(b.warning)}`);
  lines.push(
    'Next: pick up to 5 candidates, rate fit 0-5 with a reason, and call rw_evaluate. Stop searching once a candidate reaches hint "adopt".',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Result of `performSearch`: the tool output plus what the text summary needs. */
export interface PerformedSearch {
  output: SearchOutput;
  component: Component | undefined;
  targets: Target[];
}

/**
 * The whole `rw_search` operation without the MCP result wrapping: resolves the
 * component and targets, checks the budget, runs the adapters, merges, records
 * the search evidence and the component status. Returns `{ error }` for the
 * agent-facing input errors. Shared with `rw_decompose` (`search: true`).
 */
export async function performSearch(ctx: AppContext, input: SearchToolInput): Promise<PerformedSearch | { error: string }> {
  if (input.component_id === undefined && (input.query === undefined || input.query.trim() === '')) {
    return { error: `${TOOL_NAME}: pass component_id (to use its planned queries) and/or query.` };
  }

  const ledger = ctx.ledger(input.project_root);
  const state = ledger.read();

  let component: Component | undefined;
  if (input.component_id !== undefined) {
    component = findComponent(state, input.component_id);
    if (component === undefined) {
      const known = state.components.slice(0, 10).map((c) => c.id);
      return {
        error: `${TOOL_NAME}: unknown component_id ${codeSpan(input.component_id, 64)}. ${
          known.length > 0 ? `Known ids: ${known.map((id) => codeSpan(id, 64)).join(', ')}.` : 'The ledger has no components yet.'
        } Call rw_decompose first, or fix the id.`,
      };
    }
  }

  const resolved = resolveTargets(input, component, state.project?.ecosystems ?? [], ctx.config.sources);
  if ('error' in resolved) return { error: resolved.error };
  const { targets } = resolved;

  let budget: SearchBudgetReport;
  if (component !== undefined) {
    const check = checkSearchBudget(state, component.id, ctx.config.budget, {
      ...(input.force !== undefined ? { force: input.force } : {}),
      ...(input.force_reason !== undefined ? { force_reason: input.force_reason } : {}),
    });
    if (!check.allowed) return { error: `${TOOL_NAME}: ${check.error ?? 'search budget exhausted.'}` };
    budget = check.budget;
  } else {
    budget = {
      rounds_used: 0,
      rounds_limit: ctx.config.budget.rounds,
      hard_limit: hardLimit(ctx.config.budget.rounds),
    };
  }

  const limit = input.limit_per_source ?? DEFAULT_LIMIT_PER_SOURCE;
  const outcomes = await Promise.all(targets.map((t) => runTarget(ctx, t, input, component, limit)));

  const searchedCount = outcomes.filter((o) => o.searched).length;
  const candidates = mergeSearchResults(
    outcomes.map((o) => o.candidates),
    limit * Math.max(1, searchedCount),
  );
  const perSource = outcomes.map((o) => o.meta);
  const answered = [...new Set(perSource.filter((m) => ANSWERED.has(m.status)).map((m) => m.source))];
  const degraded = answered.length === 0;

  let fallbackHint: string | undefined;
  if (degraded) {
    // The query sits inside code spans of the hint: one line, no quotes, backticks or angle brackets.
    const first = stripControlChars(targets[0]?.queries[0] ?? '')
      .replace(/[\s"`<>]+/g, ' ')
      .trim()
      .slice(0, MAX_QUERY_LABEL_CHARS);
    const parts = [MANUAL_FALLBACK.replaceAll('<query>', first)];
    if (perSource.some((m) => m.status === 'unauthenticated')) parts.push(CODE_SEARCH_FALLBACK);
    fallbackHint = parts.join(' ');
  }

  const now = ctx.now();
  // The evidence records the queries that were actually sent (planned alternatives only when they ran).
  const ranBySource = outcomes.map((o, i) => ({ source: targets[i]!.source, ran: o.ran.length > 0 ? o.ran : [targets[i]!.queries[0] ?? ''] }));
  const distinctQueries = new Set(ranBySource.flatMap((r) => r.ran));
  const queryLabel = (
    distinctQueries.size === 1
      ? [...distinctQueries][0] ?? ''
      : ranBySource.map((r) => `${r.source}: ${r.ran.join(' | ')}`).join(' | ')
  ).slice(0, MAX_QUERY_LABEL_CHARS);
  const notAnswered = perSource.filter((m) => !ANSWERED.has(m.status));
  const summary =
    `Searched ${answered.join(', ') || 'no source'}: ${candidates.length} unique candidate(s).` +
    (notAnswered.length > 0 ? ` Not answered: ${notAnswered.map((m) => `${m.source} (${m.status})`).join(', ')}.` : '');
  const provenance = uniqueProvenance(candidates);
  const evidence: Evidence = {
    id: newId('ev'),
    component_id: component?.id ?? UNSCOPED_COMPONENT_ID,
    kind: 'search',
    at: now.toISOString(),
    query: queryLabel,
    sources: answered,
    tool: TOOL_NAME,
    result_refs: candidates.map((c) => c.ref),
    summary,
    ...(provenance.length > 0 ? { provenance } : {}),
  };
  ledger.append({ v: 1, type: 'evidence.add', at: evidence.at, evidence });
  if (component !== undefined && component.status === 'pending') {
    ledger.append({
      v: 1,
      type: 'component.upsert',
      at: evidence.at,
      component: { ...component, status: 'searching' },
    });
  }

  const output: SearchOutput = {
    evidence_id: evidence.id,
    candidates,
    per_source: perSource,
    degraded,
    ...(fallbackHint !== undefined ? { fallback_hint: fallbackHint } : {}),
    budget,
  };
  return { output, component, targets };
}

async function handleSearch(ctx: AppContext, input: SearchToolInput): Promise<CallToolResult> {
  try {
    const done = await performSearch(ctx, input);
    if ('error' in done) return errorResult(done.error);
    return {
      content: [{ type: 'text', text: summaryText(done) }],
      structuredContent: done.output,
    };
  } catch (err) {
    return errorResult(`${TOOL_NAME} failed: ${safeErrorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSearchTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Search for existing solutions',
      description:
        'Step 3 of the reuse-first workflow. Search GitHub, npm, PyPI and the MCP registry in parallel for existing solutions to a component, merge duplicates, and record the round as search evidence in the ledger (returns evidence_id; this tool writes to .recyclewheel/ledger.jsonl and is not read-only). Uses the planned queries of component_id unless query is given. A failing source does not fail the call; check per_source and degraded. Respects a per-component round budget.',
      inputSchema: searchInputShape,
      outputSchema: SearchOutputSchema.shape,
      // Appends search evidence (and a component status update) to the ledger, so not read-only.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => handleSearch(ctx, args as SearchToolInput),
  );
}

export const searchTool: ToolModule = { name: TOOL_NAME, register: registerSearchTool };
