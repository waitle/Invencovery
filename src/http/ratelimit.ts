/**
 * Rate-limit awareness for the HTTP client (docs/PLAN.md §9.3 steps 4 and 6).
 *
 * Pure helpers. All timestamps are epoch milliseconds except the
 * `x-ratelimit-reset` header, which follows GitHub and is epoch seconds.
 * Response header maps are expected to have lowercase names.
 */
import type { RateLimitState } from '../types.js';

type HeaderMap = Readonly<Record<string, string>>;

/** Block duration when a 429 carries no usable reset information. */
export const DEFAULT_BACKOFF_MS = 60_000;
/** Upper bound for any recorded block, so a bad header cannot disable a source for long. */
export const MAX_BACKOFF_MS = 24 * 3_600_000;

const GITHUB_HOST = 'api.github.com';

function githubBucket(pathname: string): string {
  if (pathname === '/search/code' || pathname.startsWith('/search/code/')) return 'code_search';
  if (pathname.startsWith('/search/')) return 'search';
  return 'core';
}

/**
 * Name of the rate-limit bucket a request counts against: `github:search`,
 * `github:code_search`, `github:core`, `librariesio`, `npm`, `pypi`, `depsdev`,
 * `mcp_registry`, `huggingface`. Unauthenticated GitHub requests get an `:anon` suffix because
 * GitHub tracks them separately (a token added later must not inherit a
 * block recorded while anonymous). When `responseHeaders` has
 * `x-ratelimit-resource` it names the GitHub bucket.
 */
export function rateLimitResource(
  url: URL,
  authenticated: boolean,
  responseHeaders?: HeaderMap,
): string {
  switch (url.hostname) {
    case GITHUB_HOST: {
      const reported = responseHeaders?.['x-ratelimit-resource']?.trim().toLowerCase();
      const bucket =
        reported !== undefined && /^[a-z0-9_]{1,32}$/.test(reported)
          ? reported
          : githubBucket(url.pathname);
      return `github:${bucket}${authenticated ? '' : ':anon'}`;
    }
    case 'libraries.io':
      return 'librariesio';
    case 'api.deps.dev':
      return 'depsdev';
    case 'registry.npmjs.org':
    case 'api.npmjs.org':
      return 'npm';
    case 'pypi.org':
      return 'pypi';
    case 'registry.modelcontextprotocol.io':
      return 'mcp_registry';
    case 'huggingface.co':
      return 'huggingface';
    default:
      return url.hostname;
  }
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** `Retry-After` as a delay in ms: delta-seconds or an HTTP date. `undefined` when absent or invalid. */
export function parseRetryAfterMs(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

function clampReset(resetAt: number, nowMs: number): number {
  return Math.min(resetAt, nowMs + MAX_BACKOFF_MS);
}

/**
 * State announced by `x-ratelimit-{limit,remaining,reset}`. `reset` is epoch
 * seconds (GitHub); a value below 1e9 is read as seconds from now, one above
 * 1e11 as epoch milliseconds. `undefined` when remaining or reset is missing.
 */
export function readRateLimitState(
  headers: HeaderMap,
  nowMs: number,
  resource: string,
): RateLimitState | undefined {
  const remaining = toInt(headers['x-ratelimit-remaining']);
  const reset = toInt(headers['x-ratelimit-reset']);
  if (remaining === undefined || reset === undefined) return undefined;
  const resetAt = reset < 1e9 ? nowMs + reset * 1000 : reset < 1e11 ? reset * 1000 : reset;
  return {
    resource,
    limit: toInt(headers['x-ratelimit-limit']) ?? 0,
    remaining: Math.max(0, remaining),
    reset_at: clampReset(resetAt, nowMs),
    updated_at: nowMs,
  };
}

/**
 * 429 is always a rate limit; 403 only with evidence (`remaining=0` or a
 * `retry-after`), since a bare 403 is a permission problem.
 */
export function isRateLimited(status: number, headers: HeaderMap): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return toInt(headers['x-ratelimit-remaining']) === 0 || parseRetryAfterMs(headers['retry-after'], 0) !== undefined;
}

/**
 * The state to persist after a rate-limited response: `remaining=0` and a
 * `reset_at` in the future, taken from the reset header, `retry-after`, or a
 * default backoff.
 */
export function blockedStateFor(
  base: RateLimitState | undefined,
  headers: HeaderMap,
  nowMs: number,
  resource: string,
): RateLimitState {
  const retryAfter = parseRetryAfterMs(headers['retry-after'], nowMs);
  const candidates: number[] = [];
  if (base !== undefined && base.remaining <= 0) candidates.push(base.reset_at);
  if (retryAfter !== undefined) candidates.push(nowMs + retryAfter);
  let resetAt = Math.max(0, ...candidates);
  if (resetAt <= nowMs) resetAt = nowMs + DEFAULT_BACKOFF_MS;
  return {
    resource,
    limit: base?.limit ?? 0,
    remaining: 0,
    reset_at: clampReset(resetAt, nowMs),
    updated_at: nowMs,
  };
}

/** `reset_at` when requests against this bucket must not be sent now, else `undefined`. */
export function blockedUntil(state: RateLimitState | undefined, nowMs: number): number | undefined {
  if (state === undefined) return undefined;
  return state.remaining <= 0 && state.reset_at > nowMs ? state.reset_at : undefined;
}

/**
 * Headers describing a state, for results that never reached upstream.
 * `x-ratelimit-reset` is epoch seconds; `retry-after` is seconds from now.
 */
export function rateLimitHeaders(state: RateLimitState, nowMs: number): Record<string, string> {
  return {
    'x-ratelimit-limit': String(state.limit),
    'x-ratelimit-remaining': String(state.remaining),
    'x-ratelimit-reset': String(Math.ceil(state.reset_at / 1000)),
    'retry-after': String(Math.max(0, Math.ceil((state.reset_at - nowMs) / 1000))),
  };
}
