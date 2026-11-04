/**
 * `rw_status` (docs/PLAN.md §7.1): preflight report. Read-only; no network
 * probes (the remote cache health check, capped at 1.5 s, is the only call).
 */
import { z } from 'zod';
import { codeSpan, softLine } from '../../core/sanitize.js';
import { StatusReportSchema, collectStatus, resolveProjectRoot } from '../../doctor.js';
import type { StatusContext, StatusReport } from '../../doctor.js';
import type { ToolModule } from '../../types.js';
import { errorMessage, errorResult, formatBytes, mdCell, okResult } from '../result.js';

export const STATUS_TOOL_NAME = 'rw_status';

const InputShape = {
  project_root: z
    .string()
    .optional()
    .describe('Project directory holding .recyclewheel/ (default: the server project root).'),
};

function remoteLine(r: StatusReport['remote_cache']): string {
  if (r.mode === 'off') return 'off';
  const where = r.host ?? 'configured host';
  const reach = r.reachable === undefined ? '' : r.reachable ? ', reachable' : ', NOT reachable (falls back to upstream)';
  return `${r.mode} at ${where}${reach}`;
}

export function statusMarkdown(r: StatusReport): string {
  const lines: string[] = [
    `**recyclewheel ${r.version}** on Node ${r.node}`,
    '',
    `- project root: ${codeSpan(r.project_root, 500)}`,
    `- ledger: ${codeSpan(r.ledger_path, 500)} (${r.ledger_exists ? 'exists' : 'not created yet'})`,
    `- GitHub auth: ${r.github_auth}${r.github_auth === 'none' ? ' (search 10/min, code search disabled)' : ''}`,
    `- offline: ${r.offline ? 'yes (cache only)' : 'no'}`,
    `- remote cache: ${remoteLine(r.remote_cache)}`,
    `- local cache: ${codeSpan(r.cache.path, 500)} (${r.cache.entries} entries, ${formatBytes(r.cache.bytes)})`,
    `- budget per component: ${r.budget.rounds_per_component} search rounds, ${r.budget.evals_per_component} evaluations, ${r.budget.web_per_component} web queries`,
    '',
    '| source | enabled | note |',
    '|---|---|---|',
  ];
  for (const a of r.adapters) {
    lines.push(`| ${a.source} | ${a.enabled ? 'yes' : 'no'} | ${mdCell(a.note ?? '')} |`);
  }
  if (r.rate_limits.length > 0) {
    lines.push('', '| rate limit | remaining | resets at |', '|---|---|---|');
    for (const s of r.rate_limits) {
      lines.push(`| ${mdCell(s.resource)} | ${s.remaining}/${s.limit} | ${new Date(s.reset_at).toISOString()} |`);
    }
  }
  lines.push(
    '',
    `cross-cutting checks: ${r.cross_cutting
      .map((c) => {
        const markets = (c.markets ?? []).map((m) => `${codeSpan(m.code, 8)} ${m.checked ? `checked (${m.evidence_count})` : 'not checked'}`);
        const state = c.checked ? `checked (${c.evidence_count})` : c.market_only === true ? 'not checked (only market-specific evidence)' : 'not checked';
        return `${c.concern} ${state}${markets.length > 0 ? ` [markets: ${markets.join(', ')}]` : ''}`;
      })
      .join(', ')}`,
  );
  if (r.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const w of r.warnings) lines.push(`- ${softLine(w)}`);
  }
  return lines.join('\n');
}

export const statusTool: ToolModule = {
  name: STATUS_TOOL_NAME,
  register(server, ctx) {
    server.registerTool(
      STATUS_TOOL_NAME,
      {
        title: 'recyclewheel status',
        description:
          'Preflight check: server version, GitHub auth source, offline mode, remote cache state, known rate limits, which search sources are enabled, search budget, and the ledger location. Call this first, before rw_decompose. No arguments are required.',
        inputSchema: InputShape,
        outputSchema: StatusReportSchema.shape,
        // Not open-world: it never contacts a third-party service (only the user's own remote cache, if configured).
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          const projectRoot = resolveProjectRoot(ctx.config, args.project_root);
          const report = await collectStatus(ctx as StatusContext, { projectRoot });
          return okResult(statusMarkdown(report), report);
        } catch (err) {
          return errorResult(`rw_status failed: ${errorMessage(err)}`);
        }
      },
    );
  },
};
