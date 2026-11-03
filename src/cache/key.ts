/**
 * Cache keys and URL hygiene (docs/PLAN.md §9.1).
 *
 * The key never contains secrets: secret query parameters and URL userinfo are
 * dropped before hashing, and `redactUrl` is the only form of a URL that may be
 * stored in `url_redacted` or written to logs.
 */
import { createHash } from 'node:crypto';

/** Query parameter names (case-insensitive) that carry credentials. */
export const SECRET_PARAMS: readonly string[] = [
  'api_key',
  'access_token',
  'token',
  'client_secret',
  'key',
];

export const REDACTED = 'REDACTED';

/** Hosts the HTTP client may contact (SSRF and misuse guard). Exact match, https only. */
export const ALLOWED_HOSTS: readonly string[] = [
  'api.github.com',
  'registry.npmjs.org',
  'api.npmjs.org',
  'pypi.org',
  'api.deps.dev',
  'registry.modelcontextprotocol.io',
  'libraries.io',
  'huggingface.co',
];

const SECRET_SET: ReadonlySet<string> = new Set(SECRET_PARAMS);
const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_HOSTS);
const SECRET_QUERY_FALLBACK = new RegExp(`([?&](?:${SECRET_PARAMS.join('|')})=)[^&#]*`, 'gi');

function isSecretParam(name: string): boolean {
  return SECRET_SET.has(name.toLowerCase());
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical form used for hashing: lowercase scheme and host, default port,
 * fragment and userinfo removed, secret parameters removed, remaining
 * parameters sorted by name then value, percent-escapes in the path uppercased.
 * Throws `TypeError` when `url` is not a parseable absolute URL.
 */
export function normalizeUrl(url: string): string {
  const u = new URL(url);
  const pairs = [...u.searchParams].filter(([name]) => !isSecretParam(name));
  pairs.sort(([an, av], [bn, bv]) => compare(an, bn) || compare(av, bv));
  const query = new URLSearchParams(pairs).toString();
  const path = u.pathname.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
  return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`;
}

/** `sha256hex("rw1|" + normalizeUrl(url))`. Authentication is deliberately not part of the key. */
export function cacheKey(url: string): string {
  return createHash('sha256').update(`rw1|${normalizeUrl(url)}`).digest('hex');
}

/**
 * The URL with secret parameter values replaced by `REDACTED`, userinfo and
 * fragment removed. Never throws: unparseable input falls back to a pattern
 * replacement.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.hash = '';
    for (const name of new Set(u.searchParams.keys())) {
      if (isSecretParam(name)) u.searchParams.set(name, REDACTED);
    }
    return u.toString();
  } catch {
    return url.replace(SECRET_QUERY_FALLBACK, `$1${REDACTED}`);
  }
}

export function isAllowedHost(hostname: string): boolean {
  return ALLOWED_SET.has(hostname.toLowerCase());
}

/**
 * Parses `url` and returns it only when it may be requested: https, allowlisted
 * host (exact match), default port, no userinfo. Otherwise `undefined`.
 */
export function parseAllowedUrl(url: string): URL | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') {
    return undefined;
  }
  return isAllowedHost(u.hostname) ? u : undefined;
}
