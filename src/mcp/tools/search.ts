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
import { planComponent } from '../../core/decompose.js';
import { mergeSearchResults } from '../../core/dedupe.js';
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
  query: string;
  nameHints?: string[];
}

interface TargetOutcome {
  meta: SourceMeta;
  candidates: Candidate[];
  /** True when an adapter was actually invoked. */
  searched: boolean;
}

/**
 * Decides which (source, query) pairs to run. With `query`, every selected
 * source gets that query; otherwise each source uses its planned query, or the
 * component keywords for a source the plan does not cover (e.g. github_code).
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
        query,
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
      return { source, query: p?.query ?? keywordQuery, ...(nameHints !== undefined ? { nameHints } : {}) };
    }),
  };
}

function skipped(source: Source, query: string, message: string): TargetOutcome {
  return { meta: { source, status: 'skipped', count: 0, query, message }, candidates: [], searched: false };
}

async function runTarget(
  ctx: AppContext,
  target: Target,
  input: SearchToolInput,
  component: Component | undefined,
  limit: number,
): Promise<TargetOutcome> {
  const { source, query } = target;
  if (!ctx.config.sources.includes(source)) {
    return skipped(
      source,
      query,
      `Source ${source} is disabled (RECYCLEWHEEL_SOURCES lists: ${ctx.config.sources.join(', ') || 'none'}).`,
    );
  }
  const adapter = ctx.adapters[source];
  if (adapter === undefined) return skipped(source, query, `No adapter is registered for ${source}.`);

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
    const meta: SourceMeta = { ...result.meta, source, count: candidates.length };
    if (dropped > 0) {
      meta.message = `${meta.message ? `${meta.message} ` : ''}${dropped} malformed candidate(s) dropped.`;
      if (meta.status === 'ok' || meta.status === 'cached') meta.status = 'partial';
    }
    return { meta, candidates, searched: true };
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
      searched: true,
    };
  }
}

function uniqueProvenance(candidates: readonly Candidate[]): Provenance[] {
  return [...new Set(candidates.map((c) => c.provenance))];
}

function formatCount(n: number | undefined): string {
  return n === undefined ? '-' : String(n);
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
  lines.push(`Evidence ${codeSpan(output.evidence_id)} recorded. Queries: ${targets.map((t) => `${t.source}: ${codeSpan(t.query)}`).join('; ')}`, '');

  if (output.candidates.length > 0) {
    // Names, licenses and descriptions come from third parties: fence the table.
    const table: string[] = [
      '| # | Candidate | Source | Stars | Weekly downloads | License | Last activity | Description |',
      '|---|---|---|---|---|---|---|---|',
    ];
    output.candidates.slice(0, MAX_TABLE_ROWS).forEach((c, i) => {
      const alias = c.also_known_as && c.also_known_as.length > 0 ? ` (+${c.also_known_as.join(', ')})` : '';
      const flags = [c.archived ? 'archived' : '', c.deprecated ? 'deprecated' : ''].filter(Boolean).join(', ');
      table.push(
        `| ${i + 1} | \`${cell(c.ref, 1100)}\`${cell(alias, 600)}${flags ? ` [${flags}]` : ''} | ${c.source} | ${formatCount(c.stars)} | ${formatCount(c.downloads_weekly)} | ${cell(c.license_spdx ?? (c.license_spdx === null ? 'none' : '-'))} | ${c.last_activity?.slice(0, 10) ?? '-'} | ${cell(c.description ?? '')} |`,
      );
    });
    lines.push(...wrapUntrusted(table));
    if (output.candidates.length > MAX_TABLE_ROWS) {
      lines.push('', `_... and ${output.candidates.length - MAX_TABLE_ROWS} more candidate(s); see structuredContent._`);
    }
  } else {
    lines.push('No candidates found.');
  }

  lines.push('', 'Sources:');
  for (const m of output.per_source) {
    lines.push(`- ${m.source}: ${m.status}, ${m.count} result(s)${m.message ? ` - ${softLine(m.message, 400)}` : ''}`);
  }
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

async function handleSearch(ctx: AppContext, input: SearchToolInput): Promise<CallToolResult> {
  try {
    if (input.component_id === undefined && (input.query === undefined || input.query.trim() === '')) {
      return errorResult(`${TOOL_NAME}: pass component_id (to use its planned queries) and/or query.`);
    }

    const ledger = ctx.ledger(input.project_root);
    const state = ledger.read();

    let component: Component | undefined;
    if (input.component_id !== undefined) {
      component = findComponent(state, input.component_id);
      if (component === undefined) {
        const known = state.components.slice(0, 10).map((c) => c.id);
        return errorResult(
          `${TOOL_NAME}: unknown component_id ${codeSpan(input.component_id, 64)}. ${
            known.length > 0 ? `Known ids: ${known.map((id) => codeSpan(id, 64)).join(', ')}.` : 'The ledger has no components yet.'
          } Call rw_decompose first, or fix the id.`,
        );
      }
    }

    const resolved = resolveTargets(input, component, state.project?.ecosystems ?? [], ctx.config.sources);
    if ('error' in resolved) return errorResult(resolved.error);
    const { targets } = resolved;

    let budget: SearchBudgetReport;
    if (component !== undefined) {
      const check = checkSearchBudget(state, component.id, ctx.config.budget, {
        ...(input.force !== undefined ? { force: input.force } : {}),
        ...(input.force_reason !== undefined ? { force_reason: input.force_reason } : {}),
      });
      if (!check.allowed) return errorResult(`${TOOL_NAME}: ${check.error ?? 'search budget exhausted.'}`);
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
      const first = stripControlChars(targets[0]?.query ?? '')
        .replace(/[\s"`<>]+/g, ' ')
        .trim()
        .slice(0, MAX_QUERY_LABEL_CHARS);
      const parts = [MANUAL_FALLBACK.replaceAll('<query>', first)];
      if (perSource.some((m) => m.status === 'unauthenticated')) parts.push(CODE_SEARCH_FALLBACK);
      fallbackHint = parts.join(' ');
    }

    const now = ctx.now();
    const queryLabel = (
      new Set(targets.map((t) => t.query)).size === 1
        ? (targets[0]?.query ?? '')
        : targets.map((t) => `${t.source}: ${t.query}`).join(' | ')
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
    return {
      content: [{ type: 'text', text: summaryText({ output, component, targets }) }],
      structuredContent: output,
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
