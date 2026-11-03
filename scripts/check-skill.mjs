#!/usr/bin/env node
/**
 * Static lint for the recyclewheel skill (docs/PLAN.md §12 T18/T30, §13.5).
 *
 *   node scripts/check-skill.mjs [skill-dir] [--tools rw_a,rw_b,...]
 *
 * skill-dir  defaults to <repo>/skills/recyclewheel. The directory name must
 *            equal the skill name.
 * --tools    use this tool list instead of asking dist/cli.js (tests, CI without a build).
 *
 * Checks (all violations are reported, exit code 1 if there is any):
 *   frontmatter   name == "recyclewheel" == directory name, ^[a-z0-9]+(-[a-z0-9]+)*$, <= 64 chars;
 *                 description 1..1024 chars
 *   length        body <= 300 lines
 *   tools         every `rw_[a-z_]+` token in SKILL.md and reference/manual-mode.md is a registered
 *                 tool, and every registered tool is mentioned in SKILL.md. The registered set comes
 *                 from a real tools/list against `node dist/cli.js mcp`; without a build it falls back to
 *                 the TOOL_NAMES constant in src/mcp/server.ts.
 *   structure     "### Step 0." ... "### Step 9." (10 headings, in order), the heading
 *                 "## 중단 조건 (Stop conditions)" with items (a)..(d), the 7 build reason identifiers
 *   links         relative links in SKILL.md and reference/manual-mode.md resolve to existing files
 *
 * Plain Node (ESM), no dependencies. Exit codes: 0 ok, 1 violations, 2 the lint itself could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'recyclewheel';
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_BODY_LINES = 300;
const BUILD_REASONS = [
  'no_candidate',
  'license_incompatible',
  'unmaintained_or_risky',
  'too_heavy',
  'core_differentiator',
  'trivial',
  'integration_glue',
];
const STOP_HEADING = '## 중단 조건 (Stop conditions)';
const TOOL_TOKEN = /\brw_[a-z_]+/g;

class LintError extends Error {}

// ---------------------------------------------------------------------------
// Frontmatter (a small subset of YAML: top-level scalars and block scalars)
// ---------------------------------------------------------------------------

/** Returns `{ data, body, bodyStartLine }` or throws LintError when there is no frontmatter block. */
export function parseFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new LintError('SKILL.md must start with a "---" frontmatter block.');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new LintError('Frontmatter is not closed: no second "---" line.');

  const data = {};
  const fm = lines.slice(1, end);
  for (let i = 0; i < fm.length; ) {
    const line = fm[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!m) throw new LintError(`Frontmatter line ${i + 2} is not "key: value": ${JSON.stringify(line)}`);
    const [, key, rawValue = ''] = m;
    if (Object.hasOwn(data, key)) throw new LintError(`Frontmatter key "${key}" is defined twice.`);

    // Indented lines that follow belong to this key.
    let j = i + 1;
    const continuation = [];
    while (j < fm.length && (fm[j].trim() === '' || /^\s/.test(fm[j]))) {
      continuation.push(fm[j]);
      j++;
    }
    while (continuation.length > 0 && continuation[continuation.length - 1].trim() === '') continuation.pop();

    const value = rawValue.trim();
    const block = /^([>|])([+-]?)$/.exec(value);
    if (block) {
      const indent = Math.min(...continuation.filter((l) => l.trim() !== '').map((l) => l.match(/^\s*/)[0].length));
      const content = continuation.map((l) => (l.trim() === '' ? '' : l.slice(indent)));
      data[key] = block[1] === '|' ? content.join('\n') : foldLines(content);
    } else if (continuation.length > 0 && value !== '') {
      // Multi-line plain scalar: continuation lines are joined with single spaces.
      data[key] = unquote([value, ...continuation.map((l) => l.trim())].filter(Boolean).join(' '));
    } else {
      data[key] = unquote(value);
    }
    i = j;
  }

  return { data, body: lines.slice(end + 1).join('\n'), bodyStartLine: end + 2 };
}

/** YAML folded scalar: single newlines become spaces, blank lines stay newlines. */
function foldLines(lines) {
  let out = '';
  let pendingBreaks = 0;
  for (const line of lines) {
    if (line === '') {
      pendingBreaks++;
      continue;
    }
    if (out !== '') out += pendingBreaks > 0 ? '\n'.repeat(pendingBreaks) : ' ';
    pendingBreaks = 0;
    out += line;
  }
  return out;
}

function unquote(value) {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q)) {
      const inner = value.slice(1, -1);
      return q === "'" ? inner.replaceAll("''", "'") : inner.replace(/\\(["\\])/g, '$1');
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Registered tool names
// ---------------------------------------------------------------------------

/** Asks `node dist/cli.js mcp` for tools/list over stdio. Rejects on any problem. */
function listToolsFromDist(cliPath) {
  return new Promise((resolve, reject) => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'rw-skill-lint-'));
    const child = spawn(process.execPath, [cliPath, 'mcp'], {
      cwd: scratch,
      env: {
        ...process.env,
        RECYCLEWHEEL_CACHE_DIR: path.join(scratch, 'cache'),
        RECYCLEWHEEL_PROJECT_ROOT: scratch,
        RECYCLEWHEEL_OFFLINE: '1',
        RECYCLEWHEEL_NO_GH_CLI: '1',
        RECYCLEWHEEL_LOG_LEVEL: 'silent',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    let closed = false;
    // The server keeps its cache database open; remove the scratch directory only after it has exited.
    const removeScratch = () => {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // A leftover temp directory is harmless.
      }
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closed) removeScratch();
      else {
        child.once('close', removeScratch);
        child.kill();
      }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('tools/list timed out after 15s')), 15_000);

    child.on('error', (err) => finish(reject, err));
    child.on('close', () => {
      closed = true;
      finish(reject, new Error('the server exited before answering tools/list'));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line === '') continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          return finish(reject, new Error(`non JSON-RPC output on stdout: ${line.slice(0, 80)}`));
        }
        if (frame.id === 2) {
          const tools = frame.result?.tools;
          if (!Array.isArray(tools)) return finish(reject, new Error('tools/list returned no tools array'));
          return finish(resolve, tools.map((t) => t.name));
        }
      }
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'check-skill', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

/** `export const TOOL_NAMES = ['rw_a', ...] as const;` in src/mcp/server.ts. */
function listToolsFromSource() {
  const file = path.join(REPO_ROOT, 'src', 'mcp', 'server.ts');
  const text = readFileSync(file, 'utf8');
  const m = /TOOL_NAMES\s*=\s*\[([^\]]*)\]/.exec(text);
  if (!m) throw new Error(`TOOL_NAMES not found in ${file}`);
  return [...m[1].matchAll(/['"](rw_[a-z_]+)['"]/g)].map((x) => x[1]);
}

async function registeredTools(toolsOverride) {
  if (toolsOverride) return { tools: toolsOverride, origin: '--tools' };
  const cli = path.join(REPO_ROOT, 'dist', 'cli.js');
  let distError = 'dist/cli.js does not exist (run `npm run build`)';
  if (existsSync(cli)) {
    try {
      return { tools: await listToolsFromDist(cli), origin: 'dist/cli.js tools/list' };
    } catch (err) {
      distError = `tools/list from dist/cli.js failed: ${err.message}`;
    }
  }
  try {
    const tools = listToolsFromSource();
    process.stderr.write(`check-skill: note: ${distError}; using TOOL_NAMES from src/mcp/server.ts instead.\n`);
    return { tools, origin: 'src/mcp/server.ts TOOL_NAMES' };
  } catch (err) {
    throw new LintError(`cannot determine the registered tools (${distError}; ${err.message})`);
  }
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

/** Lines outside fenced code blocks, with their 1-based line numbers. */
function proseLines(text) {
  const out = [];
  let fence = null;
  text.split(/\r?\n/).forEach((line, index) => {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence === null) out.push({ line, number: index + 1 });
  });
  return out;
}

/** Relative link targets (inline and reference style) outside code. */
function linkTargets(text) {
  const targets = [];
  for (const { line, number } of proseLines(text)) {
    const noCode = line.replace(/`[^`]*`/g, '');
    for (const m of noCode.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push({ target: m[1], number });
    const ref = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(noCode);
    if (ref) targets.push({ target: ref[1], number });
  }
  return targets;
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//');
}

// ---------------------------------------------------------------------------
// The lint
// ---------------------------------------------------------------------------

export async function lintSkill(skillDir, { tools: toolsOverride } = {}) {
  const violations = [];
  const fail = (rule, message) => violations.push({ rule, message });
  const info = [];

  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) {
    return { violations: [{ rule: 'files', message: `${skillFile} does not exist.` }], info };
  }
  const skillText = readFileSync(skillFile, 'utf8');

  let fm;
  try {
    fm = parseFrontmatter(skillText);
  } catch (err) {
    if (!(err instanceof LintError)) throw err;
    return { violations: [{ rule: 'frontmatter', message: err.message }], info };
  }
  const { data, body, bodyStartLine } = fm;

  // --- frontmatter ----------------------------------------------------------
  const dirName = path.basename(path.resolve(skillDir));
  const name = data.name;
  if (typeof name !== 'string' || name === '') {
    fail('frontmatter', 'missing "name".');
  } else {
    if (name !== SKILL_NAME) fail('frontmatter', `name must be "${SKILL_NAME}" (found "${name}").`);
    if (!NAME_PATTERN.test(name)) fail('frontmatter', `name "${name}" must match ${NAME_PATTERN}.`);
    if (name.length > MAX_NAME) fail('frontmatter', `name is ${name.length} chars, the limit is ${MAX_NAME}.`);
    if (name !== dirName) fail('frontmatter', `name "${name}" must equal the directory name "${dirName}".`);
  }
  const description = data.description;
  if (typeof description !== 'string' || description.trim() === '') {
    fail('frontmatter', 'missing or empty "description".');
  } else if (description.length > MAX_DESCRIPTION) {
    fail('frontmatter', `description is ${description.length} chars, the limit is ${MAX_DESCRIPTION}.`);
  }

  // --- length ---------------------------------------------------------------
  const bodyLines = body.replace(/\n+$/, '').split('\n').length;
  if (bodyLines > MAX_BODY_LINES) {
    fail('length', `SKILL.md body is ${bodyLines} lines, the limit is ${MAX_BODY_LINES}. Move detail into reference/.`);
  }

  // --- tools ----------------------------------------------------------------
  const manualFile = path.join(skillDir, 'reference', 'manual-mode.md');
  const manualText = existsSync(manualFile) ? readFileSync(manualFile, 'utf8') : undefined;
  if (manualText === undefined) fail('files', `${path.relative(skillDir, manualFile)} does not exist.`);

  const found = await registeredTools(toolsOverride);
  const registered = new Set(found.tools);
  info.push(`${registered.size} registered tools (${found.origin})`);
  if (registered.size === 0) fail('tools', 'the registered tool list is empty.');
  const mentioned = new Set();
  for (const [label, text] of [['SKILL.md', body], ['reference/manual-mode.md', manualText ?? '']]) {
    const unknown = new Set();
    for (const token of text.match(TOOL_TOKEN) ?? []) {
      if (label === 'SKILL.md') mentioned.add(token);
      if (!registered.has(token)) unknown.add(token);
    }
    for (const token of unknown) {
      fail('tools', `${label} mentions "${token}", which is not a registered tool (${[...registered].sort().join(', ')}).`);
    }
  }
  for (const tool of [...registered].sort()) {
    if (!mentioned.has(tool)) fail('tools', `registered tool "${tool}" is never mentioned in SKILL.md.`);
  }

  // --- structure ------------------------------------------------------------
  const stepNumbers = [];
  const lines = body.split(/\r?\n/);
  for (const { line } of proseLines(body)) {
    const m = /^### Step (\d+)\.\s+\S/.exec(line);
    if (m) stepNumbers.push(Number(m[1]));
  }
  const expectedSteps = Array.from({ length: 10 }, (_, i) => i);
  if (stepNumbers.join(',') !== expectedSteps.join(',')) {
    fail(
      'structure',
      `expected the headings "### Step 0." to "### Step 9." once each, in order (10 headings); found: ${stepNumbers.length > 0 ? stepNumbers.map((n) => `Step ${n}`).join(', ') : 'none'}.`,
    );
  }

  const stopIndex = lines.findIndex((l) => l.trimEnd() === STOP_HEADING);
  if (stopIndex === -1) {
    fail('structure', `missing the heading "${STOP_HEADING}".`);
  } else {
    let stopEnd = lines.length;
    for (let i = stopIndex + 1; i < lines.length; i++) {
      if (/^#{1,2} /.test(lines[i])) {
        stopEnd = i;
        break;
      }
    }
    const section = lines.slice(stopIndex + 1, stopEnd).join('\n');
    for (const letter of ['a', 'b', 'c', 'd']) {
      if (!new RegExp(`^\\s*(?:[-*]\\s+)?\\(${letter}\\)`, 'm').test(section)) {
        fail('structure', `the stop conditions section has no item "(${letter})".`);
      }
    }
  }

  for (const reason of BUILD_REASONS) {
    if (!new RegExp(`(?<![A-Za-z0-9_])${reason}(?![A-Za-z0-9_])`).test(body)) {
      fail('structure', `build reason "${reason}" is not mentioned in SKILL.md.`);
    }
  }

  // --- links ----------------------------------------------------------------
  const linkSources = [[skillFile, skillText]];
  if (manualText !== undefined) linkSources.push([manualFile, manualText]);
  let checkedLinks = 0;
  for (const [file, text] of linkSources) {
    for (const { target, number } of linkTargets(text)) {
      if (isExternal(target)) continue;
      const clean = decodeURIComponent(target.split('#')[0].split('?')[0]);
      if (clean === '') continue;
      checkedLinks++;
      const resolved = path.resolve(path.dirname(file), clean);
      if (!existsSync(resolved)) {
        fail('links', `${path.relative(skillDir, file)}:${number} links to "${target}", which does not exist (${path.relative(skillDir, resolved)}).`);
      } else if (target.endsWith('/') && !statSync(resolved).isDirectory()) {
        fail('links', `${path.relative(skillDir, file)}:${number} links to "${target}", which is not a directory.`);
      }
    }
  }
  info.push(`${checkedLinks} relative links`);
  info.push(`body ${bodyLines}/${MAX_BODY_LINES} lines (starts at file line ${bodyStartLine})`);

  return { violations, info };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCli(argv) {
  let dir;
  let tools;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tools') {
      const value = argv[++i];
      if (!value) throw new LintError('--tools needs a comma separated list, e.g. --tools rw_status,rw_search');
      tools = value.split(',').map((t) => t.trim()).filter(Boolean);
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write('Usage: node scripts/check-skill.mjs [skill-dir] [--tools rw_a,rw_b,...]\n');
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new LintError(`unknown option ${arg}`);
    } else if (dir === undefined) {
      dir = arg;
    } else {
      throw new LintError(`unexpected argument ${arg}`);
    }
  }
  return { dir: path.resolve(dir ?? path.join(REPO_ROOT, 'skills', SKILL_NAME)), tools };
}

async function main() {
  const { dir, tools } = parseCli(process.argv.slice(2));
  const { violations, info } = await lintSkill(dir, { tools });
  const shown = path.relative(process.cwd(), dir) || '.';
  if (violations.length > 0) {
    for (const v of violations) process.stderr.write(`check-skill: FAIL [${v.rule}] ${v.message}\n`);
    process.stderr.write(`check-skill: ${violations.length} violation(s) in ${shown}\n`);
    process.exit(1);
  }
  process.stdout.write(`check-skill: OK ${shown} (${info.join('; ')})\n`);
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`check-skill: ${err instanceof LintError ? err.message : err.stack ?? err}\n`);
    process.exit(2);
  });
}
