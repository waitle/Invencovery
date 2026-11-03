import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheKey } from '../../../src/cache/key.js';
import { RemoteCacheError, RemoteEntryWireSchema, createRemoteCache, toWire } from '../../../src/cache/remote.js';
import type { CacheEntry } from '../../../src/types.js';
import { sendJson, startTestServer } from '../../helpers/test-server.js';
import type { TestServer } from '../../helpers/test-server.js';

const KEY = cacheKey('https://api.github.com/repos/o/r');
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const TOKEN = 'remote-secret-token';

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    key: KEY,
    url_redacted: 'https://api.github.com/repos/o/r?api_key=REDACTED',
    source: 'github_repo',
    status: 200,
    body: JSON.stringify({ full_name: 'o/r', private: false, stargazers_count: 7 }),
    etag: 'W/"abc"',
    fetched_at: T0,
    expires_at: T0 + HOUR,
    provenance: 'live',
    ...overrides,
  };
}

const servers: TestServer[] = [];
async function server(handler?: Parameters<typeof startTestServer>[0]): Promise<TestServer> {
  const s = await startTestServer(handler);
  servers.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function throwingFetch(): typeof fetch {
  return vi.fn(() => {
    throw new Error('network must not be used');
  }) as unknown as typeof fetch;
}

describe('createRemoteCache: mode off', () => {
  it('returns immediately without any network use', async () => {
    const fetchSpy = throwingFetch();
    const remote = createRemoteCache({ url: 'http://127.0.0.1:1', mode: 'off', token: TOKEN, fetch: fetchSpy });
    expect(remote.mode).toBe('off');
    await expect(remote.get(KEY)).resolves.toBeUndefined();
    await expect(remote.put(entry())).resolves.toBeUndefined();
    await expect(remote.healthy()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is off when the URL is missing or invalid, whatever the mode says', async () => {
    const fetchSpy = throwingFetch();
    for (const url of [undefined, '', 'not a url', 'ftp://example.com']) {
      const remote = createRemoteCache({ ...(url !== undefined ? { url } : {}), mode: 'readwrite', fetch: fetchSpy });
      expect(remote.mode).toBe('off');
      await expect(remote.get(KEY)).resolves.toBeUndefined();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createRemoteCache: transport security', () => {
  it('forces mode off for plain http on a non-loopback host (the token is never sent)', async () => {
    const fetchSpy = throwingFetch();
    const remote = createRemoteCache({ url: 'http://cache.example.com', mode: 'readwrite', token: TOKEN, fetch: fetchSpy });
    expect(remote.mode).toBe('off');
    await expect(remote.get(KEY)).resolves.toBeUndefined();
    await expect(remote.put(entry())).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows https, loopback http, and non-loopback http with allowInsecure', () => {
    for (const url of ['https://cache.example.com', 'http://127.0.0.1:9', 'http://localhost:9', 'http://[::1]:9']) {
      expect(createRemoteCache({ url, mode: 'read' }).mode).toBe('read');
    }
    expect(createRemoteCache({ url: 'http://cache.example.com', mode: 'read', allowInsecure: true }).mode).toBe('read');
  });
});

describe('createRemoteCache: get', () => {
  it('maps a server entry to a CacheEntry with remote_cache provenance', async () => {
    const s = await server((_req, res) => {
      sendJson(res, 200, {
        key: KEY,
        source: 'github_repo',
        status: 200,
        body: '{"stars":1}',
        etag: 'W/"x"',
        last_modified: 'Tue, 01 Oct 2026 00:00:00 GMT',
        fetched_at: T0,
        expires_at: T0 + HOUR,
      });
    });
    const remote = createRemoteCache({ url: s.url, mode: 'read', token: TOKEN });
    const got = await remote.get(KEY);
    expect(got).toEqual({
      key: KEY,
      url_redacted: '',
      source: 'github_repo',
      status: 200,
      body: '{"stars":1}',
      etag: 'W/"x"',
      last_modified: 'Tue, 01 Oct 2026 00:00:00 GMT',
      fetched_at: T0,
      expires_at: T0 + HOUR,
      provenance: 'remote_cache',
    });
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.method).toBe('GET');
    expect(s.requests[0]?.url).toBe(`/v1/entries/${KEY}`);
    expect(s.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.requests[0]?.url).not.toContain(TOKEN);
  });

  it('treats timestamps beyond the Date range or negative as an invalid entry', async () => {
    for (const bad of [{ fetched_at: 9e15 }, { expires_at: 9e15 }, { fetched_at: -1 }]) {
      const s = await server((_req, res) => {
        sendJson(res, 200, { source: 'github_repo', status: 200, body: '{}', fetched_at: T0, expires_at: T0 + HOUR, ...bad });
      });
      const remote = createRemoteCache({ url: s.url, mode: 'read' });
      await expect(remote.get(KEY)).resolves.toBeUndefined();
    }
  });

  it.each([
    ['CR/LF', 'W/"a"\r\nX-Injected: 1'],
    ['non-Latin-1', '"中文"'],
    ['control character', '"a\u0000"'],
    ['over-long', `"${'x'.repeat(300)}"`],
    ['empty', ''],
  ])('treats an entry with a %s etag or last_modified as invalid', async (_name, bad) => {
    for (const field of ['etag', 'last_modified']) {
      const s = await server((_req, res) => {
        sendJson(res, 200, { source: 'npm', status: 200, body: '{}', fetched_at: T0, expires_at: T0 + HOUR, [field]: bad });
      });
      const remote = createRemoteCache({ url: s.url, mode: 'read' });
      await expect(remote.get(KEY)).resolves.toBeUndefined();
    }
  });

  it('sends no Authorization header without a token and keeps a base path prefix', async () => {
    const s = await server((_req, res) => sendJson(res, 404, { error: 'not_found' }));
    const remote = createRemoteCache({ url: `${s.url}/cache/`, mode: 'read' });
    await expect(remote.get(KEY)).resolves.toBeUndefined();
    expect(s.requests[0]?.url).toBe(`/cache/v1/entries/${KEY}`);
    expect(s.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('resolves undefined for a miss (404) and for unusable bodies', async () => {
    const wire = { source: 'npm', status: 200, body: '{}', fetched_at: T0, expires_at: T0 + HOUR };
    const cases: Array<[number, unknown]> = [
      [404, { error: 'not_found' }],
      [200, { ...wire, body: 'not json' }],
      [200, { ...wire, status: 500 }],
      [200, { source: 'npm' }],
      [200, 'a string'],
      [400, { error: 'invalid_key' }],
    ];
    for (const [status, payload] of cases) {
      const s = await server((_req, res) => sendJson(res, status, payload));
      const remote = createRemoteCache({ url: s.url, mode: 'read' });
      await expect(remote.get(KEY)).resolves.toBeUndefined();
    }
  });

  it('resolves undefined for a body over 1 MB', async () => {
    const s = await server((_req, res) =>
      sendJson(res, 200, {
        source: 'npm',
        status: 200,
        body: JSON.stringify({ pad: 'x'.repeat(1_100_000) }),
        fetched_at: T0,
        expires_at: T0 + HOUR,
      }),
    );
    const remote = createRemoteCache({ url: s.url, mode: 'read' });
    await expect(remote.get(KEY)).resolves.toBeUndefined();
  });

  it('does not contact the server for a malformed key', async () => {
    const s = await server();
    const remote = createRemoteCache({ url: s.url, mode: 'read' });
    await expect(remote.get('../etc/passwd')).resolves.toBeUndefined();
    await expect(remote.get('A'.repeat(64))).resolves.toBeUndefined();
    expect(s.requests).toHaveLength(0);
  });

  it.each([401, 403, 429, 500, 503])('rejects with RemoteCacheError on status %i', async (status) => {
    const s = await server((_req, res) => sendJson(res, status, { error: 'x' }));
    const remote = createRemoteCache({ url: s.url, mode: 'read', token: TOKEN });
    const err = await remote.get(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCacheError);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(String((err as Error).message)).not.toContain(s.url);
  });

  it('rejects on timeout', async () => {
    const s = await server(() => new Promise<void>(() => undefined));
    const remote = createRemoteCache({ url: s.url, mode: 'read', timeoutMs: 80 });
    const err = await remote.get(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCacheError);
    expect((err as RemoteCacheError).reason).toBe('timeout');
  });

  it('rejects when the server is unreachable', async () => {
    const s = await server();
    const url = s.url;
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    const remote = createRemoteCache({ url, mode: 'read', timeoutMs: 500 });
    const err = await remote.get(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCacheError);
  });

  it('treats a redirect as a failure and does not follow it', async () => {
    const target = await server((_req, res) => sendJson(res, 200, {}));
    const s = await server((_req, res) => {
      res.writeHead(302, { location: `${target.url}/steal` });
      res.end();
    });
    const remote = createRemoteCache({ url: s.url, mode: 'read', token: TOKEN });
    const err = await remote.get(KEY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteCacheError);
    expect(target.requests).toHaveLength(0);
  });
});

describe('createRemoteCache: put', () => {
  it('is a no-op in read mode', async () => {
    const fetchSpy = throwingFetch();
    const remote = createRemoteCache({ url: 'http://127.0.0.1:1', mode: 'read', fetch: fetchSpy });
    await expect(remote.put(entry())).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('PUTs only the wire fields with the bearer token', async () => {
    const s = await server((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const remote = createRemoteCache({ url: s.url, mode: 'readwrite', token: TOKEN });
    await remote.put(entry());
    expect(s.requests).toHaveLength(1);
    const req = s.requests[0]!;
    expect(req.method).toBe('PUT');
    expect(req.url).toBe(`/v1/entries/${KEY}`);
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['content-type']).toBe('application/json');
    const sent = JSON.parse(req.body) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['body', 'etag', 'expires_at', 'fetched_at', 'source', 'status']);
    expect(sent).toEqual(toWire(entry()));
    expect(req.body).not.toContain('api_key');
    expect(req.body).not.toContain('api.github.com');
  });

  it('sanitizes before sending: private search items never leave', async () => {
    const s = await server((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const remote = createRemoteCache({ url: s.url, mode: 'readwrite' });
    const body = JSON.stringify({
      total_count: 2,
      items: [
        { full_name: 'o/public', private: false },
        { full_name: 'acme/secret-repo', private: true },
      ],
    });
    await remote.put(entry({ body }));
    const sent = JSON.parse(s.requests[0]!.body) as { body: string };
    expect(sent.body).not.toContain('secret-repo');
    expect(JSON.parse(sent.body)).toEqual({ total_count: 1, items: [{ full_name: 'o/public', private: false }] });
  });

  it('sends nothing for entries that must not be uploaded', async () => {
    const s = await server((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const remote = createRemoteCache({ url: s.url, mode: 'readwrite' });
    await remote.put(entry({ source: 'librariesio' }));
    await remote.put(entry({ body: JSON.stringify({ full_name: 'a/b', private: true }) }));
    await remote.put(entry({ source: 'github_code', body: JSON.stringify({ items: [{ repository: { private: true } }] }) }));
    await remote.put(entry({ key: 'not-a-key' }));
    expect(s.requests).toHaveLength(0);
  });

  it('uses an injected sanitize function', async () => {
    const s = await server((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const remote = createRemoteCache({ url: s.url, mode: 'readwrite', sanitize: () => undefined });
    await remote.put(entry());
    expect(s.requests).toHaveLength(0);
  });

  it('rejects on auth, rate-limit and server errors but not on a refused entry', async () => {
    for (const status of [401, 403, 429, 502]) {
      const s = await server((_req, res) => sendJson(res, status, { error: 'x' }));
      const remote = createRemoteCache({ url: s.url, mode: 'readwrite', token: TOKEN });
      await expect(remote.put(entry())).rejects.toBeInstanceOf(RemoteCacheError);
    }
    for (const status of [400, 413, 422]) {
      const s = await server((_req, res) => sendJson(res, status, { error: 'x' }));
      const remote = createRemoteCache({ url: s.url, mode: 'readwrite', token: TOKEN });
      await expect(remote.put(entry())).resolves.toBeUndefined();
    }
  });
});

describe('createRemoteCache: healthy', () => {
  it('is true for a healthy server and never rejects', async () => {
    const ok = await server((_req, res) => sendJson(res, 200, { ok: true, version: '0.1.0', entries: 3 }));
    await expect(createRemoteCache({ url: ok.url, mode: 'read' }).healthy()).resolves.toBe(true);
    expect(ok.requests[0]?.url).toBe('/v1/health');

    const bad = await server((_req, res) => sendJson(res, 500, { ok: false }));
    await expect(createRemoteCache({ url: bad.url, mode: 'read' }).healthy()).resolves.toBe(false);

    const garbage = await server((_req, res) => {
      res.writeHead(200);
      res.end('not json');
    });
    await expect(createRemoteCache({ url: garbage.url, mode: 'readwrite' }).healthy()).resolves.toBe(false);

    const hung = await server(() => new Promise<void>(() => undefined));
    await expect(createRemoteCache({ url: hung.url, mode: 'read', timeoutMs: 60 }).healthy()).resolves.toBe(false);
  });

  it('only needs { ok: true }: the minimal body an unauthenticated /v1/health returns', async () => {
    const minimal = await server((_req, res) => sendJson(res, 200, { ok: true }));
    await expect(createRemoteCache({ url: minimal.url, mode: 'read' }).healthy()).resolves.toBe(true);
  });
});

describe('RemoteEntryWireSchema validators', () => {
  const base = { source: 'npm', status: 200, body: '{}', fetched_at: T0, expires_at: T0 + HOUR };

  it('accepts printable ASCII validators up to 256 characters', () => {
    expect(RemoteEntryWireSchema.safeParse({ ...base, etag: 'W/"abc"', last_modified: 'Tue, 01 Oct 2026 00:00:00 GMT' }).success).toBe(true);
    expect(RemoteEntryWireSchema.safeParse({ ...base, etag: 'x'.repeat(256) }).success).toBe(true);
    expect(RemoteEntryWireSchema.safeParse(base).success).toBe(true);
  });

  it.each(['a\r\nb', 'a\nb', 'a\tb', 'café', '中', 'a\u007fb', '', 'x'.repeat(257)])(
    'rejects %j as etag and as last_modified',
    (bad) => {
      expect(RemoteEntryWireSchema.safeParse({ ...base, etag: bad }).success).toBe(false);
      expect(RemoteEntryWireSchema.safeParse({ ...base, last_modified: bad }).success).toBe(false);
    },
  );
});
