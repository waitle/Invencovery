/**
 * `rw_decompose` (docs/PLAN.md section 7.2): validates the agent's component
 * list, records `project.set` + `component.upsert` events in the ledger and
 * returns the deterministic per-source search plan.
 *
 * The tool layer only validates input, calls `core/decompose` and
 * `core/ledger`, and formats the result.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { redactGithubToken } from '../../auth/github-token.js';
import {
  MAX_COMPONENTS,
  MAX_DESCRIPTION_CHARS,
  MAX_KEYWORDS,
  MAX_MARKETS,
  MAX_NAME_CHARS,
  MAX_SUMMARY_CHARS,
  buildDecomposeEvents,
  buildSearchPlan,
  validateDecompose,
} from '../../core/decompose.js';
import { buildConcernsChecklist } from '../../core/concerns.js';
import { codeSpan, oneLine, softLine } from '../../core/sanitize.js';
import {
  ComponentSchema,
  ConcernSchema,
  DistributionSchema,
  EcosystemSchema,
  MarketCodeSchema,
  SourceSchema,
} from '../../types.js';
import type { AppContext, ToolModule } from '../../types.js';
import { collectStatus } from '../../doctor.js';
import type { StatusContext } from '../../doctor.js';
import { SearchOutputSchema, candidateTableLines, performSearch } from './search.js';
import type { SearchOutput } from './search.js';

export const TOOL_NAME = 'rw_decompose';

const MAX_TABLE_ROWS = 15;
/** Candidate rows shown per component when `search: true`; the rest is in structuredContent. */
const MAX_SEARCH_ROWS = 8;
/** Components searched at the same time with `search: true` (each one already queries its sources in parallel). */
const SEARCH_CONCURRENCY = 2;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ProjectInputSchema = z.object({
  name: z.string().min(1).describe('Project name.'),
  summary: z
    .string()
    .min(1)
    .max(MAX_SUMMARY_CHARS)
    .describe(`What is being built, at most ${MAX_SUMMARY_CHARS} characters.`),
  license: z
    .string()
    .optional()
    .describe('SPDX expression of the project license, e.g. "MIT". Omit when undecided or to keep the recorded value.'),
  distribution: DistributionSchema.optional().describe('library | application | saas | internal (default application; omitted later, the recorded value is kept).'),
  ecosystems: z
    .array(EcosystemSchema)
    .optional()
    .describe('Package ecosystems (npm, pypi, ...): selects the registries searched. Omitted later, the recorded list is kept.'),
  markets: z
    .array(MarketCodeSchema)
    .min(1)
    .max(MAX_MARKETS)
    .optional()
    .describe(`Target markets, 1-${MAX_MARKETS} codes: ISO 3166-1 alpha-2 in capitals or "EU" (e.g. ["KR", "US"]). Adds per-market legal and store questions; legal_privacy coverage is tracked per market. Omit only when unknown (Hangul or kana infer KR or JP); earlier values are kept when omitted.`),
});

const ComponentInputSchema = z.object({
  id: z.string().optional().describe('Stable id. Default: a slug of the name. Repeating an id upserts that component.'),
  name: z.string().min(1).max(MAX_NAME_CHARS).describe(`Short component name, at most ${MAX_NAME_CHARS} characters.`),
  description: z
    .string()
    .min(1)
    .max(MAX_DESCRIPTION_CHARS)
    .describe(`What the component must do, at most ${MAX_DESCRIPTION_CHARS} characters.`),
  keywords: z
    .array(z.string().min(1).max(MAX_NAME_CHARS))
    .min(1)
    .max(MAX_KEYWORDS)
    .describe(`1-${MAX_KEYWORDS} search keywords, 3-6 works best, each a 1-3 word search term (a library name, the problem domain, a synonym), not a sentence.`),
  ecosystem: EcosystemSchema.optional().describe('Ecosystem of this component when it differs from the project.'),
  kind: z.enum(['library', 'service', 'tool', 'ui', 'glue']).optional(),
  parent_id: z.string().optional().describe('Id of the parent component.'),
  trivial: z
    .boolean()
    .optional()
    .describe('true for standard-library level or roughly 50 lines or fewer; such components are not searched.'),
});

export const decomposeInputShape = {
  project: ProjectInputSchema,
  components: z
    .array(ComponentInputSchema)
    .min(1)
    .max(MAX_COMPONENTS)
    .describe(`1-${MAX_COMPONENTS} components (3-10 is typical).`),
  replace: z
    .boolean()
    .optional()
    .describe('Default false (upsert by id). true marks components missing from this list as superseded (warning; the ledger keeps them).'),
  search: z
    .boolean()
    .optional()
    .describe('Default false. true runs the first rw_search round for every non-trivial component in this call (same budget and evidence; results in searches[]), replacing N rw_search calls. Re-search only thin components.'),
  project_root: z
    .string()
    .optional()
    .describe('Project directory holding .recyclewheel/ (default: the server project root).'),
};
export const DecomposeInputSchema = z.object(decomposeInputShape);
export type DecomposeToolInput = z.infer<typeof DecomposeInputSchema>;

export const DecomposeOutputSchema = z.object({
  components: z.array(z.object({ id: z.string(), name: z.string(), status: ComponentSchema.shape.status })),
  search_plan: z.array(
    z.object({
      component_id: z.string(),
      queries: z.array(
        z.object({
          source: SourceSchema,
          query: z.string(),
          /** Shorter follow-up queries built from the remaining keywords; rw_search runs them while results are thin. */
          alternatives: z.array(z.string()).optional(),
          params: z.object({ nameHints: z.array(z.string()).optional() }).optional(),
        }),
      ),
      skip_reason: z.literal('trivial').optional(),
    }),
  ),
  /** With `search: true`: the first search round of every non-trivial component (an rw_search output each), or why it could not run. */
  searches: z
    .array(
      z.union([
        SearchOutputSchema.extend({ component_id: z.string() }),
        z.object({ component_id: z.string(), error: z.string() }),
      ]),
    )
    .optional(),
  budget: z.object({
    rounds_per_component: z.number().int(),
    evals_per_component: z.number().int(),
    web_per_component: z.number().int(),
  }),
  /**
   * Cross-cutting concerns that package research does not reveal. Investigate each on the web and
   * record it with rw_record_evidence(concern=...); "not applicable, because ..." is a valid record.
   */
  concerns_checklist: z.array(
    z.object({
      concern: ConcernSchema,
      relevance: z.enum(['likely', 'consider']),
      reason: z.string(),
      questions: z.array(z.string()),
      search_hints: z.array(z.string()),
    }),
  ),
  /** Target markets used for the checklist: `input` as given, `inferred` from the project text, `none` when unknown (see warnings). */
  markets: z.object({ codes: z.array(z.string()), source: z.enum(['input', 'inferred', 'none']) }),
  /** What rw_status would report, so the preflight needs no separate call: GitHub auth, offline mode, enabled sources, ledger health. */
  preflight: z
    .object({
      github_auth: z.enum(['env', 'gh_cli', 'none']),
      offline: z.boolean(),
      sources: z.array(z.string()),
      ledger_exists: z.boolean(),
      warnings: z.array(z.string()),
    })
    .optional(),
  /** Project fields (license, distribution, ecosystems, markets) that this call omitted and kept from the ledger. */
  inherited_project_fields: z.array(z.string()).optional(),
  ledger_path: z.string(),
  /** Non-fatal notes from validation (superseded components, too many components, no ecosystem, no market). */
  warnings: z.array(z.string()).optional(),
});
export type DecomposeOutput = z.infer<typeof DecomposeOutputSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** A table cell: one line, escaped (it holds names and keyword queries; `oneLine` escapes `\` and `|` too). */
function cell(text: string): string {
  return oneLine(text, 300);
}

function summaryText(out: DecomposeOutput, projectName: string): string {
  const lines: string[] = [`## rw_decompose: ${oneLine(projectName, 100)}`, ''];
  lines.push(`Recorded ${out.components.length} component(s) in ${codeSpan(out.ledger_path, 500)}.`, '');
  lines.push('| Component | Status | Planned searches |', '|---|---|---|');
  const planById = new Map(out.search_plan.map((p) => [p.component_id, p]));
  for (const c of out.components.slice(0, MAX_TABLE_ROWS)) {
    const plan = planById.get(c.id);
    let searches: string;
    if (plan?.skip_reason === 'trivial') searches = 'skipped (trivial)';
    else if (!plan || plan.queries.length === 0) searches = 'none (enabled sources do not apply)';
    else {
      searches = plan.queries
        .map((q) => {
          const alt = q.alternatives && q.alternatives.length > 0 ? ` (+${q.alternatives.length} alt.)` : '';
          return `${q.source}: ${codeSpan(q.query).replace(/\|/g, '\\|')}${alt}`;
        })
        .join('<br>');
    }
    // `searches` already holds escaped code spans; only the name is escaped here.
    lines.push(`| ${cell(c.name)} (${codeSpan(c.id, 64)}) | ${c.status} | ${searches} |`);
  }
  if (out.components.length > MAX_TABLE_ROWS) {
    lines.push('', `_... and ${out.components.length - MAX_TABLE_ROWS} more component(s); see structuredContent._`);
  }
  if (out.search_plan.some((p) => p.queries.some((q) => q.alternatives !== undefined))) {
    lines.push('', '"alt." queries are alternatives built from the remaining keywords; rw_search runs them only while a source returns few results.');
  }

  if (out.searches !== undefined) {
    const nameById = new Map(out.components.map((c) => [c.id, c.name]));
    lines.push('', `## First search round (${out.searches.length} component(s))`);
    for (const s of out.searches) {
      const title = `### ${cell(nameById.get(s.component_id) ?? s.component_id)} (${codeSpan(s.component_id, 64)})`;
      if ('error' in s) {
        lines.push('', title, '', `Not searched: ${softLine(s.error, 400)}`);
        continue;
      }
      lines.push('', `${title}: ${s.candidates.length} candidate(s), evidence ${codeSpan(s.evidence_id)}`, '');
      lines.push(...candidateTableLines(s.candidates, MAX_SEARCH_ROWS));
      const sources = s.per_source.map((m) => `${m.source} ${m.status} (${m.count})`).join(', ');
      lines.push('', `Sources: ${sources}.`);
      const problems = s.per_source.filter((m) => m.status !== 'ok' && m.status !== 'cached' && m.message !== undefined);
      for (const m of problems) lines.push(`- ${m.source}: ${softLine(m.message ?? '', 300)}`);
      if (s.degraded && s.fallback_hint) lines.push(`Degraded: ${softLine(s.fallback_hint, 400)}`);
      if (s.budget.warning) lines.push(`Budget warning: ${softLine(s.budget.warning)}`);
    }
  }
  if (out.preflight !== undefined) {
    const p = out.preflight;
    const auth = p.github_auth === 'none' ? 'none (GitHub search 10/min, code search off)' : p.github_auth;
    lines.push('', `Preflight: GitHub auth ${auth}; ${p.offline ? 'OFFLINE (cache only)' : 'online'}; sources ${p.sources.join(', ') || 'none'}; ledger ${p.ledger_exists ? 'ok' : 'new'}.`);
    for (const w of p.warnings) lines.push(`- ${softLine(w)}`);
  }
  lines.push(
    '',
    out.markets.source === 'none'
      ? 'Target markets: none (set project.markets).'
      : `Target markets: ${out.markets.codes.map((m) => codeSpan(m, 8)).join(', ')} (${out.markets.source}${out.markets.source === 'inferred' ? '; confirm with the user or set project.markets' : ''}).`,
  );
  if (out.inherited_project_fields && out.inherited_project_fields.length > 0) {
    lines.push(`Project fields kept from the ledger (omitted in this call): ${out.inherited_project_fields.join(', ')}.`);
  }
  if (out.warnings && out.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const w of out.warnings) lines.push(`- ${softLine(w)}`);
  }
  lines.push('', 'Cross-cutting concerns (not found by package search; investigate each on the web, then rw_record_evidence with concern=...):');
  for (const c of out.concerns_checklist) {
    lines.push(`- ${c.concern}: ${c.relevance}${c.reason ? ` (${softLine(c.reason, 200)})` : ''}`);
  }
  lines.push(
    '',
    `Budget per component: ${out.budget.rounds_per_component} rw_search rounds, ${out.budget.evals_per_component} rw_evaluate candidates, ${out.budget.web_per_component} web queries.`,
    out.searches !== undefined
      ? 'Next: pick up to 5 candidates per component, rate fit 0-5 with a reason, and call rw_evaluate. Call rw_search with a different query only where the round above was thin.'
      : 'Next: call rw_search for each non-trivial component (use component_id), then rw_evaluate the best candidates. Tip: `search: true` on this tool runs that first round for every component in one call.',
  );
  return lines.join('\n');
}

/** Runs `fn` over `items` with at most `concurrency` in flight; results keep the input order. */
async function mapLimited<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

type SearchEntry = NonNullable<DecomposeOutput['searches']>[number];

/** The rw_status facts an agent needs before searching, or undefined when the status cannot be collected (never fails the call). */
async function collectPreflight(ctx: AppContext, ledgerPath: string): Promise<DecomposeOutput['preflight']> {
  try {
    const projectRoot = ledgerPath.replace(/[\\/]\.recyclewheel[\\/]ledger\.jsonl$/, '');
    const report = await collectStatus(ctx as StatusContext, { projectRoot });
    return {
      github_auth: report.github_auth,
      offline: report.offline,
      sources: report.adapters.filter((a) => a.enabled).map((a) => a.source),
      ledger_exists: report.ledger_exists,
      warnings: report.warnings,
    };
  } catch {
    return undefined;
  }
}

/** The first search round of every planned (non-trivial, searchable) component, in plan order. */
async function runFirstRound(
  ctx: AppContext,
  plan: DecomposeOutput['search_plan'],
  projectRoot: string | undefined,
): Promise<SearchEntry[]> {
  const ids = plan.filter((p) => p.skip_reason === undefined && p.queries.length > 0).map((p) => p.component_id);
  return mapLimited(ids, SEARCH_CONCURRENCY, async (component_id): Promise<SearchEntry> => {
    try {
      const done = await performSearch(ctx, { component_id, ...(projectRoot !== undefined ? { project_root: projectRoot } : {}) });
      if ('error' in done) return { component_id, error: done.error };
      const output: SearchOutput & { component_id: string } = { component_id, ...done.output };
      return output;
    } catch (err) {
      return { component_id, error: redactGithubToken(err instanceof Error ? err.message : String(err)) };
    }
  });
}

async function handleDecompose(ctx: AppContext, input: DecomposeToolInput): Promise<CallToolResult> {
  try {
    const ledger = ctx.ledger(input.project_root);
    const state = ledger.read();

    const validation = validateDecompose(
      { project: input.project, components: input.components, replace: input.replace ?? false },
      state.components,
      state.project,
    );
    if (validation.errors.length > 0 || validation.project === undefined) {
      const reasons = validation.errors.map((e) => `- ${e}`).join('\n');
      return errorResult(`${TOOL_NAME}: invalid decomposition; nothing was recorded.\n${reasons}\nFix these and call ${TOOL_NAME} again.`);
    }

    for (const event of buildDecomposeEvents(validation.project, validation.components, ctx.now())) {
      ledger.append(event);
    }

    const plan = buildSearchPlan(validation.project, validation.components, {
      enabledSources: ctx.config.sources,
    });
    const concernText = [
      validation.project.name,
      validation.project.summary,
      ...validation.components.flatMap((c) => [c.name, c.description, ...c.keywords]),
    ].join(' ');
    const searches = input.search === true ? await runFirstRound(ctx, plan, input.project_root) : undefined;
    const preflight = await collectPreflight(ctx, ledger.path);
    // A searched component is now `searching`; report the status after the round.
    const after = searches !== undefined ? ledger.read() : undefined;
    const statusOf = (id: string, fallback: string): string => after?.components.find((c) => c.id === id)?.status ?? fallback;
    const output: DecomposeOutput = {
      components: validation.components.map((c) => ({ id: c.id, name: c.name, status: statusOf(c.id, c.status) as typeof c.status })),
      search_plan: plan,
      ...(searches !== undefined ? { searches } : {}),
      ...(preflight !== undefined ? { preflight } : {}),
      concerns_checklist: buildConcernsChecklist(concernText, validation.project.distribution, validation.markets.codes),
      markets: validation.markets,
      ...(validation.inherited.length > 0 ? { inherited_project_fields: validation.inherited } : {}),
      budget: {

        rounds_per_component: ctx.config.budget.rounds,
        evals_per_component: ctx.config.budget.evals,
        web_per_component: ctx.config.budget.web,
      },
      ledger_path: ledger.path,
      ...(validation.warnings.length > 0 ? { warnings: validation.warnings } : {}),
    };
    return {
      content: [{ type: 'text', text: summaryText(output, validation.project.name) }],
      structuredContent: output,
    };
  } catch (err) {
    const message = redactGithubToken(err instanceof Error ? err.message : String(err));
    return errorResult(`${TOOL_NAME} failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDecomposeTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Decompose a project into components',
      description:
        'Step 2. Record the project and its 1-30 components (3-6 short keywords each) and get the per-source search plan, a preflight (GitHub auth, offline, enabled sources) and concerns_checklist: cross-cutting concerns (cost, distribution policy, legal/privacy, operations, security) to research on the web and record with rw_record_evidence concern=.... search:true also runs the first search round of every non-trivial component here (searches[]).',
      inputSchema: decomposeInputShape,
      outputSchema: DecomposeOutputSchema.shape,
      // Without `search` the call is an idempotent upsert; with it, searches are recorded as evidence (open world, not idempotent).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => handleDecompose(ctx, args as DecomposeToolInput),
  );
}

export const decomposeTool: ToolModule = { name: TOOL_NAME, register: registerDecomposeTool };
