/**
 * `rw_record_evidence` (docs/PLAN.md section 7.5): records research the agent
 * did itself (WebSearch/WebFetch, Grep MCP, manual inspection) so that a
 * decision can cite it. Zero results is a valid record ("looked, found none").
 *
 * With `concern` the evidence covers a cross-cutting concern (cost, store
 * policy, privacy, operations, security) instead of a component's candidates:
 * `component_id` is then optional (project-wide evidence is filed under the
 * unscoped pseudo component), and the evidence is kept out of the per-component
 * budget and the "build needs 2 sources" count. Each concern has its own web
 * allowance of `budget.web` queries (warning only; `legal_privacy` gets it once
 * per target market). `market` tags a `concern` evidence with the country whose
 * law or store rule it covers, so coverage can be tracked per market.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { redactGithubToken } from '../../auth/github-token.js';
import { redactUrl } from '../../cache/key.js';
import { concernWebLimit, concernWebUsage, hardLimit, usageFor } from '../../core/budget.js';
import { findComponent, truncateContent } from '../../core/ledger.js';
import { clampInput, codeSpan, oneLine, softLine, stripControlChars, wrapUntrusted } from '../../core/sanitize.js';
import { CandidateRefSchema, ConcernSchema, MarketCodeSchema, newId } from '../../types.js';
import type { AppContext, Evidence, ToolModule } from '../../types.js';
import { UNSCOPED_COMPONENT_ID } from './search.js';

export const TOOL_NAME = 'rw_record_evidence';

const MAX_NOTE_CHARS = 300;
const MAX_RESULTS = 20;
const MAX_ECHO_SUMMARY_CHARS = 300;

/** Single-line, control-free excerpt of at most `max` characters for the fenced Markdown echo. */
function excerpt(text: string, max: number): string {
  const t = stripControlChars(clampInput(text, max)).replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Replaces every URL inside free text by its redacted form (no userinfo, fragment or secret query values). */
function redactUrlsIn(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (m) => redactUrl(m));
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const evidenceInputShape = {
  component_id: z
    .string()
    .min(1)
    .optional()
    .describe('Component the research was done for (from rw_decompose). Required unless `concern` is set; with `concern`, omit it for project-wide research.'),
  concern: ConcernSchema.optional().describe(
    'Cross-cutting concern this research covers: cost | distribution_policy | legal_privacy | operations | security (see concerns_checklist of rw_decompose). Also record "not applicable, because ..." here.',
  ),
  market: MarketCodeSchema.optional().describe(
    'Target market this concern research covers: ISO 3166-1 alpha-2 code in capitals or "EU" (e.g. "KR"). Only with `concern`; use it for legal_privacy and distribution_policy research that is specific to one country.',
  ),
  kind: z
    .enum(['web', 'code_search', 'manual'])
    .describe('web = WebSearch/WebFetch, code_search = Grep MCP / GitHub code search, manual = anything else (e.g. reading the repository).'),
  query: z.string().max(2000).optional().describe('The query or URL you searched with.'),
  tool: z.string().max(200).optional().describe('Tool used, e.g. "WebSearch", "grep_mcp", "gh".'),
  results: z
    .array(
      z.object({
        url: z.string().max(2000).refine(isHttpUrl, { message: 'url must be an absolute http(s) URL' }).describe('Absolute http(s) URL.'),
        title: z.string().max(2000).optional(),
        note: z.string().max(MAX_NOTE_CHARS).optional().describe(`Why this result matters, at most ${MAX_NOTE_CHARS} characters.`),
        ref: CandidateRefSchema.optional().describe('Candidate ref this result corresponds to, e.g. "github:owner/repo".'),
      }),
    )
    .max(MAX_RESULTS)
    .describe(`0-${MAX_RESULTS} results. An empty list records that nothing relevant was found.`),
  summary: z.string().min(10).describe('What was searched and what was learned (at least 10 characters).'),
  project_root: z
    .string()
    .optional()
    .describe('Project directory that holds .recyclewheel/ledger.jsonl. Default: RECYCLEWHEEL_PROJECT_ROOT or the working directory.'),
};
/** The tool input with its cross-field rules; `evidenceInputShape` stays the plain field list. */
export const EvidenceInputSchema = z.object(evidenceInputShape).superRefine((input, ctx) => {
  if (input.market !== undefined && input.concern === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['market'],
      message: 'market is only allowed together with `concern` (it says which country a cross-cutting concern evidence covers); drop market, or set concern.',
    });
  }
});
export type EvidenceToolInput = z.infer<typeof EvidenceInputSchema>;

export const EvidenceOutputSchema = z.object({
  evidence_id: z.string(),
  /** Non-fatal notes: web query budget exceeded, summary truncated. */
  warnings: z.array(z.string()).optional(),
});
export type EvidenceOutput = z.infer<typeof EvidenceOutputSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function handleEvidence(ctx: AppContext, input: EvidenceToolInput): CallToolResult {
  try {
    const ledger = ctx.ledger(input.project_root);
    const state = ledger.read();

    if (input.component_id === undefined && input.concern === undefined) {
      return errorResult(`${TOOL_NAME}: component_id is required unless \`concern\` is set (project-wide cross-cutting research).`);
    }
    const componentId = input.component_id ?? UNSCOPED_COMPONENT_ID;
    const component =
      input.component_id === undefined
        ? { id: UNSCOPED_COMPONENT_ID, name: 'project-wide' }
        : findComponent(state, input.component_id);
    if (component === undefined) {
      const known = state.components.slice(0, 10).map((c) => c.id);
      return errorResult(
        `${TOOL_NAME}: unknown component_id ${codeSpan(componentId, 64)}. ${
          known.length > 0 ? `Known ids: ${known.map((id) => codeSpan(id, 64)).join(', ')}.` : 'The ledger has no components yet.'
        } Call rw_decompose first, or fix the id.`,
      );
    }

    const warnings: string[] = [];
    if (input.kind === 'web' && input.concern !== undefined) {
      const limit = concernWebLimit(state, input.concern, ctx.config.budget.web);
      const after = concernWebUsage(state, input.concern) + 1;
      if (after > limit) {
        warnings.push(`web query budget for concern "${input.concern}" exceeded (${after - 1}/${limit} used); decide what the research shows instead of searching more.`);
      }
    } else if (input.kind === 'web') {
      // Evidence is a record of something that already happened, so budget overruns
      // only warn here; the budget gates the searching, not the bookkeeping.
      const limit = ctx.config.budget.web;
      const after = usageFor(state, component.id).web + 1;
      if (after > hardLimit(limit)) {
        warnings.push(
          `web query budget for "${component.id}" is past its hard limit (${after - 1}/${limit}, hard ${hardLimit(limit)}); recorded anyway. Stop searching and decide.`,
        );
      } else if (after > limit) {
        warnings.push(`web query budget exceeded for "${component.id}" (${after - 1}/${limit} used); decide with the evidence you have.`);
      }
    }

    const summary = truncateContent(input.summary);
    if (summary.truncated) warnings.push('summary was longer than 50KB and was truncated.');

    const refs = [...new Set(input.results.flatMap((r) => (r.ref !== undefined ? [r.ref] : [])))];
    const evidence: Evidence = {
      id: newId('ev'),
      component_id: component.id,
      kind: input.kind,
      at: ctx.now().toISOString(),
      ...(input.query !== undefined ? { query: redactUrlsIn(input.query) } : {}),
      ...(input.tool !== undefined ? { tool: input.tool } : {}),
      result_refs: refs,
      results: input.results.map((r) => ({
        url: redactUrl(r.url),
        ...(r.title !== undefined ? { title: r.title } : {}),
        ...(r.note !== undefined ? { note: r.note } : {}),
      })),
      summary: summary.content,
      ...(input.concern !== undefined ? { concern: input.concern } : {}),
      ...(input.market !== undefined ? { market: input.market } : {}),
    };
    ledger.append({ v: 1, type: 'evidence.add', at: evidence.at, evidence });

    const output: EvidenceOutput = {
      evidence_id: evidence.id,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    const lines = [
      `## rw_record_evidence: ${oneLine(component.name, 100)} (${codeSpan(component.id, 64)})`,
      '',
      `Recorded ${input.kind} evidence ${codeSpan(evidence.id)} with ${input.results.length} result(s)${input.concern !== undefined ? ` for concern ${codeSpan(input.concern)}${input.market !== undefined ? ` (market ${codeSpan(input.market)})` : ''}` : ''}.`,
    ];
    if (input.results.length === 0) lines.push('Zero results recorded: this counts as "searched, found nothing".');
    for (const w of warnings) lines.push(`Warning: ${softLine(w)}`);
    // Summary, titles and notes usually paraphrase web pages: echo them fenced as untrusted data.
    const recorded = [`summary: ${excerpt(summary.content, MAX_ECHO_SUMMARY_CHARS)}`];
    for (const r of input.results) {
      const parts = [redactUrl(r.url), r.title, r.note].filter((p): p is string => p !== undefined && p !== '');
      recorded.push(`- ${parts.map((p) => excerpt(p, MAX_NOTE_CHARS)).join(' | ')}`);
    }
    lines.push('', ...wrapUntrusted(recorded), '');
    lines.push('Cite this id in rw_decide (evidence_ids) or let rw_decide include all evidence of the component.');
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: output };
  } catch (err) {
    const message = redactGithubToken(err instanceof Error ? err.message : String(err));
    return errorResult(`${TOOL_NAME} failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerEvidenceTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Record research evidence',
      description:
        'Record research you did yourself (WebSearch/WebFetch, Grep MCP, GitHub code search, manual inspection) as evidence for a component and get an evidence_id. Web and code_search evidence each count as one source toward the "build needs 2 sources" rule. Zero results is valid ("searched, found nothing"). Set `concern` (cost | distribution_policy | legal_privacy | operations | security) to record research on a cross-cutting concern instead; component_id is then optional, and that evidence does not count toward the component search budget or the 2-source rule. Add `market` (e.g. "KR", "US", "EU") for research on one target market, such as its privacy law; legal_privacy is reported as not checked for each target market without such evidence.',
      inputSchema: EvidenceInputSchema,
      outputSchema: EvidenceOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => handleEvidence(ctx, args as EvidenceToolInput),
  );
}

export const evidenceTool: ToolModule = { name: TOOL_NAME, register: registerEvidenceTool };
