/**
 * Caching HTTP client (docs/PLAN.md §9.3).
 *
 * Lookup order: local fresh -> offline -> remote -> rate-limit pre-block ->
 * upstream (conditional request, one retry). `getJson` never throws and never
 * puts a message in the result, so secrets cannot leak through errors; failures
 * are reported through `HttpResult.error` and `status` only.
 *
 * Extra headers this client guarantees on results (adapters may rely on them):
 * - rate-limited results (`error: 'rate_limited'`, or a stale result served
 *   because of a rate limit) carry `x-ratelimit-limit`, `x-ratelimit-remaining`,
 *   `x-ratelimit-reset` (epoch SECONDS) and `retry-after` (seconds from now).
 * - cache hits only carry `etag` and `last-modified` (the cache stores nothing
 *   else), so e.g. `link` is only present on live results.
 */
import { cacheKey, parseAllowedUrl, redactUrl } from '../cache/key.js';
import { CONDITIONAL_HEADER_PATTERN } from '../cache/remote.js';
import type {
  CacheEntry,
  CacheStore,
  Config,
  HttpClient,
  HttpRequestOptions,
  HttpResult,
  Provenance,
  RateLimitState,
  RemoteCache,
  TtlClass,
} from '../types.js';
import {
  blockedStateFor,
  blockedUntil,
  isRateLimited,
  rateLimitHeaders,
  rateLimitResource,
  readRateLimitState,
} from './ratelimit.js';

const HOUR_MS = 3_600_000;

/** Fresh TTL per class (§9.3). */
export const TTL_MS: Readonly<Record<TtlClass, number>> = {
  search: 12 * HOUR_MS,
  repo: 6 * HOUR_MS,
  repo_aux: 24 * HOUR_MS,
  package: 24 * HOUR_MS,
  downloads: 24 * HOUR_MS,
  depsdev: 72 * HOUR_MS,
  registry: 24 * HOUR_MS,
};
/** TTL of a cached 404. */
export const NEGATIVE_TTL_MS = HOUR_MS;
/** How long past `expires_at` an entry may still be served on errors and rate limits. */
export const MAX_STALE_MS = 7 * 24 * HOUR_MS;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 1_500;
const DEFAULT_RETRY_DELAY_MS = 500;
const CIRCUIT_FAILURES = 3;
const CIRCUIT_OPEN_MS = 5 * 60_000;
const MAX_REDIRECTS = 3;
const MAX_SHARE_BYTES = 1_000_000;
/** Upper bound for an upstream response body. */
export const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
/** Largest valid JS Date (epoch ms). */
const MAX_EPOCH_MS = 8.64e15;
const GITHUB_HOST = 'api.github.com';
const DEFAULT_USER_AGENT = 'recyclewheel/0.1.0 (+https://github.com/recyclewheel/recyclewheel)';

type HttpError = NonNullable<HttpResult['error']>;

export interface HttpClientOptions {
  store: CacheStore;
  remote: RemoteCache;
  /** Only `offline` is read. */
  config: Pick<Config, 'offline'>;
  /** Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Resolves the GitHub token. Called only for `auth: true` requests to api.github.com. */
  token?: () => Promise<string | undefined>;
  /** Clock; `Date` or epoch ms. Defaults to `Date.now`. */
  now?: () => Date | number;
  /** Defaults to `recyclewheel/0.1.0 (+https://github.com/recyclewheel/recyclewheel)`. */
  userAgent?: string;
  /**
   * Applied to an entry before it is uploaded to the remote cache; return
   * `undefined` to skip the upload. `url_redacted` is already blank.
   */
  sanitize?: (entry: CacheEntry) => CacheEntry | undefined;
  /** Upstream timeout per attempt. Default 10000. */
  timeoutMs?: number;
  /** Remote get/put timeout. Default 1500. */
  remoteTimeoutMs?: number;
  /** Delay before the single retry. Default 500. */
  retryDelayMs?: number;
}

interface Outcome {
  status: number;
  /** JSON text parsed per caller, or null when there is no data. */
  body: string | null;
  headers: Record<string, string>;
  provenance: Provenance;
  fetchedAt: number;
  error?: HttpError;
}

type Raw =
  | { kind: 'response'; status: number; headers: Record<string, string>; text: string }
  | { kind: 'error'; error: 'network' | 'timeout' | 'http' };

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** A finite epoch-ms value that `new Date()` can render. */
function isEpochMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_EPOCH_MS;
}

/** A stored validator that is safe to send back as a header value (printable ASCII, 1-256 chars). */
function isHeaderToken(v: unknown): v is string {
  return typeof v === 'string' && CONDITIONAL_HEADER_PATTERN.test(v);
}

/** Entries with unusable timestamps are treated as a cache miss. */
function usable(entry: CacheEntry | undefined): CacheEntry | undefined {
  if (entry === undefined) return undefined;
  if (!isSuccess(entry.status) && entry.status !== 404) return undefined;
  return isEpochMs(entry.fetched_at) && isEpochMs(entry.expires_at) ? entry : undefined;
}

function fromEntry(e: CacheEntry, provenance: Provenance, extra: Record<string, string> = {}): Outcome {
  const headers: Record<string, string> = {};
  if (e.etag) headers.etag = e.etag;
  if (e.last_modified) headers['last-modified'] = e.last_modified;
  return {
    status: e.status,
    body: e.status === 404 ? null : e.body,
    headers: { ...headers, ...extra },
    provenance,
    fetchedAt: e.fetched_at,
  };
}

function failure(
  error: HttpError,
  status: number,
  at: number,
  headers: Record<string, string> = {},
): Outcome {
  return { status, body: null, headers, provenance: 'live', fetchedAt: at, error };
}

function safeIso(ms: number): string {
  return new Date(isEpochMs(ms) ? ms : Date.now()).toISOString();
}

function toResult<T>(o: Outcome): HttpResult<T> {
  let data: T | null = null;
  let error = o.error;
  if (o.body !== null) {
    try {
      data = JSON.parse(o.body) as T | null;
    } catch {
      error ??= 'http';
    }
  }
  const result: HttpResult<T> = {
    status: o.status,
    data,
    headers: { ...o.headers },
    provenance: o.provenance,
    fetched_at: safeIso(o.fetchedAt),
  };
  if (error !== undefined) result.error = error;
  return result;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref();
    Promise.resolve()
      .then(run)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the body as UTF-8 text; `undefined` when it exceeds `cap` bytes (declared or streamed). */
async function readCapped(res: Response, cap: number): Promise<string | undefined> {
  const declared = res.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > cap) {
    void res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function responseHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

export function createHttpClient(o: HttpClientOptions): HttpClient {
  const { store, remote } = o;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const remoteTimeoutMs = o.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  const retryDelayMs = o.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const userAgent = o.userAgent ?? DEFAULT_USER_AGENT;
  const clock = (): number => {
    const v = (o.now ?? Date.now)();
    return typeof v === 'number' ? v : v.getTime();
  };
  const doFetch: typeof globalThis.fetch = (input, init) => (o.fetch ?? globalThis.fetch)(input, init);
  const inflight = new Map<string, Promise<Outcome>>();

  // Cache failures never fail a request.
  const cacheGet = (key: string): CacheEntry | undefined => {
    try {
      return usable(store.get(key));
    } catch {
      return undefined;
    }
  };
  const cachePut = (e: CacheEntry): void => {
    try {
      store.put(e);
    } catch {
      /* ignored: caching is best effort */
    }
  };
  const getLimit = (resource: string): RateLimitState | undefined => {
    try {
      return store.getRateLimit(resource);
    } catch {
      return undefined;
    }
  };
  const setLimit = (s: RateLimitState): void => {
    try {
      store.setRateLimit(s);
    } catch {
      /* ignored: caching is best effort */
    }
  };

  // Remote circuit breaker: 3 consecutive failures -> unused for 5 minutes.
  let remoteFailures = 0;
  let remoteOpenUntil = 0;
  const remoteUsable = (t: number): boolean => remote.mode !== 'off' && t >= remoteOpenUntil;
  const remoteSucceeded = (): void => {
    remoteFailures = 0;
  };
  const remoteFailed = (): void => {
    remoteFailures += 1;
    if (remoteFailures >= CIRCUIT_FAILURES) remoteOpenUntil = clock() + CIRCUIT_OPEN_MS;
  };

  async function lookupRemote(
    key: string,
    url: string,
    opts: HttpRequestOptions,
    t: number,
  ): Promise<CacheEntry | undefined> {
    if (!remoteUsable(t)) return undefined;
    let found: CacheEntry | undefined;
    try {
      found = await withTimeout(() => remote.get(key), remoteTimeoutMs);
    } catch {
      remoteFailed();
      return undefined;
    }
    remoteSucceeded();
    if (found === undefined) return undefined;
    // The remote is untrusted: a malformed entry is a cache miss, never an exception.
    let entry: CacheEntry;
    try {
      const okStatus = found.status === 200 || found.status === 404;
      if (
        !okStatus ||
        typeof found.body !== 'string' ||
        !isEpochMs(found.fetched_at) ||
        !isEpochMs(found.expires_at) ||
        Buffer.byteLength(found.body) > MAX_SHARE_BYTES ||
        (found.status === 200 && !isJson(found.body))
      ) {
        return undefined;
      }
      // A remote entry cannot claim a fetch time in the future, nor pin itself
      // beyond what this request class allows counted from that fetch time.
      const fetchedAt = Math.min(found.fetched_at, t);
      const expiresAt = Math.min(
        found.expires_at,
        fetchedAt + (found.status === 404 ? NEGATIVE_TTL_MS : TTL_MS[opts.ttlClass]),
      );
      if (expiresAt <= t) return undefined;
      entry = {
        ...found,
        key,
        url_redacted: redactUrl(url),
        source: opts.source,
        fetched_at: fetchedAt,
        expires_at: expiresAt,
        provenance: 'remote_cache',
      };
      // etag / last_modified are replayed as conditional request headers: a value
      // the remote could use to smuggle CR/LF or oversized data is dropped (the
      // entry itself stays usable).
      if (!isHeaderToken(entry.etag)) delete entry.etag;
      if (!isHeaderToken(entry.last_modified)) delete entry.last_modified;
    } catch {
      return undefined;
    }
    cachePut(entry);
    return entry;
  }

  function share(entry: CacheEntry, opts: HttpRequestOptions): void {
    if (!opts.shareable || remote.mode !== 'readwrite' || opts.source === 'librariesio') return;
    if (!remoteUsable(clock()) || Buffer.byteLength(entry.body) > MAX_SHARE_BYTES) return;
    let outgoing: CacheEntry | undefined = { ...entry, url_redacted: '' };
    try {
      if (o.sanitize) outgoing = o.sanitize(outgoing);
    } catch {
      outgoing = undefined;
    }
    if (outgoing === undefined) return;
    const payload = outgoing;
    withTimeout(() => remote.put(payload), remoteTimeoutMs).then(remoteSucceeded, remoteFailed);
  }

  async function resolveToken(u: URL, opts: HttpRequestOptions): Promise<string | undefined> {
    if (!opts.auth || u.hostname !== GITHUB_HOST || !o.token) return undefined;
    try {
      const token = await o.token();
      return token ? token : undefined;
    } catch {
      return undefined;
    }
  }

  async function fetchOnce(start: URL, startHeaders: Record<string, string>): Promise<Raw> {
    const signal = AbortSignal.timeout(timeoutMs);
    let current = start;
    let headers = startHeaders;
    for (let hop = 0; ; hop += 1) {
      let res: Response;
      try {
        res = await doFetch(current.href, { method: 'GET', headers, redirect: 'manual', signal });
      } catch {
        return { kind: 'error', error: signal.aborted ? 'timeout' : 'network' };
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers.get('location');
        void res.body?.cancel().catch(() => undefined);
        let next: URL | undefined;
        if (location !== null && hop < MAX_REDIRECTS) {
          try {
            next = parseAllowedUrl(new URL(location, current).href);
          } catch {
            next = undefined;
          }
        }
        if (next === undefined) {
          return { kind: 'response', status: res.status, headers: responseHeaders(res), text: '' };
        }
        if (next.hostname !== GITHUB_HOST && headers.authorization !== undefined) {
          headers = { ...headers };
          delete headers.authorization;
        }
        current = next;
        continue;
      }
      try {
        const text = await readCapped(res, MAX_UPSTREAM_BYTES);
        if (text === undefined) return { kind: 'error', error: 'http' };
        return { kind: 'response', status: res.status, headers: responseHeaders(res), text };
      } catch {
        return { kind: 'error', error: signal.aborted ? 'timeout' : 'network' };
      }
    }
  }

  async function fetchWithRetry(url: URL, headers: Record<string, string>): Promise<Raw> {
    const first = await fetchOnce(url, headers);
    const retryable =
      first.kind === 'error' ? first.error === 'network' : first.status >= 500 && first.status < 600;
    if (!retryable) return first;
    await sleep(retryDelayMs);
    return fetchOnce(url, headers);
  }

  async function resolveRequest(
    url: string,
    u: URL,
    opts: HttpRequestOptions,
    key: string,
  ): Promise<Outcome> {
    const t0 = clock();
    const cached = cacheGet(key);

    // 1. local fresh
    if (cached && cached.expires_at > t0) {
      return fromEntry(cached, cached.provenance === 'remote_cache' ? 'remote_cache' : 'local_cache');
    }

    const staleFor = (t: number, extra: Record<string, string> = {}): Outcome | undefined =>
      cached && t - cached.expires_at <= MAX_STALE_MS
        ? fromEntry(cached, 'stale_cache', extra)
        : undefined;

    // 2. offline: any stale entry, else error
    if (o.config.offline) {
      return cached ? fromEntry(cached, 'stale_cache') : failure('offline', 0, t0);
    }

    // 3. remote
    const remoteHit = await lookupRemote(key, url, opts, t0);
    if (remoteHit) return fromEntry(remoteHit, 'remote_cache');

    // 4. rate-limit pre-block
    const token = await resolveToken(u, opts);
    const resource = rateLimitResource(u, token !== undefined);
    const t1 = clock();
    const known = getLimit(resource);
    if (known !== undefined && blockedUntil(known, t1) !== undefined) {
      const extra = rateLimitHeaders(known, t1);
      return staleFor(t1, extra) ?? failure('rate_limited', 429, t1, extra);
    }

    // 5. upstream
    const isGithub = u.hostname === GITHUB_HOST;
    const headers: Record<string, string> = {
      accept: opts.accept ?? (isGithub ? 'application/vnd.github+json' : 'application/json'),
      'user-agent': userAgent,
    };
    if (isGithub) headers['x-github-api-version'] = '2022-11-28';
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    // A row that came from the remote cache is someone else's copy: revalidating it with its (also remote) validators
    // would turn that copy into "live" on a 304. Without conditional headers the origin sends the body itself.
    if (cached && isSuccess(cached.status) && cached.provenance !== 'remote_cache') {
      if (isHeaderToken(cached.etag)) headers['if-none-match'] = cached.etag;
      if (isHeaderToken(cached.last_modified)) headers['if-modified-since'] = cached.last_modified;
    }

    const raw = await fetchWithRetry(u, headers);
    const t2 = clock();
    if (raw.kind === 'error') {
      return staleFor(t2) ?? failure(raw.error, 0, t2);
    }
    const { status, headers: resHeaders } = raw;

    // 6. rate-limit bookkeeping
    const recordedAs = rateLimitResource(u, token !== undefined, resHeaders);
    const announced = readRateLimitState(resHeaders, t2, recordedAs);
    if (isRateLimited(status, resHeaders)) {
      const blocked = blockedStateFor(announced, resHeaders, t2, recordedAs);
      setLimit(blocked);
      const extra = rateLimitHeaders(blocked, t2);
      return staleFor(t2, extra) ?? failure('rate_limited', 429, t2, { ...resHeaders, ...extra });
    }
    if (announced !== undefined) setLimit(announced);

    if (status === 304) {
      if (!cached || !isSuccess(cached.status)) return failure('http', status, t2, resHeaders);
      const expiresAt = t2 + TTL_MS[opts.ttlClass];
      try {
        store.touch(key, expiresAt);
      } catch {
        /* ignored: caching is best effort */
      }
      return { ...fromEntry(cached, 'live'), headers: resHeaders, fetchedAt: t2 };
    }

    if (isSuccess(status)) {
      if (!isJson(raw.text)) return staleFor(t2) ?? failure('http', status, t2, resHeaders);
      const entry: CacheEntry = {
        key,
        url_redacted: redactUrl(url),
        source: opts.source,
        status,
        body: raw.text,
        fetched_at: t2,
        expires_at: t2 + TTL_MS[opts.ttlClass],
        provenance: 'live',
      };
      const etag = resHeaders.etag;
      const lastModified = resHeaders['last-modified'];
      if (etag) entry.etag = etag;
      if (lastModified) entry.last_modified = lastModified;
      cachePut(entry);
      share(entry, opts);
      return { status, body: raw.text, headers: resHeaders, provenance: 'live', fetchedAt: t2 };
    }

    if (status === 404) {
      const entry: CacheEntry = {
        key,
        url_redacted: redactUrl(url),
        source: opts.source,
        status: 404,
        body: 'null',
        fetched_at: t2,
        expires_at: t2 + NEGATIVE_TTL_MS,
        provenance: 'live',
      };
      cachePut(entry);
      share(entry, opts);
      return { status, body: null, headers: resHeaders, provenance: 'live', fetchedAt: t2 };
    }

    if (status >= 500) return staleFor(t2) ?? failure('http', status, t2, resHeaders);
    return failure('http', status, t2, resHeaders);
  }

  function run(url: string, opts: HttpRequestOptions): Promise<Outcome> {
    const u = parseAllowedUrl(url);
    if (u === undefined) return Promise.resolve(failure('http', 0, clock()));
    const key = cacheKey(url);
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = resolveRequest(url, u, opts, key)
      .catch(() => failure('network', 0, clock()))
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    async getJson<T = unknown>(url: string, opts: HttpRequestOptions): Promise<HttpResult<T>> {
      return toResult<T>(await run(url, opts));
    },
  };
}
