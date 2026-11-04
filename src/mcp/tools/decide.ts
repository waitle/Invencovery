/**
 * `rw_decide` (docs/PLAN.md section 7.6): validates a decision against the
 * ledger (`validateDecision`) and appends `decision.add`. Validation failures
 * come back as `isError` text that names the next action; an `override` with a
 * reason demotes rule violations to recorded warnings.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { redactGithubToken } from '../../auth/github-token.js';
import { concernWarnings } from '../../core/concerns.js';
import { buildDecision, findComponent, validateDecision } from '../../core/ledger.js';
import type { DecisionInput } from '../../core/ledger.js';
import { codeSpan, oneLine } from '../../core/sanitize.js';
import { BuildReasonSchema, CandidateRefSchema, DecisionKindSchema } from '../../types.js';
import type { AppContext, Decision, ToolModule } from '../../types.js';

export const TOOL_NAME = 'rw_decide';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const decisionItemShape = {
  component_id: z.string().min(1).describe('Component being decided (from rw_decompose).'),
  decision: DecisionKindSchema.describe('adopt = use as is | extend = wrap or fork | reference = design only (or copy with attribution) | build = implement yourself.'),
  ref: CandidateRefSchema.optional().describe('Chosen candidate ref (any scheme). Required for adopt, extend and reference.'),
  version: z.string().optional().describe('Pinned version or revision.'),
  rationale: z.string().min(20).describe('Why, at least 20 characters. For build: why no candidate fits.'),
  build_reason: BuildReasonSchema.optional().describe(
    'Required for build: no_candidate | license_incompatible | unmaintained_or_risky | too_heavy | core_differentiator | trivial | integration_glue.',
  ),
  alternatives: z
    .array(z.object({ ref: CandidateRefSchema, why_not: z.string().min(1) }))
    .optional()
    .describe('Rejected candidates with the reason.'),
  attribution: z
    .object({
      source_url: z.string().min(1),
      license: z.string().min(1),
      copyright: z.string().optional(),
      revision: z.string().optional(),
      files: z.array(z.string()).optional(),
    })
    .optional()
    .describe('Required when code is copied, forked or vendored.'),
  evidence_ids: z.array(z.string()).optional().describe('Evidence ids to cite. Default: all evidence of the component.'),
  override: z
    .object({ reason: z.string().min(20) })
    .optional()
    .describe('Waives rule violations (recorded as warnings). Only with explicit user approval, together with decided_by "user".'),
  decided_by: z.enum(['agent', 'user']).optional().describe('Default agent. "user" when the user made or approved the call.'),
};
const DecisionItemSchema = z.object(decisionItemShape);
export type DecisionItem = z.infer<typeof DecisionItemSchema>;

export const MAX_BATCH_DECISIONS = 30;

/** One decision in the top-level fields, or several in `decisions`. */
export const decideInputShape = {
  ...decisionItemShape,
  component_id: decisionItemShape.component_id.optional(),
  decision: decisionItemShape.decision.optional(),
  rationale: decisionItemShape.rationale.optional(),
  decisions: z
    .array(DecisionItemSchema)
    .min(1)
    .max(MAX_BATCH_DECISIONS)
    .optional()
    .describe(`Several components in one call (1-${MAX_BATCH_DECISIONS} items with the fields above); then leave the top-level decision fields empty. Each item is validated and recorded on its own.`),
  project_root: z
    .string()
    .optional()
    .describe('Project directory holding .recyclewheel/ (default: the server project root).'),
};
const SINGLE_FIELDS = ['component_id', 'decision', 'ref', 'version', 'rationale', 'build_reason', 'alternatives', 'attribution', 'evidence_ids', 'override', 'decided_by'] as const;
export const DecideInputSchema = z.object(decideInputShape).superRefine((input, ctx) => {
  if (input.decisions === undefined) {
    for (const field of ['component_id', 'decision', 'rationale'] as const) {
      if (input[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required (or pass decisions[] for several components).` });
    }
  } else {
    const stray = SINGLE_FIELDS.filter((f) => input[f] !== undefined);
    if (stray.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['decisions'], message: `with decisions[], put every decision inside the array; top-level ${stray.join(', ')} must be empty.` });
    }
  }
});
export type DecideToolInput = z.infer<typeof DecideInputSchema>;

export const DecideOutputSchema = z.object({
  /** The recorded decision when exactly one was recorded (single call, or a batch of one). */
  decision_id: z.string().optional(),
  /** Warnings of the recorded decision(s) and the cross-cutting concern gaps. */
  warnings: z.array(z.string()),
  /** One entry per decision in input order: recorded (decision_id) or rejected (error). */
  results: z.array(
    z.object({
      component_id: z.string(),
      decision_id: z.string().optional(),
      error: z.string().optional(),
      warnings: z.array(z.string()).optional(),
    }),
  ),
  ledger_path: z.string(),
});
export type DecideOutput = z.infer<typeof DecideOutputSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function toDecisionInput(item: DecisionItem): DecisionInput {
  return {
    component_id: item.component_id,
    decision: item.decision,
    rationale: item.rationale,
    ...(item.ref !== undefined ? { ref: item.ref } : {}),
    ...(item.version !== undefined ? { version: item.version } : {}),
    ...(item.build_reason !== undefined ? { build_reason: item.build_reason } : {}),
    ...(item.alternatives !== undefined ? { alternatives: item.alternatives } : {}),
    ...(item.attribution !== undefined ? { attribution: item.attribution } : {}),
    ...(item.evidence_ids !== undefined ? { evidence_ids: item.evidence_ids } : {}),
    ...(item.override !== undefined ? { override: item.override } : {}),
    ...(item.decided_by !== undefined ? { decided_by: item.decided_by } : {}),
  };
}

type ItemResult = DecideOutput['results'][number] & { decision?: Decision; component_name?: string };

/** Validates and records one decision against the current ledger state. */
function recordOne(ctx: AppContext, ledger: ReturnType<AppContext['ledger']>, item: DecisionItem): ItemResult {
  const state = ledger.read();
  const decisionInput = toDecisionInput(item);
  const { errors, warnings, waived_gates } = validateDecision(state, decisionInput);
  if (errors.length > 0) {
    // validateDecision sanitizes the dynamic values inside its messages.
    return { component_id: item.component_id, error: errors.map((e) => `- ${e}`).join('\n') };
  }
  if (item.override !== undefined && (item.decided_by ?? 'agent') !== 'user') {
    warnings.push(
      'override is recorded with decided_by "agent". Use override only with explicit user approval and set decided_by "user" so the ledger shows who accepted the risk.',
    );
  }
  const component = findComponent(state, item.component_id);
  const now = ctx.now();
  const decision = buildDecision(state, decisionInput, now, waived_gates);
  const at = now.toISOString();
  ledger.append({ v: 1, type: 'decision.add', at, decision });
  if (component !== undefined && component.status !== 'decided') {
    ledger.append({ v: 1, type: 'component.upsert', at, component: { ...component, status: 'decided' } });
  }
  return {
    component_id: item.component_id,
    decision_id: decision.id,
    ...(warnings.length > 0 ? { warnings } : {}),
    decision,
    ...(component !== undefined ? { component_name: component.name } : {}),
  };
}

function describeDecision(r: ItemResult): string {
  const d = r.decision!;
  const target = d.ref !== undefined ? ` ${codeSpan(d.ref)}` : '';
  return `Recorded **${d.decision}**${target}${d.build_reason ? ` (build_reason: ${d.build_reason})` : ''} as ${codeSpan(d.id)}, decided by ${d.decided_by}. Cited evidence: ${d.evidence_ids.length}.`;
}

function handleDecide(ctx: AppContext, input: DecideToolInput): CallToolResult {
  try {
    const ledger = ctx.ledger(input.project_root);
    const items: DecisionItem[] = input.decisions ?? [
      // The schema guarantees these three fields in the single form.
      { ...input, component_id: input.component_id!, decision: input.decision!, rationale: input.rationale! },
    ];
    const results = items.map((item) => recordOne(ctx, ledger, item));
    const recorded = results.filter((r) => r.decision !== undefined);

    if (recorded.length === 0) {
      const reasons = results.map((r) => (items.length > 1 ? `${codeSpan(r.component_id, 64)}:\n${r.error ?? ''}` : r.error ?? '')).join('\n');
      return errorResult(`${TOOL_NAME} rejected; nothing was recorded.\n${reasons}`);
    }

    // Cross-cutting gaps are worth saying once a decision exists: judged on the ledger after this call.
    const state = ledger.read();
    const warnings = [...recorded.flatMap((r) => r.warnings ?? []), ...concernWarnings({ evidence: state.evidence, decisions: state.decisions, project: state.project })];
    const output: DecideOutput = {
      ...(recorded.length === 1 ? { decision_id: recorded[0]!.decision!.id } : {}),
      warnings,
      results: results.map(({ component_id, decision_id, error, warnings: w }) => ({
        component_id,
        ...(decision_id !== undefined ? { decision_id } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(w !== undefined ? { warnings: w } : {}),
      })),
      ledger_path: ledger.path,
    };

    const lines: string[] = [];
    if (items.length === 1) {
      const r = recorded[0]!;
      lines.push(`## rw_decide: ${oneLine(r.component_name ?? r.component_id, 100)} (${codeSpan(r.component_id, 64)})`, '', describeDecision(r));
    } else {
      lines.push(`## rw_decide: ${recorded.length} of ${items.length} decision(s) recorded`, '');
      for (const r of results) {
        const label = `${oneLine(r.component_name ?? r.component_id, 100)} (${codeSpan(r.component_id, 64)})`;
        if (r.decision !== undefined) lines.push(`- ${label}: ${describeDecision(r)}`);
        else lines.push(`- ${label}: **rejected**, nothing recorded for it.\n${r.error ?? ''}`);
      }
    }
    if (warnings.length > 0) {
      lines.push('', 'Warnings:');
      for (const w of warnings) lines.push(`- ${w}`);
    }
    const builds = recorded.filter((r) => r.decision!.decision === 'build');
    if (builds.length > 0) {
      lines.push('', `Reference decision id${builds.length > 1 ? 's' : ''} ${builds.map((r) => codeSpan(r.decision!.id)).join(', ')} in the commit or PR message when implementing.`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: output };
  } catch (err) {
    const message = redactGithubToken(err instanceof Error ? err.message : String(err));
    return errorResult(`${TOOL_NAME} failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDecideTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Record a reuse decision',
      description:
        'Step 5. Record adopt | extend | reference | build for a component with rationale, alternatives and evidence; decisions[] records several components in one call. Rules are enforced server-side: adopt/extend need an rw_evaluate result with an acceptable license; a non-trivial build needs evidence from 2 sources. A rejection names the next tool to call. Warns about cross-cutting concerns without evidence.',
      inputSchema: DecideInputSchema,
      outputSchema: DecideOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => handleDecide(ctx, args as DecideToolInput),
  );
}

export const decideTool: ToolModule = { name: TOOL_NAME, register: registerDecideTool };
