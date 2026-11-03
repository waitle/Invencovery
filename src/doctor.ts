/**
 * Environment checks shared by `rw_status` and `recyclewheel doctor`
 * (docs/PLAN.md §7.1, §12 T20), plus a few small helpers every entry point
 * needs (version, project-root resolution, SQLite warning filter).
 *
 * Nothing here writes to stdout. No secret value is ever returned: the GitHub
 * token appears only as its source (`env | gh_cli | none`) and the remote cache
 * only as a host name.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { createGithubTokenProvider, redactGithubToken } from './auth/github-token.js';
import type { GithubTokenSource, RunGh } from './auth/github-token.js';
import { collectSecrets, loadConfig, maskSecrets } from './config.js';
import { concernCoverage, concernWarnings } from './core/concerns.js';
import { LEDGER_DIR, ledgerPathProblem } from './core/ledger.js';
import { serviceWarnings } from './core/service-terms.js';
import { ConcernSchema, RateLimitStateSchema, SourceSchema } from './types.js';
import type { AppContext, Config, RateLimitState, Source } from './types.js';

export const VERSION: string = pkg.version;

/** Minimum Node version (node:sqlite without flags). */
export const MIN_NODE = { major: 22, minor: 13 } as const;

/** True when `target` is `root` itself or lies below it (pure path arithmetic, no filesystem access). */
export function isPathInside(
  root: string,
  target: string,
  pathImpl: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path,
): boolean {
  const rel = pathImpl.relative(root, target);
  if (rel === '') return true;
  if (pathImpl.isAbsolute(rel)) return false; // other drive / UNC share
  return rel !== '..' && !rel.startsWith(`..${pathImpl.sep}`);
}

/** `realpath` of the nearest existing ancestor of `p`, with the not-yet-existing remainder appended. */
export function realpathOfNearest(p: string): string {
  const abs = path.resolve(p);
  let probe = abs;
  // lstat, not existsSync: a dangling symlink "exists" and must be resolved (and fail), not skipped.
  while (lstatSync(probe, { throwIfNoEntry: false }) === undefined) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = realpathSync.native(probe);
  const rest = path.relative(probe, abs);
  return rest === '' ? real : path.join(real, rest);
}

/** Raised when a caller-supplied `project_root` leaves the server's project root. */
export class ProjectRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRootError';
  }
}

/**
 * Resolves the effective project root: `input` (relative to the configured root)
 * or the configured root. A caller-supplied `input` must stay inside the
 * configured root (symlinks and junctions included, judged by the real
 * location of the nearest existing ancestor); otherwise a `ProjectRootError`
 * with an actionable message is thrown.
 */
export function resolveProjectRoot(config: Pick<Config, 'projectRoot'>, input?: string): string {
  const raw = input?.trim();
  if (!raw) return config.projectRoot;
  const root = path.resolve(config.projectRoot);
  const fail = (): never => {
    throw new ProjectRootError(
      `project_root '${input}' is outside the server's project root (${root}). Omit project_root, or pass a path inside it; to work on another project, start the server with RECYCLEWHEEL_PROJECT_ROOT set to that directory.`,
    );
  };
  const failLedgerDir = (): never => {
    throw new ProjectRootError(
      `project_root '${input}' points at or into ${LEDGER_DIR}/, which holds the ledger itself. Omit project_root, or pass the project directory that contains ${LEDGER_DIR}/.`,
    );
  };
  if (raw.includes('\0')) return fail();
  const resolved = path.resolve(root, raw);
  if (!isPathInside(root, resolved)) return fail();
  // `.recyclewheel` by spelling, with an alternate data stream (`name::$INDEX_ALLOCATION`), or by real location.
  const segments = path.relative(root, resolved).split(/[\\/]+/).filter((s) => s !== '');
  // Windows also folds trailing dots and spaces away, so `.recyclewheel.` can name the ledger directory.
  if (segments.some((s) => s.includes(':') || (process.platform === 'win32' && /[. ]$/.test(s)))) return failLedgerDir();
  if ((segments[0] ?? '').toLowerCase() === LEDGER_DIR) return failLedgerDir();
  try {
    const realRoot = realpathOfNearest(root);
    const realResolved = realpathOfNearest(resolved);
    if (!isPathInside(realRoot, realResolved)) return fail();
    const ledgerDirs = [path.join(realRoot, LEDGER_DIR), realpathOfNearest(path.join(root, LEDGER_DIR))];
    if (ledgerDirs.some((dir) => isPathInside(dir, realResolved))) return failLedgerDir();
  } catch (err) {
    if (err instanceof ProjectRootError) throw err;
    return fail();
  }
  return resolved;
}

let sqliteFilterInstalled = false;

/**
 * Drops Node's "SQLite is an experimental feature" ExperimentalWarning (it goes
 * to stderr, so the stdio protocol is safe either way; this only keeps logs
 * clean). Install before the first `openCacheStore` call. Idempotent.
 */
export function installSqliteWarningFilter(): void {
  if (sqliteFilterInstalled) return;
  sqliteFilterInstalled = true;
  const original = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const first = rest[0];
    const type =
      typeof first === 'string'
        ? first
        : first !== null && typeof first === 'object'
          ? (first as { type?: string }).type
          : warning instanceof Error
            ? warning.name
            : undefined;
    const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
    if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return;
    original(warning, ...rest);
  }) as typeof process.emitWarning;
}

// ---------------------------------------------------------------------------
// rw_status report (light checks, no network probes)
// ---------------------------------------------------------------------------

export const StatusReportSchema = z.object({
  version: z.string(),
  node: z.string(),
  project_root: z.string(),
  ledger_path: z.string(),
  ledger_exists: z.boolean(),
  github_auth: z.enum(['env', 'gh_cli', 'none']),
  offline: z.boolean(),
  remote_cache: z.object({
    mode: z.enum(['off', 'read', 'readwrite']),
    host: z.string().optional(),
    reachable: z.boolean().optional(),
  }),
  rate_limits: z.array(RateLimitStateSchema),
  adapters: z.array(
    z.object({ source: SourceSchema, enabled: z.boolean(), note: z.string().optional() }),
  ),
  budget: z.object({
    rounds_per_component: z.number(),
    evals_per_component: z.number(),
    web_per_component: z.number(),
  }),
  cache: z.object({ path: z.string(), entries: z.number(), bytes: z.number() }),
  /** Cross-cutting concerns (cost, privacy, ...) and whether the ledger has evidence for each. */
  cross_cutting: z.array(
    z.object({
      concern: ConcernSchema,
      checked: z.boolean(),
      evidence_count: z.number().int(),
      /** `legal_privacy` only, when the project has target markets. */
      markets: z.array(z.object({ code: z.string(), checked: z.boolean(), evidence_count: z.number().int() })).optional(),
      /** `distribution_policy` only: not checked because every evidence is tagged with one market. */
      market_only: z.boolean().optional(),
    }),
  ),
  /** Notes about ignored or invalid environment values, and cross-cutting concerns not checked once a decision exists. */
  warnings: z.array(z.string()),
});
export type StatusReport = z.infer<typeof StatusReportSchema>;

/** The context produced by `createApp`; fake contexts in tests may omit `githubAuthSource`. */
export type StatusContext = AppContext & {
  githubAuthSource?: () => Promise<GithubTokenSource>;
};

const REMOTE_HEALTH_TIMEOUT_MS = 1500;

/** Resource names recorded by the HTTP client (src/http/ratelimit.ts). */
const RATE_LIMIT_RESOURCES: readonly string[] = [
  'github:search',
  'github:code_search',
  'github:core',
  'github:search:anon',
  'github:code_search:anon',
  'github:core:anon',
  'librariesio',
  'npm',
  'pypi',
  'depsdev',
  'mcp_registry',
  'huggingface',
];

export function collectRateLimits(store: Pick<AppContext['store'], 'getRateLimit'>): RateLimitState[] {
  const out: RateLimitState[] = [];
  for (const resource of RATE_LIMIT_RESOURCES) {
    try {
      const state = store.getRateLimit(resource);
      if (state !== undefined) out.push(state);
    } catch {
      // A damaged cache must not break the status call.
    }
  }
  return out;
}

function remoteHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function adapterRows(
  ctx: StatusContext,
  githubAuth: GithubTokenSource,
): StatusReport['adapters'] {
  const { config } = ctx;
  return SourceSchema.options.map((source: Source) => {
    if (!config.sources.includes(source)) {
      return { source, enabled: false, note: 'disabled by RECYCLEWHEEL_SOURCES' };
    }
    if (ctx.adapters[source] === undefined) {
      return { source, enabled: false, note: 'adapter not available in this build' };
    }
    if (source === 'github_code' && githubAuth === 'none') {
      return { source, enabled: false, note: 'needs GITHUB_TOKEN; consider Grep MCP' };
    }
    if (source === 'pypi') {
      return {
        source,
        enabled: true,
        note:
          config.librariesIoApiKey !== undefined
            ? 'PyPI has no search API: name probes plus libraries.io search'
            : 'PyPI has no search API: name probes only; set LIBRARIES_IO_API_KEY to add search',
      };
    }
    if (config.offline) return { source, enabled: true, note: 'offline: cached responses only' };
    return { source, enabled: true };
  });
}

/**
 * Light status (PLAN §7.1): no network probes; the remote cache health check
 * is the only network call and is capped at 1.5 s.
 */
export async function collectStatus(
  ctx: StatusContext,
  opts: { projectRoot: string },
): Promise<StatusReport> {
  const { config } = ctx;
  const githubAuth = (await ctx.githubAuthSource?.()) ?? 'none';

  const remote_cache: StatusReport['remote_cache'] = { mode: ctx.remote.mode };
  if (ctx.remote.mode !== 'off') {
    const host = remoteHost(config.remoteCacheUrl);
    if (host !== undefined) remote_cache.host = host;
    remote_cache.reachable = await withTimeout(
      ctx.remote.healthy().catch(() => false),
      REMOTE_HEALTH_TIMEOUT_MS,
      false,
    );
  }

  let stats = { entries: 0, bytes: 0 };
  try {
    const s = ctx.store.stats();
    stats = { entries: s.entries, bytes: s.bytes };
  } catch {
    // Report an empty cache rather than failing the whole call.
  }

  const ledgerPath = ctx.ledger(opts.projectRoot).path;
  // A ledger location that is a link (or leaves the root) is reported, never followed (N-1).
  let linkProblem: string | undefined;
  try {
    linkProblem = ledgerPathProblem(opts.projectRoot);
  } catch (err) {
    linkProblem = err instanceof Error ? err.message : String(err);
  }
  // Coverage comes from the ledger; a missing, damaged or rejected ledger just reports nothing checked.
  let ledgerState: Parameters<typeof concernCoverage>[0] & Parameters<typeof concernWarnings>[0] & Parameters<typeof serviceWarnings>[0] = {
    evidence: [],
    decisions: [],
    evaluations: [],
  };
  if (linkProblem === undefined) {
    try {
      const s = ctx.ledger(opts.projectRoot).read();
      ledgerState = { evidence: s.evidence, decisions: s.decisions, evaluations: s.evaluations, project: s.project };
    } catch {
      // Keep the empty state.
    }
  }
  const secrets = collectSecrets(process.env);
  return {
    version: VERSION,
    node: process.versions.node,
    project_root: opts.projectRoot,
    ledger_path: ledgerPath,
    ledger_exists: linkProblem === undefined && existsSync(ledgerPath),
    github_auth: githubAuth,
    offline: config.offline,
    remote_cache,
    rate_limits: collectRateLimits(ctx.store),
    adapters: adapterRows(ctx, githubAuth),
    budget: {
      rounds_per_component: config.budget.rounds,
      evals_per_component: config.budget.evals,
      web_per_component: config.budget.web,
    },
    cache: { path: config.cacheDbPath, entries: stats.entries, bytes: stats.bytes },
    cross_cutting: concernCoverage(ledgerState).map((c) => ({
      concern: c.concern,
      checked: c.checked,
      evidence_count: c.evidence_ids.length,
      ...(c.markets !== undefined ? { markets: c.markets } : {}),
      ...(c.market_only === true ? { market_only: true } : {}),
    })),
    warnings: [
      ...config.warnings.map((w) => maskSecrets(redactGithubToken(w), secrets)),
      ...(linkProblem !== undefined ? [`ledger location rejected: ${linkProblem}`] : []),
      ...concernWarnings(ledgerState),
      ...serviceWarnings(ledgerState),
    ],

  };
}

// ---------------------------------------------------------------------------
// `recyclewheel doctor`
// ---------------------------------------------------------------------------

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  id: string;
  level: CheckLevel;
  title: string;
  message: string;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Probe the public APIs. Default true; always skipped when RECYCLEWHEEL_OFFLINE is set. */
  network?: boolean;
  fetch?: typeof globalThis.fetch;
  /** Runs `gh` (injectable for tests). Used for `gh --version` and `gh auth token`. */
  runGh?: RunGh;
  /** Per-probe timeout. Default 5000. */
  timeoutMs?: number;
  /** Node version to check (tests). Default `process.versions.node`. */
  nodeVersion?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** 1 only when a hard requirement fails (Node version, node:sqlite). Warnings never fail. */
  exitCode: 0 | 1;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * execFile options for `gh`: run from the home directory (never the project
 * or server cwd, so a planted `gh.exe` there is not picked up), skip the
 * current directory in the Windows executable search, and never prompt.
 */
export function ghExecOptions(timeoutMs: number, baseEnv: NodeJS.ProcessEnv = process.env) {
  return {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024,
    encoding: 'utf8' as const,
    cwd: os.homedir(),
    env: { ...baseEnv, NoDefaultCurrentDirectoryInExePath: '1', GH_PROMPT_DISABLED: '1' },
  };
}

const defaultRunGh: RunGh = (args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile('gh', [...args], ghExecOptions(timeoutMs), (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

function parseNodeVersion(v: string): { major: number; minor: number } {
  const [major = 0, minor = 0] = v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return { major, minor };
}

function nodeMeetsMinimum(v: string): boolean {
  const { major, minor } = parseNodeVersion(v);
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

function checkSqlite(): DoctorCheck {
  try {
    installSqliteWarningFilter();
    const require = createRequire(import.meta.url);
    const mod = require('node:sqlite') as { DatabaseSync?: unknown };
    if (typeof mod.DatabaseSync !== 'function') throw new Error('DatabaseSync missing');
    return { id: 'sqlite', level: 'ok', title: 'node:sqlite', message: 'available' };
  } catch {
    return {
      id: 'sqlite',
      level: 'fail',
      title: 'node:sqlite',
      message: `not available; Node >= ${MIN_NODE.major}.${MIN_NODE.minor} is required for the local cache`,
    };
  }
}

function checkCacheDir(config: Config): DoctorCheck {
  const probe = path.join(config.cacheDir, `.rw-doctor-${process.pid}`);
  try {
    mkdirSync(config.cacheDir, { recursive: true });
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return { id: 'cache_dir', level: 'ok', title: 'cache directory', message: `${config.cacheDir} is writable` };
  } catch {
    return {
      id: 'cache_dir',
      level: 'warn',
      title: 'cache directory',
      message: `${config.cacheDir} is not writable; an in-memory cache will be used (set RECYCLEWHEEL_CACHE_DIR)`,
    };
  }
}

interface Probe {
  id: string;
  title: string;
  url: string;
  method: 'GET' | 'HEAD';
}

const PROBES: readonly Probe[] = [
  { id: 'net_github', title: 'network: api.github.com', url: 'https://api.github.com/rate_limit', method: 'GET' },
  { id: 'net_npm', title: 'network: registry.npmjs.org', url: 'https://registry.npmjs.org/-/ping', method: 'GET' },
  { id: 'net_pypi', title: 'network: pypi.org', url: 'https://pypi.org/pypi/pip/json', method: 'HEAD' },
  { id: 'net_depsdev', title: 'network: api.deps.dev', url: 'https://api.deps.dev/v3/systems/npm/packages/left-pad', method: 'HEAD' },
  {
    id: 'net_mcp_registry',
    title: 'network: registry.modelcontextprotocol.io',
    url: 'https://registry.modelcontextprotocol.io/v0.1/servers?limit=1',
    method: 'HEAD',
  },
  { id: 'net_huggingface', title: 'network: huggingface.co', url: 'https://huggingface.co/api/models?limit=1', method: 'HEAD' },
];

async function runProbe(
  probe: Probe,
  doFetch: typeof globalThis.fetch,
  timeoutMs: number,
  token: string | undefined,
): Promise<DoctorCheck> {
  const headers: Record<string, string> = { 'user-agent': `recyclewheel-doctor/${VERSION}`, accept: 'application/json' };
  if (token !== undefined && probe.id === 'net_github') headers.authorization = `Bearer ${token}`;
  const started = Date.now();
  try {
    const res = await doFetch(probe.url, {
      method: probe.method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - started;
    let extra = '';
    if (probe.id === 'net_github' && res.ok) {
      try {
        const body = (await res.json()) as { resources?: Record<string, { remaining?: number; limit?: number }> };
        const core = body.resources?.core;
        const search = body.resources?.search;
        if (core?.remaining !== undefined && search?.remaining !== undefined) {
          extra = `; core ${core.remaining}/${core.limit ?? '?'}, search ${search.remaining}/${search.limit ?? '?'} remaining`;
        }
      } catch {
        // Reachability is what matters.
      }
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    if (res.status >= 500) {
      return { id: probe.id, level: 'warn', title: probe.title, message: `HTTP ${res.status} (${ms} ms)` };
    }
    return { id: probe.id, level: 'ok', title: probe.title, message: `reachable, HTTP ${res.status} (${ms} ms)${extra}` };
  } catch {
    return {
      id: probe.id,
      level: 'warn',
      title: probe.title,
      message: 'not reachable; searches will use cached data or report a degraded result',
    };
  }
}

/**
 * Human-oriented environment check. Never throws. Warnings do not change the
 * exit code (an offline machine is still a valid setup); only a missing Node
 * feature does.
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const config = loadConfig(env, opts.cwd !== undefined ? { cwd: opts.cwd } : {});
  const checks: DoctorCheck[] = [];
  const runGh = opts.runGh ?? defaultRunGh;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  checks.push({
    id: 'node',
    level: nodeMeetsMinimum(nodeVersion) ? 'ok' : 'fail',
    title: 'node',
    message: nodeMeetsMinimum(nodeVersion)
      ? `v${nodeVersion} (>= ${MIN_NODE.major}.${MIN_NODE.minor} required)`
      : `v${nodeVersion} is too old; Node >= ${MIN_NODE.major}.${MIN_NODE.minor} is required`,
  });
  checks.push(checkSqlite());
  checks.push(checkCacheDir(config));

  for (const w of config.warnings) {
    checks.push({ id: 'config', level: 'warn', title: 'configuration', message: w });
  }

  // gh CLI presence (optional) and token resolution.
  let ghFound = false;
  try {
    const out = await runGh(['--version'], { timeoutMs: 3000 });
    ghFound = true;
    checks.push({ id: 'gh', level: 'ok', title: 'gh CLI', message: out.split(/\r?\n/)[0]?.trim() || 'found' });
  } catch {
    checks.push({
      id: 'gh',
      level: 'info',
      title: 'gh CLI',
      message: 'not found (optional; GITHUB_TOKEN or GH_TOKEN also work)',
    });
  }

  const provider = createGithubTokenProvider({
    env,
    noGhCli: config.noGhCli,
    runGh,
  });
  const auth = await provider.resolve();
  if (auth.source === 'none') {
    checks.push({
      id: 'github_token',
      level: 'warn',
      title: 'GitHub token',
      message: `none found; GitHub search is limited to 10 requests/min and code search is disabled${
        ghFound && !config.noGhCli ? ' (run `gh auth login` or set GITHUB_TOKEN)' : ' (set GITHUB_TOKEN)'
      }`,
    });
  } else {
    checks.push({
      id: 'github_token',
      level: 'ok',
      title: 'GitHub token',
      message: auth.source === 'env' ? 'from environment (GITHUB_TOKEN/GH_TOKEN)' : 'from `gh auth token`',
    });
  }

  let ledgerLink: string | undefined;
  try {
    ledgerLink = ledgerPathProblem(config.projectRoot);
  } catch (err) {
    ledgerLink = err instanceof Error ? err.message : String(err);
  }
  if (ledgerLink !== undefined) {
    checks.push({
      id: 'ledger_path',
      level: 'warn',
      title: 'ledger location',
      message: `${ledgerLink}; the ledger will not be read or written until the link is removed`,
    });
  }
  checks.push({
    id: 'project_root',
    level: 'info',
    title: 'project root',
    message: `${config.projectRoot} (ledger: ${path.join(config.projectRoot, LEDGER_DIR, 'ledger.jsonl')})`,
  });

  // Remote cache.
  if (config.remoteCacheMode === 'off' || config.remoteCacheUrl === undefined) {
    checks.push({ id: 'remote_cache', level: 'info', title: 'remote cache', message: 'off (default)' });
  } else if (config.offline || opts.network === false) {
    checks.push({
      id: 'remote_cache',
      level: 'info',
      title: 'remote cache',
      message: `${config.remoteCacheMode} at ${remoteHost(config.remoteCacheUrl) ?? 'configured host'} (health check skipped)`,
    });
  } else {
    let healthy = false;
    try {
      const res = await doFetch(`${config.remoteCacheUrl}/v1/health`, {
        signal: AbortSignal.timeout(Math.min(timeoutMs, REMOTE_HEALTH_TIMEOUT_MS * 2)),
      });
      healthy = res.ok;
    } catch {
      healthy = false;
    }
    checks.push({
      id: 'remote_cache',
      level: healthy ? 'ok' : 'warn',
      title: 'remote cache',
      message: `${config.remoteCacheMode} at ${remoteHost(config.remoteCacheUrl) ?? 'configured host'}: ${
        healthy ? 'healthy' : 'not reachable (requests fall back to upstream)'
      }`,
    });
  }

  // Network probes.
  if (config.offline) {
    checks.push({
      id: 'network',
      level: 'info',
      title: 'network',
      message: 'skipped (RECYCLEWHEEL_OFFLINE is set)',
    });
  } else if (opts.network === false) {
    checks.push({ id: 'network', level: 'info', title: 'network', message: 'skipped (--no-network)' });
  } else {
    const token = await provider.getToken();
    const probed = await Promise.all(PROBES.map((p) => runProbe(p, doFetch, timeoutMs, token)));
    checks.push(...probed);
  }

  // Every string leaves through here (text and --json): mask secret env values and GitHub tokens (L-G).
  const secrets = collectSecrets(env);
  const scrub = (text: string): string => maskSecrets(redactGithubToken(text), secrets);
  const masked = checks.map((c) => ({ ...c, title: scrub(c.title), message: scrub(c.message) }));
  const failed = masked.some((c) => c.level === 'fail');
  return { checks: masked, exitCode: failed ? 1 : 0 };
}

const LEVEL_LABEL: Record<CheckLevel, string> = {
  ok: '[ ok ]',
  warn: '[warn]',
  fail: '[FAIL]',
  info: '[info]',
};

export function formatDoctor(report: DoctorReport): string {
  const lines = [`recyclewheel ${VERSION} doctor`, ''];
  for (const c of report.checks) {
    lines.push(`${LEVEL_LABEL[c.level]} ${c.title}: ${c.message}`);
  }
  const warns = report.checks.filter((c) => c.level === 'warn').length;
  const fails = report.checks.filter((c) => c.level === 'fail').length;
  lines.push('', `${fails} failed, ${warns} warning(s). ${report.exitCode === 0 ? 'Ready.' : 'Fix the failed checks first.'}`);
  return redactGithubToken(lines.join('\n'));
}
