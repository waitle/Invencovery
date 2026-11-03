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
import type { AppContext, ToolModule } from '../../types.js';

export const TOOL_NAME = 'rw_decide';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const decideInputShape = {
  component_id: z.string().min(1).describe('Component being decided (from rw_decompose).'),
  decision: DecisionKindSchema.describe(
    'adopt = use as is | extend = wrap or fork | reference = design/idea only (or copy with attribution) | build = implement yourself.',
  ),
  ref: CandidateRefSchema.optional().describe(
    'Chosen candidate (github:, npm:, pypi:, mcp:, hf: model weights, saas: hosted service, web:). Required for adopt, extend and reference. adopt/extend of a saas: ref needs verified pricing and data-use terms.',
  ),
  version: z.string().optional().describe('Pinned version or revision of the chosen candidate.'),
  rationale: z.string().min(20).describe('Why this decision, at least 20 characters. For build, why no candidate fits.'),
  build_reason: BuildReasonSchema.optional().describe(
    'Required for build: no_candidate | license_incompatible | unmaintained_or_risky | too_heavy | core_differentiator | trivial | integration_glue.',
  ),
  alternatives: z
    .array(z.object({ ref: CandidateRefSchema, why_not: z.string().min(1) }))
    .optional()
    .describe('Candidates (any ref scheme, including hf: and saas:) that were considered and rejected, each with the reason.'),
  attribution: z
    .object({
      source_url: z.string().min(1),
      license: z.string().min(1),
      copyright: z.string().optional(),
      revision: z.string().optional(),
      files: z.array(z.string()).optional(),
    })
    .optional()
    .describe('Required when code is copied, forked or vendored (source_url, license, files).'),
  evidence_ids: z
    .array(z.string())
    .optional()
    .describe('Evidence ids to cite. Default: all evidence recorded for the component.'),
  override: z
    .object({ reason: z.string().min(20) })
    .optional()
    .describe('Waives rule violations (recorded as warnings). Only with explicit user approval, together with decided_by "user".'),
  decided_by: z.enum(['agent', 'user']).optional().describe('Default agent. Use "user" when the user made or approved the call.'),
  project_root: z
    .string()
    .optional()
    .describe('Project directory that holds .recyclewheel/ledger.jsonl. Default: RECYCLEWHEEL_PROJECT_ROOT or the working directory.'),
};
export const DecideInputSchema = z.object(decideInputShape);
export type DecideToolInput = z.infer<typeof DecideInputSchema>;

export const DecideOutputSchema = z.object({
  decision_id: z.string(),
  warnings: z.array(z.string()),
  ledger_path: z.string(),
});
export type DecideOutput = z.infer<typeof DecideOutputSchema>;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function handleDecide(ctx: AppContext, input: DecideToolInput): CallToolResult {
  try {
    const ledger = ctx.ledger(input.project_root);
    const state = ledger.read();

    const decisionInput: DecisionInput = {
      component_id: input.component_id,
      decision: input.decision,
      rationale: input.rationale,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.build_reason !== undefined ? { build_reason: input.build_reason } : {}),
      ...(input.alternatives !== undefined ? { alternatives: input.alternatives } : {}),
      ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
      ...(input.evidence_ids !== undefined ? { evidence_ids: input.evidence_ids } : {}),
      ...(input.override !== undefined ? { override: input.override } : {}),
      ...(input.decided_by !== undefined ? { decided_by: input.decided_by } : {}),
    };

    const { errors, warnings, waived_gates } = validateDecision(state, decisionInput);
    if (errors.length > 0) {
      // validateDecision sanitizes the dynamic values inside its messages.
      const reasons = errors.map((e) => `- ${e}`).join('\n');
      return errorResult(`${TOOL_NAME} rejected; nothing was recorded.\n${reasons}`);
    }

    if (input.override !== undefined && (input.decided_by ?? 'agent') !== 'user') {
      warnings.push(
        'override is recorded with decided_by "agent". Use override only with explicit user approval and set decided_by "user" so the ledger shows who accepted the risk.',
      );
    }

    const component = findComponent(state, input.component_id);
    const now = ctx.now();
    const decision = buildDecision(state, decisionInput, now, waived_gates);
    // This decision is the one that makes "a decision exists": cross-cutting gaps are worth saying now.
    warnings.push(...concernWarnings({ evidence: state.evidence, decisions: [...state.decisions, decision], project: state.project }));
    const at = now.toISOString();
    ledger.append({ v: 1, type: 'decision.add', at, decision });
    if (component !== undefined && component.status !== 'decided') {
      ledger.append({ v: 1, type: 'component.upsert', at, component: { ...component, status: 'decided' } });
    }

    const output: DecideOutput = { decision_id: decision.id, warnings, ledger_path: ledger.path };
    const target = decision.ref !== undefined ? ` ${codeSpan(decision.ref)}` : '';
    const lines = [
      `## rw_decide: ${oneLine(component?.name ?? input.component_id, 100)} (${codeSpan(input.component_id, 64)})`,
      '',
      `Recorded **${decision.decision}**${target}${decision.build_reason ? ` (build_reason: ${decision.build_reason})` : ''} as ${codeSpan(decision.id)}, decided by ${decision.decided_by}.`,
      `Cited evidence: ${decision.evidence_ids.length}.`,
    ];
    if (warnings.length > 0) {
      lines.push('', 'Warnings:');
      for (const w of warnings) lines.push(`- ${w}`);
    }
    if (decision.decision === 'build') {
      lines.push('', `Reference decision id ${codeSpan(decision.id)} in the commit or PR message when implementing.`);
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
        'Step 5 of the reuse-first workflow. Record adopt | extend | reference | build for a component with rationale, alternatives and evidence. The server enforces the rules: adopt/extend need an rw_evaluate result with a compatible license; build needs a build_reason and, unless trivial, search evidence from at least 2 distinct sources. A rejected call explains which tool to call next. Warns for each cross-cutting concern (cost, distribution_policy, legal_privacy, operations, security) that has no evidence yet.',
      inputSchema: decideInputShape,
      outputSchema: DecideOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => handleDecide(ctx, args as DecideToolInput),
  );
}

export const decideTool: ToolModule = { name: TOOL_NAME, register: registerDecideTool };
