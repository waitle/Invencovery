/**
 * Client for the shared remote cache (docs/PLAN.md §9.4).
 *
 * `createRemoteCache` is a thin transport: it maps `get`/`put` onto the
 * cache-server HTTP API and nothing else. Circuit breaking, the caller-side
 * timeout and the decision of what to share live in `http/client.ts`.
 *
 * Contract (what `http/client.ts` relies on):
 * - `mode: 'off'` (also when no valid `url` was given): every method returns
 *   immediately without touching the network (`get` -> `undefined`, `put` ->
 *   resolves, `healthy` -> `false`).
 * - `get` resolves `undefined` for a miss (404), an unusable body or an
 *   invalid entry. It REJECTS with `RemoteCacheError` on transport trouble
 *   (network, timeout, redirect, 401/403/429, 5xx) so the caller's circuit
 *   breaker can count failures. The error message never contains the URL, the
 *   token or any request data.
 * - `put` is a no-op unless `mode === 'readwrite'`. The entry goes through
 *   `sanitize` first (an entry that must not leave the machine resolves
 *   without any request) and only the wire fields are sent: never the URL,
 *   the query, the project, or any request header of the original call.
 *   Failures reject like `get`; a refused entry (other 4xx) resolves.
 * - `healthy` never rejects.
 * - Only the `Authorization: Bearer` token is added to requests, never to a URL.
 *
 * Only erasable TypeScript syntax is used (no enums, no parameter properties).
 */
import { z } from 'zod';
import { isSecureRemoteUrl } from '../config.js';
import type { CacheEntry, RemoteCache } from '../types.js';
import { MAX_SHARE_BODY_BYTES, sanitize as defaultSanitize } from './sanitize.js';

export const DEFAULT_REMOTE_TIMEOUT_MS = 1_500;
/** Largest response accepted from the server, including JSON escaping overhead. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Largest valid JS Date (epoch ms); anything above cannot be rendered as an ISO string. */
export const MAX_EPOCH_MS = 8.64e15;

/**
 * What may travel in `etag` / `last_modified`: printable ASCII only, 1-256
 * characters. These values are replayed as `If-None-Match` / `If-Modified-Since`
 * request headers, so CR/LF, control or non-Latin-1 characters must never pass.
 */
export const CONDITIONAL_HEADER_PATTERN = /^[\x20-\x7e]{1,256}$/;

/** JSON body of `GET`/`PUT /v1/entries/{key}`. */
export const RemoteEntryWireSchema = z.object({
  source: z.string().min(1).max(64),
  status: z.number().int(),
  body: z.string(),
  etag: z.string().regex(CONDITIONAL_HEADER_PATTERN).optional(),
  last_modified: z.string().regex(CONDITIONAL_HEADER_PATTERN).optional(),
  /** Epoch milliseconds. */
  fetched_at: z.number().int().nonnegative().max(MAX_EPOCH_MS),
  /** Epoch milliseconds. */
  expires_at: z.number().int().nonnegative().max(MAX_EPOCH_MS),
});
export type RemoteEntryWire = z.infer<typeof RemoteEntryWireSchema>;

export function isCacheKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Projects a cache entry onto the wire format (drops `url_redacted`, `provenance`, `key`). */
export function toWire(entry: CacheEntry): RemoteEntryWire {
  const wire: RemoteEntryWire = {
    source: entry.source,
    status: entry.status,
    body: entry.body,
    fetched_at: entry.fetched_at,
    expires_at: entry.expires_at,
  };
  if (entry.etag !== undefined) wire.etag = entry.etag;
  if (entry.last_modified !== undefined) wire.last_modified = entry.last_modified;
  return wire;
}

export type RemoteFailureReason = 'network' | 'timeout' | 'redirect' | 'unauthorized' | 'rate_limited' | 'server_error';

/** Transport-level failure of the remote cache. The message is safe to log. */
export class RemoteCacheError extends Error {
  reason: RemoteFailureReason;
  constructor(operation: 'get' | 'put', reason: RemoteFailureReason) {
    super(`remote cache ${operation} failed: ${reason}`);
    this.name = 'RemoteCacheError';
    this.reason = reason;
  }
}

export interface RemoteCacheOptions {
  /** Base URL of the cache server (path prefixes are kept). Missing or invalid forces mode `off`;
   * so does plain `http:` on a non-loopback host unless `allowInsecure` is set. */
  url?: string;
  mode: RemoteCache['mode'];
  /** Bearer token for the server (read and write). */
  token?: string;
  /**
   * Accept a plain `http:` URL on a non-loopback host (the token then travels
   * unencrypted). Default false: such a URL forces mode `off`.
   */
  allowInsecure?: boolean;
  /** Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. Default 1500. */
  timeoutMs?: number;
  /** Applied inside `put`. Default: the `sanitize` of `cache/sanitize.ts`. */
  sanitize?: (entry: CacheEntry) => CacheEntry | undefined;
}

function baseUrl(raw: string | undefined, allowInsecure: boolean): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username !== '' || u.password !== '') return undefined;
    if (!isSecureRemoteUrl(u.href, allowInsecure)) return undefined;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

async function readCapped(res: Response, cap: number): Promise<string | undefined> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
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

export function createRemoteCache(o: RemoteCacheOptions): RemoteCache {
  const base = baseUrl(o.url, o.allowInsecure === true);
  const mode: RemoteCache['mode'] = base === undefined ? 'off' : o.mode;
  const timeoutMs = o.timeoutMs !== undefined && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_REMOTE_TIMEOUT_MS;
  const doFetch: typeof globalThis.fetch = (input, init) => (o.fetch ?? globalThis.fetch)(input, init);
  const clean = o.sanitize ?? defaultSanitize;

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', 'user-agent': 'recyclewheel-remote-cache', ...extra };
    if (o.token) h.authorization = `Bearer ${o.token}`;
    return h;
  }

  /** One request. Throws `RemoteCacheError` on network, timeout or redirect; `text` is undefined when oversized. */
  async function send(
    operation: 'get' | 'put',
    method: 'GET' | 'PUT',
    path: string,
    body?: string,
  ): Promise<{ status: number; text: string | undefined }> {
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        redirect: 'manual',
        signal,
      };
      if (body !== undefined) init.body = body;
      res = await doFetch(`${base}${path}`, init);
    } catch {
      throw new RemoteCacheError(operation, signal.aborted ? 'timeout' : 'network');
    }
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel().catch(() => undefined);
      throw new RemoteCacheError(operation, 'redirect');
    }
    let text: string | undefined;
    try {
      text = await readCapped(res, MAX_RESPONSE_BYTES);
    } catch {
      throw new RemoteCacheError(operation, signal.aborted ? 'timeout' : 'network');
    }
    return { status: res.status, text };
  }

  function failureFor(operation: 'get' | 'put', status: number): RemoteCacheError | undefined {
    if (status === 401 || status === 403) return new RemoteCacheError(operation, 'unauthorized');
    if (status === 429) return new RemoteCacheError(operation, 'rate_limited');
    if (status >= 500) return new RemoteCacheError(operation, 'server_error');
    return undefined;
  }

  return {
    mode,

    async get(key) {
      if (mode === 'off' || !isCacheKey(key)) return undefined;
      const { status, text } = await send('get', 'GET', `/v1/entries/${key}`);
      const failure = failureFor('get', status);
      if (failure !== undefined) throw failure;
      if (status !== 200 || text === undefined) return undefined;

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return undefined;
      }
      const parsed = RemoteEntryWireSchema.safeParse(json);
      if (!parsed.success) return undefined;
      const wire = parsed.data;
      if (wire.status !== 200 && wire.status !== 404) return undefined;
      if (Buffer.byteLength(wire.body) > MAX_SHARE_BODY_BYTES) return undefined;
      if (wire.status === 200) {
        try {
          JSON.parse(wire.body);
        } catch {
          return undefined;
        }
      }
      const entry: CacheEntry = {
        key,
        url_redacted: '',
        source: wire.source,
        status: wire.status,
        body: wire.body,
        fetched_at: wire.fetched_at,
        expires_at: wire.expires_at,
        provenance: 'remote_cache',
      };
      if (wire.etag !== undefined) entry.etag = wire.etag;
      if (wire.last_modified !== undefined) entry.last_modified = wire.last_modified;
      return entry;
    },

    async put(entry) {
      if (mode !== 'readwrite' || !isCacheKey(entry.key)) return;
      let outgoing: CacheEntry | undefined;
      try {
        outgoing = clean(entry);
      } catch {
        outgoing = undefined;
      }
      if (outgoing === undefined || !isCacheKey(outgoing.key)) return;
      if (Buffer.byteLength(outgoing.body) > MAX_SHARE_BODY_BYTES) return;
      const { status } = await send('put', 'PUT', `/v1/entries/${outgoing.key}`, JSON.stringify(toWire(outgoing)));
      const failure = failureFor('put', status);
      if (failure !== undefined) throw failure;
      // Any other 4xx means the server refused this entry (too large, rejected): not a health problem.
    },

    async healthy() {
      if (mode === 'off') return false;
      try {
        const { status, text } = await send('get', 'GET', '/v1/health');
        if (status !== 200 || text === undefined) return false;
        const json = JSON.parse(text) as { ok?: unknown } | null;
        return json !== null && typeof json === 'object' && json.ok === true;
      } catch {
        return false;
      }
    },
  };
}
