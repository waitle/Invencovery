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

export const TOOL_NAME = 'rw_decompose';

const MAX_TABLE_ROWS = 15;

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
    .describe(
      'SPDX license expression of the project, e.g. "MIT". Omit when undecided (permissive is assumed), or on a later call to keep the value already recorded.',
    ),
  distribution: DistributionSchema.optional().describe(
    'How the project is delivered: library | application | saas | internal. Default application; omitted on a later call it keeps the value already recorded.',
  ),
  ecosystems: z
    .array(EcosystemSchema)
    .optional()
    .describe(
      'Package ecosystems the project uses (npm, pypi, ...). Selects the registries that are searched. Omitted on a later call it keeps the value already recorded; a given list replaces it.',
    ),
  markets: z
    .array(MarketCodeSchema)
    .min(1)
    .max(MAX_MARKETS)
    .optional()
    .describe(
      `Target markets: 1-${MAX_MARKETS} ISO 3166-1 alpha-2 country codes in capitals, or "EU" (e.g. ["KR", "US"]). Laws and store rules differ per country, so concerns_checklist adds questions for each and legal_privacy coverage is tracked per market. Omit only when unknown: Hangul or kana in the project text then infers KR or JP (reported as markets.source "inferred"). Markets given in an earlier call are kept when omitted.`,
    ),
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
    .describe(`1-${MAX_KEYWORDS} search keywords (3-6 works best, each at most ${MAX_NAME_CHARS} characters); these become the search queries.`),
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
    .describe(
      'Default false: upsert by id. true marks components missing from this list as superseded (reported as a warning; the append-only ledger keeps them).',
    ),
  project_root: z
    .string()
    .optional()
    .describe('Project directory that holds .recyclewheel/ledger.jsonl. Default: RECYCLEWHEEL_PROJECT_ROOT or the working directory.'),
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
          params: z.object({ nameHints: z.array(z.string()).optional() }).optional(),
        }),
      ),
      skip_reason: z.literal('trivial').optional(),
    }),
  ),
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
    else searches = plan.queries.map((q) => `${q.source}: ${codeSpan(q.query).replace(/\|/g, '\\|')}`).join('<br>');
    // `searches` already holds escaped code spans; only the name is escaped here.
    lines.push(`| ${cell(c.name)} (${codeSpan(c.id, 64)}) | ${c.status} | ${searches} |`);
  }
  if (out.components.length > MAX_TABLE_ROWS) {
    lines.push('', `_... and ${out.components.length - MAX_TABLE_ROWS} more component(s); see structuredContent._`);
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
    'Next: call rw_search for each non-trivial component (use component_id), then rw_evaluate the best candidates.',
  );
  return lines.join('\n');
}

function handleDecompose(ctx: AppContext, input: DecomposeToolInput): CallToolResult {
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
    const output: DecomposeOutput = {
      components: validation.components.map((c) => ({ id: c.id, name: c.name, status: c.status })),
      search_plan: plan,
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
        'Step 2 of the reuse-first workflow. Record the project and its components (1-30, each with keywords) in the ledger and get a deterministic search plan: one query per relevant source per component. Trivial components are skipped; components that sound like ML also get a Hugging Face model query (hf_models). The result also carries concerns_checklist: cross-cutting concerns (cost, distribution policy, legal/privacy, operations, security) that package search does not reveal; research each on the web and record it with rw_record_evidence(concern=...). Call this before rw_search.',
      inputSchema: decomposeInputShape,
      outputSchema: DecomposeOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => handleDecompose(ctx, args as DecomposeToolInput),
  );
}

export const decomposeTool: ToolModule = { name: TOOL_NAME, register: registerDecomposeTool };
