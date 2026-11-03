import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheKey } from '../../../src/cache/key.js';
import { createRemoteCache } from '../../../src/cache/remote.js';
import { openCacheStore } from '../../../src/cache/store.js';
import { normalizeClientAddress, startCacheServer } from '../../../src/server/cache-server.js';
import type { CacheServerOptions } from '../../../src/server/cache-server.js';
import { createHttpClient } from '../../../src/http/client.js';
import type { CacheStore } from '../../../src/types.js';
import { cleanupTmpDirs, makeTmpDir } from '../../helpers/tmp.js';
import { sendJson, startTestServer } from '../../helpers/test-server.js';
import type { TestServer } from '../../helpers/test-server.js';

const WRITE = 'write-token-AAAA';
const READ = 'read-token-BBBBBB';
const GH_TOKEN = 'ghp_TESTTOKEN123';
const SEARCH_URL = 'https://api.github.com/search/repositories?q=markdown%20pdf&api_key=SECRETKEY';
const KEY = cacheKey('https://api.github.com/repos/o/r');
const KEY2 = cacheKey('https://registry.npmjs.org/left-pad/latest');

type Handle = Awaited<ReturnType<typeof startCacheServer>>;
const handles: Handle[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

async function boot(options: Partial<CacheServerOptions> = {}): Promise<Handle> {
  const handle = await startCacheServer({ host: '127.0.0.1', port: 0, dbPath: ':memory:', ...options });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  for (const fn of cleanups.splice(0)) await fn();
  cleanupTmpDirs();
});

interface WireOverrides {
  source?: string;
  status?: number;
  body?: string;
  etag?: string;
  last_modified?: string;
  fetched_at?: number;
  expires_at?: number;
}

function wire(overrides: WireOverrides = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    source: 'npm',
    status: 200,
    body: JSON.stringify({ name: 'left-pad', version: '1.3.0' }),
    fetched_at: now,
    expires_at: now + 3_600_000,
    ...overrides,
  };
}

async function call(
  base: string,
  method: string,
  pathName: string,
  opts: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.rawBody !== undefined) init.body = opts.rawBody;
  else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}${pathName}`, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

describe('health and routing', () => {
  it('serves /v1/health without credentials, reporting only that the server is up', async () => {
    const s = await boot({ writeToken: WRITE, readToken: READ, version: '9.9.9' });
    const r = await call(s.url, 'GET', '/v1/health');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(r.headers.get('content-type')).toContain('application/json');
  });

  it('adds version and entry count to /v1/health only for a caller with a valid token', async () => {
    const s = await boot({ writeToken: WRITE, readToken: READ, version: '9.9.9' });
    await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire() });
    expect((await call(s.url, 'GET', '/v1/health', { token: READ })).json).toEqual({ ok: true, version: '9.9.9', entries: 1 });
    expect((await call(s.url, 'GET', '/v1/health', { token: WRITE })).json).toEqual({ ok: true, version: '9.9.9', entries: 1 });
    const wrong = await call(s.url, 'GET', '/v1/health', { token: 'wrong-token-CCCC' });
    expect(wrong.status).toBe(200);
    expect(wrong.json).toEqual({ ok: true });
  });

  it('keeps /v1/health minimal when the server has no token configured', async () => {
    const s = await boot({ version: '9.9.9' });
    expect((await call(s.url, 'GET', '/v1/health', { token: 'anything-at-all' })).json).toEqual({ ok: true });
  });

  it('counts wrong tokens on /v1/health as auth failures and gives a locked-out client no detail', async () => {
    const s = await boot({ writeToken: WRITE, readToken: READ, authFailLimitPerMin: 2, rateLimitPerMin: 0, now: () => 1_900_000_000_000 });
    for (let i = 0; i < 2; i++) {
      expect((await call(s.url, 'GET', '/v1/health', { token: 'wrong-token-CCCC' })).json).toEqual({ ok: true });
    }
    // Locked now: even the right token learns nothing on health, and entries answer 429.
    expect((await call(s.url, 'GET', '/v1/health', { token: READ })).json).toEqual({ ok: true });
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: READ })).status).toBe(429);
  });

  it('stays compatible with the client reachability probe', async () => {
    const s = await boot({ writeToken: WRITE, readToken: READ });
    expect(await createRemoteCache({ url: s.url, mode: 'read' }).healthy()).toBe(true);
    expect(await createRemoteCache({ url: s.url, mode: 'read', token: 'wrong-token-CCCC' }).healthy()).toBe(true);
    expect(await createRemoteCache({ url: s.url, mode: 'read', token: READ }).healthy()).toBe(true);
  });

  it('reports 404 for unknown paths and 405 for wrong methods', async () => {
    const s = await boot({ writeToken: WRITE });
    expect((await call(s.url, 'GET', '/nope')).status).toBe(404);
    expect((await call(s.url, 'GET', '/v1/entries')).status).toBe(404);
    expect((await call(s.url, 'POST', '/v1/health')).status).toBe(405);
    expect((await call(s.url, 'POST', `/v1/entries/${KEY}`, { token: WRITE })).status).toBe(405);
  });

  it('binds the requested host and returns a usable URL', async () => {
    const s = await boot();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await s.close();
    await s.close(); // idempotent
  });

  it('rejects when the port is already taken', async () => {
    const s = await boot();
    const port = Number(new URL(s.url).port);
    await expect(startCacheServer({ host: '127.0.0.1', port, dbPath: ':memory:' })).rejects.toThrow();
  });
});

describe('client <-> server round trip', () => {
  it('PUT then GET through createRemoteCache, and the stored row has no URL', async () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'server.db');
    const s = await boot({ dbPath, writeToken: WRITE, readToken: READ });
    const writer = createRemoteCache({ url: s.url, mode: 'readwrite', token: WRITE });
    const reader = createRemoteCache({ url: s.url, mode: 'read', token: READ });
    const now = Date.now();

    await writer.put({
      key: KEY,
      url_redacted: 'https://api.github.com/repos/o/r?api_key=REDACTED',
      source: 'github_repo',
      status: 200,
      body: JSON.stringify({ full_name: 'o/r', private: false }),
      etag: 'W/"1"',
      fetched_at: now,
      expires_at: now + 600_000,
      provenance: 'live',
    });

    const got = await reader.get(KEY);
    expect(got).toMatchObject({
      key: KEY,
      url_redacted: '',
      source: 'github_repo',
      status: 200,
      etag: 'W/"1"',
      provenance: 'remote_cache',
    });
    expect(JSON.parse(got?.body ?? '{}')).toEqual({ full_name: 'o/r', private: false });
    expect(await reader.healthy()).toBe(true);

    await s.close();
    const store: CacheStore = openCacheStore(dbPath);
    try {
      const row = store.get(KEY);
      expect(row?.url_redacted).toBe('');
      expect(row?.provenance).toBe('remote_cache');
    } finally {
      store.close();
    }
  });

  it('round-trips a negative (404) entry', async () => {
    const s = await boot({ writeToken: WRITE });
    const remote = createRemoteCache({ url: s.url, mode: 'readwrite', token: WRITE });
    const now = Date.now();
    await remote.put({
      key: KEY2,
      url_redacted: '',
      source: 'npm',
      status: 404,
      body: 'null',
      fetched_at: now,
      expires_at: now + 3_600_000,
      provenance: 'live',
    });
    const got = await remote.get(KEY2);
    expect(got?.status).toBe(404);
    expect(got?.body).toBe('null');
  });

  it('returns undefined for a missing key', async () => {
    const s = await boot();
    const remote = createRemoteCache({ url: s.url, mode: 'read' });
    await expect(remote.get(KEY)).resolves.toBeUndefined();
  });
});

describe('minimum token length (second re-check L2)', () => {
  const FIFTEEN = 'fifteen-chars-x';
  const SIXTEEN = 'sixteen-chars-xy';

  it.each([
    ['write', { writeToken: FIFTEEN }],
    ['read', { readToken: FIFTEEN }],
    ['write (the other is fine)', { writeToken: FIFTEEN, readToken: SIXTEEN }],
    ['read (the other is fine)', { writeToken: SIXTEEN, readToken: FIFTEEN }],
    ['write, a one-character token', { writeToken: 'x' }],
  ] as const)('refuses to start with a short %s token, without echoing it', async (label, options) => {
    const err = await startCacheServer({ host: '127.0.0.1', port: 0, dbPath: ':memory:', ...options }).then(
      (h) => {
        handles.push(h);
        return undefined;
      },
      (e: unknown) => e as Error,
    );
    expect(err, label).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/too short/);
    expect(err?.message).toContain('at least 16');
    expect(err?.message).toContain('openssl rand -hex 32');
    for (const token of [FIFTEEN, 'x']) {
      if (token.length > 1) expect(err?.message).not.toContain(token);
    }
  });

  it('starts with 16-character tokens and they authenticate', async () => {
    const s = await boot({ writeToken: SIXTEEN, readToken: 'read-chars-16-ab' });
    expect((await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: SIXTEEN, body: wire() })).status).toBe(204);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: 'read-chars-16-ab' })).status).toBe(200);
  });

  it('treats an empty token as not configured (writes disabled, reads open)', async () => {
    const s = await boot({ writeToken: '', readToken: '' });
    expect((await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: SIXTEEN, body: wire() })).status).toBe(403);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(404);
  });
});

describe('authentication', () => {
  it('disables writes (403) when no write token is configured', async () => {
    const s = await boot();
    const put = await call(s.url, 'PUT', `/v1/entries/${KEY}`, { body: wire() });
    expect(put.status).toBe(403);
    const withToken = await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire() });
    expect(withToken.status).toBe(403);
    expect((await call(s.url, 'DELETE', `/v1/entries/${KEY}`, { token: WRITE })).status).toBe(403);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(404);
  });

  it('refuses PUT and DELETE without or with a wrong write token (403)', async () => {
    const s = await boot({ writeToken: WRITE, readToken: READ });
    for (const token of [undefined, 'wrong', READ, '']) {
      const opts = token === undefined ? { body: wire() } : { token, body: wire() };
      expect((await call(s.url, 'PUT', `/v1/entries/${KEY}`, opts)).status).toBe(403);
      expect((await call(s.url, 'DELETE', `/v1/entries/${KEY}`, token === undefined ? {} : { token })).status).toBe(403);
    }
    expect((await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire() })).status).toBe(204);
  });

  it('requires the read token for GET when configured (401); the write token also reads', async () => {
    const s = await boot({ writeToken: WRITE, readToken: READ });
    await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire() });
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(401);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: 'wrong' })).status).toBe(401);
    const denied = await call(s.url, 'GET', `/v1/entries/${KEY}`);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer');
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: READ })).status).toBe(200);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: WRITE })).status).toBe(200);
  });

  it('leaves reads open when only a write token is configured', async () => {
    const s = await boot({ writeToken: WRITE });
    await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire() });
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(200);
  });

  it('does not buffer or validate the body of an unauthorized PUT', async () => {
    const s = await boot({ writeToken: WRITE });
    const r = await call(s.url, 'PUT', `/v1/entries/${KEY}`, { rawBody: 'x'.repeat(3_000_000) });
    expect(r.status).toBe(403);
  });
});

describe('PUT validation', () => {
  it('rejects malformed keys with 400', async () => {
    const s = await boot({ writeToken: WRITE });
    for (const bad of ['abc', 'g'.repeat(64), KEY.toUpperCase(), `${KEY}0`, '..%2F..%2Fetc', '%00']) {
      expect((await call(s.url, 'PUT', `/v1/entries/${bad}`, { token: WRITE, body: wire() })).status).toBe(400);
      expect((await call(s.url, 'GET', `/v1/entries/${bad}`)).status).toBe(400);
    }
    expect((await call(s.url, 'GET', '/v1/entries/')).status).toBe(400);
  });

  it('rejects invalid JSON, wrong shapes, bad status and unknown sources with 400', async () => {
    const s = await boot({ writeToken: WRITE });
    const put = (opts: { body?: unknown; rawBody?: string }) =>
      call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, ...opts });
    expect((await put({ rawBody: '{not json' })).status).toBe(400);
    expect((await put({ rawBody: '' })).status).toBe(400);
    expect((await put({ body: [1, 2] })).status).toBe(400);
    expect((await put({ body: { source: 'npm' } })).status).toBe(400);
    expect((await put({ body: wire({ status: 500 }) })).status).toBe(400);
    expect((await put({ body: wire({ status: 201 }) })).status).toBe(400);
    expect((await put({ body: wire({ source: 'librariesio' }) })).status).toBe(400);
    expect((await put({ body: wire({ source: 'evil' }) })).status).toBe(400);
    expect((await put({ body: wire({ expires_at: -5 }) })).status).toBe(400);
    expect((await put({ body: wire({ fetched_at: 1.5 }) })).status).toBe(400);
  });

  it('rejects etag / last_modified values that could not be replayed safely as header values with 400', async () => {
    const s = await boot({ writeToken: WRITE });
    const put = (overrides: WireOverrides) =>
      call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire(overrides) });
    for (const bad of ['W/"a"\r\nX-Injected: 1', '"中文"', '"café"', '"a\u0000"', `"${'x'.repeat(300)}"`, '']) {
      expect((await put({ etag: bad })).status).toBe(400);
      expect((await put({ last_modified: bad })).status).toBe(400);
    }
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(404); // nothing was stored
    expect((await put({ etag: 'W/"ok"', last_modified: 'Tue, 01 Oct 2026 00:00:00 GMT' })).status).toBe(204);
  });

  it('answers 413 for oversized request bodies and oversized entry bodies', async () => {
    const s = await boot({ writeToken: WRITE });
    const huge = await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, rawBody: 'x'.repeat(2_000_000) });
    expect(huge.status).toBe(413);

    const over = JSON.stringify({ pad: 'x'.repeat(1_000_000) });
    const entryTooBig = await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire({ body: over }) });
    expect(entryTooBig.status).toBe(413);

    const justFits = JSON.stringify({ pad: 'x'.repeat(999_000) });
    expect((await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire({ body: justFits }) })).status).toBe(204);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(200);
  });

  it('honors a custom maxBodyBytes', async () => {
    const s = await boot({ writeToken: WRITE, maxBodyBytes: 200 });
    const big = JSON.stringify({ pad: 'x'.repeat(300) });
    expect((await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire({ body: big }) })).status).toBe(413);
    const small = JSON.stringify({ a: 1 });
    expect((await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire({ body: small }) })).status).toBe(204);
  });

  it('refuses entries that sanitize rejects (422) and stores nothing', async () => {
    const s = await boot({ writeToken: WRITE });
    const privateRepo = JSON.stringify({ full_name: 'acme/secret', private: true });
    const r = await call(s.url, 'PUT', `/v1/entries/${KEY}`, {
      token: WRITE,
      body: wire({ source: 'github_repo', body: privateRepo }),
    });
    expect(r.status).toBe(422);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(404);

    const notJson = await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire({ body: 'plain text' }) });
    expect(notJson.status).toBe(422);
  });

  it('removes private search items on the server as well', async () => {
    const s = await boot({ writeToken: WRITE });
    const body = JSON.stringify({
      total_count: 3,
      items: [
        { full_name: 'o/a', private: false },
        { full_name: 'acme/hidden', private: true },
        { full_name: 'o/b', private: false },
      ],
    });
    expect((await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire({ source: 'github_repo', body }) })).status).toBe(204);
    const got = (await call(s.url, 'GET', `/v1/entries/${KEY}`)).json as { body: string };
    expect(got.body).not.toContain('hidden');
    expect(JSON.parse(got.body)).toMatchObject({ total_count: 2 });
  });
});

describe('TTL handling', () => {
  it('clamps expires_at - fetched_at to maxTtlSec', async () => {
    const t = 1_900_000_000_000;
    const s = await boot({ writeToken: WRITE, maxTtlSec: 60, now: () => t });
    const r = await call(s.url, 'PUT', `/v1/entries/${KEY}`, {
      token: WRITE,
      body: wire({ fetched_at: t, expires_at: t + 30 * 24 * 3_600_000 }),
    });
    expect(r.status).toBe(204);
    const got = (await call(s.url, 'GET', `/v1/entries/${KEY}`)).json as { fetched_at: number; expires_at: number };
    expect(got.fetched_at).toBe(t);
    expect(got.expires_at).toBe(t + 60_000);
  });

  it('defaults to a 7 day cap', async () => {
    const t = 1_900_000_000_000;
    const s = await boot({ writeToken: WRITE, now: () => t });
    await call(s.url, 'PUT', `/v1/entries/${KEY}`, {
      token: WRITE,
      body: wire({ fetched_at: t, expires_at: t + 90 * 24 * 3_600_000 }),
    });
    const got = (await call(s.url, 'GET', `/v1/entries/${KEY}`)).json as { expires_at: number };
    expect(got.expires_at).toBe(t + 7 * 24 * 3_600_000);
  });

  it('does not accept a fetched_at in the future', async () => {
    const t = 1_900_000_000_000;
    const s = await boot({ writeToken: WRITE, maxTtlSec: 60, now: () => t });
    await call(s.url, 'PUT', `/v1/entries/${KEY}`, {
      token: WRITE,
      body: wire({ fetched_at: t + 10 * 24 * 3_600_000, expires_at: t + 20 * 24 * 3_600_000 }),
    });
    const got = (await call(s.url, 'GET', `/v1/entries/${KEY}`)).json as { fetched_at: number; expires_at: number };
    expect(got.fetched_at).toBe(t);
    expect(got.expires_at).toBe(t + 60_000);
  });

  it('serves 404 once an entry has expired, and ignores already expired uploads', async () => {
    let t = 1_900_000_000_000;
    const s = await boot({ writeToken: WRITE, now: () => t });
    await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire({ fetched_at: t, expires_at: t + 1_000 }) });
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(200);
    t += 1_000;
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(404);

    const stale = await call(s.url, 'PUT', `/v1/entries/${KEY2}`, {
      token: WRITE,
      body: wire({ fetched_at: t - 5_000, expires_at: t - 1 }),
    });
    expect(stale.status).toBe(204);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY2}`)).status).toBe(404);
  });
});

describe('DELETE', () => {
  it('invalidates an entry and is idempotent', async () => {
    const s = await boot({ writeToken: WRITE });
    await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire() });
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(200);
    expect((await call(s.url, 'DELETE', `/v1/entries/${KEY}`, { token: WRITE })).status).toBe(204);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(404);
    expect((await call(s.url, 'DELETE', `/v1/entries/${KEY}`, { token: WRITE })).status).toBe(204);
    expect((await call(s.url, 'DELETE', `/v1/entries/${KEY2}`, { token: WRITE })).status).toBe(204);
  });
});

describe('rate limiting', () => {
  it('answers 429 with Retry-After once the bucket is empty and recovers over time', async () => {
    let t = 1_900_000_000_000;
    const s = await boot({ rateLimitPerMin: 3, now: () => t });
    for (let i = 0; i < 3; i++) expect((await call(s.url, 'GET', '/v1/health')).status).toBe(200);
    const limited = await call(s.url, 'GET', '/v1/health');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    t += 61_000;
    expect((await call(s.url, 'GET', '/v1/health')).status).toBe(200);
  });

  it('can be disabled with 0', async () => {
    const s = await boot({ rateLimitPerMin: 0 });
    for (let i = 0; i < 30; i++) expect((await call(s.url, 'GET', '/v1/health')).status).toBe(200);
  });

  it('applies a generous default (120/min)', async () => {
    const t = 1_900_000_000_000;
    const s = await boot({ now: () => t });
    let last = 0;
    let ok = 0;
    for (let i = 0; i < 125; i++) {
      last = (await call(s.url, 'GET', '/v1/health')).status;
      if (last === 200) ok += 1;
    }
    expect(ok).toBe(120);
    expect(last).toBe(429);
  });

  it('keys buckets by X-Forwarded-For unless trustProxy is false (default: trusted from loopback peers)', async () => {
    const t = 1_900_000_000_000;
    const direct = await boot({ rateLimitPerMin: 1, trustProxy: false, now: () => t });
    expect((await call(direct.url, 'GET', '/v1/health', { headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(200);
    expect((await call(direct.url, 'GET', '/v1/health', { headers: { 'x-forwarded-for': '10.0.0.2' } })).status).toBe(429);

    const byDefault = await boot({ rateLimitPerMin: 1, now: () => t });
    expect((await call(byDefault.url, 'GET', '/v1/health', { headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(200);
    expect((await call(byDefault.url, 'GET', '/v1/health', { headers: { 'x-forwarded-for': '10.0.0.2' } })).status).toBe(200);

    const proxied = await boot({ rateLimitPerMin: 1, trustProxy: true, now: () => t });
    expect((await call(proxied.url, 'GET', '/v1/health', { headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(200);
    expect((await call(proxied.url, 'GET', '/v1/health', { headers: { 'x-forwarded-for': '10.0.0.2' } })).status).toBe(200);
    expect((await call(proxied.url, 'GET', '/v1/health', { headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(429);
  });
});

describe('rate limiting behind proxies', () => {
  const T = 1_900_000_000_000;
  const health = (base: string, xff: string) => call(base, 'GET', '/v1/health', { headers: { 'x-forwarded-for': xff } });

  it('ignores forged leading X-Forwarded-For entries (default: one trusted hop, read from the right)', async () => {
    const s = await boot({ rateLimitPerMin: 1, now: () => T });
    // nginx $proxy_add_x_forwarded_for: the client-supplied value stays first, the proxy appends the real peer.
    expect((await health(s.url, 'forged-1, 203.0.113.7')).status).toBe(200);
    expect((await health(s.url, 'forged-2, 203.0.113.7')).status).toBe(429);
    expect((await health(s.url, '203.0.113.7')).status).toBe(429);
    expect((await health(s.url, 'forged-1, 203.0.113.8')).status).toBe(200);
  });

  it('counts trustedHops entries from the right', async () => {
    const s = await boot({ rateLimitPerMin: 1, trustedHops: 2, now: () => T });
    expect((await health(s.url, 'forged-1, 198.51.100.5, 10.0.0.1')).status).toBe(200);
    expect((await health(s.url, 'forged-2, 198.51.100.5, 10.0.0.2')).status).toBe(429);
    expect((await health(s.url, 'forged-1, 198.51.100.6, 10.0.0.1')).status).toBe(200);
  });

  it('falls back to the socket address when the header has fewer entries than trustedHops', async () => {
    const s = await boot({ rateLimitPerMin: 1, trustedHops: 3, now: () => T });
    expect((await health(s.url, 'a, b')).status).toBe(200);
    expect((await health(s.url, 'c, d')).status).toBe(429); // same socket bucket, not keyed by the forged values
    expect((await call(s.url, 'GET', '/v1/health')).status).toBe(429);
  });

  it('treats an invalid trustedHops as the default of 1', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const s = await boot({ rateLimitPerMin: 1, trustedHops: bad, now: () => T });
      expect((await health(s.url, 'forged-1, 203.0.113.7')).status).toBe(200);
      expect((await health(s.url, 'forged-2, 203.0.113.7')).status).toBe(429);
    }
  });

  it('bounds the bucket map by evicting the least recently used client instead of refusing new ones', async () => {
    const s = await boot({ rateLimitPerMin: 1, trustProxy: true, maxTrackedClients: 2, now: () => T });
    expect((await health(s.url, '10.0.0.1')).status).toBe(200); // [A]
    expect((await health(s.url, '10.0.0.2')).status).toBe(200); // [A, B]
    expect((await health(s.url, '10.0.0.3')).status).toBe(200); // C is served; A evicted -> [B, C]
    expect((await health(s.url, '10.0.0.3')).status).toBe(429); // C is still tracked
    expect((await health(s.url, '10.0.0.1')).status).toBe(200); // A starts over with a fresh bucket, B evicted -> [C, A]
    expect((await health(s.url, '10.0.0.1')).status).toBe(429);
  });

  it('keeps serving new clients after a flood of fake addresses', async () => {
    const s = await boot({ rateLimitPerMin: 5, trustProxy: true, maxTrackedClients: 8, now: () => T });
    for (let i = 0; i < 40; i++) expect((await health(s.url, `192.0.2.${i}`)).status).toBe(200);
    expect((await health(s.url, '198.51.100.99')).status).toBe(200);
  });
});

describe('authentication failure limiting', () => {
  const T0 = 1_900_000_000_000;

  it('locks a client out with 429 + Retry-After after too many failed attempts, then recovers', async () => {
    let t = T0;
    const s = await boot({ writeToken: WRITE, readToken: READ, authFailLimitPerMin: 3, rateLimitPerMin: 0, now: () => t });
    for (let i = 0; i < 3; i++) {
      expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: 'wrong-token-CCCC' })).status).toBe(401);
    }
    const locked = await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: 'wrong-token-CCCC' });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // Even correct credentials wait out the lockout, and so do writes.
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: READ })).status).toBe(429);
    expect((await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire() })).status).toBe(429);
    // Health stays reachable (monitoring).
    expect((await call(s.url, 'GET', '/v1/health')).status).toBe(200);
    t += 61_000;
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: READ })).status).toBe(404);
  });

  it('counts wrong write tokens (403) too, and tracks clients separately', async () => {
    const s = await boot({
      writeToken: WRITE,
      authFailLimitPerMin: 2,
      rateLimitPerMin: 0,
      trustProxy: true,
      now: () => T0,
    });
    const put = (token: string, ip: string) =>
      call(s.url, 'PUT', `/v1/entries/${KEY}`, { token, body: wire(), headers: { 'x-forwarded-for': ip } });
    expect((await put('bad-1', '10.1.1.1')).status).toBe(403);
    expect((await put('bad-2', '10.1.1.1')).status).toBe(403);
    expect((await put('bad-3', '10.1.1.1')).status).toBe(429);
    expect((await put(WRITE, '10.1.1.2')).status).toBe(204);
  });

  it('does not count successful or unauthenticated-by-design requests', async () => {
    const s = await boot({ writeToken: WRITE, readToken: READ, authFailLimitPerMin: 2, rateLimitPerMin: 0, now: () => T0 });
    for (let i = 0; i < 10; i++) {
      expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: READ })).status).toBe(404);
    }
    const readOnly = await boot({ authFailLimitPerMin: 2, rateLimitPerMin: 0, now: () => T0 });
    for (let i = 0; i < 5; i++) {
      expect((await call(readOnly.url, 'PUT', `/v1/entries/${KEY}`, { body: wire() })).status).toBe(403); // writes disabled
      expect((await call(readOnly.url, 'GET', `/v1/entries/${KEY}`)).status).toBe(404);
    }
  });

  it('allows 20 failures per minute by default and can be disabled with 0', async () => {
    const s = await boot({ readToken: READ, rateLimitPerMin: 0, now: () => T0 });
    for (let i = 0; i < 20; i++) expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: 'nope' })).status).toBe(401);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: 'nope' })).status).toBe(429);

    const off = await boot({ readToken: READ, rateLimitPerMin: 0, authFailLimitPerMin: 0, now: () => T0 });
    for (let i = 0; i < 30; i++) expect((await call(off.url, 'GET', `/v1/entries/${KEY}`, { token: 'nope' })).status).toBe(401);
  });
});

describe('client address normalization', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['[::ffff:203.0.113.7]', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:db8::', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b::192.0.2.33', '64:ff9b:0:0::/64'],
    ['forged-entry', 'forged-entry'],
    ['unknown', 'unknown'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeClientAddress(raw)).toBe(expected);
  });
});

describe('rate limiting by address family', () => {
  const T = 1_900_000_000_000;
  const health = (base: string, xff: string) => call(base, 'GET', '/v1/health', { headers: { 'x-forwarded-for': xff } });

  it('shares one bucket across a whole IPv6 /64', async () => {
    const s = await boot({ rateLimitPerMin: 1, trustProxy: true, now: () => T });
    expect((await health(s.url, '2001:db8:aa:bb::1')).status).toBe(200);
    expect((await health(s.url, '2001:db8:aa:bb:1234:5678:9abc:def0')).status).toBe(429);
    expect((await health(s.url, '2001:db8:aa:bb:ffff::')).status).toBe(429);
    expect((await health(s.url, '2001:db8:aa:bc::1')).status).toBe(200); // another /64
  });

  it('counts IPv4-mapped IPv6 as the IPv4 address', async () => {
    const s = await boot({ rateLimitPerMin: 1, trustProxy: true, now: () => T });
    expect((await health(s.url, '10.9.9.9')).status).toBe(200);
    expect((await health(s.url, '::ffff:10.9.9.9')).status).toBe(429);
    expect((await health(s.url, '::ffff:0a09:0909')).status).toBe(429);
    expect((await health(s.url, '::ffff:10.9.9.10')).status).toBe(200);
  });

  it('applies the /64 grouping to the auth-failure limit too', async () => {
    const s = await boot({
      readToken: READ,
      authFailLimitPerMin: 2,
      rateLimitPerMin: 0,
      globalAuthFailLimitPerMin: 0,
      trustProxy: true,
      now: () => T,
    });
    const get = (token: string, ip: string) =>
      call(s.url, 'GET', `/v1/entries/${KEY}`, { token, headers: { 'x-forwarded-for': ip } });
    expect((await get('bad-1', '2001:db8:5:6::1')).status).toBe(401);
    expect((await get('bad-2', '2001:db8:5:6::2')).status).toBe(401);
    expect((await get('bad-3', '2001:db8:5:6::3')).status).toBe(429);
    expect((await get(READ, '2001:db8:5:6::4')).status).toBe(429); // same /64: locked out, valid token included
    expect((await get(READ, '2001:db8:5:7::1')).status).toBe(404);
  });
});

describe('global authentication failure limit', () => {
  const T0 = 1_900_000_000_000;

  it('turns further failed attempts from any address into 429 + Retry-After, but not valid tokens', async () => {
    let t = T0;
    const s = await boot({
      writeToken: WRITE,
      readToken: READ,
      authFailLimitPerMin: 0,
      globalAuthFailLimitPerMin: 3,
      rateLimitPerMin: 0,
      trustProxy: true,
      now: () => t,
    });
    const get = (token: string, ip: string) =>
      call(s.url, 'GET', `/v1/entries/${KEY}`, { token, headers: { 'x-forwarded-for': ip } });
    const put = (token: string, ip: string) =>
      call(s.url, 'PUT', `/v1/entries/${KEY}`, {
        token,
        body: wire({ fetched_at: T0, expires_at: T0 + 3_600_000 }),
        headers: { 'x-forwarded-for': ip },
      });

    expect((await get('bad-1', '10.0.0.1')).status).toBe(401);
    expect((await put('bad-2', '10.0.0.2')).status).toBe(403);
    expect((await get('bad-3', '10.0.0.3')).status).toBe(401);
    const spent = await get('bad-4', '10.0.0.4'); // a fresh address, but the server-wide budget is gone
    expect(spent.status).toBe(429);
    expect(Number(spent.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await put('bad-5', '10.0.0.5')).status).toBe(429);

    // Valid credentials are not held back by the global budget.
    expect((await get(READ, '10.0.0.6')).status).toBe(404);
    expect((await put(WRITE, '10.0.0.6')).status).toBe(204);
    expect((await get(READ, '10.0.0.6')).status).toBe(200);

    t += 61_000; // budget refilled
    expect((await get('bad-6', '10.0.0.7')).status).toBe(401);
  });

  it('keeps the per-address lockout for an address that locked itself out, valid token included', async () => {
    const s = await boot({
      readToken: READ,
      authFailLimitPerMin: 1,
      globalAuthFailLimitPerMin: 1000,
      rateLimitPerMin: 0,
      now: () => T0,
    });
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: 'bad-1' })).status).toBe(401);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: 'bad-2' })).status).toBe(429);
    expect((await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: READ })).status).toBe(429);
  });

  it('defaults to 600 failures per minute and can be disabled with 0', async () => {
    const def = await boot({ readToken: READ, authFailLimitPerMin: 0, rateLimitPerMin: 0, now: () => T0 });
    for (let i = 0; i < 600; i++) expect((await call(def.url, 'GET', `/v1/entries/${KEY}`, { token: 'nope' })).status).toBe(401);
    expect((await call(def.url, 'GET', `/v1/entries/${KEY}`, { token: 'nope' })).status).toBe(429);
    expect((await call(def.url, 'GET', `/v1/entries/${KEY}`, { token: READ })).status).toBe(404);

    const off = await boot({
      readToken: READ,
      authFailLimitPerMin: 0,
      globalAuthFailLimitPerMin: 0,
      rateLimitPerMin: 0,
      now: () => T0,
    });
    for (let i = 0; i < 650; i++) expect((await call(off.url, 'GET', `/v1/entries/${KEY}`, { token: 'nope' })).status).toBe(401);
  });

  it('does not count writes-disabled answers or unauthenticated health calls', async () => {
    const s = await boot({ globalAuthFailLimitPerMin: 2, authFailLimitPerMin: 0, rateLimitPerMin: 0, now: () => T0 });
    for (let i = 0; i < 5; i++) {
      expect((await call(s.url, 'PUT', `/v1/entries/${KEY}`, { body: wire() })).status).toBe(403);
      expect((await call(s.url, 'GET', '/v1/health')).status).toBe(200);
    }
  });
});

describe('logging', () => {
  it('never logs tokens, keys or bodies', async () => {
    const lines: string[] = [];
    const s = await boot({
      writeToken: WRITE,
      readToken: READ,
      logger: (level, message) => lines.push(`${level} ${message}`),
    });
    await call(s.url, 'PUT', `/v1/entries/${KEY}`, { token: WRITE, body: wire({ body: JSON.stringify({ marker: 'BODY-MARKER' }) }) });
    await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: READ });
    await call(s.url, 'GET', `/v1/entries/${KEY}`, { token: 'wrong-token-CCCC' });
    await call(s.url, 'DELETE', `/v1/entries/${KEY}`, { token: WRITE });
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const secret of [WRITE, READ, 'wrong-token-CCCC', KEY, 'BODY-MARKER', 'Bearer']) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('end to end with the HTTP client', () => {
  const SEARCH_BODY = JSON.stringify({
    total_count: 2,
    incomplete_results: false,
    items: [
      { full_name: 'o/public', private: false, stargazers_count: 10 },
      { full_name: 'acme/internal-tool', private: true, stargazers_count: 1 },
    ],
  });

  function upstream(): { fetch: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fn = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(SEARCH_BODY, { status: 200, headers: { 'content-type': 'application/json', etag: '"e1"' } });
    });
    return { fetch: fn as unknown as typeof fetch, calls };
  }

  it('shares a live response and a second client is served from the remote cache', async () => {
    const s = await boot({ writeToken: WRITE });
    const storeA = openCacheStore(':memory:');
    const storeB = openCacheStore(':memory:');
    cleanups.push(() => storeA.close(), () => storeB.close());
    const up = upstream();
    const opts = { source: 'github_repo', ttlClass: 'search', auth: true, shareable: true } as const;

    const clientA = createHttpClient({
      store: storeA,
      remote: createRemoteCache({ url: s.url, mode: 'readwrite', token: WRITE }),
      config: { offline: false },
      fetch: up.fetch,
      token: async () => GH_TOKEN,
    });
    const first = await clientA.getJson<{ items: unknown[] }>(SEARCH_URL, opts);
    expect(first.provenance).toBe('live');
    expect(first.data?.items).toHaveLength(2); // local result is untouched

    const uploaded = await vi.waitFor(async () => {
      const r = await call(s.url, 'GET', `/v1/entries/${cacheKey(SEARCH_URL)}`);
      expect(r.status).toBe(200);
      return r.json as { body: string };
    });
    expect(uploaded.body).not.toContain('internal-tool');

    const fail = vi.fn(async () => {
      throw new Error('upstream must not be called');
    });
    const clientB = createHttpClient({
      store: storeB,
      remote: createRemoteCache({ url: s.url, mode: 'read' }),
      config: { offline: false },
      fetch: fail as unknown as typeof fetch,
    });
    const second = await clientB.getJson<{ total_count: number; items: Array<{ full_name: string }> }>(SEARCH_URL, opts);
    expect(second.provenance).toBe('remote_cache');
    expect(fail).not.toHaveBeenCalled();
    expect(second.data?.items.map((i) => i.full_name)).toEqual(['o/public']);
    expect(second.data?.total_count).toBe(1);
    expect(up.calls).toHaveLength(1);
  });

  describe('captured traffic', () => {
    let capture: TestServer | undefined;
    afterEach(async () => {
      await capture?.close();
      capture = undefined;
    });

    it('contains no URL, query, GitHub token or upstream header', async () => {
      capture = await startTestServer((req, res) => {
        if (req.method === 'PUT') {
          res.writeHead(204);
          res.end();
        } else {
          sendJson(res, 404, { error: 'not_found' });
        }
      });
      const store = openCacheStore(':memory:');
      cleanups.push(() => store.close());
      const up = upstream();
      const client = createHttpClient({
        store,
        remote: createRemoteCache({ url: capture.url, mode: 'readwrite', token: 'cache-bearer-DDDD' }),
        config: { offline: false },
        fetch: up.fetch,
        token: async () => GH_TOKEN,
      });
      await client.getJson(SEARCH_URL, { source: 'github_repo', ttlClass: 'search', auth: true, shareable: true });
      await vi.waitFor(() => {
        expect(capture?.requests.some((r) => r.method === 'PUT')).toBe(true);
      });

      expect(capture.requests.length).toBeGreaterThanOrEqual(2); // a GET lookup, then the PUT
      const everything = JSON.stringify(capture.requests);
      for (const leak of [
        GH_TOKEN,
        'SECRETKEY',
        'api_key',
        'markdown',
        'api.github.com',
        'search/repositories',
        'x-github-api-version',
        'vnd.github',
        'internal-tool',
      ]) {
        expect(everything).not.toContain(leak);
      }
      for (const r of capture.requests) {
        expect(r.url).toMatch(/^\/v1\/entries\/[0-9a-f]{64}$/);
        expect(r.headers.authorization).toBe('Bearer cache-bearer-DDDD');
      }
      const put = capture.requests.find((r) => r.method === 'PUT');
      expect(Object.keys(JSON.parse(put?.body ?? '{}') as object).sort()).toEqual([
        'body',
        'etag',
        'expires_at',
        'fetched_at',
        'source',
        'status',
      ]);
    });
  });
});
