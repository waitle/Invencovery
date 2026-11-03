/**
 * Shared remote cache server (docs/PLAN.md §9.4): `node:http` + the local
 * `CacheStore`. Four endpoints, JSON only:
 *
 *   GET    /v1/health            -> 200 { ok } (+ version, entries for a caller with a valid token)
 *   GET    /v1/entries/{key}     -> 200 entry | 404           (read token if configured)
 *   PUT    /v1/entries/{key}     -> 204                       (write token required)
 *   DELETE /v1/entries/{key}     -> 204                       (write token required)
 *
 * Rules enforced here (the client is trusted no further than that):
 * - keys must be 64 lowercase hex characters (sha256), else 400;
 * - the request body is capped (413); the cached `body` is capped at
 *   `maxBodyBytes` (413); `status` must be 200 or 404 and `source` must be a
 *   shareable source (400); `expires_at - fetched_at` is clamped to `maxTtlSec`;
 * - every stored entry passes `sanitize` again (422 when it must not be
 *   stored) and is saved with `provenance: 'remote_cache'` and a blank
 *   `url_redacted`: the server never learns a URL;
 * - tokens are compared in constant time. Writes are disabled (403) when no
 *   write token is configured and refused with 403 for a missing or wrong
 *   token; reads are open unless a read token is configured (401). The write
 *   token also reads;
 * - per-IP token bucket (default 120 requests/minute), 429 with `Retry-After`.
 *   The client IP comes from the socket, or (behind a proxy) from
 *   `X-Forwarded-For` counted from the RIGHT by `trustedHops` (default 1): the
 *   entries appended by your own proxies are the only ones a client cannot forge.
 *   The bucket map is bounded (idle entries expire, then least recently used
 *   entries are evicted), so a flood of fake addresses cannot grow memory or
 *   lock out new clients. Failed authentication (401/403) draws from a second,
 *   stricter per-IP bucket (default 20 failures/minute) and then answers 429
 *   (that lockout also refuses a valid token from the locked-out address);
 *   a server-wide budget (default 600 failures/minute) turns further failed
 *   attempts into 429 as well, whatever their address. The token is compared
 *   first and the server-wide budget is spent only by a comparison that failed,
 *   so a valid token is never affected by it (checking the budget before the
 *   comparison would let anyone burn it to lock every legitimate client out).
 *   Consequently the server-wide budget caps the rate of failure answers, not
 *   the rate of guesses: a correct guess is accepted whatever the budget says.
 *   What makes guessing hopeless is the token itself, hence the 16-character
 *   minimum (`MIN_TOKEN_LENGTH`) enforced at start. Addresses are bucketed as
 *   IPv4, or as the /64 prefix for IPv6 (IPv4-mapped IPv6 counts as the IPv4
 *   address);
 * - the logger receives method, route template and status only: no token, key
 *   or body ever.
 *
 * The server is stateless apart from the `CacheStore` it opens: `DELETE` stores
 * an already-expired tombstone (the store has no per-key delete), which reads
 * as a miss and is removed by the store's housekeeping.
 *
 * Nothing here writes to stdout. Only erasable TypeScript syntax is used.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import type { AddressInfo } from 'node:net';
import { RemoteEntryWireSchema, isCacheKey } from '../cache/remote.js';
import { SHAREABLE_SOURCES, sanitize } from '../cache/sanitize.js';
import { openCacheStore } from '../cache/store.js';
import type { CacheEntry, StartCacheServer } from '../types.js';

export const DEFAULT_MAX_BODY_BYTES = 1_000_000;
export const DEFAULT_MAX_TTL_SEC = 7 * 24 * 60 * 60;
export const DEFAULT_RATE_LIMIT_PER_MIN = 120;
const DEFAULT_VERSION = '0.1.0';
/** Slack for the JSON envelope around the cached body. */
const ENVELOPE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TRACKED_CLIENTS = 10_000;
/** An idle bucket is fully refilled after a minute; keeping it longer than this has no value. */
const BUCKET_IDLE_TTL_MS = 10 * 60_000;
export const DEFAULT_AUTH_FAIL_LIMIT_PER_MIN = 20;
export const DEFAULT_GLOBAL_AUTH_FAIL_LIMIT_PER_MIN = 600;
const GLOBAL_BUCKET = '*';
export const DEFAULT_TRUSTED_HOPS = 1;
/** Shortest accepted write or read token; shorter ones are refused at start. */
export const MIN_TOKEN_LENGTH = 16;

export type CacheServerLogger = (level: 'info' | 'warn' | 'error', message: string) => void;

/** `StartCacheServer`'s options plus optional operational knobs. */
export type CacheServerOptions = Parameters<StartCacheServer>[0] & {
  /** Receives one line per request (no secrets) and lifecycle warnings. Default: silent. */
  logger?: CacheServerLogger;
  /** Requests per minute per client IP; `0` disables limiting. Default 120. */
  rateLimitPerMin?: number;
  /**
   * Take the client IP for rate limiting from `X-Forwarded-For`.
   * `true`: always (the server is reachable only through your proxy);
   * `false`: never; default: only when the direct peer is a loopback address
   * (a reverse proxy on the same host), which remote clients cannot spoof.
   */
  trustProxy?: boolean;
  /**
   * Number of proxies in front of the server that each append to
   * `X-Forwarded-For`. The client IP is the entry that many positions from the
   * right (1 = the last entry, what a single nginx/Caddy appends); earlier
   * entries are client-controlled and ignored. Default 1. Only used when the
   * proxy header is trusted (see `trustProxy`).
   */
  trustedHops?: number;
  /** Failed authentications (401/403) per minute per client IP before 429; `0` disables. Default 20. */
  authFailLimitPerMin?: number;
  /**
   * Failed authentications per minute across ALL clients. Once spent, every
   * further failed attempt answers 429 + `Retry-After`. Requests with a valid
   * token are not affected (the token is compared before this budget is
   * spent), so it limits failure answers from many addresses; it does not slow
   * guessing, which the token length covers. `0` disables. Default 600.
   */
  globalAuthFailLimitPerMin?: number;
  /** Upper bound of tracked client buckets (oldest evicted first). Default 10000. */
  maxTrackedClients?: number;
  /** Size cap of the database in bytes (default: the store's 200 MB). */
  maxDbBytes?: number;
  /** Reported by `/v1/health` to authenticated callers only. */
  version?: string;
  /** Clock override (epoch ms) for tests. */
  now?: () => number;
};

export interface CacheServerHandle {
  /** Base URL clients should use. Wildcard bind hosts are reported as loopback. */
  url: string;
  close(): Promise<void>;
}

type RouteLabel = '/v1/health' | '/v1/entries/:key' | 'unknown';
type BodyResult = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'aborted' };

function sendJson(res: ServerResponse, status: number, payload?: unknown, extra: Record<string, string> = {}): void {
  const text = payload === undefined ? '' : JSON.stringify(payload);
  const headers: Record<string, string | number> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  };
  if (payload !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = Buffer.byteLength(text);
  }
  res.writeHead(status, headers);
  res.end(text);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return m?.[1];
}

/** Constant-time comparison (digests have equal length, so length is not leaked either). */
function tokenMatches(given: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined) return false;
  const a = digest(given ?? '');
  const b = digest(expected);
  return timingSafeEqual(a, b) && given !== undefined;
}

function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      resolve({ ok: false, reason: 'too_large' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return; // keep draining, discard
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        finish({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, reason: 'aborted' }));
    req.on('close', () => finish({ ok: false, reason: 'aborted' }));
  });
}

interface Bucket {
  tokens: number;
  at: number;
}

interface BucketLimiter {
  /** Takes a token for `client`; returns 0 when allowed, otherwise the seconds to wait. */
  take(client: string): number;
  /** Seconds until `client` has a token again (0 = has one); consumes nothing. */
  wait(client: string): number;
}

/**
 * Token bucket per client with a bounded map. The map is kept in least recently
 * used order; when it is full, idle buckets (full again anyway) go first, then
 * the least recently used one, so a new client is never refused.
 */
function createRateLimiter(perMin: number, now: () => number, maxClients: number): BucketLimiter {
  if (perMin <= 0) return { take: () => 0, wait: () => 0 };
  const buckets = new Map<string, Bucket>();
  const perMs = perMin / 60_000;
  const capacity = Math.max(1, Math.floor(maxClients));
  const refill = (bucket: Bucket, t: number): void => {
    bucket.tokens = Math.min(perMin, bucket.tokens + Math.max(0, t - bucket.at) * perMs);
    bucket.at = t;
  };
  const secondsToWait = (bucket: Bucket): number => Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000));
  return {
    take(client) {
      const t = now();
      let bucket = buckets.get(client);
      if (bucket === undefined) {
        for (const [id, b] of buckets) {
          if (buckets.size < capacity && t - b.at <= BUCKET_IDLE_TTL_MS) break;
          buckets.delete(id);
        }
        bucket = { tokens: perMin, at: t };
      } else {
        buckets.delete(client); // re-inserted below as the most recently used
        refill(bucket, t);
      }
      buckets.set(client, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return 0;
      }
      return secondsToWait(bucket);
    },
    wait(client) {
      const bucket = buckets.get(client);
      if (bucket === undefined) return 0;
      const probe = { tokens: bucket.tokens, at: bucket.at };
      refill(probe, now());
      return probe.tokens >= 1 ? 0 : secondsToWait(probe);
    },
  };
}

function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** The eight 16-bit groups of a valid IPv6 address (embedded IPv4 tail and `::` expanded). */
function ipv6Groups(address: string): number[] {
  let s = address;
  const tail4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail4) {
    const [a = 0, b = 0, c = 0, d = 0] = tail4.slice(1).map(Number);
    s = `${s.slice(0, -tail4[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = s.split('::');
  const front = head === '' ? [] : head.split(':');
  const back = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? [] : new Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0');
  return [...front, ...fill, ...back].map((g) => Number.parseInt(g, 16));
}

/**
 * Bucket identity for a client address: IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is
 * the IPv4 address, any other IPv6 address is its /64 prefix (one subscriber
 * routinely owns the whole /64, so per-address buckets would be free to
 * multiply). Anything that is not an IP literal is kept as is.
 */
export function normalizeClientAddress(raw: string): string {
  let a = raw.trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (isIPv4(a)) return a;
  if (!isIPv6(a)) return raw;
  const g = ipv6Groups(a);
  if (g.length !== 8) return raw;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const hi = g[6] ?? 0;
    const lo = g[7] ?? 0;
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * The socket address, or (when the proxy header is trusted) the
 * `X-Forwarded-For` entry `trustedHops` positions from the right. Entries to
 * its left were supplied by the client or by earlier, untrusted hops. A header
 * with fewer entries than `trustedHops` falls back to the socket address.
 */
function clientIp(req: IncomingMessage, trustProxy: boolean | undefined, trustedHops: number): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (trustProxy ?? isLoopbackPeer(req.socket.remoteAddress)) {
    const forwarded = req.headers['x-forwarded-for'];
    const joined = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
    if (joined) {
      const parts = joined.split(',');
      const hop = parts[parts.length - trustedHops]?.trim();
      if (hop) return normalizeClientAddress(hop.slice(0, 64));
    }
  }
  return normalizeClientAddress(peer);
}

function reachableHost(address: AddressInfo): string {
  const host = address.address;
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return address.family === 'IPv6' ? `[${host}]` : host;
}

async function startCacheServerImpl(o: CacheServerOptions): Promise<CacheServerHandle> {
  const clock = o.now ?? Date.now;
  const log: CacheServerLogger = o.logger ?? (() => undefined);
  const writeToken = o.writeToken ? o.writeToken : undefined;
  const readToken = o.readToken ? o.readToken : undefined;
  for (const [label, token] of [['write', writeToken], ['read', readToken]] as const) {
    if (token !== undefined && token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `The cache server ${label} token is too short (${token.length} characters); use at least ${MIN_TOKEN_LENGTH}. Generate one with: openssl rand -hex 32`,
      );
    }
  }
  const maxBodyBytes = o.maxBodyBytes !== undefined && o.maxBodyBytes > 0 ? Math.floor(o.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES;
  const maxTtlMs = (o.maxTtlSec !== undefined && o.maxTtlSec > 0 ? Math.floor(o.maxTtlSec) : DEFAULT_MAX_TTL_SEC) * 1000;
  const requestLimit = maxBodyBytes + ENVELOPE_BYTES;
  const version = o.version ?? DEFAULT_VERSION;
  const maxClients = o.maxTrackedClients !== undefined && o.maxTrackedClients > 0 ? o.maxTrackedClients : MAX_TRACKED_CLIENTS;
  const trustedHops = o.trustedHops !== undefined && Number.isInteger(o.trustedHops) && o.trustedHops >= 1 ? o.trustedHops : DEFAULT_TRUSTED_HOPS;
  const limiter = createRateLimiter(o.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN, clock, maxClients);
  const authFailures = createRateLimiter(o.authFailLimitPerMin ?? DEFAULT_AUTH_FAIL_LIMIT_PER_MIN, clock, maxClients);
  const globalAuthFailures = createRateLimiter(
    o.globalAuthFailLimitPerMin ?? DEFAULT_GLOBAL_AUTH_FAIL_LIMIT_PER_MIN,
    clock,
    1,
  );

  /**
   * Counts a failed authentication (called only after the token comparison has
   * failed, never before); returns the seconds to wait when the server-wide
   * budget is spent, else 0.
   */
  function recordAuthFailure(client: string): number {
    authFailures.take(client);
    return globalAuthFailures.take(GLOBAL_BUCKET);
  }

  const store = openCacheStore(o.dbPath, {
    now: clock,
    // The server never serves expired entries, so keeping them has no value.
    staleRetentionMs: 0,
    ...(o.maxDbBytes !== undefined ? { maxBytes: o.maxDbBytes } : {}),
  });

  async function handlePut(req: IncomingMessage, res: ServerResponse, key: string): Promise<number> {
    const body = await readBody(req, requestLimit);
    if (!body.ok) {
      if (body.reason === 'too_large') {
        sendJson(res, 413, { error: 'payload_too_large' });
        return 413;
      }
      return 0; // the client went away
    }
    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return 400;
    }
    const parsed = RemoteEntryWireSchema.safeParse(json);
    if (!parsed.success) {
      sendJson(res, 400, { error: 'invalid_entry' });
      return 400;
    }
    const wire = parsed.data;
    if (!SHAREABLE_SOURCES.includes(wire.source)) {
      sendJson(res, 400, { error: 'invalid_source' });
      return 400;
    }
    if (wire.status !== 200 && wire.status !== 404) {
      sendJson(res, 400, { error: 'invalid_status' });
      return 400;
    }
    if (Buffer.byteLength(wire.body) > maxBodyBytes) {
      sendJson(res, 413, { error: 'payload_too_large' });
      return 413;
    }

    const now = clock();
    const fetchedAt = Math.min(wire.fetched_at, now);
    const expiresAt = Math.min(wire.expires_at, fetchedAt + maxTtlMs);
    if (expiresAt <= now) {
      // Already expired: nothing worth storing, and it must not replace a fresh entry.
      sendJson(res, 204);
      return 204;
    }
    const candidate: CacheEntry = {
      key,
      url_redacted: '',
      source: wire.source,
      status: wire.status,
      body: wire.body,
      fetched_at: fetchedAt,
      expires_at: expiresAt,
      provenance: 'remote_cache',
    };
    if (wire.etag !== undefined) candidate.etag = wire.etag;
    if (wire.last_modified !== undefined) candidate.last_modified = wire.last_modified;
    const clean = sanitize(candidate);
    if (clean === undefined || Buffer.byteLength(clean.body) > maxBodyBytes) {
      sendJson(res, 422, { error: 'entry_rejected' });
      return 422;
    }
    store.put({ ...clean, url_redacted: '', provenance: 'remote_cache' });
    sendJson(res, 204);
    return 204;
  }

  function handleGet(res: ServerResponse, key: string): number {
    const entry = store.get(key);
    if (entry === undefined || entry.expires_at <= clock()) {
      sendJson(res, 404, { error: 'not_found' });
      return 404;
    }
    const payload: Record<string, unknown> = {
      key: entry.key,
      source: entry.source,
      status: entry.status,
      body: entry.body,
      fetched_at: entry.fetched_at,
      expires_at: entry.expires_at,
    };
    if (entry.etag !== undefined) payload.etag = entry.etag;
    if (entry.last_modified !== undefined) payload.last_modified = entry.last_modified;
    sendJson(res, 200, payload);
    return 200;
  }

  function handleDelete(res: ServerResponse, key: string): number {
    const existing = store.get(key);
    if (existing !== undefined) {
      store.put({
        key,
        url_redacted: '',
        source: existing.source,
        status: 404,
        body: 'null',
        fetched_at: clock(),
        expires_at: 0,
        provenance: 'remote_cache',
      });
    }
    sendJson(res, 204);
    return 204;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<{ label: RouteLabel; status: number }> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { error: 'bad_request' });
      return { label: 'unknown', status: 400 };
    }
    const method = req.method ?? 'GET';

    const client = clientIp(req, o.trustProxy, trustedHops);
    const retryAfter = limiter.take(client);
    const label: RouteLabel =
      pathname === '/v1/health' ? '/v1/health' : pathname.startsWith('/v1/entries/') ? '/v1/entries/:key' : 'unknown';
    if (retryAfter > 0) {
      sendJson(res, 429, { error: 'rate_limited' }, { 'retry-after': String(retryAfter) });
      return { label, status: 429 };
    }

    if (label === '/v1/health') {
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
        return { label, status: 405 };
      }
      // Unauthenticated callers (monitors, the client's reachability probe) learn
      // only that the server is up. Version and entry count go to a caller that
      // presents a valid token. A wrong token is an authentication failure like any
      // other, and a locked-out client gets no detail, so health is no guessing oracle.
      let detailed = false;
      const presented = bearerToken(req);
      if (presented !== undefined && (readToken !== undefined || writeToken !== undefined) && authFailures.wait(client) === 0) {
        if (tokenMatches(presented, readToken) || tokenMatches(presented, writeToken)) detailed = true;
        else recordAuthFailure(client);
      }
      sendJson(res, 200, detailed ? { ok: true, version, entries: store.stats().entries } : { ok: true });
      return { label, status: 200 };
    }

    if (label !== '/v1/entries/:key') {
      sendJson(res, 404, { error: 'not_found' });
      return { label, status: 404 };
    }
    if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, PUT, DELETE' });
      return { label, status: 405 };
    }

    // Authorization comes before anything else is looked at. A client that keeps
    // failing it is locked out for a while, valid credentials included. The
    // server-wide budget is different: it is spent below, only after a failed
    // comparison, so a valid token passes even when that budget is spent.
    const lockedFor = authFailures.wait(client);
    if (lockedFor > 0) {
      sendJson(res, 429, { error: 'too_many_auth_failures' }, { 'retry-after': String(lockedFor) });
      return { label, status: 429 };
    }
    const given = bearerToken(req);
    if (method === 'GET') {
      if (readToken !== undefined) {
        const isRead = tokenMatches(given, readToken);
        const isWrite = tokenMatches(given, writeToken);
        if (!(isRead || isWrite)) {
          const globalWait = recordAuthFailure(client);
          if (globalWait > 0) {
            sendJson(res, 429, { error: 'too_many_auth_failures' }, { 'retry-after': String(globalWait) });
            return { label, status: 429 };
          }
          sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
          return { label, status: 401 };
        }
      }
    } else if (writeToken === undefined) {
      sendJson(res, 403, { error: 'writes_disabled' });
      return { label, status: 403 };
    } else if (!tokenMatches(given, writeToken)) {
      const globalWait = recordAuthFailure(client);
      if (globalWait > 0) {
        sendJson(res, 429, { error: 'too_many_auth_failures' }, { 'retry-after': String(globalWait) });
        return { label, status: 429 };
      }
      sendJson(res, 403, { error: 'forbidden' });
      return { label, status: 403 };
    }

    const key = pathname.slice('/v1/entries/'.length);
    if (!isCacheKey(key)) {
      sendJson(res, 400, { error: 'invalid_key' });
      return { label, status: 400 };
    }

    if (method === 'GET') return { label, status: handleGet(res, key) };
    if (method === 'DELETE') return { label, status: handleDelete(res, key) };
    return { label, status: await handlePut(req, res, key) };
  }

  const server = createServer((req, res) => {
    route(req, res)
      .then(({ label, status }) => {
        if (status !== 0) log('info', `${req.method ?? '?'} ${label} ${status}`);
      })
      .catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
        else res.destroy();
        log('error', `${req.method ?? '?'} request failed with an internal error`);
      });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = 10_000;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.port, o.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    try {
      store.close();
    } catch {
      /* the listen error is the one worth reporting */
    }
    throw err;
  }

  const address = server.address() as AddressInfo;
  const url = `http://${reachableHost(address)}:${address.port}`;
  let closing: Promise<void> | undefined;

  return {
    url,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => {
          try {
            store.close();
          } catch {
            /* already closed */
          }
          resolve();
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

export const startCacheServer = startCacheServerImpl satisfies StartCacheServer;
