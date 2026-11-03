import { afterEach, describe, expect, it } from 'vitest';
import { cacheKey } from '../../../src/cache/key.js';
import { cacheTool } from '../../../src/mcp/tools/cache.js';
import type { CacheEntry } from '../../../src/types.js';
import { cleanupTmpDirs } from '../../helpers/tmp.js';
import { NOW, connect, makeCtx, offRemote } from './_t20-helpers.js';
import type { Connected } from './_t20-helpers.js';

let conn: Connected | undefined;
afterEach(async () => {
  await conn?.close();
  conn = undefined;
  cleanupTmpDirs();
});

const DAY = 24 * 60 * 60 * 1000;
const URL_NPM = 'https://registry.npmjs.org/zod/latest';
const BODY = '{"secret-looking":"BODY-MUST-NOT-APPEAR"}';

function entry(url: string, source: string, ageDays: number, ttlMs = DAY): CacheEntry {
  const fetched = NOW.getTime() - ageDays * DAY;
  return {
    key: cacheKey(url),
    url_redacted: url,
    source,
    status: 200,
    body: BODY,
    fetched_at: fetched,
    expires_at: fetched + ttlMs,
    provenance: 'live',
  };
}

async function setup(opts: Parameters<typeof makeCtx>[0] = {}) {
  const t = makeCtx(opts);
  conn = await connect(cacheTool, t.ctx);
  return { t, call: conn.call };
}

describe('rw_cache', () => {
  it('advertises schemas', async () => {
    await setup();
    const { tools } = await conn!.client.listTools();
    expect(tools[0]?.name).toBe('rw_cache');
    expect(tools[0]?.inputSchema).toBeDefined();
    expect(tools[0]?.outputSchema).toBeDefined();
  });

  it('stats reports counts, per-source numbers, rate limits and the remote state', async () => {
    const { t, call } = await setup();
    t.store.put(entry(URL_NPM, 'npm', 0));
    t.store.put(entry('https://pypi.org/pypi/pip/json', 'pypi', 0));
    t.store.setRateLimit({ resource: 'npm', limit: 100, remaining: 7, reset_at: NOW.getTime(), updated_at: NOW.getTime() });
    const r = await call('rw_cache', { action: 'stats' });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({ entries: 2, by_source: { npm: 1, pypi: 1 }, remote: { mode: 'off' } });
    expect((r.structured?.rate_limits as { resource: string }[]).map((s) => s.resource)).toEqual(['npm']);
    expect(r.text).toContain('| npm | 1 |');
  });

  it('stats includes remote host and health when configured', async () => {
    const remote = { ...offRemote, mode: 'read' as const, healthy: async () => true };
    const { call } = await setup({
      remote,
      env: { RECYCLEWHEEL_REMOTE_CACHE_URL: 'https://cache.example.com/v', RECYCLEWHEEL_REMOTE_CACHE_MODE: 'read' },
    });
    const r = await call('rw_cache', { action: 'stats' });
    expect(r.structured?.remote).toEqual({ mode: 'read', host: 'cache.example.com', healthy: true });
  });

  it('lookup returns metadata only, never the body, and ignores secret query params', async () => {
    const { t, call } = await setup();
    t.store.put(entry(URL_NPM, 'npm', 0));
    const r = await call('rw_cache', { action: 'lookup', url: `${URL_NPM}?api_key=SECRET123` });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({ hit: true, key: cacheKey(URL_NPM), provenance: 'live', status: 200, fresh: true });
    const all = JSON.stringify(r);
    expect(all).not.toContain('BODY-MUST-NOT-APPEAR');
    expect(all).not.toContain('SECRET123');
    expect(r.structured).not.toHaveProperty('body');
  });

  it('lookup reports misses and stale entries', async () => {
    const { t, call } = await setup();
    expect((await call('rw_cache', { action: 'lookup', url: URL_NPM })).structured).toMatchObject({ hit: false });
    t.store.put(entry(URL_NPM, 'npm', 3));
    expect((await call('rw_cache', { action: 'lookup', url: URL_NPM })).structured).toMatchObject({ hit: true, fresh: false });
  });

  it('lookup validates its input', async () => {
    const { call } = await setup();
    expect((await call('rw_cache', { action: 'lookup' })).isError).toBe(true);
    expect((await call('rw_cache', { action: 'lookup', url: 'not a url' })).isError).toBe(true);
  });

  it('purge filters by source and by age, and clears everything without a filter (with confirm)', async () => {
    const { t, call } = await setup();
    t.store.put(entry(URL_NPM, 'npm', 10));
    t.store.put(entry('https://registry.npmjs.org/ms/latest', 'npm', 0));
    t.store.put(entry('https://pypi.org/pypi/pip/json', 'pypi', 10));
    // The store computes ages against the real clock, so entries "10 days old" relative to NOW are old either way.
    expect((await call('rw_cache', { action: 'purge', source: 'pypi', confirm: true })).structured).toEqual({ action: 'purge', removed: 1 });
    expect(t.store.stats().entries).toBe(2);
    expect((await call('rw_cache', { action: 'purge', older_than_days: 1e6, confirm: true })).structured).toMatchObject({ removed: 0 });
    expect((await call('rw_cache', { action: 'purge', confirm: true })).structured).toMatchObject({ removed: 2 });
    expect(t.store.stats().entries).toBe(0);
  });

  describe('purge confirmation (L-1)', () => {
    async function seeded() {
      const s = await setup();
      s.t.store.put(entry(URL_NPM, 'npm', 10));
      s.t.store.put(entry('https://registry.npmjs.org/ms/latest', 'npm', 0));
      s.t.store.put(entry('https://pypi.org/pypi/pip/json', 'pypi', 10));
      return s;
    }

    it.each([{}, { confirm: false }])('deletes nothing without confirm: true (%j) and previews the count', async (extra) => {
      const { t, call } = await seeded();
      const r = await call('rw_cache', { action: 'purge', ...extra });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('confirm: true');
      expect(r.text).toContain('3 of 3 entries');
      expect(r.text).toContain('all local entries');
      expect(t.store.stats().entries).toBe(3);
    });

    it('previews the source-specific count, and an upper bound for age filters', async () => {
      const { t, call } = await seeded();
      const bySource = await call('rw_cache', { action: 'purge', source: 'npm' });
      expect(bySource.isError).toBe(true);
      expect(bySource.text).toContain('2 of 3 entries');
      expect(bySource.text).toContain('source npm');
      const byAge = await call('rw_cache', { action: 'purge', older_than_days: 5 });
      expect(byAge.isError).toBe(true);
      expect(byAge.text).toContain('up to 3 of 3 entries');
      expect(byAge.text).toContain('older than 5 day(s)');
      expect((await call('rw_cache', { action: 'purge', source: 'nothing-here' })).text).toContain('0 of 3 entries');
      expect(t.store.stats().entries).toBe(3);
    });

    it('purges after confirm: true', async () => {
      const { t, call } = await seeded();
      const r = await call('rw_cache', { action: 'purge', source: 'npm', confirm: true });
      expect(r.isError).toBe(false);
      expect(r.structured).toEqual({ action: 'purge', removed: 2 });
      expect(t.store.stats().entries).toBe(1);
    });

    it('stats and lookup do not need confirm', async () => {
      const { call } = await seeded();
      expect((await call('rw_cache', { action: 'stats' })).isError).toBe(false);
      expect((await call('rw_cache', { action: 'lookup', url: URL_NPM })).isError).toBe(false);
    });

    it('marks the tool destructive', async () => {
      await setup();
      const { tools } = await conn!.client.listTools();
      expect(tools[0]?.annotations?.destructiveHint).toBe(true);
      expect(tools[0]?.annotations?.readOnlyHint).toBe(false);
    });

    it.each([1.5, -1, 0.1])('rejects older_than_days=%s (integer >= 0 only)', async (days) => {
      const { t, call } = await seeded();
      const r = await call('rw_cache', { action: 'purge', older_than_days: days, confirm: true });
      expect(r.isError).toBe(true);
      expect(t.store.stats().entries).toBe(3);
    });

    it('accepts older_than_days=0', async () => {
      const { call } = await seeded();
      const r = await call('rw_cache', { action: 'purge', older_than_days: 0, confirm: true });
      expect(r.isError).toBe(false);
    });
  });
});
