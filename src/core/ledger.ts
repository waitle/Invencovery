/**
 * Reuse ledger (docs/PLAN.md §11): an append-only JSONL event log under
 * `<project_root>/.recyclewheel/ledger.jsonl`, a tolerant parser, a reducer that
 * replays events into `LedgerState`, decision validation (§7.6) and the
 * Reuse Report / THIRD_PARTY_NOTICES renderers (§7.7).
 *
 * Nothing here writes to stdout (the MCP stdio channel). Time-dependent
 * helpers take `now` as an argument.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { LEDGER_SUMMARY_MAX, LEDGER_TEXT_MAX, LedgerEventSchema, newId, parseRef } from '../types.js';
import { concernCoverage } from './concerns.js';
import { codeSpan, cut, escapeMd, hasUnsafeChars, softLine, stripUnsafe } from './sanitize.js';
import { serviceTermsGaps, serviceUsageGaps } from './service-terms.js';

// Kept here for existing importers; the implementations live in core/sanitize.ts.
export { escapeMd, stripUnsafe };
import type {
  BuildReason,
  Component,
  Decision,
  DecisionKind,
  Evaluation,
  Evidence,
  LedgerEvent,
  LedgerHandle,
  LedgerState,
  ProjectInfo,
} from '../types.js';

export const LEDGER_DIR = '.recyclewheel';
export const LEDGER_FILE = 'ledger.jsonl';
/** A ledger line (without the trailing newline) is kept at or below this many bytes. */
export const MAX_LINE_BYTES = 64 * 1024;

/** A line longer than this (bytes) is skipped on load, not parsed: a hostile file cannot make us parse megabytes per line. */
export const MAX_LOAD_LINE_BYTES = 256 * 1024;
/** A ledger file larger than this is refused on read; real ledgers are a few KB to a few MB. */
export const MAX_LEDGER_FILE_BYTES = 64 * 1024 * 1024;

const STRING_CAP = LEDGER_TEXT_MAX;
const RESULT_REFS_CAP = 200;

export function ledgerPath(projectRoot: string): string {
  return path.join(projectRoot, LEDGER_DIR, LEDGER_FILE);
}

// ---------------------------------------------------------------------------
// Link and containment guard (security review N-1)
// ---------------------------------------------------------------------------

/** Raised when `<root>/.recyclewheel` or `ledger.jsonl` is a link or resolves outside the project root. */
export class LedgerPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerPathError';
  }
}

/** O_NOFOLLOW where the platform has it (not on Windows, where lstat checks alone apply). */
const NOFOLLOW: number = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
/**
 * Append handle: read-write (the last byte is checked for a torn line through the
 * same handle), append-only writes, created owner-only, never through a final-component link.
 */
const APPEND_FLAGS: number = fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | NOFOLLOW;
const READ_FLAGS: number = fsConstants.O_RDONLY | NOFOLLOW;

function sameFsPath(a: string, b: string): boolean {
  const key = (p: string): string => (process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase());
  return key(a) === key(b);
}

function lstatIfExists(p: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(p, { throwIfNoEntry: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
}

/**
 * Describes why the ledger location of `projectRoot` must not be used, or
 * `undefined` when it is fine or does not exist yet. Rejected: `.recyclewheel`
 * or `ledger.jsonl` being a symbolic link or Windows junction, not a regular
 * directory/file, or resolving (by `realpath`) to anywhere but its own place
 * under the real project root.
 */
export function ledgerPathProblem(projectRoot: string): string | undefined {
  const root = path.resolve(projectRoot);
  const dir = path.join(root, LEDGER_DIR);
  const dirStat = lstatIfExists(dir);
  if (dirStat === undefined) return undefined;
  if (dirStat.isSymbolicLink()) return `${LEDGER_DIR} is a symbolic link or junction`;
  if (!dirStat.isDirectory()) return `${LEDGER_DIR} exists but is not a directory`;
  const realDir = realpathSync.native(dir);
  if (!sameFsPath(realDir, path.join(realpathSync.native(root), LEDGER_DIR))) {
    return `${LEDGER_DIR} resolves to ${realDir}, which is not inside the project root`;
  }
  const file = path.join(dir, LEDGER_FILE);
  const fileStat = lstatIfExists(file);
  if (fileStat === undefined) return undefined;
  if (fileStat.isSymbolicLink()) return `${LEDGER_FILE} is a symbolic link`;
  if (!fileStat.isFile()) return `${LEDGER_FILE} is not a regular file`;
  if (fileStat.nlink > 1) return `${LEDGER_FILE} has ${fileStat.nlink} hard links (it must be the only name of its file)`;
  const realFile = realpathSync.native(file);
  if (!sameFsPath(realFile, path.join(realDir, LEDGER_FILE))) {
    return `${LEDGER_FILE} resolves to ${realFile}, which is not inside ${LEDGER_DIR}`;
  }
  return undefined;
}

function refuseLedger(projectRoot: string, problem: string): never {
  throw new LedgerPathError(
    `Refusing to use the ledger under ${path.resolve(projectRoot)}: ${problem}. ${LEDGER_DIR}/ and ${LEDGER_FILE} must be a regular directory and file inside the project root, not links (symbolic, junction or hard); remove the link and retry.`,
  );
}

function assertLedgerPath(projectRoot: string): void {
  const problem = ledgerPathProblem(projectRoot);
  if (problem !== undefined) refuseLedger(projectRoot, problem);
}

/**
 * Checks the file that was actually opened (`fd`), not the path it was opened
 * by, so a swap after the path checks cannot slip through: it must be a regular
 * file with a single name (a hard link would make appends hit a file elsewhere),
 * and, where inode numbers are reliable (not Windows), the same file that the
 * ledger path resolves to now. Throws `LedgerPathError`; the caller closes `fd`.
 */
function assertOpenedLedger(projectRoot: string, fd: number, file: string): Stats {
  const opened = fstatSync(fd);
  if (!opened.isFile()) refuseLedger(projectRoot, `${LEDGER_FILE} is not a regular file`);
  if (opened.nlink > 1) {
    refuseLedger(projectRoot, `${LEDGER_FILE} has ${opened.nlink} hard links (it must be the only name of its file)`);
  }
  if (process.platform !== 'win32') {
    const named = statSync(realpathSync.native(file));
    if (named.dev !== opened.dev || named.ino !== opened.ino) {
      refuseLedger(projectRoot, `${LEDGER_FILE} was replaced while it was being opened`);
    }
  }
  return opened;
}

// ---------------------------------------------------------------------------
// Strict field rules (security review N-2)
// ---------------------------------------------------------------------------

/** Component ids are slugs; they are echoed in tool output, so the shape is fixed. */
export const COMPONENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Evidence of `rw_search` without a component is filed under this pseudo id. */
const UNSCOPED_ID = '_unscoped';

function badId(id: string, allowUnscoped: boolean): boolean {
  return !COMPONENT_ID_PATTERN.test(id) && !(allowUnscoped && id === UNSCOPED_ID);
}

/**
 * Rules the schema cannot express: component ids match `COMPONENT_ID_PATTERN`,
 * component names and candidate refs hold no control, invisible or line-break
 * characters. Returns the offending field path, or `undefined` when the event
 * is fine. Applied on write (`serializeEvent`) and on load (`parseLedgerText`),
 * so a hand-edited or hostile `ledger.jsonl` cannot smuggle such strings into
 * tool output; the offending line is skipped like any corrupt line.
 */
export function strictEventProblem(e: LedgerEvent): string | undefined {
  const badRef = (ref: string | undefined): boolean => ref !== undefined && hasUnsafeChars(ref);
  switch (e.type) {
    case 'project.set':
      return undefined;
    case 'component.upsert':
      if (badId(e.component.id, false)) return 'component.id';
      if (e.component.parent_id !== undefined && badId(e.component.parent_id, false)) return 'component.parent_id';
      if (hasUnsafeChars(e.component.name)) return 'component.name';
      return undefined;
    case 'evidence.add':
      if (badId(e.evidence.component_id, true)) return 'evidence.component_id';
      if (e.evidence.result_refs.some(badRef)) return 'evidence.result_refs';
      // A market says which country a concern evidence covers; without a concern it means nothing.
      if (e.evidence.market !== undefined && e.evidence.concern === undefined) return 'evidence.market';
      return undefined;
    case 'evaluation.add':
      if (badId(e.evaluation.component_id, true)) return 'evaluation.component_id';
      if (badRef(e.evaluation.ref)) return 'evaluation.ref';
      // A service link is the ref of a hosted service, and a candidate is either linked or exempt, never both.
      if (e.evaluation.service_ref !== undefined) {
        if (badRef(e.evaluation.service_ref) || parseRef(e.evaluation.service_ref)?.scheme !== 'saas') return 'evaluation.service_ref';
        if (e.evaluation.no_service_reason !== undefined) return 'evaluation.no_service_reason';
      }
      return undefined;
    case 'decision.add':
      if (badId(e.decision.component_id, false)) return 'decision.component_id';
      if (badRef(e.decision.ref)) return 'decision.ref';
      if (e.decision.alternatives.some((a) => badRef(a.ref))) return 'decision.alternatives';
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function lineBytes(line: string): number {
  return Buffer.byteLength(line, 'utf8');
}

function capString(value: string, cap: number): string {
  return value.length > cap ? `${value.slice(0, cap - 1)}…` : value;
}

function capStrings(value: unknown): unknown {
  if (typeof value === 'string') return capString(value, STRING_CAP);
  if (Array.isArray(value)) return value.map(capStrings);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = capStrings(v);
    return out;
  }
  return value;
}

/**
 * Free text longer than the schema allows (`LEDGER_TEXT_MAX`, evidence summaries
 * `LEDGER_SUMMARY_MAX`) is shortened with an ellipsis on write instead of being
 * rejected; the same limits are enforced as a schema rule when the ledger is loaded.
 */
function clampEventText(event: LedgerEvent): LedgerEvent {
  const capped = capStrings(event) as LedgerEvent;
  if (event.type === 'evidence.add' && capped.type === 'evidence.add') {
    capped.evidence.summary = capString(event.evidence.summary, LEDGER_SUMMARY_MAX);
  }
  return capped;
}

/**
 * Validates `event` and returns its single JSON line (no newline). Lines above
 * `MAX_LINE_BYTES` are shrunk: evidence results are trimmed first, then long
 * strings are capped. Throws on an invalid event or one that cannot be shrunk.
 */
export function serializeEvent(event: LedgerEvent): string {
  const parsed = LedgerEventSchema.parse(clampEventText(event));
  // A component name is one line of plain text; fold stray line breaks and hidden characters on write.
  const valid: LedgerEvent =
    parsed.type === 'component.upsert'
      ? { ...parsed, component: { ...parsed.component, name: stripUnsafe(parsed.component.name) || parsed.component.id } }
      : parsed;
  const problem = strictEventProblem(valid);
  if (problem !== undefined) throw new Error(`Ledger event ${valid.type} rejected: invalid ${problem}.`);
  let line = JSON.stringify(valid);
  if (lineBytes(line) <= MAX_LINE_BYTES) return line;

  let current: LedgerEvent = valid;
  if (current.type === 'evidence.add') {
    // Step 1: shorten per-result free text, then drop results from the end.
    const ev: Evidence = { ...current.evidence };
    if (ev.results) {
      ev.results = ev.results.map((r) => ({
        url: r.url,
        ...(r.title !== undefined ? { title: r.title.slice(0, 120) } : {}),
        ...(r.note !== undefined ? { note: r.note.slice(0, 120) } : {}),
      }));
    }
    current = { ...current, evidence: ev };
    line = JSON.stringify(current);
    while (lineBytes(line) > MAX_LINE_BYTES && ev.results && ev.results.length > 0) {
      ev.results = ev.results.slice(0, Math.floor(ev.results.length / 2));
      line = JSON.stringify(current);
    }
  }
  if (lineBytes(line) <= MAX_LINE_BYTES) return line;

  // Step 2: cap every long string and the result_refs list.
  const capped = capStrings(current) as LedgerEvent;
  if (capped.type === 'evidence.add' && capped.evidence.result_refs.length > RESULT_REFS_CAP) {
    capped.evidence.result_refs = capped.evidence.result_refs.slice(0, RESULT_REFS_CAP);
  }
  line = JSON.stringify(capped);
  if (lineBytes(line) > MAX_LINE_BYTES) {
    throw new Error(`Ledger event ${capped.type} exceeds ${MAX_LINE_BYTES} bytes even after truncation.`);
  }
  return line;
}

// ---------------------------------------------------------------------------
// Parsing and reduction
// ---------------------------------------------------------------------------

/**
 * Parses JSONL text line by line. Blank lines are ignored; corrupt lines (bad
 * JSON, unknown event type, schema violation, a line over `MAX_LOAD_LINE_BYTES`)
 * are skipped with a warning.
 */
export function parseLedgerText(text: string): { events: LedgerEvent[]; warnings: string[] } {
  const events: LedgerEvent[] = [];
  const warnings: string[] = [];
  const lines = text.replace(/^﻿/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? '').trim();
    if (raw === '') continue;
    if (raw.length > MAX_LOAD_LINE_BYTES || lineBytes(raw) > MAX_LOAD_LINE_BYTES) {
      warnings.push(`ledger line ${i + 1} skipped: too long`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      warnings.push(`ledger line ${i + 1} skipped: not valid JSON`);
      continue;
    }
    const parsed = LedgerEventSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
      warnings.push(`ledger line ${i + 1} skipped: not a valid ledger event${where}`);
      continue;
    }
    const problem = strictEventProblem(parsed.data);
    if (problem !== undefined) {
      warnings.push(`ledger line ${i + 1} skipped: not a valid ledger event at ${problem}`);
      continue;
    }
    events.push(parsed.data);
  }
  return { events, warnings };
}

/**
 * Replays events in file order. Components upsert by id, evidence by id,
 * evaluations by (component_id, ref), and the newest decision per component
 * wins (earlier ones go to `history`). A repeated decision id is ignored so
 * duplicated lines from a git merge do not pollute history.
 *
 * Component status is derived: a component with a decision is `decided`, and a
 * `pending` component that has evidence is `searching`.
 */
export function reduceEvents(events: readonly LedgerEvent[]): LedgerState {
  let project: ProjectInfo | undefined;
  const components = new Map<string, Component>();
  const evidence = new Map<string, Evidence>();
  const evaluations = new Map<string, Evaluation>();
  const decisions = new Map<string, Decision>();
  const history: Decision[] = [];
  const seenDecisionIds = new Set<string>();

  for (const e of events) {
    switch (e.type) {
      case 'project.set':
        project = e.project;
        break;
      case 'component.upsert':
        components.set(e.component.id, e.component);
        break;
      case 'evidence.add':
        evidence.set(e.evidence.id, e.evidence);
        break;
      case 'evaluation.add':
        evaluations.set(`${e.evaluation.component_id}\u0000${e.evaluation.ref}`, e.evaluation);
        break;
      case 'decision.add': {
        const d = e.decision;
        if (seenDecisionIds.has(d.id)) break;
        seenDecisionIds.add(d.id);
        const previous = decisions.get(d.component_id);
        if (previous) history.push(previous);
        decisions.set(d.component_id, d);
        break;
      }
    }
  }

  const evidenceComponents = new Set<string>();
  for (const ev of evidence.values()) evidenceComponents.add(ev.component_id);

  const derived = [...components.values()].map((c): Component => {
    if (decisions.has(c.id)) return { ...c, status: 'decided' };
    if (c.status === 'pending' && evidenceComponents.has(c.id)) return { ...c, status: 'searching' };
    return c;
  });

  return {
    ...(project ? { project } : {}),
    components: derived,
    evidence: [...evidence.values()],
    evaluations: [...evaluations.values()],
    decisions: [...decisions.values()],
    history,
  };
}

// ---------------------------------------------------------------------------
// File-backed ledger
// ---------------------------------------------------------------------------

export interface Ledger extends LedgerHandle {
  /** Like `read()`, but also returns the parsed events and parse warnings. */
  readDetailed(): { state: LedgerState; events: LedgerEvent[]; warnings: string[] };
}

/** True when the open file `fd` (of `size` bytes) is non-empty and does not end with a newline (torn last write). */
function endsWithoutNewline(fd: number, size: number): boolean {
  if (size === 0) return false;
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
}

/**
 * Opens (lazily) the ledger of `projectRoot`. The directory and file are
 * created on the first `append`; `read()` on a missing file yields an empty
 * state. Concurrent appenders are safe: each event is one `O_APPEND` write.
 *
 * Both directions work on the opened handle: after the path checks the file is
 * opened (`O_NOFOLLOW` where the platform has it), then `fstat` must show a
 * regular file with one name, and the path guard runs once more before the first
 * byte is read or written. What remains is a race on a directory component
 * (swapping `.recyclewheel` or a parent for a link between the last check and
 * the open), which no portable API closes.
 */
export function openLedger(projectRoot: string): Ledger {
  const file = ledgerPath(projectRoot);

  function readDetailed(): { state: LedgerState; events: LedgerEvent[]; warnings: string[] } {
    assertLedgerPath(projectRoot);
    let text: string;
    let fd: number;
    try {
      fd = openSync(file, READ_FLAGS);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: reduceEvents([]), events: [], warnings: [] };
      }
      throw err;
    }
    try {
      const opened = assertOpenedLedger(projectRoot, fd, file);
      assertLedgerPath(projectRoot);
      if (opened.size > MAX_LEDGER_FILE_BYTES) {
        throw new Error(
          `${LEDGER_FILE} is ${Math.round(opened.size / (1024 * 1024))} MB, over the ${MAX_LEDGER_FILE_BYTES / (1024 * 1024)} MB limit; archive or trim old events and retry.`,
        );
      }
      text = readFileSync(fd, { encoding: 'utf8' });
    } finally {
      closeSync(fd);
    }
    const { events, warnings } = parseLedgerText(text);
    return { state: reduceEvents(events), events, warnings };
  }

  return {
    path: file,
    append(event: LedgerEvent): void {
      const line = serializeEvent(event);
      // Links are refused before and after the directory is created (N-1).
      assertLedgerPath(projectRoot);
      // Owner-only on POSIX (the ledger can hold project notes); ignored on Windows.
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      assertLedgerPath(projectRoot);
      const fd = openSync(file, APPEND_FLAGS, 0o600);
      try {
        const opened = assertOpenedLedger(projectRoot, fd, file);
        assertLedgerPath(projectRoot);
        // A crash can leave the last line unterminated; start on a fresh line so
        // the new event is not glued to the corrupt one.
        const prefix = endsWithoutNewline(fd, opened.size) ? '\n' : '';
        writeAll(fd, Buffer.from(`${prefix}${line}\n`, 'utf8'));
      } finally {
        closeSync(fd);
      }
    },
    read(): LedgerState {
      return readDetailed().state;
    },
    readDetailed,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function findComponent(state: LedgerState, componentId: string): Component | undefined {
  return state.components.find((c) => c.id === componentId);
}

export function evidenceFor(state: LedgerState, componentId: string): Evidence[] {
  return state.evidence.filter((e) => e.component_id === componentId);
}

export function evaluationFor(state: LedgerState, componentId: string, ref: string): Evaluation | undefined {
  return state.evaluations.find((e) => e.component_id === componentId && e.ref === ref);
}

export function decisionFor(state: LedgerState, componentId: string): Decision | undefined {
  return state.decisions.find((d) => d.component_id === componentId);
}

export interface LedgerSummary {
  components: number;
  decided: number;
  by_decision: Record<DecisionKind, number>;
  /** Component ids that have no decision yet. */
  undecided: string[];
}

export function summarize(state: LedgerState): LedgerSummary {
  const by_decision: Record<DecisionKind, number> = { adopt: 0, extend: 0, reference: 0, build: 0 };
  const undecided: string[] = [];
  let decided = 0;
  for (const c of state.components) {
    const d = decisionFor(state, c.id);
    if (d) {
      decided++;
      by_decision[d.decision]++;
    } else {
      undecided.push(c.id);
    }
  }
  return { components: state.components.length, decided, by_decision, undecided };
}

/** Cuts `content` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateContent(
  content: string,
  maxBytes = 50 * 1024,
): { content: string; truncated: boolean } {
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= maxBytes) return { content, truncated: false };
  // Drop the half character at the cut (a trailing U+FFFD run); a loop, since `/�+$/` is quadratic on long runs.
  let cut = buf.subarray(0, maxBytes).toString('utf8');
  let end = cut.length;
  while (end > 0 && cut.charCodeAt(end - 1) === 0xfffd) end--;
  cut = cut.slice(0, end);
  return { content: cut, truncated: true };
}

// ---------------------------------------------------------------------------
// Decision validation (PLAN §7.6)
// ---------------------------------------------------------------------------

export interface DecisionInput {
  component_id: string;
  decision: DecisionKind;
  ref?: string;
  version?: string;
  rationale: string;
  build_reason?: BuildReason;
  alternatives?: Decision['alternatives'];
  attribution?: Decision['attribution'];
  /** Defaults to every evidence entry of the component. */
  evidence_ids?: string[];
  override?: { reason: string };
  decided_by?: 'agent' | 'user';
}

/**
 * Distinct evidence sources of a component: the union of `sources` over search
 * evidence, plus one pseudo-source each for `web` and `code_search` evidence.
 * Evidence recorded for a cross-cutting concern researched something other
 * than candidates, so it does not count.
 */
export function distinctEvidenceSources(evidence: readonly Evidence[]): string[] {
  const found = new Set<string>();
  for (const ev of evidence) {
    if (ev.concern !== undefined) continue;
    if (ev.kind === 'search') {
      for (const s of ev.sources ?? []) found.add(s);
    } else if (ev.kind === 'web') {
      found.add('web');
    } else if (ev.kind === 'code_search') {
      found.add('code_search');
    }
  }
  return [...found];
}

const MIN_OVERRIDE_REASON = 20;

/** A dynamic value inside a validation message: refs, ids and license obligations may come from the ledger or a third party. */
const v = (text: string): string => softLine(text, 200);
/** A component id or ref echoed in a validation message: a code span, cut to 64 or 200 characters. */
const idv = (text: string): string => codeSpan(text, 64);
const refv = (text: string): string => codeSpan(text, 200);

/**
 * SaaS rules of §7.6: adopt/extend of a hosted service needs pricing and data-use
 * terms that were read on the vendor's own pages and are backed by evidence in
 * the ledger. Each gap blocks the decision, unless the user decides.
 */
function validateSaas(
  state: LedgerState,
  input: DecisionInput,
  evaluation: Evaluation,
  violations: string[],
  warnings: string[],
  waived: string[],
): void {
  const ref = refv(evaluation.ref);
  const domains = evaluation.saas?.vendor_domains;
  const vendor = domains !== undefined && domains.length > 0 ? ` (${v(domains.join(', '))})` : '';
  const next = `Read the vendor's own page, then call rw_evaluate again with its URL as saas.pricing.source_url / saas.data_use.source_url (a page on the vendor domains${vendor}), or with an evidence_id from rw_record_evidence; or choose "reference".`;

  const gates: Array<[string, string]> = [
    [
      'saas_terms_unverified',
      `pricing or data-use terms of ${ref} are not verified (saas_terms_unverified); ${input.decision} needs both checked on the vendor pages. ${next}`,
    ],
    [
      'saas_evidence_missing',
      `the pricing or data-use terms of ${ref} cite no evidence that is in the ledger (saas_evidence_missing: no evidence_id, or an id that was never recorded); ${input.decision} needs it. ${next}`,
    ],
    [
      'saas_terms_secondhand',
      `the pricing or data-use terms of ${ref} rest only on pages outside the vendor domains (saas_terms_secondhand), for example a reseller or comparison page; ${input.decision} needs the vendor's own page. ${next}`,
    ],
  ];
  for (const [flag, message] of gates) {
    if (!evaluation.flags.includes(flag)) continue;
    if (input.decided_by === 'user') {
      warnings.push(`${message} Proceeding because decided_by is "user".`);
      waived.push(flag);
    } else violations.push(message);
  }
  if (evaluation.flags.includes('saas_trains_on_data')) {
    warnings.push(`the vendor of ${ref} may train on submitted data; confirm that is acceptable for the data this component handles.`);
  }
  if (evaluation.flags.includes('saas_data_use_not_stated')) {
    warnings.push(
      `the vendor of ${ref} does not state whether it uses submitted data (saas_data_use_not_stated); check the vendor's DPA or ask the vendor before sending personal or confidential data.`,
    );
  }
  const known = new Set(state.evidence.map((e) => e.id));
  const cited = [evaluation.saas?.pricing.evidence_id, evaluation.saas?.data_use.evidence_id].filter((id): id is string => id !== undefined);
  const unknown = cited.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    warnings.push(`evidence_id(s) cited for the terms of ${ref} are not in the ledger: ${unknown.map((id) => codeSpan(id, 64)).join(', ')}.`);
  }
}

/**
 * Service rule of §7.6: adopt/extend of a client or plugin linked to a hosted
 * service (`service_ref`) is judged on the service's latest evaluation in the
 * component at decision time, not on the one that existed when the client was
 * evaluated, so evaluating the service later is enough. A candidate that only
 * looks like a service client (`service_client_suspected`) or like an LLM gateway
 * without a provider or model (`upstream_provider_unverified`) gets a warning.
 */
function validateServiceClient(
  state: LedgerState,
  input: DecisionInput,
  evaluation: Evaluation,
  violations: string[],
  warnings: string[],
  waived: string[],
): void {
  const ref = refv(evaluation.ref);
  if (evaluation.service_ref !== undefined) {
    const service = refv(evaluation.service_ref);
    const gaps = serviceTermsGaps(evaluationFor(state, input.component_id, evaluation.service_ref));
    if (gaps.length === 0) return;
    const message = `${ref} is a client of the hosted service ${service}, whose terms are not confirmed (${gaps.join(', ')}); ${input.decision} would accept those terms unread. Evaluate ${service} with rw_evaluate in this component (saas block; pass the vendor's pricing and data-use pages as source_url, the client needs no re-evaluation), or choose "reference".`;
    if (input.decided_by === 'user') {
      warnings.push(`${message} Proceeding because decided_by is "user".`);
      waived.push('service_terms_unverified');
    } else violations.push(message);
  } else if (evaluation.flags.includes('upstream_provider_unverified')) {
    warnings.push(
      `${ref} looks like an LLM gateway (upstream_provider_unverified); the model provider behind it is a separate decision that was not evaluated. Evaluate the provider (saas: ref) and re-evaluate ${ref} with service_ref, or with weights_ref="hf:<owner>/<model>" if you host the model yourself (no_service_reason does not clear this).`,
    );
  } else if (evaluation.flags.includes('service_client_suspected')) {
    warnings.push(
      `${ref} looks like a client of a hosted service (service_client_suspected), and using it means accepting that service's terms; evaluate the service (saas: ref) and re-evaluate ${ref} with service_ref, or with no_service_reason="<why no hosted service is needed>" if it works without one.`,
    );
  }
}

/**
 * Applies the §7.6 rules against the ledger `state`. Every violation is an
 * error, unless `input.override` carries a reason of at least 20 characters;
 * then violations are demoted to warnings. Structural problems (unknown
 * component, malformed ref, bad override) are never overridable.
 */
export function validateDecision(
  state: LedgerState,
  input: DecisionInput,
): { errors: string[]; warnings: string[]; waived_gates: string[] } {
  const hard: string[] = [];
  const violations: string[] = [];
  const warnings: string[] = [];
  // Gates that `decided_by: "user"` turned into warnings (flag names): the server fills `Decision.waived_gates` from this.
  const waived: string[] = [];

  const component = findComponent(state, input.component_id);
  if (!component) {
    hard.push(`unknown component_id ${idv(input.component_id)}; call rw_decompose first or fix the id.`);
  }

  if (input.override !== undefined && input.override.reason.trim().length < MIN_OVERRIDE_REASON) {
    hard.push(`override.reason must be at least ${MIN_OVERRIDE_REASON} characters explaining why the rule is waived.`);
  }

  if (input.ref !== undefined && parseRef(input.ref) === undefined) {
    hard.push(`ref ${refv(input.ref)} is not a valid candidate ref; expected "<scheme>:<id>" (github, npm, pypi, mcp, hf, saas, web).`);
  }

  const componentEvidence = evidenceFor(state, input.component_id);
  if (input.evidence_ids !== undefined) {
    const known = new Set(componentEvidence.map((e) => e.id));
    const unknown = input.evidence_ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      violations.push(
        `evidence_ids not found for component ${idv(input.component_id)}: ${unknown.map((id) => codeSpan(id, 64)).join(', ')}; omit evidence_ids to cite all evidence.`,
      );
    }
  }

  if (input.decision !== 'build' && input.build_reason !== undefined) {
    warnings.push(`build_reason is only meaningful for decision "build"; it is ignored for "${input.decision}".`);
  }

  switch (input.decision) {
    case 'adopt':
    case 'extend': {
      if (input.ref === undefined) {
        violations.push(`${input.decision} requires ref (the candidate being ${input.decision === 'adopt' ? 'adopted' : 'extended'}).`);
        break;
      }
      const evaluation = evaluationFor(state, input.component_id, input.ref);
      if (!evaluation) {
        violations.push(
          `no evaluation for ${refv(input.ref)} on component ${idv(input.component_id)}; call rw_evaluate with this ref before deciding ${input.decision}.`,
        );
        break;
      }
      const verdict = evaluation.license.verdict;
      const weights = evaluation.weights_license;
      // The model license is the cause when the candidate is the weights itself, or the code license is fine.
      const modelCause =
        weights !== undefined &&
        (weights.ref === evaluation.ref || (weights.code_verdict !== 'incompatible' && weights.code_verdict !== 'unknown'));
      if (verdict === 'incompatible' || verdict === 'unknown') {
        const subject = `license verdict for ${refv(input.ref)} is "${verdict}"${
          weights !== undefined && modelCause ? ` (model weights ${refv(weights.ref)}: "${weights.verdict}")` : ''
        }`;
        if (modelCause && input.decided_by === 'user') {
          // A model license is a business call (custom terms, non-commercial); the user may accept it knowingly.
          warnings.push(`${subject}; proceeding because decided_by is "user". Read the model license text first.`);
          waived.push(`model_license_${verdict}`);
        } else {
          violations.push(
            `${subject}; ${input.decision} is not allowed. Choose "reference" or "build", or verify the license and re-evaluate.`,
          );
        }
      } else if (verdict === 'conditional') {
        const obligations = v(evaluation.license.obligations.join('; '));
        warnings.push(`license for ${refv(input.ref)} is conditional${obligations ? `: ${obligations}` : ''}.`);
      }
      if (evaluation.flags.includes('license_from_remote_cache')) {
        if (input.decided_by === 'user') {
          warnings.push(`license for ${refv(input.ref)} came from the remote cache; verify the LICENSE text before relying on it.`);
          waived.push('license_from_remote_cache');
        } else {
          violations.push(
            `license for ${refv(input.ref)} came from the remote cache, which anyone with write access can poison; ${input.decision} needs the user's confirmation (decided_by "user"). Otherwise re-run rw_evaluate for ${refv(input.ref)} with the remote cache off or offline (RECYCLEWHEEL_REMOTE_CACHE_MODE=off) to re-check the license locally, or verify the LICENSE text and ask the user.`,
          );
        }
      }
      if (evaluation.flags.includes('model_weights_unverified')) {
        warnings.push(
          `${refv(input.ref)} may load pretrained model weights that were not checked (model_weights_unverified); re-run rw_evaluate with weights_ref="hf:<owner>/<model>", or with weights_exempt_reason="<why it loads no weights, or bundles them under the code license>" if it loads none (a note in the rationale does not clear this warning).`,
        );
      }
      validateServiceClient(state, input, evaluation, violations, warnings, waived);
      if (evaluation.profile === 'saas') validateSaas(state, input, evaluation, violations, warnings, waived);
      if (input.decision === 'extend' && input.attribution === undefined) {
        warnings.push('extend usually forks or vendors the original; add attribution (source_url, license) to record provenance.');
      }
      break;
    }
    case 'reference': {
      if (input.ref === undefined) {
        violations.push('reference requires ref (the project or page being used as a reference; web: refs are allowed).');
        break;
      }
      const attribution = input.attribution;
      if (attribution === undefined) {
        warnings.push('if code was copied from the reference, add attribution (source_url, license, files).');
      } else {
        const copying = (attribution.files ?? []).length > 0;
        if (copying && (attribution.source_url.trim() === '' || attribution.license.trim() === '')) {
          violations.push('attribution with files needs a non-empty source_url and license.');
        }
        if (copying) {
          const verdict = evaluationFor(state, input.component_id, input.ref)?.license.verdict;
          if (verdict === 'incompatible' || verdict === 'unknown') {
            warnings.push(`files are copied from ${refv(input.ref)}, whose license verdict is "${verdict}"; review the license before copying.`);
          }
        }
      }
      break;
    }
    case 'build': {
      if (input.build_reason === undefined) {
        violations.push(
          'build requires build_reason (no_candidate, license_incompatible, unmaintained_or_risky, too_heavy, core_differentiator, trivial, integration_glue).',
        );
      } else if (input.build_reason !== 'trivial') {
        const sources = distinctEvidenceSources(componentEvidence);
        if (sources.length < 2) {
          violations.push(
            `build requires search evidence from >=2 distinct sources (found ${sources.length}: ${sources.join(', ') || 'none'}); call rw_search with sources=[...], record web/code_search evidence with rw_record_evidence, or set build_reason='trivial' if the component is trivial.`,
          );
        }
      }
      const adoptable = state.evaluations.find(
        (e) => e.component_id === input.component_id && e.hint === 'adopt' && e.license.verdict === 'compatible',
      );
      if (adoptable) {
        warnings.push(`${refv(adoptable.ref)} was evaluated with hint "adopt" and a compatible license; explain in the rationale why it is not used.`);
      }
      break;
    }
  }

  const waived_gates = [...new Set(waived)];
  const overridden = input.override !== undefined && !hard.some((m) => m.startsWith('override.reason'));
  if (overridden) {
    return {
      errors: hard,
      warnings: [...violations.map((v) => `override applied: ${v}`), ...warnings],
      waived_gates,
    };
  }
  return { errors: [...hard, ...violations], warnings, waived_gates };
}

/**
 * Builds the `Decision` to append. Fills `id`, `decided_at`, `decided_by`,
 * `alternatives` and defaults `evidence_ids` to all evidence of the component.
 * `waivedGates` comes from `validateDecision`, never from the caller's input.
 * Call `validateDecision` first.
 */
export function buildDecision(state: LedgerState, input: DecisionInput, now: Date, waivedGates: readonly string[] = []): Decision {
  const decision: Decision = {
    id: newId('dec'),
    component_id: input.component_id,
    decision: input.decision,
    rationale: input.rationale,
    alternatives: input.alternatives ?? [],
    evidence_ids: input.evidence_ids ?? evidenceFor(state, input.component_id).map((e) => e.id),
    decided_at: now.toISOString(),
    decided_by: input.decided_by ?? 'agent',
  };
  if (input.ref !== undefined) decision.ref = input.ref;
  if (input.version !== undefined) decision.version = input.version;
  if (input.build_reason !== undefined && input.decision === 'build') decision.build_reason = input.build_reason;
  if (input.attribution !== undefined) decision.attribution = input.attribution;
  if (input.override !== undefined) decision.override = input.override;
  if (decision.decided_by === 'user' && waivedGates.length > 0) decision.waived_gates = [...waivedGates];
  return decision;
}

// ---------------------------------------------------------------------------
// Rendering (PLAN §7.7)
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Restrict the output to one component. */
  componentId?: string;
}

/**
 * Marker that makes an export recognisable as ours. Markdown exports (Reuse
 * Report, notices) start with `EXPORT_MARKER_MD` on the first line; JSON
 * exports carry `"recyclewheel_export": 1` as their first top-level key. Only
 * files with the marker may be overwritten by `rw_ledger write_to`.
 */
export const EXPORT_MARKER_MD = '<!-- recyclewheel:export v1 -->';
export const EXPORT_JSON_KEY = 'recyclewheel_export';

/** The decision word; a call that `decided_by` says the user made says so, with the gates the user waived. */
function decisionCell(d: Decision): string {
  if (d.decided_by !== 'user') return d.decision;
  const waived = d.waived_gates ?? [];
  return `${d.decision} (decided by user${waived.length > 0 ? `; gate waived by user: ${waived.map(escapeMd).join(', ')}` : ''})`;
}

function inlineCode(text: string, inTable = false): string {
  const body = stripUnsafe(text).replace(/`/g, "'");
  if (body === '') return '`(empty)`';
  return `\`${inTable ? body.replace(/\|/g, '\\|') : body}\``;
}

/**
 * A link target. Only http(s) URLs are emitted as (auto)linkable text, in
 * normalised form with characters that could end the link or the table cell
 * percent-encoded; anything else (`javascript:`, `data:`, bare words) becomes an
 * inert code span.
 */
export function safeUrl(url: string): string {
  const clean = stripUnsafe(url);
  try {
    const u = new URL(clean);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.href.replace(/[()[\]|`<>\\]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
    }
  } catch {
    // Not an absolute URL: fall through to the inert form.
  }
  return inlineCode(clean);
}

function scopedComponents(state: LedgerState, opts: RenderOptions): Component[] {
  return opts.componentId === undefined
    ? state.components
    : state.components.filter((c) => c.id === opts.componentId);
}

function evidenceCell(state: LedgerState, d: Decision): string {
  const byId = new Map(state.evidence.map((e) => [e.id, e]));
  const kinds = new Map<string, number>();
  for (const id of d.evidence_ids) {
    const kind = byId.get(id)?.kind ?? 'missing';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  if (d.evidence_ids.length === 0) return '0';
  const parts = [...kinds].map(([k, n]) => `${k}×${n}`);
  return `${d.evidence_ids.length}: ${parts.join(', ')}`;
}

/** Reuse Report: decision table, undecided components, alternatives, overrides. */
export function renderMarkdown(state: LedgerState, opts: RenderOptions = {}): string {
  const out: string[] = [EXPORT_MARKER_MD, '# Reuse Report', ''];
  const project = state.project;
  if (project) {
    out.push(`**Project:** ${escapeMd(project.name)} — ${escapeMd(project.summary)}`);
    out.push(
      `**License:** ${escapeMd(project.license ?? 'unspecified')} · **Distribution:** ${escapeMd(project.distribution)} · **Ecosystems:** ${project.ecosystems.map(escapeMd).join(', ') || 'unspecified'}${
        project.markets !== undefined ? ` · **Markets:** ${project.markets.map(escapeMd).join(', ')} (${project.markets_source ?? 'input'})` : ''
      }`,
    );
    out.push('');
  }

  const components = scopedComponents(state, opts);
  const decided: Array<{ component: Component; decision: Decision }> = [];
  const undecided: Component[] = [];
  for (const c of components) {
    const d = decisionFor(state, c.id);
    if (d) decided.push({ component: c, decision: d });
    else undecided.push(c);
  }

  out.push('## Decisions', '');
  if (decided.length === 0) {
    out.push('_No decisions recorded yet._', '');
  } else {
    out.push('| Component | Decision | Choice | License | Score | Evidence | Rationale |');
    out.push('|---|---|---|---|---|---|---|');
    for (const { component, decision: d } of decided) {
      const evaluation = d.ref !== undefined ? evaluationFor(state, d.component_id, d.ref) : undefined;
      let choice: string;
      if (d.decision === 'build') {
        choice = d.build_reason ? `— (${d.build_reason})` : '—';
      } else {
        choice = `${d.ref !== undefined ? inlineCode(d.ref, true) : '—'}${d.version ? ` @${escapeMd(d.version)}` : ''}`;
      }
      let license = '—';
      if (evaluation) {
        license = `${escapeMd(evaluation.license.candidate_spdx ?? 'unknown')} (${evaluation.license.verdict})`;
        const weights = evaluation.weights_license;
        if (weights !== undefined && weights.ref !== evaluation.ref) {
          license += `; weights ${escapeMd(weights.spdx ?? weights.license_name ?? 'custom')} (${weights.verdict})`;
        }
        if (evaluation.weights_exempt_reason !== undefined) {
          license += `; weights exempt: ${escapeMd(evaluation.weights_exempt_reason)}`;
        }
        if (evaluation.service_ref !== undefined) license += `; client of ${escapeMd(evaluation.service_ref)}`;
        if (evaluation.no_service_reason !== undefined) license += `; no hosted service: ${escapeMd(evaluation.no_service_reason)}`;

      } else if (d.attribution) {
        license = escapeMd(d.attribution.license);
      }
      const score = evaluation ? `${evaluation.total}/100` : '—';
      out.push(
        `| ${escapeMd(component.name)} | ${decisionCell(d)} | ${choice} | ${license} | ${score} | ${escapeMd(evidenceCell(state, d))} | ${escapeMd(d.rationale)} |`,
      );
    }
    out.push('');
  }

  const services = decided.filter(({ decision }) => decision.ref !== undefined && parseRef(decision.ref)?.scheme === 'saas');
  const unevaluated = serviceUsageGaps(state).filter((g) => decided.some(({ component }) => component.id === g.component_id));

  if (services.length > 0) {
    out.push('## Services (SaaS)', '');
    out.push('| Component | Service | Vendor domains | Decision | Maturity | Pricing | Data use | Lock-in | Exit path | SDK | Flags |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const { component, decision: d } of services) {
      const ev = evaluationFor(state, d.component_id, d.ref ?? '');
      const saas = ev?.saas;
      if (ev === undefined || saas === undefined) {
        out.push(`| ${escapeMd(component.name)} | ${inlineCode(d.ref ?? '', true)} | — | ${decisionCell(d)} | — | — | — | — | — | — | — |`);
        continue;
      }
      // Each term shows whose page the server found behind it (first_party, secondhand, none); older ledgers have none.
      const pricingSource = saas.pricing.source !== undefined ? ` (${saas.pricing.source})` : '';
      const dataUseSource = saas.data_use.source !== undefined ? ` (${saas.data_use.source})` : '';
      const pricing = `${saas.pricing.checked ? escapeMd(saas.pricing.summary ?? 'checked') : 'not checked'}${pricingSource}`;
      const retention = saas.data_use.retention !== undefined ? `, ${escapeMd(saas.data_use.retention)}` : '';
      const vendorDomains = saas.vendor_domains !== undefined ? escapeMd(saas.vendor_domains.join(', ')) : '—';
      const sdk = ev.saas_sdk !== undefined ? `${inlineCode(ev.saas_sdk.ref, true)} (${ev.saas_sdk.verdict})` : 'none';
      out.push(
        `| ${escapeMd(component.name)} | ${inlineCode(ev.ref, true)} | ${vendorDomains} | ${decisionCell(d)} | ${saas.maturity} | ${pricing} | ${saas.data_use.policy}${dataUseSource}${retention} | ${saas.lock_in} | ${escapeMd(saas.exit_path)} | ${sdk} | ${escapeMd(ev.flags.join(', ') || '-')} |`,
      );
    }
    out.push('');
  }

  if (unevaluated.length > 0) {
    // Adopt/extend of a client whose hosted service has no confirmed terms (or that only looks like one): shown so it is not read as cleared.
    out.push('## Services used through a client but not evaluated', '');
    for (const g of unevaluated) {
      const name = components.find((c) => c.id === g.component_id)?.name ?? g.component_id;
      out.push(`- ${escapeMd(name)}: ${inlineCode(g.ref)} (${g.decision}) — ${escapeMd(g.reason)}`);
    }
    out.push('');
  }

  out.push('## Undecided components', '');

  if (undecided.length === 0) {
    out.push('_None._', '');
  } else {
    for (const c of undecided) out.push(`- ${inlineCode(c.id)} ${escapeMd(c.name)} (${c.status})`);
    out.push('');
  }

  const withAlternatives = decided.filter(({ decision }) => decision.alternatives.length > 0);
  if (withAlternatives.length > 0) {
    out.push('## Alternatives considered', '');
    for (const { component, decision } of withAlternatives) {
      out.push(`### ${escapeMd(component.name)}`, '');
      for (const alt of decision.alternatives) out.push(`- ${inlineCode(alt.ref)} — ${escapeMd(alt.why_not)}`);
      out.push('');
    }
  }

  const coverage = concernCoverage(state);
  if (opts.componentId === undefined && (decided.length > 0 || coverage.some((c) => c.checked || (c.markets ?? []).some((m) => m.checked)))) {
    out.push('## Cross-cutting checks', '');
    for (const c of coverage) {
      // Per target market (legal_privacy): "KR checked (2)", "US **not checked**".
      const perMarket = (c.markets ?? []).map((m) => `${escapeMd(m.code)} ${m.checked ? `checked (${m.evidence_count})` : '**not checked**'}`);
      if (!c.checked) {
        const marketOnly = c.market_only === true ? ` (only market-specific evidence: ${c.evidence_ids.length})` : '';
        out.push(`- ${c.concern}: **not checked**${marketOnly}${perMarket.length > 0 ? ` (markets: ${perMarket.join(', ')})` : ''}`);
        continue;
      }
      const latest = state.evidence.find((e) => e.id === c.evidence_ids[c.evidence_ids.length - 1]);
      const note = latest !== undefined ? ` — ${escapeMd(cut(stripUnsafe(latest.summary), 200))}` : '';
      out.push(`- ${c.concern}: checked (${c.evidence_ids.length} evidence)${note}${perMarket.length > 0 ? ` · markets: ${perMarket.join(', ')}` : ''}`);
    }
    out.push('');
  }

  const overrides = decided.filter(({ decision }) => decision.override !== undefined);
  if (overrides.length > 0) {
    out.push('## Overrides', '');
    for (const { component, decision } of overrides) {
      out.push(`- ${escapeMd(component.name)} (${decision.decision}): ${escapeMd(decision.override?.reason ?? '')}`);
    }
    out.push('');
  }

  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

function refUrl(ref: string): string {
  const parsed = parseRef(ref);
  if (!parsed) return ref;
  switch (parsed.scheme) {
    case 'github':
      return `https://github.com/${parsed.id}`;
    case 'npm':
      return `https://www.npmjs.com/package/${parsed.id}`;
    case 'pypi':
      return `https://pypi.org/project/${parsed.id}/`;
    case 'web':
      return parsed.id;
    case 'hf':
      return `https://huggingface.co/${parsed.id}`;
    case 'mcp':
    case 'saas':
      return ref;
  }
}

/**
 * THIRD_PARTY_NOTICES draft: adopt/extend decisions, plus reference decisions
 * that carry an attribution. Build decisions are excluded.
 */
export function renderNotices(state: LedgerState, opts: RenderOptions = {}): string {
  const out: string[] = [
    EXPORT_MARKER_MD,
    '# Third-Party Notices (draft)',
    '',
    'Generated from the recyclewheel ledger. Verify each license text and copyright line before distribution. Not legal advice.',
    '',
  ];
  let count = 0;
  for (const c of scopedComponents(state, opts)) {
    const d = decisionFor(state, c.id);
    if (!d || d.decision === 'build' || d.ref === undefined) continue;
    if (d.decision === 'reference' && d.attribution === undefined) continue;
    const parsed = parseRef(d.ref);
    // A hosted service has terms of service, not a license text to attribute.
    if (parsed?.scheme === 'saas') continue;
    const evaluation = evaluationFor(state, d.component_id, d.ref);
    const license = d.attribution?.license ?? evaluation?.license.candidate_spdx ?? 'UNKNOWN';
    out.push(`## ${escapeMd(parsed ? parsed.id : d.ref)}`, '');
    out.push(`- Component: ${escapeMd(c.name)}`);
    out.push(`- Decision: ${d.decision}`);
    if (d.version) out.push(`- Version: ${escapeMd(d.version)}`);
    out.push(`- License: ${escapeMd(license)}`);
    if (d.attribution?.copyright) out.push(`- Copyright: ${escapeMd(d.attribution.copyright)}`);
    // Model weights carry their own license and obligations (for example a Llama attribution line), apart from the code's.
    const weights = evaluation?.weights_license;
    if (weights !== undefined) {
      if (weights.ref !== d.ref) out.push(`- Model weights: ${escapeMd(weights.ref)} (${escapeMd(weights.spdx ?? weights.license_name ?? 'no license declared')})`);
      const obligations = evaluation?.license.obligations ?? [];
      if (obligations.length > 0) out.push(`- Obligations: ${obligations.map(escapeMd).join('; ')}`);
    }
    out.push(`- URL: ${safeUrl(d.attribution?.source_url ?? refUrl(d.ref))}`);
    if (d.attribution?.revision) out.push(`- Revision: ${escapeMd(d.attribution.revision)}`);
    if (d.attribution?.files && d.attribution.files.length > 0) out.push(`- Files: ${d.attribution.files.map(escapeMd).join(', ')}`);
    out.push('');
    count++;
  }
  if (count === 0) out.push('_No third-party components recorded._', '');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}
