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

const entryShape = {
  component_id: z
    .string()
    .min(1)
    .optional()
    .describe('Component the research was for. Required unless concern is set (then omit it for project-wide research).'),
  concern: ConcernSchema.optional().describe(
    'Cross-cutting concern this covers: cost | distribution_policy | legal_privacy | operations | security. "Not applicable, because ..." is also recorded here.',
  ),
  market: MarketCodeSchema.optional().describe('Country this concern research covers (ISO 3166-1 alpha-2 or "EU"); only with concern.'),
  kind: z.enum(['web', 'code_search', 'manual']).describe('web = WebSearch/WebFetch, code_search = Grep MCP or GitHub code search, manual = anything else.'),
  query: z.string().max(2000).optional().describe('The query or URL searched.'),
  tool: z.string().max(200).optional().describe('Tool used, e.g. "WebSearch".'),
  results: z
    .array(
      z.object({
        url: z.string().max(2000).refine(isHttpUrl, { message: 'url must be an absolute http(s) URL' }).describe('Absolute http(s) URL.'),
        title: z.string().max(2000).optional(),
        note: z.string().max(MAX_NOTE_CHARS).optional().describe(`Why it matters, at most ${MAX_NOTE_CHARS} characters.`),
        ref: CandidateRefSchema.optional().describe('Candidate ref this result is about, e.g. "github:owner/repo".'),
      }),
    )
    .max(MAX_RESULTS)
    .describe(`0-${MAX_RESULTS} results; an empty list records "searched, found nothing".`),
  summary: z.string().min(10).describe('What was searched and learned (at least 10 characters).'),
};
const EntrySchema = z.object(entryShape).superRefine((input, ctx) => {
  if (input.market !== undefined && input.concern === undefined) {
    ctx.addIssue({ code: 'custom', path: ['market'], message: 'market is only allowed together with concern.' });
  }
  if (input.component_id === undefined && input.concern === undefined) {
    ctx.addIssue({ code: 'custom', path: ['component_id'], message: 'component_id is required unless concern is set (project-wide cross-cutting research).' });
  }
});
export type EvidenceEntry = z.infer<typeof EntrySchema>;

export const MAX_BATCH_ENTRIES = 30;

/** One record in the top-level fields, or several in `entries`. */
export const evidenceInputShape = {
  ...entryShape,
  kind: entryShape.kind.optional(),
  results: entryShape.results.optional(),
  summary: entryShape.summary.optional(),
  entries: z
    .array(EntrySchema)
    .min(1)
    .max(MAX_BATCH_ENTRIES)
    .optional()
    .describe(`Several records in one call (1-${MAX_BATCH_ENTRIES} items with the fields above, e.g. one per cross-cutting concern); then leave the top-level record fields empty.`),
  project_root: z
    .string()
    .optional()
    .describe('Project directory holding .recyclewheel/ (default: the server project root).'),
};
const ENTRY_FIELDS = ['component_id', 'concern', 'market', 'kind', 'query', 'tool', 'results', 'summary'] as const;
/** The tool input with its cross-field rules; `evidenceInputShape` stays the plain field list. */
export const EvidenceInputSchema = z.object(evidenceInputShape).superRefine((input, ctx) => {
  if (input.entries !== undefined) {
    const stray = ENTRY_FIELDS.filter((f) => input[f] !== undefined);
    if (stray.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['entries'], message: `with entries[], put every record inside the array; top-level ${stray.join(', ')} must be empty.` });
    }
    return;
  }
  for (const field of ['kind', 'results', 'summary'] as const) {
    if (input[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required (or pass entries[] for several records).` });
  }
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
  /** The recorded evidence when exactly one was recorded. */
  evidence_id: z.string().optional(),
  /** Every recorded evidence id, in input order. */
  evidence_ids: z.array(z.string()),
  /** One entry per record in input order: recorded (evidence_id) or rejected (error). */
  results: z.array(
    z.object({
      index: z.number().int(),
      evidence_id: z.string().optional(),
      error: z.string().optional(),
      warnings: z.array(z.string()).optional(),
    }),
  ),
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

interface Recorded {
  evidence: Evidence;
  component: { id: string; name: string };
  entry: EvidenceEntry;
  warnings: string[];
}

/** Validates one record against the current ledger state and appends it. */
function recordOne(ctx: AppContext, ledger: ReturnType<AppContext['ledger']>, entry: EvidenceEntry): Recorded | { error: string } {
  const state = ledger.read();
  const componentId = entry.component_id ?? UNSCOPED_COMPONENT_ID;
  const component =
    entry.component_id === undefined ? { id: UNSCOPED_COMPONENT_ID, name: 'project-wide' } : findComponent(state, entry.component_id);
  if (component === undefined) {
    const known = state.components.slice(0, 10).map((c) => c.id);
    return {
      error: `unknown component_id ${codeSpan(componentId, 64)}. ${
        known.length > 0 ? `Known ids: ${known.map((id) => codeSpan(id, 64)).join(', ')}.` : 'The ledger has no components yet.'
      } Call rw_decompose first, or fix the id.`,
    };
  }

  const warnings: string[] = [];
  if (entry.kind === 'web' && entry.concern !== undefined) {
    const limit = concernWebLimit(state, entry.concern, ctx.config.budget.web);
    const after = concernWebUsage(state, entry.concern) + 1;
    if (after > limit) {
      warnings.push(`web query budget for concern "${entry.concern}" exceeded (${after - 1}/${limit} used); decide what the research shows instead of searching more.`);
    }
  } else if (entry.kind === 'web') {
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

  const summary = truncateContent(entry.summary);
  if (summary.truncated) warnings.push('summary was longer than 50KB and was truncated.');

  const refs = [...new Set(entry.results.flatMap((r) => (r.ref !== undefined ? [r.ref] : [])))];
  const evidence: Evidence = {
    id: newId('ev'),
    component_id: component.id,
    kind: entry.kind,
    at: ctx.now().toISOString(),
    ...(entry.query !== undefined ? { query: redactUrlsIn(entry.query) } : {}),
    ...(entry.tool !== undefined ? { tool: entry.tool } : {}),
    result_refs: refs,
    results: entry.results.map((r) => ({
      url: redactUrl(r.url),
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.note !== undefined ? { note: r.note } : {}),
    })),
    summary: summary.content,
    ...(entry.concern !== undefined ? { concern: entry.concern } : {}),
    ...(entry.market !== undefined ? { market: entry.market } : {}),
  };
  ledger.append({ v: 1, type: 'evidence.add', at: evidence.at, evidence });
  return { evidence, component, entry, warnings };
}

function describeRecorded(r: Recorded): string {
  const { entry, evidence } = r;
  const scope = entry.concern !== undefined ? ` for concern ${codeSpan(entry.concern)}${entry.market !== undefined ? ` (market ${codeSpan(entry.market)})` : ''}` : '';
  const none = entry.results.length === 0 ? ' Zero results: counts as "searched, found nothing".' : '';
  return `${entry.kind} evidence ${codeSpan(evidence.id)} with ${entry.results.length} result(s)${scope}.${none}`;
}

/** Summary, titles and notes paraphrase web pages: one fenced block per record. */
function echoLines(r: Recorded): string[] {
  const recorded = [`summary: ${excerpt(r.evidence.summary, MAX_ECHO_SUMMARY_CHARS)}`];
  for (const x of r.entry.results) {
    const parts = [redactUrl(x.url), x.title, x.note].filter((p): p is string => p !== undefined && p !== '');
    recorded.push(`- ${parts.map((p) => excerpt(p, MAX_NOTE_CHARS)).join(' | ')}`);
  }
  return wrapUntrusted(recorded);
}

function handleEvidence(ctx: AppContext, input: EvidenceToolInput): CallToolResult {
  try {
    const ledger = ctx.ledger(input.project_root);
    const entries: EvidenceEntry[] = input.entries ?? [
      // The schema guarantees kind, results and summary in the single form.
      {
        ...(input.component_id !== undefined ? { component_id: input.component_id } : {}),
        ...(input.concern !== undefined ? { concern: input.concern } : {}),
        ...(input.market !== undefined ? { market: input.market } : {}),
        kind: input.kind!,
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.tool !== undefined ? { tool: input.tool } : {}),
        results: input.results!,
        summary: input.summary!,
      },
    ];
    if (input.entries === undefined && entries[0]!.component_id === undefined && entries[0]!.concern === undefined) {
      return errorResult(`${TOOL_NAME}: component_id is required unless \`concern\` is set (project-wide cross-cutting research).`);
    }

    const outcomes = entries.map((entry) => recordOne(ctx, ledger, entry));
    const recorded = outcomes.filter((o): o is Recorded => !('error' in o));
    if (recorded.length === 0) {
      const batch = input.entries !== undefined;
      const reasons = outcomes.map((o, i) => (batch ? `- entries[${i}]: ${'error' in o ? o.error : ''}` : 'error' in o ? o.error : '')).join('\n');
      return errorResult(`${TOOL_NAME}: ${batch ? `nothing was recorded.\n${reasons}` : reasons}`);
    }

    const warnings = recorded.flatMap((r) => r.warnings);
    const output: EvidenceOutput = {
      ...(recorded.length === 1 ? { evidence_id: recorded[0]!.evidence.id } : {}),
      evidence_ids: recorded.map((r) => r.evidence.id),
      results: outcomes.map((o, index) =>
        'error' in o
          ? { index, error: o.error }
          : { index, evidence_id: o.evidence.id, ...(o.warnings.length > 0 ? { warnings: o.warnings } : {}) },
      ),
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    const lines: string[] = [];
    if (entries.length === 1) {
      const r = recorded[0]!;
      lines.push(`## rw_record_evidence: ${oneLine(r.component.name, 100)} (${codeSpan(r.component.id, 64)})`, '', `Recorded ${describeRecorded(r)}`);
      for (const w of r.warnings) lines.push(`Warning: ${softLine(w)}`);
      lines.push('', ...echoLines(r), '');
    } else {
      lines.push(`## rw_record_evidence: ${recorded.length} of ${entries.length} record(s) recorded`, '');
      outcomes.forEach((o, i) => {
        if ('error' in o) {
          lines.push(`- entries[${i}]: **rejected**: ${softLine(o.error, 400)}`);
          return;
        }
        lines.push(`- entries[${i}] ${oneLine(o.component.name, 100)} (${codeSpan(o.component.id, 64)}): ${describeRecorded(o)}${o.warnings.length > 0 ? ` Warning: ${softLine(o.warnings.join(' '), 300)}` : ''}`);
      });
      lines.push('');
    }
    lines.push('Cite these ids in rw_decide (evidence_ids) or let rw_decide include all evidence of the component.');
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
        'Record research you did yourself (WebSearch/WebFetch, code search, manual inspection) and get evidence ids; zero results is valid. web and code_search each count as one source for the "build needs 2 sources" rule. With concern (cost | distribution_policy | legal_privacy | operations | security) it records cross-cutting research instead (component_id optional, outside the component budget); add market (e.g. "KR") for one country. entries[] records several in one call.',
      inputSchema: EvidenceInputSchema,
      outputSchema: EvidenceOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => handleEvidence(ctx, args as EvidenceToolInput),
  );
}

export const evidenceTool: ToolModule = { name: TOOL_NAME, register: registerEvidenceTool };
