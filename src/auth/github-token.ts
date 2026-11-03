/**
 * GitHub token resolution (docs/PLAN.md §9.5).
 *
 * Priority: GITHUB_TOKEN -> GH_TOKEN -> `gh auth token` (unless
 * RECYCLEWHEEL_NO_GH_CLI is truthy). The token lives only in memory and is only
 * ever used for the Authorization header (attached by the HTTP client). It must
 * never reach logs, tool output, the cache, or a remote cache.
 *
 * Defense in depth: the `token` property of a result is non-enumerable, so
 * JSON.stringify, object spread and util.inspect never expose it by accident.
 * Use `redactGithubToken` on any text that might embed a token.
 */
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';

export type GithubTokenSource = 'env' | 'gh_cli' | 'none';

export interface GithubTokenResult {
  /** Where the token came from; the only part that is safe to show (rw_status). */
  readonly source: GithubTokenSource;
  /** The secret. Non-enumerable: invisible to JSON.stringify, spread and inspect. */
  readonly token: string | undefined;
}

/**
 * Runs `gh` with the given args and resolves with its stdout. Rejects on a
 * non-zero exit, spawn failure or timeout. Injectable so tests never spawn gh.
 */
export type RunGh = (args: readonly string[], opts: { timeoutMs: number }) => Promise<string>;

export interface GetGithubTokenOptions {
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * Overrides `RECYCLEWHEEL_NO_GH_CLI` from `env` (pass `config.noGhCli`).
   * true disables the `gh auth token` fallback.
   */
  noGhCli?: boolean;
  /** Defaults to a `child_process.execFile('gh', ...)` runner (no shell). */
  runGh?: RunGh;
  /** `gh auth token` timeout. Default 3000. */
  timeoutMs?: number;
}

export interface GithubTokenProvider {
  /** Memoized for the provider's lifetime, including a negative result: gh runs at most once. */
  resolve(): Promise<GithubTokenResult>;
  /** Shape of the HTTP client's `token` option. */
  getToken(): Promise<string | undefined>;
  hasToken(): Promise<boolean>;
}

const DEFAULT_GH_TIMEOUT_MS = 3000;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
/** Printable ASCII, no whitespace: a header-safe token. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,512}$/;

// ghp_/gho_/ghu_/ghs_/ghr_ classic and OAuth tokens, github_pat_ fine-grained PATs.
const TOKEN_PATTERN = /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g;

/** Replaces GitHub token lookalikes (and the exact `knownToken`, if given) with `[REDACTED]`. */
export function redactGithubToken(text: string, knownToken?: string): string {
  let out = text.replace(TOKEN_PATTERN, '[REDACTED]');
  if (knownToken) out = out.split(knownToken).join('[REDACTED]');
  return out;
}

function makeResult(source: GithubTokenSource, token?: string): GithubTokenResult {
  const result = { source } as { source: GithubTokenSource; token?: string };
  Object.defineProperty(result, 'token', { value: token, enumerable: false });
  return result as unknown as GithubTokenResult;
}

function cleanToken(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  return t !== undefined && TOKEN_SHAPE.test(t) ? t : undefined;
}

function isNoGhCli(env: NodeJS.ProcessEnv): boolean {
  const raw = env.RECYCLEWHEEL_NO_GH_CLI?.trim().toLowerCase();
  return raw !== undefined && TRUE_VALUES.has(raw);
}

/**
 * A directory that is not the (possibly untrusted) project being worked on:
 * on Windows, a `gh.exe` in the current directory would otherwise win the
 * executable search, and its stdout is used as the token.
 */
function neutralCwd(): string {
  try {
    return homedir() || tmpdir();
  } catch {
    return tmpdir();
  }
}

const defaultRunGh: RunGh = (args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      [...args],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
        cwd: neutralCwd(),
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          NoDefaultCurrentDirectoryInExePath: '1',
        },
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('gh auth token timed out')), ms);
    timer.unref();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One-shot resolution. Never throws; a failure of any step falls through to the next. */
export async function getGithubToken(opts: GetGithubTokenOptions = {}): Promise<GithubTokenResult> {
  const env = opts.env ?? process.env;

  const fromEnv = cleanToken(env.GITHUB_TOKEN) ?? cleanToken(env.GH_TOKEN);
  if (fromEnv !== undefined) return makeResult('env', fromEnv);

  if (opts.noGhCli ?? isNoGhCli(env)) return makeResult('none');

  const timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  const runGh = opts.runGh ?? defaultRunGh;
  try {
    // --hostname pins github.com so a GH_HOST/GHES token is never sent to api.github.com.
    const stdout = await withTimeout(runGh(['auth', 'token', '--hostname', 'github.com'], { timeoutMs }), timeoutMs);
    const token = cleanToken(stdout);
    if (token !== undefined) return makeResult('gh_cli', token);
  } catch {
    // gh missing, not logged in, or timed out: no token. The error text is deliberately dropped.
  }
  return makeResult('none');
}

/** Resolves lazily and at most once (so `gh auth token` runs at most once per process). */
export function createGithubTokenProvider(opts: GetGithubTokenOptions = {}): GithubTokenProvider {
  let pending: Promise<GithubTokenResult> | undefined;
  const resolve = (): Promise<GithubTokenResult> => (pending ??= getGithubToken(opts));
  return {
    resolve,
    getToken: async () => (await resolve()).token,
    hasToken: async () => (await resolve()).token !== undefined,
  };
}
