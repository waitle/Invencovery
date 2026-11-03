import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_BYTES,
  MAX_STALE_MS,
  SCHEMA_VERSION,
  openCacheStore,
} from '../../../src/cache/store.js';
import type { CacheEntry, CacheStore, RateLimitState } from '../../../src/types.js';
import { cleanupTmpDirs, makeTmpDir } from '../../helpers/tmp.js';

const STORE_TS = fileURLToPath(new URL('../../../src/cache/store.ts', import.meta.url));
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const opened: CacheStore[] = [];
function open(dbPath: string, options?: Parameters<typeof openCacheStore>[1]): CacheStore {
  const store = openCacheStore(dbPath, options);
  opened.push(store);
  return store;
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  cleanupTmpDirs();
});

function entry(key: string, overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    key,
    url_redacted: `https://api.github.com/repos/o/${key}?api_key=REDACTED`,
    source: 'github_repo',
    status: 200,
    body: JSON.stringify({ key }),
    fetched_at: T0,
    expires_at: T0 + 6 * HOUR,
    provenance: 'live',
    ...overrides,
  };
}

function rateLimit(resource: string, overrides: Partial<RateLimitState> = {}): RateLimitState {
  return { resource, limit: 60, remaining: 59, reset_at: T0 + HOUR, updated_at: T0, ...overrides };
}

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

describe('CRUD', () => {
  it('returns undefined for a missing key', () => {
    const store = open(':memory:');
    expect(store.get('nope')).toBeUndefined();
  });

  it('round-trips every field, including optional ones', () => {
    const store = open(':memory:');
    const full = entry('full', {
      etag: 'W/"abc"',
      last_modified: 'Tue, 01 Jan 2030 00:00:00 GMT',
      status: 404,
      provenance: 'remote_cache',
    });
    store.put(full);
    expect(store.get('full')).toEqual(full);
  });

  it('omits etag and last_modified when they were not stored', () => {
    const store = open(':memory:');
    store.put(entry('bare'));
    const got = store.get('bare');
    expect(got).toBeDefined();
    expect('etag' in got!).toBe(false);
    expect('last_modified' in got!).toBe(false);
  });

  it('replaces an existing entry with the same key', () => {
    const store = open(':memory:');
    store.put(entry('k', { body: 'old', etag: 'e1' }));
    store.put(entry('k', { body: 'new' }));
    const got = store.get('k');
    expect(got?.body).toBe('new');
    expect(got && 'etag' in got).toBe(false);
    expect(store.stats().entries).toBe(1);
  });

  it('keeps unicode and large bodies intact', () => {
    const store = open(':memory:');
    const body = `{"d":"재활용 바퀴 \u{1F6DE} ${'x'.repeat(200_000)}"}`;
    store.put(entry('uni', { body }));
    expect(store.get('uni')?.body).toBe(body);
  });

  it('returns expired entries as-is so callers can serve stale-if-error', () => {
    const store = open(':memory:', { now: () => T0 + 2 * DAY });
    store.put(entry('old', { expires_at: T0 + HOUR }));
    expect(store.get('old')?.expires_at).toBe(T0 + HOUR);
  });

  it('touch extends expires_at without changing the rest and ignores unknown keys', () => {
    const store = open(':memory:');
    const e = entry('t', { etag: 'e' });
    store.put(e);
    store.touch('t', T0 + 10 * DAY);
    expect(store.get('t')).toEqual({ ...e, expires_at: T0 + 10 * DAY });
    expect(() => store.touch('missing', T0)).not.toThrow();
    expect(store.get('missing')).toBeUndefined();
  });

  it('keeps separate :memory: stores independent', () => {
    const a = open(':memory:');
    const b = open(':memory:');
    a.put(entry('only-a'));
    expect(b.get('only-a')).toBeUndefined();
  });
});

describe('purge', () => {
  function seeded(): CacheStore {
    const store = open(':memory:', { now: () => T0 + 10 * DAY });
    store.put(entry('gh-old', { source: 'github_repo', fetched_at: T0 }));
    store.put(entry('gh-new', { source: 'github_repo', fetched_at: T0 + 9 * DAY }));
    store.put(entry('npm-old', { source: 'npm', fetched_at: T0 }));
    store.put(entry('npm-new', { source: 'npm', fetched_at: T0 + 9 * DAY }));
    return store;
  }

  it('filters by source', () => {
    const store = seeded();
    expect(store.purge({ source: 'npm' })).toBe(2);
    expect(store.stats().by_source).toEqual({ github_repo: 2 });
  });

  it('filters by age relative to now', () => {
    const store = seeded();
    expect(store.purge({ olderThanMs: 5 * DAY })).toBe(2);
    expect(store.get('gh-old')).toBeUndefined();
    expect(store.get('npm-old')).toBeUndefined();
    expect(store.get('gh-new')).toBeDefined();
  });

  it('combines source and age with AND', () => {
    const store = seeded();
    expect(store.purge({ source: 'npm', olderThanMs: 5 * DAY })).toBe(1);
    expect(store.get('npm-old')).toBeUndefined();
    expect(store.get('npm-new')).toBeDefined();
    expect(store.get('gh-old')).toBeDefined();
  });

  it('removes every entry without a filter but keeps rate-limit state', () => {
    const store = seeded();
    store.setRateLimit(rateLimit('github:core'));
    expect(store.purge()).toBe(4);
    expect(store.stats()).toEqual({ entries: 0, bytes: 0, by_source: {} });
    expect(store.getRateLimit('github:core')).toBeDefined();
  });

  it('returns 0 when nothing matches', () => {
    const store = seeded();
    expect(store.purge({ source: 'pypi' })).toBe(0);
    expect(store.purge({ olderThanMs: 100 * DAY })).toBe(0);
    expect(store.stats().entries).toBe(4);
  });
});

describe('stats', () => {
  it('is all zero for an empty store', () => {
    expect(open(':memory:').stats()).toEqual({ entries: 0, bytes: 0, by_source: {} });
  });

  it('counts entries per source and body bytes in UTF-8', () => {
    const store = open(':memory:');
    store.put(entry('a', { source: 'github_repo', body: 'abcde' }));
    store.put(entry('b', { source: 'github_repo', body: '한글' }));
    store.put(entry('c', { source: 'npm', body: '123' }));
    expect(store.stats()).toEqual({
      entries: 3,
      bytes: 5 + 6 + 3,
      by_source: { github_repo: 2, npm: 1 },
    });
  });
});

describe('rate limits', () => {
  it('returns undefined for an unknown resource', () => {
    expect(open(':memory:').getRateLimit('github:search')).toBeUndefined();
  });

  it('upserts per resource', () => {
    const store = open(':memory:');
    const first = rateLimit('github:search', { limit: 10, remaining: 3 });
    store.setRateLimit(first);
    store.setRateLimit(rateLimit('github:core'));
    expect(store.getRateLimit('github:search')).toEqual(first);

    const second = rateLimit('github:search', { limit: 10, remaining: 0, reset_at: T0 + 2 * HOUR, updated_at: T0 + 1 });
    store.setRateLimit(second);
    expect(store.getRateLimit('github:search')).toEqual(second);
    expect(store.getRateLimit('github:core')?.remaining).toBe(59);
  });
});

describe('file-backed store', () => {
  it('creates missing directories, including ones with spaces and non-ASCII names', () => {
    const base = makeTmpDir();
    const dbPath = path.join(base, 'a b', 'ünï cödé', 'cache.db');
    const store = open(dbPath);
    store.put(entry('k'));
    expect(existsSync(dbPath)).toBe(true);
  });

  it('persists entries and rate limits across reopen', () => {
    const dbPath = path.join(makeTmpDir(), 'cache.db');
    const first = openCacheStore(dbPath);
    first.put(entry('persist', { etag: 'e' }));
    first.setRateLimit(rateLimit('github:core'));
    first.close();

    const second = open(dbPath);
    expect(second.get('persist')).toEqual(entry('persist', { etag: 'e' }));
    expect(second.getRateLimit('github:core')).toEqual(rateLimit('github:core'));
  });

  it('close is idempotent and further use throws', () => {
    const store = openCacheStore(path.join(makeTmpDir(), 'cache.db'));
    store.close();
    expect(() => store.close()).not.toThrow();
    expect(() => store.get('k')).toThrow();
  });

  it('uses WAL and records schema_version', () => {
    const dbPath = path.join(makeTmpDir(), 'cache.db');
    const store = open(dbPath);
    store.put(entry('k'));
    const raw = new DatabaseSync(dbPath);
    try {
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual(expect.objectContaining({ journal_mode: 'wal' }));
      expect(raw.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()).toEqual(
        expect.objectContaining({ v: String(SCHEMA_VERSION) }),
      );
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['http_cache', 'rate_limits', 'meta']));
    } finally {
      raw.close();
    }
  });
});

describe('file permissions', () => {
  const posix = process.platform !== 'win32';
  const mode = (p: string): number => statSync(p).mode & 0o777;

  it.skipIf(!posix)('creates new directories as 0700 and the database with its WAL files as 0600', () => {
    const dir = path.join(makeTmpDir(), 'new', 'nested');
    const dbPath = path.join(dir, 'cache.db');
    const store = open(dbPath);
    store.put(entry('k'));
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.dirname(dir))).toBe(0o700);
    expect(mode(dbPath)).toBe(0o600);
    for (const side of ['-wal', '-shm']) {
      if (existsSync(`${dbPath}${side}`)) expect(mode(`${dbPath}${side}`)).toBe(0o600);
    }
  });

  it.skipIf(!posix)('tightens an existing world-readable database but leaves an existing directory alone', () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'cache.db');
    open(dbPath).close();
    chmodSync(dbPath, 0o644);
    const dirMode = mode(dir);
    open(dbPath);
    expect(mode(dbPath)).toBe(0o600);
    expect(mode(dir)).toBe(dirMode);
  });

  it('never throws because of permission handling (also on Windows, where modes are ignored)', () => {
    const dbPath = path.join(makeTmpDir(), 'a', 'cache.db');
    const store = open(dbPath);
    store.put(entry('k'));
    expect(store.get('k')?.key).toBe('k');
    const memory = open(':memory:');
    memory.put(entry('m'));
    expect(memory.get('m')?.key).toBe('m');
  });
});

describe('schema versioning and recovery', () => {
  it('adopts an empty pre-existing database file', () => {
    const dbPath = path.join(makeTmpDir(), 'cache.db');
    new DatabaseSync(dbPath).close();
    const store = open(dbPath);
    store.put(entry('k'));
    expect(store.get('k')).toBeDefined();
  });

  it('resets a database written by a newer schema version', () => {
    const dbPath = path.join(makeTmpDir(), 'cache.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
      INSERT INTO meta VALUES ('schema_version', '${SCHEMA_VERSION + 41}');
      CREATE TABLE http_cache (key TEXT PRIMARY KEY, payload BLOB, shiny_new_column INTEGER);
      INSERT INTO http_cache VALUES ('future', x'00', 1);
    `);
    raw.close();

    const store = open(dbPath);
    expect(store.get('future')).toBeUndefined();
    store.put(entry('now'));
    expect(store.get('now')).toEqual(entry('now'));
    store.close();

    const check = new DatabaseSync(dbPath);
    try {
      expect(check.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()).toEqual(
        expect.objectContaining({ v: String(SCHEMA_VERSION) }),
      );
    } finally {
      check.close();
    }
  });

  it('moves a corrupt file aside and starts fresh', () => {
    const dbPath = path.join(makeTmpDir(), 'cache.db');
    writeFileSync(dbPath, 'definitely not a sqlite database '.repeat(200));
    const store = open(dbPath);
    store.put(entry('k'));
    expect(store.get('k')).toBeDefined();
    expect(existsSync(`${dbPath}.corrupt`)).toBe(true);
    expect(readFileSync(`${dbPath}.corrupt`, 'utf8')).toContain('definitely not a sqlite database');
  });
});

describe('housekeeping', () => {
  it('evicts the oldest fetched_at entries down to 80% once the size cap is exceeded', () => {
    const store = open(':memory:', { maxBytes: 1000, pruneEveryPuts: 1 });
    // 10 x 100 bytes = exactly the cap: nothing is evicted.
    for (let i = 0; i < 10; i++) {
      store.put(entry(`k${pad(i)}`, { body: 'x'.repeat(100), fetched_at: T0 + i }));
    }
    expect(store.stats()).toMatchObject({ entries: 10, bytes: 1000 });

    // The 11th pushes it to 1100 > 1000, so the oldest 3 go: 800 bytes remain.
    store.put(entry('k010', { body: 'x'.repeat(100), fetched_at: T0 + 10 }));
    expect(store.stats()).toMatchObject({ entries: 8, bytes: 800 });
    for (const gone of ['k000', 'k001', 'k002']) expect(store.get(gone)).toBeUndefined();
    for (const kept of ['k003', 'k009', 'k010']) expect(store.get(kept)).toBeDefined();
  });

  it('orders eviction by fetched_at, not by insertion order', () => {
    const store = open(':memory:', { maxBytes: 300, pruneEveryPuts: 1 });
    store.put(entry('newest', { body: 'x'.repeat(100), fetched_at: T0 + 100 }));
    store.put(entry('oldest', { body: 'x'.repeat(100), fetched_at: T0 }));
    store.put(entry('middle', { body: 'x'.repeat(100), fetched_at: T0 + 50 }));
    store.put(entry('extra', { body: 'x'.repeat(100), fetched_at: T0 + 75 }));
    // 400 > 300: evict oldest first until <= 240 -> oldest (300), middle (200).
    expect(store.get('oldest')).toBeUndefined();
    expect(store.get('middle')).toBeUndefined();
    expect(store.get('newest')).toBeDefined();
    expect(store.get('extra')).toBeDefined();
    expect(store.stats().bytes).toBe(200);
  });

  it('only checks size every pruneEveryPuts puts', () => {
    const store = open(':memory:', { maxBytes: 1000, pruneEveryPuts: 5 });
    for (let i = 0; i < 4; i++) {
      store.put(entry(`k${i}`, { body: 'x'.repeat(500), fetched_at: T0 + i }));
    }
    expect(store.stats().entries).toBe(4); // 2000 bytes, but no check yet
    store.put(entry('k4', { body: 'x'.repeat(500), fetched_at: T0 + 4 }));
    // 2500 -> target 800 -> keeps only the newest entry (500).
    expect(store.stats()).toMatchObject({ entries: 1, bytes: 500 });
    expect(store.get('k4')).toBeDefined();
  });

  it('has no size cap when maxBytes is not a positive finite number', () => {
    const store = open(':memory:', { maxBytes: Infinity, pruneEveryPuts: 1 });
    for (let i = 0; i < 5; i++) store.put(entry(`k${i}`, { body: 'x'.repeat(1000) }));
    expect(store.stats().entries).toBe(5);
  });

  it('defaults the cap to 200 MB', () => {
    expect(DEFAULT_MAX_BYTES).toBe(200 * 1024 * 1024);
  });

  it('drops entries expired for longer than the 7-day stale window when opened', () => {
    const dbPath = path.join(makeTmpDir(), 'cache.db');
    const writer = openCacheStore(dbPath, { now: () => T0 });
    writer.put(entry('expired-8d', { expires_at: T0 - 8 * DAY }));
    writer.put(entry('expired-6d', { expires_at: T0 - 6 * DAY }));
    writer.put(entry('fresh', { expires_at: T0 + HOUR }));
    writer.close();

    const reader = open(dbPath, { now: () => T0 });
    expect(reader.get('expired-8d')).toBeUndefined();
    expect(reader.get('expired-6d')).toBeDefined();
    expect(reader.get('fresh')).toBeDefined();
    expect(MAX_STALE_MS).toBe(7 * DAY);
  });

  it('also drops over-stale entries during periodic maintenance', () => {
    let clock = T0;
    const store = open(':memory:', { now: () => clock, pruneEveryPuts: 2 });
    store.put(entry('a', { expires_at: T0 + HOUR }));
    clock = T0 + 8 * DAY + HOUR;
    store.put(entry('b', { expires_at: clock + HOUR }));
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
  });

  it('keeps stale entries indefinitely when staleRetentionMs is Infinity', () => {
    const dbPath = path.join(makeTmpDir(), 'cache.db');
    const writer = openCacheStore(dbPath, { now: () => T0 });
    writer.put(entry('ancient', { expires_at: T0 - 365 * DAY }));
    writer.close();
    const reader = open(dbPath, { now: () => T0, staleRetentionMs: Infinity });
    expect(reader.get('ancient')).toBeDefined();
  });
});

describe('concurrent access', () => {
  it('lets two connections to the same file see each other and interleave writes', () => {
    const dbPath = path.join(makeTmpDir(), 'cache.db');
    const a = open(dbPath);
    const b = open(dbPath);
    for (let i = 0; i < 50; i++) {
      a.put(entry(`a${i}`));
      b.put(entry(`b${i}`));
      a.setRateLimit(rateLimit('shared', { remaining: i }));
    }
    expect(a.get('b49')).toBeDefined();
    expect(b.get('a49')).toBeDefined();
    expect(a.stats().entries).toBe(100);
    expect(b.getRateLimit('shared')?.remaining).toBe(49);
  });

  it('survives several processes opening and writing the same fresh file at once', async () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, 'shared', 'cache.db');
    const workerPath = path.join(dir, 'worker.mjs');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(
      workerPath,
      `
import { openCacheStore } from ${JSON.stringify(pathToFileURL(STORE_TS).href)};
const [dbPath, id, countRaw] = process.argv.slice(2);
const count = Number(countRaw);
const store = openCacheStore(dbPath, { pruneEveryPuts: 25 });
for (let i = 0; i < count; i++) {
  const now = Date.now();
  store.put({
    key: 'w' + id + '-' + i, url_redacted: '', source: 'github_repo', status: 200,
    body: 'x'.repeat(256), fetched_at: now, expires_at: now + 3600000, provenance: 'live',
  });
  store.put({
    key: 'contended', url_redacted: '', source: 'npm', status: 200,
    body: 'writer-' + id, fetched_at: now, expires_at: now + 3600000, provenance: 'live',
  });
  store.setRateLimit({ resource: 'github:core', limit: 60, remaining: i, reset_at: now + 1000, updated_at: now });
  if (store.get('contended') === undefined) throw new Error('contended key vanished');
}
store.close();
`,
    );

    const procs = 4;
    const perProc = 100;
    const results = await Promise.all(
      Array.from({ length: procs }, (_, id) =>
        new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--experimental-strip-types',
              '--disable-warning=ExperimentalWarning',
              workerPath,
              dbPath,
              String(id),
              String(perProc),
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          let stderr = '';
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stderr }));
        }),
      ),
    );

    for (const r of results) {
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
    }

    const store = open(dbPath);
    // 4 writers x 100 distinct keys, plus the one contended key.
    expect(store.stats()).toMatchObject({ entries: procs * perProc + 1 });
    expect(store.get('contended')?.body).toMatch(/^writer-[0-3]$/);
    expect(store.getRateLimit('github:core')?.limit).toBe(60);
  }, 60_000);
});
