/**
 * `rw_ledger` (docs/PLAN.md §7.7): read or export the decision ledger as JSON,
 * a Markdown Reuse Report, or a THIRD_PARTY_NOTICES draft.
 *
 * `exportLedger` is the shared implementation: the tool and
 * `recyclewheel ledger export` both call it, so path containment and the
 * overwrite guard behave the same everywhere.
 *
 * write_to rules: the target must stay inside the project root (symlinks
 * included), must not touch `.recyclewheel/`, hidden entries, agent
 * configuration files or folders (the rules run on the spelled path and on the
 * real path behind any link), and an existing file is replaced
 * only when it is itself a recyclewheel export of the same format. A
 * hand-written THIRD_PARTY_NOTICES.md is therefore never overwritten.
 */
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { concernCoverage, concernWarnings } from '../../core/concerns.js';
import type { MarketCoverage } from '../../core/concerns.js';
import {
  EXPORT_JSON_KEY,
  EXPORT_MARKER_MD,
  LEDGER_DIR,
  renderMarkdown,
  renderNotices,
  summarize,
  truncateContent,
} from '../../core/ledger.js';
import type { Ledger, LedgerSummary } from '../../core/ledger.js';
import { codeSpan, wrapUntrusted } from '../../core/sanitize.js';
import { serviceWarnings } from '../../core/service-terms.js';

import { ProjectRootError, isPathInside, realpathOfNearest, resolveProjectRoot } from '../../doctor.js';
import { ConcernSchema } from '../../types.js';
import type { Concern, LedgerHandle, LedgerState, ToolModule } from '../../types.js';
import { errorMessage, errorResult, okResult } from '../result.js';

export const LEDGER_TOOL_NAME = 'rw_ledger';

export const LedgerFormatSchema = z.enum(['json', 'markdown', 'notices']);
export type LedgerFormat = z.infer<typeof LedgerFormatSchema>;

/** Response content cap (PLAN §7.7). The written file is never truncated. */
export const MAX_CONTENT_BYTES = 50 * 1024;

const MARKDOWN_HEADER = '# Reuse Report';
const NOTICES_HEADER = '# Third-Party Notices (draft)';

const InputShape = {
  action: z
    .enum(['get', 'export'])
    .describe("'get' returns the ledger content; 'export' does the same and may also write it to a file with write_to."),
  format: LedgerFormatSchema.optional().describe("Output format. Default 'markdown' (Reuse Report). 'notices' drafts THIRD_PARTY_NOTICES."),
  component_id: z.string().optional().describe('Restrict the output to one component.'),
  write_to: z
    .string()
    .optional()
    .describe(
      "Export only: file path relative to the project root, ending in .md or .json, e.g. 'docs/REUSE.md'. Rejected: paths outside the root, hidden folders or files (.claude, .git, .github, ...), CLAUDE.md/AGENTS.md/GEMINI.md/SKILL.md and similar agent files, folders named commands, agents, skills or hooks, and names with ':' or '~1'. Links inside the project are judged by where they lead.",
    ),
  project_root: z
    .string()
    .optional()
    .describe('Project directory inside the server project root (RECYCLEWHEEL_PROJECT_ROOT or the server working directory). Defaults to that root; other locations are rejected.'),
};

const SummaryShape = z.object({
  components: z.number(),
  decided: z.number(),
  by_decision: z.object({
    adopt: z.number(),
    extend: z.number(),
    reference: z.number(),
    build: z.number(),
  }),
  undecided: z.array(z.string()),
});

const OutputShape = {
  format: LedgerFormatSchema,
  content: z.string().describe('Rendered ledger, at most 50KB; see truncated.'),
  truncated: z.boolean(),
  path: z.string().optional().describe('Absolute path of the file written by write_to.'),
  summary: SummaryShape,
  warnings: z
    .array(z.string())
    .optional()
    .describe('Ledger lines that were skipped because they were corrupt, and cross-cutting concerns without evidence once a decision exists.'),
  cross_cutting: z
    .array(
      z.object({
        concern: ConcernSchema,
        checked: z.boolean(),
        evidence_count: z.number().int(),
        markets: z.array(z.object({ code: z.string(), checked: z.boolean(), evidence_count: z.number().int() })).optional(),
        market_only: z.boolean().optional(),
      }),
    )
    .optional()
    .describe('Evidence coverage of the cross-cutting concerns (legal_privacy also per target market); absent when the output is scoped to one component.'),
};

// ---------------------------------------------------------------------------
// Shared implementation
// ---------------------------------------------------------------------------

export type ExportFailure = { ok: false; error: string };

export interface LedgerExportRequest {
  ledger: LedgerHandle;
  projectRoot: string;
  format: LedgerFormat;
  componentId?: string;
  /** Path relative to `projectRoot`. */
  writeTo?: string;
}

export interface LedgerExportResult {
  ok: true;
  format: LedgerFormat;
  /** Full content; callers truncate for responses. */
  content: string;
  summary: LedgerSummary;
  /** Absolute path of the written file, when `writeTo` was given. */
  writtenTo?: string;
  warnings: string[];
  /** `cross-cutting concern not checked: <concern>` entries; empty when scoped to one component or no decision exists. */
  concernWarnings: string[];
  /** Decided adopt/extend candidates used through a client whose hosted service has no confirmed terms. */
  serviceWarnings: string[];
  /** Evidence coverage per cross-cutting concern; `undefined` when scoped to one component. */
  crossCutting?: Array<{ concern: Concern; checked: boolean; evidence_count: number; markets?: MarketCoverage[]; market_only?: boolean }>;
}

function scopeState(state: LedgerState, componentId: string): LedgerState {
  const own = <T extends { component_id: string }>(list: T[]): T[] => list.filter((x) => x.component_id === componentId);
  return {
    ...(state.project ? { project: state.project } : {}),
    components: state.components.filter((c) => c.id === componentId),
    evidence: own(state.evidence),
    evaluations: own(state.evaluations),
    decisions: own(state.decisions),
    history: own(state.history),
  };
}

function render(state: LedgerState, format: LedgerFormat, componentId: string | undefined): string {
  switch (format) {
    case 'markdown':
      return renderMarkdown(state, componentId !== undefined ? { componentId } : {});
    case 'notices':
      return renderNotices(state, componentId !== undefined ? { componentId } : {});
    case 'json':
      // The marker is the first key so `isOwnExport` can find it in the head of the file.
      return `${JSON.stringify(
        { [EXPORT_JSON_KEY]: 1, ...state, ...(componentId === undefined ? { cross_cutting: concernCoverage(state) } : {}) },
        null,
        2,
      )}\n`;
  }
}

function readHead(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8').replace(/^﻿/, '');
  } finally {
    closeSync(fd);
  }
}

const JSON_MARKER_RE = new RegExp(`^\\s*\\{\\s*"${EXPORT_JSON_KEY}"\\s*:\\s*1\\s*[,}]`);

/**
 * True only for files carrying the explicit export marker (see
 * `EXPORT_MARKER_MD` / `EXPORT_JSON_KEY`): Markdown exports start with the
 * marker comment followed by the format's own header, JSON exports have
 * `"recyclewheel_export": 1` as their first key. Files without a marker
 * (including exports from older versions) are never overwritten.
 */
export function isOwnExport(head: string, format: LedgerFormat): boolean {
  switch (format) {
    case 'markdown':
    case 'notices': {
      const [first, second] = head.split(/\r?\n/);
      return first?.trim() === EXPORT_MARKER_MD && second?.trim() === (format === 'markdown' ? MARKDOWN_HEADER : NOTICES_HEADER);
    }
    case 'json':
      return JSON_MARKER_RE.test(head);
  }
}

/** Only these file types can be written; a ledger export is never an executable or a config file. */
export const ALLOWED_WRITE_EXTENSIONS: readonly string[] = ['.md', '.json'];
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** True for a Windows device name as a path segment; the part before the first dot decides (`nul.x.md`, `con.txt.md`). */
export function isWindowsDeviceName(segment: string): boolean {
  return WINDOWS_DEVICE_NAME.test((segment.split('.')[0] ?? '').replace(/ +$/, ''));
}

/**
 * Files that configure coding agents or editors; a ledger export must never
 * create or replace one (L-C). Compared case-insensitively against the file name.
 */
const AGENT_CONFIG_NAMES: ReadonlySet<string> = new Set([
  'claude.md',
  'claude.local.md',
  'agents.md',
  'agent.md',
  'gemini.md',
  'qwen.md',
  'warp.md',
  'skill.md',
  '.cursorrules',
  '.windsurfrules',
  'copilot-instructions.md',
]);

/**
 * Directory names under which coding agents look for commands, sub-agents,
 * skills and hooks; nothing is written into a folder of this name (case-insensitive).
 */
const AGENT_CONFIG_DIRS: ReadonlySet<string> = new Set(['commands', 'agents', 'skills', 'hooks', '.claude']);

/** Segments Windows resolves differently from their spelling: streams (`:`), 8.3 short names (`~1`), trailing dots/spaces. */
const SPECIAL_SEGMENT = /[:]|~\d|[. ]$/;

/**
 * The segment rules of `write_to`, applied to the spelled path and again to the
 * real path (links resolved) relative to the project root, so a link inside the
 * root cannot lead a write into a place the spelling would not be allowed to name.
 * Returns the error message, or `undefined` when every segment is fine.
 */
function segmentProblem(writeTo: string, segments: readonly string[], realRel: string | undefined): string | undefined {
  const shown = codeSpan(writeTo, 200);
  const via = realRel !== undefined ? ` The path reaches ${codeSpan(realRel, 200)} through a link.` : '';
  const special = segments.find((s) => SPECIAL_SEGMENT.test(s));
  if (special !== undefined) {
    return `write_to ${shown} has a path segment (${codeSpan(special, 64)}) that Windows resolves differently from how it is spelled (':' streams, '~1' short names, trailing dot or space). Use plain folder and file names such as 'docs/REUSE.md'.${via}`;
  }
  const ledgerDir = segments.find((s) => s.toLowerCase() === LEDGER_DIR);
  if (ledgerDir !== undefined) {
    return `write_to ${shown} must not point into ${LEDGER_DIR}/ (that directory holds the ledger itself). Use e.g. 'docs/REUSE.md'.${via}`;
  }
  const hidden = segments.find((s) => s.startsWith('.'));
  if (hidden !== undefined) {
    return `write_to ${shown} goes into or creates the hidden entry ${codeSpan(hidden, 64)}. Hidden folders and files (.claude, .git, .github, .vscode, .cursor, .idea, ...) hold agent, editor and repository configuration and are never written. Use a visible path such as 'docs/REUSE.md'.${via}`;
  }
  const dir = segments.slice(0, -1).find((s) => AGENT_CONFIG_DIRS.has(s.toLowerCase()));
  if (dir !== undefined) {
    return `write_to ${shown} goes into a folder named ${codeSpan(dir, 64)}, where coding agents load commands, sub-agents, skills or hooks; a ledger export must not be placed there. Use a path such as 'docs/REUSE.md'.${via}`;
  }
  const name = segments[segments.length - 1] ?? '';
  if (AGENT_CONFIG_NAMES.has(name.toLowerCase())) {
    return `write_to ${shown} names an agent instruction file (${codeSpan(name, 64)}); a ledger export must not create or replace one. Use a different file name such as 'docs/REUSE.md'.${via}`;
  }
  if (process.platform === 'win32' && segments.some(isWindowsDeviceName)) {
    return `write_to ${shown} names a Windows device; choose another file name such as 'docs/REUSE.md'.${via}`;
  }
  return undefined;
}

function splitSegments(rel: string): string[] {
  return rel.split(/[\\/]+/).filter((s) => s !== '');
}

/** Validates `writeTo` and returns the absolute target, or an actionable error. */
export function resolveWriteTarget(
  projectRoot: string,
  writeTo: string,
  format: LedgerFormat,
): { ok: true; target: string } | ExportFailure {
  const raw = writeTo.trim();
  if (raw === '' || raw.includes('\0')) {
    return { ok: false, error: "write_to must be a non-empty file path relative to the project root, e.g. 'docs/REUSE.md'." };
  }
  const shown = codeSpan(writeTo, 200);
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, raw);
  const outside = `write_to ${shown} resolves outside the project root (${codeSpan(root, 500)}). Use a path inside the project, e.g. 'docs/REUSE.md'.`;
  if (!isPathInside(root, target) || target === root) {
    return { ok: false, error: outside };
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, error: `Project root ${codeSpan(root, 500)} does not exist; pass project_root pointing at the project directory.` };
  }
  // Symlinks and junctions: judge the real location of the nearest existing ancestor.
  let realTarget: string;
  let realRel: string;
  let ledgerDirs: string[];
  try {
    const realRoot = realpathOfNearest(root);
    realTarget = realpathOfNearest(target);
    if (!isPathInside(realRoot, realTarget)) return { ok: false, error: outside };
    realRel = path.relative(realRoot, realTarget);
    // The ledger directory by spelling and by its real location (8.3 names, aliases, links into it).
    ledgerDirs = [path.join(root, LEDGER_DIR), path.join(realRoot, LEDGER_DIR), realpathOfNearest(path.join(root, LEDGER_DIR))];
  } catch {
    return { ok: false, error: outside };
  }
  if (ledgerDirs.some((dir) => isPathInside(dir, target) || isPathInside(dir, realTarget))) {
    return {
      ok: false,
      error: `write_to must not point into ${LEDGER_DIR}/ (that directory holds the ledger itself). Use e.g. 'docs/REUSE.md'.`,
    };
  }
  const ext = path.extname(target).toLowerCase();
  if (!ALLOWED_WRITE_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      error: `write_to ${shown} must end in ${ALLOWED_WRITE_EXTENSIONS.join(' or ')} (got ${ext === '' ? 'no extension' : codeSpan(ext, 32)}). Use e.g. 'docs/REUSE.md'.`,
    };
  }
  const segments = splitSegments(path.relative(root, target));
  const spelled = segmentProblem(writeTo, segments, undefined);
  if (spelled !== undefined) return { ok: false, error: spelled };
  // The same rules on the real location: a link inside the root may point at .claude, commands/, ...
  const realSegments = splitSegments(realRel);
  if (realSegments.join('/').toLowerCase() !== segments.join('/').toLowerCase()) {
    const resolved = segmentProblem(writeTo, realSegments, realSegments.join('/'));
    if (resolved !== undefined) return { ok: false, error: resolved };
  }
  if (existsSync(target)) {
    if (statSync(target).isDirectory()) {
      return { ok: false, error: `write_to ${shown} is a directory; give a file path such as ${codeSpan(path.posix.join(writeTo, 'REUSE.md'), 200)}.` };
    }
    if (!isOwnExport(readHead(target, 4096), format)) {
      const hint =
        format === 'notices'
          ? "Call rw_ledger without write_to and merge the output into the existing file manually, write to a new path such as 'docs/THIRD_PARTY_NOTICES.draft.md', or delete the existing file yourself to let recyclewheel create it."
          : "Write to a different path (for example 'docs/REUSE.md'), or delete the existing file yourself to let recyclewheel create it.";
      return {
        ok: false,
        error: `write_to ${shown} already exists and does not carry the recyclewheel export marker (files from older versions have none), so it is not overwritten. ${hint}`,
      };
    }
  }
  return { ok: true, target };
}

export function exportLedger(req: LedgerExportRequest): LedgerExportResult | ExportFailure {
  let target: string | undefined;
  if (req.writeTo !== undefined) {
    const resolved = resolveWriteTarget(req.projectRoot, req.writeTo, req.format);
    if (!resolved.ok) return resolved;
    target = resolved.target;
  }

  const detailed = (req.ledger as Partial<Ledger>).readDetailed?.();
  const full = detailed ? detailed.state : req.ledger.read();
  const warnings = detailed?.warnings ?? [];

  let state = full;
  if (req.componentId !== undefined) {
    if (!full.components.some((c) => c.id === req.componentId)) {
      const known = full.components.map((c) => c.id);
      return {
        ok: false,
        error: `component_id ${codeSpan(req.componentId, 64)} is not in the ledger. ${
          known.length > 0 ? `Known ids: ${known.map((id) => codeSpan(id, 64)).join(', ')}.` : 'The ledger has no components yet; call rw_decompose first.'
        }`,
      };
    }
    state = scopeState(full, req.componentId);
  }

  const content = render(state, req.format, req.componentId);
  const result: LedgerExportResult = {
    ok: true,
    format: req.format,
    content,
    summary: summarize(state),
    warnings,
    concernWarnings: req.componentId === undefined ? concernWarnings(full) : [],
    serviceWarnings: serviceWarnings(state),
  };
  if (req.componentId === undefined) {
    result.crossCutting = concernCoverage(full).map((c) => ({
      concern: c.concern,
      checked: c.checked,
      evidence_count: c.evidence_ids.length,
      ...(c.markets !== undefined ? { markets: c.markets } : {}),
      ...(c.market_only === true ? { market_only: true } : {}),
    }));
  }
  if (target !== undefined) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    result.writtenTo = target;
  }
  return result;
}

function summaryLine(s: LedgerSummary): string {
  const d = s.by_decision;
  const undecided = s.undecided.length > 0 ? `, undecided: ${s.undecided.join(', ')}` : '';
  return `components: ${s.components}, decided: ${s.decided} (adopt ${d.adopt}, extend ${d.extend}, reference ${d.reference}, build ${d.build})${undecided}`;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const ledgerTool: ToolModule = {
  name: LEDGER_TOOL_NAME,
  register(server, ctx) {
    server.registerTool(
      LEDGER_TOOL_NAME,
      {
        title: 'recyclewheel ledger',
        description:
          "Read or export the reuse-decision ledger. format 'markdown' is the Reuse Report table, 'notices' drafts THIRD_PARTY_NOTICES, 'json' is the raw state (fenced as untrusted data in the text result). With action 'export' and write_to the content is also saved inside the project (an existing hand-written file is never overwritten). Output over 50KB is truncated in the response only.",
        inputSchema: InputShape,
        outputSchema: OutputShape,
        // write_to creates files, so this is not read-only; it never deletes or overwrites foreign files.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          const format: LedgerFormat = args.format ?? 'markdown';
          if (args.write_to !== undefined && args.action !== 'export') {
            return errorResult("write_to is only valid with action 'export'. Call rw_ledger again with action: 'export'.");
          }
          const projectRoot = resolveProjectRoot(ctx.config, args.project_root);
          const result = exportLedger({
            ledger: ctx.ledger(projectRoot),
            projectRoot,
            format,
            ...(args.component_id !== undefined ? { componentId: args.component_id } : {}),
            ...(args.write_to !== undefined ? { writeTo: args.write_to } : {}),
          });
          if (!result.ok) return errorResult(result.error);

          const cut = truncateContent(result.content, MAX_CONTENT_BYTES);
          const structured: Record<string, unknown> = {
            format,
            content: cut.content,
            truncated: cut.truncated,
            summary: result.summary,
          };
          if (result.writtenTo !== undefined) structured.path = result.writtenTo;
          const allWarnings = [...result.warnings, ...result.concernWarnings, ...result.serviceWarnings];
          if (allWarnings.length > 0) structured.warnings = allWarnings;
          if (result.crossCutting !== undefined) structured.cross_cutting = result.crossCutting;

          const lines: string[] = [];
          if (result.writtenTo !== undefined) {
            lines.push(`Wrote ${format} export to ${codeSpan(result.writtenTo, 500)} (${Buffer.byteLength(result.content, 'utf8')} bytes).`);
            lines.push(`Summary: ${summaryLine(result.summary)}`);
          } else {
            const body = cut.content.replace(/\n+$/, '');
            // Every format carries ledger text (names, rationales, licenses): fence it as untrusted data.
            // The renderers escape Markdown on top of that; the written file stays the plain export.
            lines.push(...wrapUntrusted(body.split('\n')));
            if (cut.truncated) lines.push('', `_Output truncated at ${MAX_CONTENT_BYTES / 1024}KB. Use component_id or write_to to get the rest._`);
            lines.push('', `Summary: ${summaryLine(result.summary)}`);
          }
          if (result.warnings.length > 0) {
            lines.push('', `Skipped corrupt ledger lines: ${result.warnings.length}`);
          }
          for (const w of result.concernWarnings) lines.push('', `Warning: ${w}`);
          for (const w of result.serviceWarnings) lines.push('', `Warning: ${w}`);

          return okResult(lines.join('\n'), structured);
        } catch (err) {
          if (err instanceof ProjectRootError) return errorResult(err.message);
          return errorResult(`rw_ledger failed: ${errorMessage(err)}`);
        }
      },
    );
  },
};
