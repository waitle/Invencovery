import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey } from '../../../src/cache/key.js';
import {
  createHttpClient,
  MAX_STALE_MS,
  MAX_UPSTREAM_BYTES,
  NEGATIVE_TTL_MS,
  TTL_MS,
} from '../../../src/http/client.js';
import type { HttpClientOptions } from '../../../src/http/client.js';
import type {
  CacheEntry,
  CacheStore,
  HttpRequestOptions,
  RateLimitState,
  RemoteCache,
} from '../../../src/types.js';
import { startTestServer } from '../../helpers/test-server.js';
import type { TestServer } from '../../helpers/test-server.js';

const TOKEN = 'ghp_TESTTOKEN123';
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

const REPO = 'https://api.github.com/repos/o/r';
const SEARCH = 'https://api.github.com/search/repositories?q=pdf';
const repoOpts: HttpRequestOptions = { source: 'github_repo', ttlClass: 'repo' };
const searchOpts: HttpRequestOptions = { source: 'github_repo', ttlClass: 'search' };
const npmOpts: HttpRequestOptions = { source: 'npm', ttlClass: 'package' };

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Minimal in-memory CacheStore (T11's SQLite store is deliberately not used). */
class MemoryStore implements CacheStore {
  entries = new Map<string, CacheEntry>();
  limits = new Map<string, RateLimitState>();
  touched: { key: string; expires_at: number }[] = [];
  puts = 0;

  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }
  put(e: CacheEntry): void {
    this.puts += 1;
    this.entries.set(e.key, { ...e });
  }
  touch(key: string, expires_at: number): void {
    this.touched.push({ key, expires_at });
    const e = this.entries.get(key);
    if (e) this.entries.set(key, { ...e, expires_at });
  }
  purge(): number {
    const n = this.entries.size;
    this.entries.clear();
    return n;
  }
  stats() {
    return { entries: this.entries.size, bytes: 0, by_source: {} };
  }
  getRateLimit(resource: string): RateLimitState | undefined {
    return this.limits.get(resource);
  }
  setRateLimit(s: RateLimitState): void {
    this.limits.set(s.resource, { ...s });
  }
  close(): void {}
}

class FakeRemote implements RemoteCache {
  mode: RemoteCache['mode'] = 'readwrite';
  entries = new Map<string, CacheEntry>();
  gets: string[] = [];
  puts: CacheEntry[] = [];
  getImpl: ((key: string) => Promise<CacheEntry | undefined>) | undefined;
  putImpl: ((e: CacheEntry) => Promise<void>) | undefined;

  async get(key: string): Promise<CacheEntry | undefined> {
    this.gets.push(key);
    return this.getImpl ? this.getImpl(key) : this.entries.get(key);
  }
  async put(e: CacheEntry): Promise<void> {
    this.puts.push(e);
    if (this.putImpl) await this.putImpl(e);
  }
  async healthy(): Promise<boolean> {
    return true;
  }
}

interface Call {
  url: string;
  headers: Record<string, string>;
  init: RequestInit;
}
type Handler = (url: string, callNumber: number) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, init: init ?? {} });
    return handler(url, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function entry(url: string, over: Partial<CacheEntry> = {}): CacheEntry {
  return {
    key: cacheKey(url),
    url_redacted: url,
    source: 'github_repo',
    status: 200,
    body: JSON.stringify({ from: 'cache' }),
    fetched_at: T0 - 48 * HOUR,
    expires_at: T0 - 24 * HOUR,
    provenance: 'live',
    ...over,
  };
}

interface Setup {
  client: ReturnType<typeof createHttpClient>;
  store: MemoryStore;
  remote: FakeRemote;
  calls: Call[];
  clock: { now: number };
}

function setup(
  handler: Handler,
  over: Partial<HttpClientOptions> & { remote?: FakeRemote; store?: MemoryStore } = {},
): Setup {
  const store = over.store ?? new MemoryStore();
  const remote = over.remote ?? Object.assign(new FakeRemote(), { mode: 'off' as const });
  const { fn, calls } = fakeFetch(handler);
  const clock = { now: T0 };
  const client = createHttpClient({
    store,
    remote,
    config: { offline: false },
    fetch: fn,
    now: () => clock.now,
    retryDelayMs: 1,
    remoteTimeoutMs: 50,
    timeoutMs: 2_000,
    ...over,
  });
  return { client, store, remote: remote as FakeRemote, calls, clock };
}

const ok = (body: unknown = { ok: true }): Handler => () => json(body);

// ---------------------------------------------------------------------------
// Fake-fetch behaviour tests
// ---------------------------------------------------------------------------

describe('allowlist', () => {
  it.each([
    'https://evil.example.com/x',
    'https://github.com/o/r',
    'https://api.github.com.evil.com/repos/o/r',
    'http://api.github.com/repos/o/r',
    'https://api.github.com:8443/repos/o/r',
    'https://user:pw@api.github.com/repos/o/r',
    'https://127.0.0.1/',
    'file:///etc/passwd',
    'not a url',
  ])('rejects %s without any network or cache access', async (url) => {
    const s = setup(ok());
    const r = await s.client.getJson(url, repoOpts);
    expect(r.error).toBe('http');
    expect(r.status).toBe(0);
    expect(r.data).toBeNull();
    expect(s.calls).toHaveLength(0);
    expect(s.store.puts).toBe(0);
  });

  it.each([
    'https://api.github.com/repos/o/r',
    'https://registry.npmjs.org/-/v1/search?text=x',
    'https://api.npmjs.org/downloads/point/last-week/x',
    'https://pypi.org/pypi/x/json',
    'https://api.deps.dev/v3/systems/npm/packages/x',
    'https://registry.modelcontextprotocol.io/v0.1/servers?search=x',
    'https://libraries.io/api/search?q=x',
  ])('allows %s', async (url) => {
    const s = setup(ok());
    const r = await s.client.getJson(url, npmOpts);
    expect(r.error).toBeUndefined();
    expect(s.calls).toHaveLength(1);
  });
});

describe('local fresh hit and storage', () => {
  it('stores a live response, then serves it without calling fetch', async () => {
    const s = setup(ok({ stars: 7 }));
    const first = await s.client.getJson<{ stars: number }>(REPO, repoOpts);
    expect(first).toMatchObject({ status: 200, data: { stars: 7 }, provenance: 'live' });
    expect(first.fetched_at).toBe(new Date(T0).toISOString());

    s.clock.now += 1000;
    const second = await s.client.getJson<{ stars: number }>(REPO, repoOpts);
    expect(second).toMatchObject({ status: 200, data: { stars: 7 }, provenance: 'local_cache' });
    expect(second.fetched_at).toBe(first.fetched_at);
    expect(s.calls).toHaveLength(1);
  });

  it('writes key, redacted url, source, etag and TTL by class', async () => {
    const url = 'https://api.github.com/search/repositories?q=pdf';
    const s = setup(() => json({ items: [] }, 200, { etag: '"e1"', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' }));
    await s.client.getJson(url, searchOpts);
    const e = s.store.get(cacheKey(url));
    expect(e).toMatchObject({
      key: cacheKey(url),
      url_redacted: url,
      source: 'github_repo',
      status: 200,
      etag: '"e1"',
      last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT',
      fetched_at: T0,
      expires_at: T0 + 12 * HOUR,
      provenance: 'live',
    });
  });

  it.each(Object.entries(TTL_MS))('uses the %s TTL', async (ttlClass, ttl) => {
    const s = setup(ok());
    await s.client.getJson('https://pypi.org/pypi/x/json', { source: 'pypi', ttlClass: ttlClass as never });
    expect(s.store.get(cacheKey('https://pypi.org/pypi/x/json'))?.expires_at).toBe(T0 + ttl);
  });

  it('refetches once the entry has expired', async () => {
    const s = setup(ok());
    await s.client.getJson(REPO, repoOpts);
    s.clock.now += 6 * HOUR + 1;
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.provenance).toBe('live');
    expect(s.calls).toHaveLength(2);
  });

  it('does not cache non-JSON 200 bodies', async () => {
    const s = setup(() => new Response('<html>nope</html>', { status: 200 }));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.error).toBe('http');
    expect(r.data).toBeNull();
    expect(s.store.entries.size).toBe(0);
  });

  it('rejects an upstream response whose Content-Length exceeds the cap, before reading it', async () => {
    const s = setup(
      () =>
        new Response('{"a":1}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(MAX_UPSTREAM_BYTES + 1) },
        }),
    );
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.error).toBe('http');
    expect(r.data).toBeNull();
    expect(s.store.entries.size).toBe(0);
  });

  it('aborts an upstream stream that grows past the cap without a Content-Length', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
        if (sent > 20) controller.close();
      },
    });
    const s = setup(() => new Response(body, { status: 200 }));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.error).toBe('http');
    expect(r.data).toBeNull();
    expect(sent).toBeLessThan(15);
    expect(s.store.entries.size).toBe(0);
  });

  it('is unaffected by a normal-sized response', async () => {
    const s = setup(ok({ pad: 'x'.repeat(200_000) }));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect((r.data as { pad: string }).pad).toHaveLength(200_000);
  });

  it('survives a cache store that throws', async () => {
    const store = new MemoryStore();
    store.get = () => {
      throw new Error('disk gone');
    };
    store.put = () => {
      throw new Error('disk gone');
    };
    store.getRateLimit = () => {
      throw new Error('disk gone');
    };
    store.setRateLimit = () => {
      throw new Error('disk gone');
    };
    const s = setup(() => json({ a: 1 }, 200, { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '9999999999' }), { store });
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 200, data: { a: 1 }, provenance: 'live' });
  });

  it('returns lowercase response headers on live results', async () => {
    const s = setup(() => json({}, 200, { Link: '<https://x/?page=3>; rel="last"', 'X-Custom': 'v' }));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.headers.link).toContain('page=3');
    expect(r.headers['x-custom']).toBe('v');
  });
});

describe('request headers', () => {
  it('sends GitHub defaults, user agent and accept override', async () => {
    const s = setup(ok(), { userAgent: 'recyclewheel/9.9.9 (+test)' });
    await s.client.getJson(REPO, repoOpts);
    await s.client.getJson('https://api.github.com/search/code?q=x', {
      source: 'github_code',
      ttlClass: 'search',
      accept: 'application/vnd.github.text-match+json',
    });
    await s.client.getJson('https://pypi.org/pypi/x/json', { source: 'pypi', ttlClass: 'package' });
    expect(s.calls[0]?.headers).toMatchObject({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'recyclewheel/9.9.9 (+test)',
    });
    expect(s.calls[1]?.headers.accept).toBe('application/vnd.github.text-match+json');
    expect(s.calls[2]?.headers.accept).toBe('application/json');
    expect(s.calls[2]?.headers['x-github-api-version']).toBeUndefined();
    expect(s.calls[0]?.init.redirect).toBe('manual');
    expect(s.calls[0]?.init.method).toBe('GET');
  });

  it('attaches the token only for auth:true requests to api.github.com', async () => {
    const token = vi.fn(async () => TOKEN);
    const s = setup(ok(), { token });
    await s.client.getJson(REPO, { ...repoOpts, auth: true });
    await s.client.getJson('https://api.github.com/repos/o/other', repoOpts);
    await s.client.getJson('https://registry.npmjs.org/x/latest', { ...npmOpts, auth: true });
    expect(s.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.calls[1]?.headers.authorization).toBeUndefined();
    expect(s.calls[2]?.headers.authorization).toBeUndefined();
    expect(token).toHaveBeenCalledTimes(1);
  });

  it('proceeds anonymously when the token resolver throws or returns nothing', async () => {
    const throwing = setup(ok(), { token: async () => { throw new Error(`gh failed ${TOKEN}`); } });
    const r = await throwing.client.getJson(REPO, { ...repoOpts, auth: true });
    expect(r.error).toBeUndefined();
    expect(throwing.calls[0]?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(TOKEN);

    const none = setup(ok(), { token: async () => undefined });
    await none.client.getJson(REPO, { ...repoOpts, auth: true });
    expect(none.calls[0]?.headers.authorization).toBeUndefined();
  });
});

describe('secrets', () => {
  it('uses the same key with and without api_key, and keeps the secret out of storage', async () => {
    const withKey = `https://libraries.io/api/search?q=pdf&api_key=${TOKEN}`;
    const withoutKey = 'https://libraries.io/api/search?q=pdf';
    const s = setup(ok({ r: 1 }));
    await s.client.getJson(withKey, { source: 'librariesio', ttlClass: 'search' });
    const second = await s.client.getJson(withoutKey, { source: 'librariesio', ttlClass: 'search' });
    expect(second.provenance).toBe('local_cache');
    expect(s.calls).toHaveLength(1);
    // upstream still receives the key (libraries.io needs it) ...
    expect(s.calls[0]?.url).toContain(`api_key=${TOKEN}`);
    // ... but nothing persisted does.
    const stored = [...s.store.entries.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.key).toBe(cacheKey(withoutKey));
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(stored[0]?.url_redacted).toBe('https://libraries.io/api/search?q=pdf&api_key=REDACTED');
  });

  it('never exposes the token in results, store, remote uploads, stdout or stderr', async () => {
    const spies = [
      vi.spyOn(process.stderr, 'write'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'log'),
    ];
    const remote = new FakeRemote();
    const s = setup(
      (url) => {
        if (url.includes('boom')) throw new Error(`socket hang up; Authorization: Bearer ${TOKEN}`);
        if (url.includes('missing')) return json({ message: 'Not Found' }, 404);
        return json({ ok: 1 }, 200, { etag: '"x"' });
      },
      { remote, token: async () => TOKEN },
    );
    const results = [
      await s.client.getJson('https://api.github.com/repos/o/boom', { ...repoOpts, auth: true }),
      await s.client.getJson(`https://api.github.com/repos/o/r?access_token=${TOKEN}`, {
        ...repoOpts,
        auth: true,
        shareable: true,
      }),
      await s.client.getJson('https://api.github.com/repos/o/missing?x=1', {
        ...repoOpts,
        auth: true,
        shareable: true,
      }),
    ];
    await new Promise((r) => setTimeout(r, 10));

    const haystack = JSON.stringify({
      results,
      entries: [...s.store.entries.values()],
      limits: [...s.store.limits.values()],
      puts: remote.puts,
      writes: spies.map((sp) => sp.mock.calls),
    });
    expect(haystack).not.toContain(TOKEN);
    expect(results[0]?.error).toBe('network');
    expect(remote.puts).toHaveLength(2);
    for (const sp of spies) sp.mockRestore();
  });
});

describe('conditional requests (ETag / Last-Modified)', () => {
  it('stale + ETag -> 304 -> touch, serves cached body as live', async () => {
    let revalidating = false;
    const s = setup((_url) =>
      revalidating
        ? empty(304, { etag: '"abc"' })
        : json({ stars: 1 }, 200, { etag: '"abc"', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' }),
    );
    await s.client.getJson(REPO, repoOpts);
    revalidating = true;
    s.clock.now += 7 * HOUR;

    const r = await s.client.getJson<{ stars: number }>(REPO, repoOpts);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]?.headers['if-none-match']).toBe('"abc"');
    expect(s.calls[1]?.headers['if-modified-since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    expect(r).toMatchObject({ status: 200, data: { stars: 1 }, provenance: 'live' });
    expect(s.store.touched).toEqual([{ key: cacheKey(REPO), expires_at: s.clock.now + 6 * HOUR }]);

    // Freshness was extended: the next call is a local hit.
    const again = await s.client.getJson(REPO, repoOpts);
    expect(again.provenance).toBe('local_cache');
    expect(s.calls).toHaveLength(2);
  });

  it('does not revalidate a row that came from the remote cache, so a 304 cannot make it "live"', async () => {
    // An origin that honours validators: 304 only when it is asked conditionally.
    let s!: Setup;
    s = setup((_url, n) =>
      s.calls[n - 1]?.headers['if-none-match'] !== undefined ? empty(304, { etag: '"abc"' }) : json({ from: 'origin' }, 200, { etag: '"abc"' }),
    );
    s.store.put(entry(REPO, { provenance: 'remote_cache', etag: '"abc"', last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT' }));
    const r = await s.client.getJson<{ from: string }>(REPO, repoOpts);
    expect(s.calls[0]?.headers['if-none-match']).toBeUndefined();
    expect(s.calls[0]?.headers['if-modified-since']).toBeUndefined();
    // Whatever the origin answers, the remote copy is never relabelled as live.
    expect(r.data).toEqual({ from: 'origin' });
  });

  it('does not send validators when the entry has none, or when the entry is a 404', async () => {
    const s = setup(ok());
    s.store.put(entry(REPO));
    s.store.put(entry('https://api.github.com/repos/o/gone', { status: 404, body: 'null', etag: '"n"' }));
    await s.client.getJson(REPO, repoOpts);
    await s.client.getJson('https://api.github.com/repos/o/gone', repoOpts);
    expect(s.calls[0]?.headers['if-none-match']).toBeUndefined();
    expect(s.calls[1]?.headers['if-none-match']).toBeUndefined();
  });

  it('replaces the entry when upstream answers 200 to a conditional request', async () => {
    let n = 0;
    const s = setup(() => json({ v: ++n }, 200, { etag: `"v${n}"` }));
    await s.client.getJson(REPO, repoOpts);
    s.clock.now += 7 * HOUR;
    const r = await s.client.getJson<{ v: number }>(REPO, repoOpts);
    expect(r.data).toEqual({ v: 2 });
    expect(s.store.get(cacheKey(REPO))?.etag).toBe('"v2"');
    expect(s.store.touched).toHaveLength(0);
  });
});

describe('rate limits', () => {
  const limitedHeaders = (nowMs: number, extra: Record<string, string> = {}) => ({
    'x-ratelimit-limit': '60',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(Math.floor(nowMs / 1000) + 3600),
    ...extra,
  });

  it('403 + remaining=0 -> rate_limited, then later requests are blocked without fetch', async () => {
    let mode: 'limited' | 'ok' = 'limited';
    const s = setup(() => (mode === 'limited' ? json({ message: 'rate limit' }, 403, limitedHeaders(T0)) : json({ ok: 1 })));

    const first = await s.client.getJson(REPO, repoOpts);
    expect(first).toMatchObject({ status: 429, data: null, error: 'rate_limited' });
    expect(first.headers['x-ratelimit-remaining']).toBe('0');
    expect(s.calls).toHaveLength(1);
    expect(s.store.getRateLimit('github:core:anon')).toMatchObject({
      limit: 60,
      remaining: 0,
      reset_at: (Math.floor(T0 / 1000) + 3600) * 1000,
    });

    const blocked = await s.client.getJson('https://api.github.com/repos/o/another', repoOpts);
    expect(blocked.error).toBe('rate_limited');
    expect(Number(blocked.headers['x-ratelimit-reset'])).toBe(Math.floor(T0 / 1000) + 3600);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(s.calls).toHaveLength(1);

    // Different bucket (search) is unaffected.
    mode = 'ok';
    const search = await s.client.getJson(SEARCH, searchOpts);
    expect(search.error).toBeUndefined();
    expect(s.calls).toHaveLength(2);

    // After the reset time the core bucket is used again.
    s.clock.now += 3601_000;
    const later = await s.client.getJson('https://api.github.com/repos/o/another', repoOpts);
    expect(later.error).toBeUndefined();
    expect(s.calls).toHaveLength(3);
  });

  it('returns a stale entry instead of an error when rate limited (upstream 429)', async () => {
    const s = setup(() => json({}, 429, { 'retry-after': '120' }));
    s.store.put(entry(REPO));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 200, data: { from: 'cache' }, provenance: 'stale_cache' });
    expect(r.error).toBeUndefined();
    expect(r.headers['retry-after']).toBe('120');
    expect(s.store.getRateLimit('github:core:anon')).toMatchObject({ remaining: 0, reset_at: T0 + 120_000 });
  });

  it('pre-blocks with a stale entry and does not call fetch', async () => {
    const s = setup(ok());
    s.store.put(entry(REPO));
    s.store.setRateLimit({ resource: 'github:core:anon', limit: 60, remaining: 0, reset_at: T0 + 60_000, updated_at: T0 });
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.provenance).toBe('stale_cache');
    expect(s.calls).toHaveLength(0);
  });

  it('does not use an entry staler than max_stale', async () => {
    const s = setup(ok());
    s.store.put(entry(REPO, { expires_at: T0 - MAX_STALE_MS - 1 }));
    s.store.setRateLimit({ resource: 'github:core:anon', limit: 60, remaining: 0, reset_at: T0 + 60_000, updated_at: T0 });
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.error).toBe('rate_limited');
    expect(r.data).toBeNull();
  });

  it('treats a 403 without rate-limit evidence as a plain http error', async () => {
    const s = setup(() => json({ message: 'forbidden' }, 403, { 'x-ratelimit-remaining': '17', 'x-ratelimit-reset': String(Math.floor(T0 / 1000) + 600) }));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 403, data: null, error: 'http' });
    expect(s.store.getRateLimit('github:core:anon')).toMatchObject({ remaining: 17 });
    const next = await s.client.getJson('https://api.github.com/repos/o/next', repoOpts);
    expect(next.error).toBe('http');
    expect(s.calls).toHaveLength(2);
  });

  it('records announced limits from successful responses and keeps anon and token buckets apart', async () => {
    const s = setup(
      () => json({ ok: 1 }, 200, { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Math.floor(T0 / 1000) + 3600) }),
      { token: async () => TOKEN },
    );
    await s.client.getJson(REPO, { ...repoOpts, auth: true });
    expect(s.store.getRateLimit('github:core')).toMatchObject({ limit: 5000, remaining: 4999 });
    expect(s.store.getRateLimit('github:core:anon')).toBeUndefined();

    // An anonymous block does not stop authenticated requests.
    s.store.setRateLimit({ resource: 'github:core:anon', limit: 60, remaining: 0, reset_at: T0 + HOUR, updated_at: T0 });
    const authed = await s.client.getJson('https://api.github.com/repos/o/b', { ...repoOpts, auth: true });
    expect(authed.error).toBeUndefined();
    const anon = await s.client.getJson('https://api.github.com/repos/o/c', repoOpts);
    expect(anon.error).toBe('rate_limited');
  });

  it('uses x-ratelimit-resource to name the GitHub bucket', async () => {
    const s = setup(() => json({}, 200, { 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '9', 'x-ratelimit-reset': String(Math.floor(T0 / 1000) + 60), 'x-ratelimit-resource': 'code_search' }));
    await s.client.getJson('https://api.github.com/search/code?q=x', { source: 'github_code', ttlClass: 'search' });
    expect(s.store.getRateLimit('github:code_search:anon')).toMatchObject({ limit: 10, remaining: 9 });
  });

  it('blocks libraries.io on 429 using retry-after', async () => {
    const s = setup(() => json({}, 429, { 'retry-after': '30' }));
    const opts: HttpRequestOptions = { source: 'librariesio', ttlClass: 'search' };
    const first = await s.client.getJson('https://libraries.io/api/search?q=a', opts);
    const second = await s.client.getJson('https://libraries.io/api/search?q=b', opts);
    expect(first.error).toBe('rate_limited');
    expect(second.error).toBe('rate_limited');
    expect(s.calls).toHaveLength(1);
    expect(s.store.getRateLimit('librariesio')?.reset_at).toBe(T0 + 30_000);
  });
});

describe('errors, retry and stale-if-error', () => {
  it('retries a 5xx once and succeeds', async () => {
    const s = setup((_u, n) => (n === 1 ? json({}, 503) : json({ ok: 1 })));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 200, data: { ok: 1 }, provenance: 'live' });
    expect(s.calls).toHaveLength(2);
  });

  it('gives up after one retry and reports an http error', async () => {
    const s = setup(() => json({ message: 'down' }, 502));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 502, data: null, error: 'http' });
    expect(s.calls).toHaveLength(2);
    expect(s.store.entries.size).toBe(0);
  });

  it('retries a network error once', async () => {
    const s = setup((_u, n) => {
      if (n === 1) throw new TypeError('fetch failed');
      return json({ ok: 1 });
    });
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.status).toBe(200);
    expect(s.calls).toHaveLength(2);

    const down = setup(() => {
      throw new TypeError('fetch failed');
    });
    const d = await down.client.getJson(REPO, repoOpts);
    expect(d).toMatchObject({ status: 0, data: null, error: 'network' });
    expect(down.calls).toHaveLength(2);
  });

  it('does not retry other 4xx', async () => {
    const s = setup(() => json({ message: 'Validation Failed' }, 422));
    const r = await s.client.getJson(SEARCH, searchOpts);
    expect(r).toMatchObject({ status: 422, data: null, error: 'http' });
    expect(s.calls).toHaveLength(1);
    expect(s.store.entries.size).toBe(0);
  });

  it('serves a stale entry on persistent 5xx and on network failure', async () => {
    const s5xx = setup(() => json({}, 500));
    s5xx.store.put(entry(REPO));
    const a = await s5xx.client.getJson(REPO, repoOpts);
    expect(a).toMatchObject({ status: 200, data: { from: 'cache' }, provenance: 'stale_cache' });
    expect(a.error).toBeUndefined();

    const sNet = setup(() => {
      throw new TypeError('fetch failed');
    });
    sNet.store.put(entry(REPO));
    const b = await sNet.client.getJson(REPO, repoOpts);
    expect(b.provenance).toBe('stale_cache');
  });

  it('does not serve entries older than max_stale on errors', async () => {
    const s = setup(() => json({}, 500));
    s.store.put(entry(REPO, { expires_at: T0 - MAX_STALE_MS - 1 }));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 500, error: 'http', data: null });
  });

  it('reports a timeout without retrying', async () => {
    const attempts: number[] = [];
    const slow = (async (_input: unknown, init?: RequestInit) => {
      attempts.push(1);
      await new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')));
      });
      return json({});
    }) as typeof fetch;
    const s = setup(ok(), { fetch: slow, timeoutMs: 40 });
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 0, data: null, error: 'timeout' });
    expect(attempts).toHaveLength(1);
  });

  it('caches a 404 as a negative entry for one hour', async () => {
    const s = setup(() => json({ message: 'Not Found' }, 404));
    const first = await s.client.getJson(REPO, repoOpts);
    expect(first).toMatchObject({ status: 404, data: null, provenance: 'live' });
    expect(first.error).toBeUndefined();
    expect(s.store.get(cacheKey(REPO))).toMatchObject({
      status: 404,
      body: 'null',
      expires_at: T0 + NEGATIVE_TTL_MS,
    });

    const second = await s.client.getJson(REPO, repoOpts);
    expect(second).toMatchObject({ status: 404, data: null, provenance: 'local_cache' });
    expect(s.calls).toHaveLength(1);

    s.clock.now += NEGATIVE_TTL_MS + 1;
    await s.client.getJson(REPO, repoOpts);
    expect(s.calls).toHaveLength(2);
  });
});

describe('redirects', () => {
  it('follows redirects to allowlisted hosts', async () => {
    const s = setup((url) =>
      url.endsWith('/repos/old/name')
        ? empty(301, { location: 'https://api.github.com/repositories/9' })
        : json({ id: 9 }),
    );
    const r = await s.client.getJson('https://api.github.com/repos/old/name', repoOpts);
    expect(r).toMatchObject({ status: 200, data: { id: 9 } });
    expect(s.calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/old/name',
      'https://api.github.com/repositories/9',
    ]);
    // Cached under the originally requested URL.
    expect(s.store.get(cacheKey('https://api.github.com/repos/old/name'))).toBeDefined();
  });

  it('refuses redirects to hosts outside the allowlist or to http', async () => {
    for (const location of ['https://evil.example.com/steal', 'http://api.github.com/x']) {
      const s = setup(() => empty(302, { location }), { token: async () => TOKEN });
      const r = await s.client.getJson(REPO, { ...repoOpts, auth: true });
      expect(r).toMatchObject({ status: 302, data: null, error: 'http' });
      expect(s.calls).toHaveLength(1);
    }
  });

  it('drops the Authorization header when a redirect leaves api.github.com', async () => {
    const s = setup(
      (url) =>
        url.startsWith('https://api.github.com')
          ? empty(302, { location: 'https://registry.npmjs.org/x/latest' })
          : json({ name: 'x' }),
      { token: async () => TOKEN },
    );
    const r = await s.client.getJson(REPO, { ...repoOpts, auth: true });
    expect(r.status).toBe(200);
    expect(s.calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.calls[1]?.headers.authorization).toBeUndefined();
  });

  it('stops after too many redirects', async () => {
    const s = setup((_u, n) => empty(302, { location: `https://api.github.com/hop/${n}` }));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.error).toBe('http');
    expect(s.calls.length).toBeLessThanOrEqual(5);
  });
});

describe('in-flight coalescing', () => {
  it('merges concurrent requests for the same key into one fetch', async () => {
    const gate = deferred<void>();
    const s = setup(async () => {
      await gate.promise;
      return json({ items: [1, 2] });
    });
    const url = 'https://libraries.io/api/search?q=pdf';
    const opts: HttpRequestOptions = { source: 'librariesio', ttlClass: 'search' };
    const p1 = s.client.getJson<{ items: number[] }>(`${url}&api_key=A`, opts);
    const p2 = s.client.getJson<{ items: number[] }>(`${url}&api_key=B`, opts);
    const p3 = s.client.getJson<{ items: number[] }>(url, opts);
    gate.resolve();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(s.calls).toHaveLength(1);
    expect(r1.data).toEqual({ items: [1, 2] });
    expect(r2.data).toEqual({ items: [1, 2] });
    expect(r3.data).toEqual({ items: [1, 2] });
    // Callers get independent objects.
    expect(r1.data).not.toBe(r2.data);
    r1.data?.items.push(3);
    expect(r2.data?.items).toEqual([1, 2]);
  });

  it('does not merge different keys and clears finished requests', async () => {
    const s = setup(ok());
    await Promise.all([
      s.client.getJson('https://pypi.org/pypi/a/json', { source: 'pypi', ttlClass: 'package' }),
      s.client.getJson('https://pypi.org/pypi/b/json', { source: 'pypi', ttlClass: 'package' }),
    ]);
    expect(s.calls).toHaveLength(2);

    s.store.purge();
    await s.client.getJson('https://pypi.org/pypi/a/json', { source: 'pypi', ttlClass: 'package' });
    expect(s.calls).toHaveLength(3);
  });

  it('propagates a failure to every merged caller and recovers afterwards', async () => {
    const gate = deferred<void>();
    let fail = true;
    const s = setup(async () => {
      await gate.promise;
      return fail ? json({}, 400) : json({ ok: 1 });
    });
    const a = s.client.getJson(REPO, repoOpts);
    const b = s.client.getJson(REPO, repoOpts);
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.error).toBe('http');
    expect(rb.error).toBe('http');
    expect(s.calls).toHaveLength(1);
    fail = false;
    expect((await s.client.getJson(REPO, repoOpts)).status).toBe(200);
  });
});

describe('offline mode', () => {
  it('serves any stale entry and never touches the network or remote', async () => {
    const remote = new FakeRemote();
    const s = setup(ok(), { remote, config: { offline: true } });
    s.store.put(entry(REPO, { expires_at: T0 - 30 * 24 * HOUR }));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 200, data: { from: 'cache' }, provenance: 'stale_cache' });
    expect(s.calls).toHaveLength(0);
    expect(remote.gets).toHaveLength(0);
  });

  it('still serves fresh entries as local_cache', async () => {
    const s = setup(ok(), { config: { offline: true } });
    s.store.put(entry(REPO, { expires_at: T0 + HOUR }));
    expect((await s.client.getJson(REPO, repoOpts)).provenance).toBe('local_cache');
  });

  it('reports offline when there is nothing cached', async () => {
    const s = setup(ok(), { config: { offline: true } });
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 0, data: null, error: 'offline' });
    expect(s.calls).toHaveLength(0);
  });
});

describe('remote cache', () => {
  const remoteEntry = (url: string, over: Partial<CacheEntry> = {}): CacheEntry => ({
    key: cacheKey(url),
    url_redacted: '',
    source: 'github_repo',
    status: 200,
    body: JSON.stringify({ from: 'remote' }),
    fetched_at: T0 - HOUR,
    expires_at: T0 + HOUR,
    provenance: 'remote_cache',
    ...over,
  });

  it('a remote hit is saved locally and served as remote_cache', async () => {
    const remote = new FakeRemote();
    remote.mode = 'read';
    remote.entries.set(cacheKey(REPO), remoteEntry(REPO));
    const s = setup(ok(), { remote });

    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 200, data: { from: 'remote' }, provenance: 'remote_cache' });
    expect(s.calls).toHaveLength(0);
    expect(s.store.get(cacheKey(REPO))).toMatchObject({
      provenance: 'remote_cache',
      url_redacted: REPO,
      source: 'github_repo',
    });

    // The next lookup is served locally and keeps the remote origin marker.
    const again = await s.client.getJson(REPO, repoOpts);
    expect(again).toMatchObject({ data: { from: 'remote' }, provenance: 'remote_cache' });
    expect(remote.gets).toHaveLength(1);
  });

  it('does not ask the remote when mode is off', async () => {
    const remote = new FakeRemote();
    remote.mode = 'off';
    const s = setup(ok(), { remote });
    await s.client.getJson(REPO, repoOpts);
    expect(remote.gets).toHaveLength(0);
    expect(remote.puts).toHaveLength(0);
  });

  it('falls through to upstream on a remote miss', async () => {
    const remote = new FakeRemote();
    const s = setup(ok({ live: 1 }), { remote });
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r.provenance).toBe('live');
    expect(remote.gets).toEqual([cacheKey(REPO)]);
  });

  it('ignores expired, malformed or oversized remote entries', async () => {
    const remote = new FakeRemote();
    const s = setup(ok({ live: 1 }), { remote });
    const variants: Partial<CacheEntry>[] = [
      { expires_at: T0 - 1 },
      { body: '{not json' },
      { status: 500 },
      { body: JSON.stringify({ pad: 'x'.repeat(1_100_000) }) },
    ];
    let i = 0;
    for (const v of variants) {
      const url = `https://api.github.com/repos/o/r${i++}`;
      remote.entries.set(cacheKey(url), remoteEntry(url, v));
      const r = await s.client.getJson(url, repoOpts);
      expect(r.provenance).toBe('live');
    }
  });

  const BAD_VALIDATORS: Array<[string, string]> = [
    ['CR/LF', 'W/"a"\r\nX-Injected: 1'],
    ['non-Latin-1', '"café-中文"'],
    ['control character', '"a\u0000b"'],
    ['over-long', `"${'x'.repeat(300)}"`],
    ['empty', ''],
  ];

  it.each(BAD_VALIDATORS)('drops a %s etag / last_modified from a remote entry and never replays it', async (_name, bad) => {
    const remote = new FakeRemote();
    remote.mode = 'read';
    remote.entries.set(cacheKey(REPO), remoteEntry(REPO, { etag: bad, last_modified: bad }));
    const s = setup(ok({ live: 1 }), { remote });

    const hit = await s.client.getJson(REPO, repoOpts);
    expect(hit).toMatchObject({ data: { from: 'remote' }, provenance: 'remote_cache' });
    expect(hit.headers.etag).toBeUndefined();
    expect(hit.headers['last-modified']).toBeUndefined();
    const stored = s.store.get(cacheKey(REPO));
    expect(stored?.etag).toBeUndefined();
    expect(stored?.last_modified).toBeUndefined();

    // Once the entry is stale the revalidation carries no validator headers.
    s.clock.now += 7 * HOUR;
    await s.client.getJson(REPO, repoOpts);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.headers['if-none-match']).toBeUndefined();
    expect(s.calls[0]?.headers['if-modified-since']).toBeUndefined();
  });

  it('keeps well-formed validators from a remote entry', async () => {
    const remote = new FakeRemote();
    remote.mode = 'read';
    remote.entries.set(
      cacheKey(REPO),
      remoteEntry(REPO, { etag: 'W/"abc"', last_modified: 'Wed, 21 Oct 2015 07:28:00 GMT' }),
    );
    const s = setup(ok(), { remote });
    const hit = await s.client.getJson(REPO, repoOpts);
    expect(hit.headers.etag).toBe('W/"abc"');
    expect(s.store.get(cacheKey(REPO))?.last_modified).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
  });

  it('never sends a malformed validator found in the local store either', async () => {
    const s = setup(ok());
    s.store.put(entry(REPO, { etag: 'W/"a"\r\nX-Injected: 1', last_modified: 'x'.repeat(300) }));
    await s.client.getJson(REPO, repoOpts);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.headers['if-none-match']).toBeUndefined();
    expect(s.calls[0]?.headers['if-modified-since']).toBeUndefined();
  });

  it('caps a remote entry lifetime at the request class TTL', async () => {
    const remote = new FakeRemote();
    remote.entries.set(cacheKey(REPO), remoteEntry(REPO, { expires_at: T0 + 365 * 24 * HOUR }));
    const s = setup(ok(), { remote });
    await s.client.getJson(REPO, repoOpts);
    // Counted from the entry's own fetch time (T0 - HOUR), not from now.
    expect(s.store.get(cacheKey(REPO))?.expires_at).toBe(T0 - HOUR + TTL_MS.repo);
  });

  it('clamps a future fetched_at to now and never breaks the request', async () => {
    const remote = new FakeRemote();
    remote.entries.set(
      cacheKey(REPO),
      remoteEntry(REPO, { fetched_at: T0 + 30 * 24 * HOUR, expires_at: T0 + 365 * 24 * HOUR }),
    );
    const s = setup(ok(), { remote });
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({
      provenance: 'remote_cache',
      data: { from: 'remote' },
      fetched_at: new Date(T0).toISOString(),
    });
    expect(s.store.get(cacheKey(REPO))).toMatchObject({ fetched_at: T0, expires_at: T0 + TTL_MS.repo });
  });

  it('ignores remote entries with out-of-range or non-finite timestamps (cache miss, no exception)', async () => {
    const remote = new FakeRemote();
    const s = setup(ok({ live: 1 }), { remote });
    const variants: Partial<CacheEntry>[] = [
      { fetched_at: 9e15 },
      { fetched_at: -5 },
      { fetched_at: Number.NaN },
      { fetched_at: Number.POSITIVE_INFINITY },
      { expires_at: 9e15 },
      { expires_at: Number.NaN },
      { fetched_at: '1800000000000' as unknown as number },
    ];
    let i = 0;
    for (const v of variants) {
      const url = `https://api.github.com/repos/o/bad${i++}`;
      remote.entries.set(cacheKey(url), remoteEntry(url, v));
      const r = await s.client.getJson(url, repoOpts);
      expect(r.provenance).toBe('live');
      expect(r.error).toBeUndefined();
    }
  });

  it('treats a local cache row with an unrenderable timestamp as a miss', async () => {
    const s = setup(ok({ live: 1 }));
    s.store.put(entry(REPO, { fetched_at: 9e15, expires_at: 9e15 + 1 }));
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ provenance: 'live', data: { live: 1 } });
  });

  it('opens the circuit after 3 consecutive failures and closes it after 5 minutes', async () => {
    const remote = new FakeRemote();
    remote.getImpl = async () => {
      throw new Error('remote down');
    };
    const s = setup(ok(), { remote });
    const url = (n: number) => `https://api.github.com/repos/o/r${n}`;

    for (let n = 0; n < 3; n += 1) {
      const r = await s.client.getJson(url(n), repoOpts);
      expect(r.provenance).toBe('live');
    }
    expect(remote.gets).toHaveLength(3);

    const open = await s.client.getJson(url(3), repoOpts);
    expect(open.provenance).toBe('live');
    expect(remote.gets).toHaveLength(3);

    s.clock.now += 5 * 60_000 - 1;
    await s.client.getJson(url(4), repoOpts);
    expect(remote.gets).toHaveLength(3);

    s.clock.now += 2;
    await s.client.getJson(url(5), repoOpts);
    expect(remote.gets).toHaveLength(4);

    // One more failure re-opens it immediately (half-open probe failed).
    await s.client.getJson(url(6), repoOpts);
    expect(remote.gets).toHaveLength(4);
  });

  it('a success resets the failure count', async () => {
    const remote = new FakeRemote();
    let failing = true;
    remote.getImpl = async () => {
      if (failing) throw new Error('down');
      return undefined;
    };
    const s = setup(ok(), { remote });
    await s.client.getJson('https://api.github.com/repos/o/a', repoOpts);
    await s.client.getJson('https://api.github.com/repos/o/b', repoOpts);
    failing = false;
    await s.client.getJson('https://api.github.com/repos/o/c', repoOpts);
    failing = true;
    await s.client.getJson('https://api.github.com/repos/o/d', repoOpts);
    await s.client.getJson('https://api.github.com/repos/o/e', repoOpts);
    await s.client.getJson('https://api.github.com/repos/o/f', repoOpts);
    expect(remote.gets).toHaveLength(6);
  });

  it('times out a hanging remote and uses upstream', async () => {
    const remote = new FakeRemote();
    remote.getImpl = () => new Promise(() => undefined);
    const s = setup(ok({ live: 1 }), { remote, remoteTimeoutMs: 20 });
    const started = Date.now();
    const r = await s.client.getJson(REPO, repoOpts);
    expect(r).toMatchObject({ data: { live: 1 }, provenance: 'live' });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  describe('uploads', () => {
    const flush = () => new Promise((r) => setTimeout(r, 10));

    it('uploads shareable 2xx responses in readwrite mode, without the URL', async () => {
      const remote = new FakeRemote();
      const s = setup(() => json({ items: [] }, 200, { etag: '"e"' }), { remote });
      await s.client.getJson(SEARCH, { ...searchOpts, shareable: true });
      await flush();
      expect(remote.puts).toHaveLength(1);
      expect(remote.puts[0]).toMatchObject({
        key: cacheKey(SEARCH),
        url_redacted: '',
        source: 'github_repo',
        status: 200,
        etag: '"e"',
        provenance: 'live',
      });
      expect(JSON.stringify(remote.puts[0])).not.toContain('api.github.com');
    });

    it.each([
      ['not shareable', 'readwrite', {}, 'github_repo'],
      ['mode read', 'read', { shareable: true }, 'github_repo'],
      ['libraries.io data', 'readwrite', { shareable: true }, 'librariesio'],
    ] as const)('does not upload when %s', async (_name, mode, extra, source) => {
      const remote = new FakeRemote();
      remote.mode = mode;
      const s = setup(ok(), { remote });
      await s.client.getJson(SEARCH, { source, ttlClass: 'search', ...extra });
      await flush();
      expect(remote.puts).toHaveLength(0);
    });

    it('does not upload non-2xx responses or oversized bodies', async () => {
      const remote = new FakeRemote();
      const s = setup(
        (url) => (url.includes('big') ? json({ pad: 'x'.repeat(1_100_000) }) : json({}, 500)),
        { remote },
      );
      await s.client.getJson('https://api.github.com/repos/o/err', { ...repoOpts, shareable: true });
      await s.client.getJson('https://api.github.com/repos/o/big', { ...repoOpts, shareable: true });
      await flush();
      expect(remote.puts).toHaveLength(0);
    });

    it('applies the sanitize hook and skips the upload when it returns undefined', async () => {
      const remote = new FakeRemote();
      const sanitize = vi.fn((e: CacheEntry) =>
        e.key === cacheKey(REPO) ? undefined : { ...e, body: JSON.stringify({ sanitized: true }) },
      );
      const s = setup(ok({ secret: 'private' }), { remote, sanitize });
      await s.client.getJson(REPO, { ...repoOpts, shareable: true });
      await s.client.getJson(SEARCH, { ...searchOpts, shareable: true });
      await flush();
      expect(sanitize).toHaveBeenCalledTimes(2);
      expect(remote.puts).toHaveLength(1);
      expect(remote.puts[0]?.body).toBe('{"sanitized":true}');
      // The local copy is untouched by sanitizing.
      expect(s.store.get(cacheKey(SEARCH))?.body).toBe('{"secret":"private"}');
    });

    it('ignores upload failures without failing the request', async () => {
      const remote = new FakeRemote();
      remote.putImpl = async () => {
        throw new Error('put failed');
      };
      const s = setup(ok(), { remote });
      for (let n = 0; n < 4; n += 1) {
        const r = await s.client.getJson(`https://api.github.com/repos/o/r${n}`, { ...repoOpts, shareable: true });
        expect(r).toMatchObject({ status: 200, provenance: 'live' });
        await flush();
      }
      expect(remote.puts).toHaveLength(4);
    });

    it('stops uploading while the circuit is open', async () => {
      const remote = new FakeRemote();
      remote.getImpl = async () => {
        throw new Error('remote down');
      };
      remote.putImpl = async () => {
        throw new Error('remote down');
      };
      const s = setup(ok(), { remote });
      for (let n = 0; n < 4; n += 1) {
        await s.client.getJson(`https://api.github.com/repos/o/r${n}`, { ...repoOpts, shareable: true });
        await flush();
      }
      // get#0 fails, put#0 fails, get#1 fails -> circuit open: no more gets or puts.
      expect(remote.gets).toHaveLength(2);
      expect(remote.puts).toHaveLength(1);
    });

    it('a synchronous throw from remote.put does not fail the request', async () => {
      const remote = new FakeRemote();
      remote.put = () => {
        throw new Error('sync boom');
      };
      const s = setup(ok({ a: 1 }), { remote });
      const r = await s.client.getJson(REPO, { ...repoOpts, shareable: true });
      expect(r).toMatchObject({ status: 200, data: { a: 1 } });
    });
  });
});

// ---------------------------------------------------------------------------
// Real fetch against a local node:http server (PLAN §13.1)
// ---------------------------------------------------------------------------

describe('against a local test server', () => {
  let server: TestServer;
  let store: MemoryStore;
  let clock: { now: number };

  beforeEach(async () => {
    server = await startTestServer();
    store = new MemoryStore();
    clock = { now: T0 };
  });
  afterEach(async () => {
    await server.close();
  });

  /** Real `fetch`, with the allowlisted host rewritten to the local server. */
  const toServer: typeof fetch = (input, init) =>
    fetch(String(input).replace('https://api.github.com', server.url), init);

  const makeClient = (over: Partial<HttpClientOptions> = {}) =>
    createHttpClient({
      store,
      remote: Object.assign(new FakeRemote(), { mode: 'off' as const }),
      config: { offline: false },
      fetch: toServer,
      now: () => clock.now,
      retryDelayMs: 1,
      timeoutMs: 2_000,
      ...over,
    });

  it('revalidates with If-None-Match and handles a real 304', async () => {
    server.setHandler((req, res) => {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"' });
        res.end();
        return;
      }
      const body = JSON.stringify({ stars: 5 });
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
    const client = makeClient();

    const first = await client.getJson<{ stars: number }>(REPO, repoOpts);
    expect(first).toMatchObject({ status: 200, data: { stars: 5 }, provenance: 'live' });
    expect(first.headers.etag).toBe('"v1"');

    clock.now += 7 * HOUR;
    const second = await client.getJson<{ stars: number }>(REPO, repoOpts);
    expect(second).toMatchObject({ status: 200, data: { stars: 5 }, provenance: 'live' });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.headers['if-none-match']).toBe('"v1"');
    expect(server.requests[1]?.url).toBe('/repos/o/r');
    expect(store.touched).toHaveLength(1);
  });

  it('parses x-ratelimit headers and pre-blocks after a 403 with remaining=0', async () => {
    const reset = Math.floor(T0 / 1000) + 1800;
    let limited = false;
    server.setHandler((_req, res) => {
      const body = JSON.stringify(limited ? { message: 'API rate limit exceeded' } : { ok: true });
      res.writeHead(limited ? 403 : 200, {
        'content-type': 'application/json',
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': limited ? '0' : '59',
        'x-ratelimit-reset': String(reset),
        'x-ratelimit-resource': 'core',
      });
      res.end(body);
    });
    const client = makeClient();

    await client.getJson('https://api.github.com/repos/o/a', repoOpts);
    expect(store.getRateLimit('github:core:anon')).toMatchObject({
      limit: 60,
      remaining: 59,
      reset_at: reset * 1000,
    });

    limited = true;
    const hit = await client.getJson('https://api.github.com/repos/o/b', repoOpts);
    expect(hit.error).toBe('rate_limited');
    expect(server.requests).toHaveLength(2);

    const blocked = await client.getJson('https://api.github.com/repos/o/c', repoOpts);
    expect(blocked.error).toBe('rate_limited');
    expect(server.requests).toHaveLength(2);
  });

  it('retries a 503 once with real HTTP', async () => {
    let n = 0;
    server.setHandler((_req, res) => {
      n += 1;
      const body = JSON.stringify(n === 1 ? { message: 'unavailable' } : { ok: true });
      res.writeHead(n === 1 ? 503 : 200, { 'content-type': 'application/json' });
      res.end(body);
    });
    const r = await makeClient().getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 200, data: { ok: true } });
    expect(server.requests).toHaveLength(2);
  });

  it('times out a server that never answers, without retrying', async () => {
    server.setHandler(() => new Promise<void>(() => undefined));
    const started = Date.now();
    const r = await makeClient({ timeoutMs: 100 }).getJson(REPO, repoOpts);
    expect(r).toMatchObject({ status: 0, data: null, error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(server.requests).toHaveLength(1);
  });

  it('serves stale data when the server later fails', async () => {
    let healthy = true;
    server.setHandler((_req, res) => {
      res.writeHead(healthy ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthy ? { v: 1 } : { message: 'boom' }));
    });
    const client = makeClient();
    await client.getJson(REPO, repoOpts);
    healthy = false;
    clock.now += 7 * HOUR;
    const r = await client.getJson<{ v: number }>(REPO, repoOpts);
    expect(r).toMatchObject({ data: { v: 1 }, provenance: 'stale_cache' });
  });

  it('follows a real redirect and sends the token only to the allowlisted GitHub host', async () => {
    server.setHandler((req, res) => {
      if (req.url === '/repos/old/name') {
        res.writeHead(301, { location: 'https://api.github.com/repositories/42' });
        res.end();
        return;
      }
      const body = JSON.stringify({ id: 42 });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
    const client = makeClient({ token: async () => TOKEN });
    const r = await client.getJson<{ id: number }>('https://api.github.com/repos/old/name', { ...repoOpts, auth: true });
    expect(r.data).toEqual({ id: 42 });
    expect(server.requests.map((q) => q.url)).toEqual(['/repos/old/name', '/repositories/42']);
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(server.requests[1]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(server.requests[0]?.headers.accept).toBe('application/vnd.github+json');
  });
});
