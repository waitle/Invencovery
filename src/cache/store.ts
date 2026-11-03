/**
 * Local HTTP cache store on the built-in `node:sqlite` (docs/PLAN.md §9.2).
 *
 * - Implements the `CacheStore` contract from `src/types.ts` (all timestamps are
 *   epoch milliseconds, all calls are synchronous).
 * - WAL + `busy_timeout` so several Claude sessions can share one cache file.
 * - Schema versioning in `meta.schema_version`. The cache is disposable, so an
 *   unknown (newer) schema or a corrupt file is reset instead of failing.
 * - Housekeeping: entries expired for longer than `MAX_STALE_MS` are dropped,
 *   and when the payload size exceeds `maxBytes` the oldest `fetched_at`
 *   entries are removed until it is back under 80%. It runs when the store is
 *   opened and after every `pruneEveryPuts` (default 100) puts.
 *
 * Permissions (POSIX): directories this call creates are `0700` and the database
 * (plus its `-wal`/`-shm` files) is `0600`, since it can hold metadata of private
 * repositories fetched with the user's token. Best effort; ignored on Windows.
 *
 * Only erasable TypeScript syntax and `import type` are used on purpose: the
 * unit test runs this file in child processes through Node's type stripping.
 *
 * `node:sqlite` is loaded lazily (first `openCacheStore` call) so the CLI can
 * install its ExperimentalWarning filter before the module is first evaluated.
 * Nothing in this file writes to stdout.
 */
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CacheEntry, CacheStore, Provenance, RateLimitState } from '../types.js';

/** Current on-disk schema version (`meta.schema_version`). */
export const SCHEMA_VERSION = 1;
/** How long an expired entry is kept for stale-if-error (PLAN §9.3 `max_stale`). */
export const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Default size cap, the same as `RECYCLEWHEEL_CACHE_MAX_MB`'s default. */
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/** After exceeding `maxBytes`, entries are evicted until the payload is at most this fraction of it. */
const PRUNE_TARGET_RATIO = 0.8;

export interface CacheStoreOptions {
  /**
   * Payload size cap in bytes (sum of UTF-8 body bytes, the same number
   * `stats().bytes` reports). Pass `config.cacheMaxMb * 1024 * 1024`.
   * A non-positive or non-finite value disables the size cap.
   */
  maxBytes?: number;
  /** Run housekeeping after this many `put` calls. Default 100. */
  pruneEveryPuts?: number;
  /**
   * How long past `expires_at` an entry is retained. Default `MAX_STALE_MS`.
   * `Infinity` keeps entries until the size cap evicts them (useful for offline mode).
   */
  staleRetentionMs?: number;
  /** SQLite busy timeout. Default 5000. */
  busyTimeoutMs?: number;
  /** Clock override for tests. Default `Date.now`. */
  now?: () => number;
}

interface EntryRow {
  key: string;
  url_redacted: string;
  source: string;
  status: number;
  etag: string | null;
  last_modified: string | null;
  body: string;
  fetched_at: number;
  expires_at: number;
  provenance: string;
}

interface RateLimitRow {
  resource: string;
  lim: number;
  remaining: number;
  reset_at: number;
  updated_at: number;
}

const BODY_BYTES_SQL = 'length(CAST(body AS BLOB))';
const MEMORY_PATH = ':memory:';

/** Each step upgrades the schema from version `index` to `index + 1`. */
const MIGRATIONS: ReadonlyArray<(db: DatabaseSync) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS http_cache (
        key TEXT PRIMARY KEY,
        url_redacted TEXT NOT NULL,
        source TEXT NOT NULL,
        status INTEGER NOT NULL,
        etag TEXT,
        last_modified TEXT,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        provenance TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_http_cache_source ON http_cache(source);
      CREATE INDEX IF NOT EXISTS idx_http_cache_fetched_at ON http_cache(fetched_at);
      CREATE TABLE IF NOT EXISTS rate_limits (
        resource TEXT PRIMARY KEY,
        lim INTEGER NOT NULL,
        remaining INTEGER NOT NULL,
        reset_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT
      );
    `);
  },
];

let sqliteModule: typeof import('node:sqlite') | undefined;

function loadSqlite(): typeof import('node:sqlite') {
  if (sqliteModule === undefined) {
    const require = createRequire(import.meta.url);
    sqliteModule = require('node:sqlite') as typeof import('node:sqlite');
  }
  return sqliteModule;
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original error is the one worth reporting.
    }
    throw err;
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  const hasMeta = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (hasMeta === undefined) return 0;
  const row = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get() as { v: string | null } | undefined;
  if (row?.v == null) return 0;
  const n = Number(row.v);
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

function dropAll(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS http_cache; DROP TABLE IF EXISTS rate_limits; DROP TABLE IF EXISTS meta;');
}

function migrate(db: DatabaseSync): void {
  inTransaction(db, () => {
    // Read inside the write transaction: another connection may have migrated meanwhile.
    let version = readSchemaVersion(db);
    if (version === SCHEMA_VERSION) return;
    if (version < 0 || version > SCHEMA_VERSION) {
      // Written by a newer release or damaged: a cache can simply start over.
      dropAll(db);
      version = 0;
    }
    for (let v = version; v < SCHEMA_VERSION; v++) {
      MIGRATIONS[v]!(db);
    }
    db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  });
}

function initDb(dbPath: string, busyTimeoutMs: number): DatabaseSync {
  const { DatabaseSync: Database } = loadSqlite();
  const db = new Database(dbPath);
  try {
    // Must come first: switching to WAL and creating the schema can race with another process.
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    if (dbPath !== MEMORY_PATH) db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db);
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // Ignore: the open error is the one worth reporting.
    }
    throw err;
  }
}

/** SQLITE_NOTADB (26) and SQLITE_CORRUPT (11), including extended result codes. */
function isUnreadableDatabase(err: unknown): boolean {
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode !== 'number') return false;
  const primary = errcode & 0xff;
  return primary === 26 || primary === 11;
}

function bestEffortChmod(target: string, mode: number): void {
  if (process.platform === 'win32') return; // ACLs, not POSIX modes
  try {
    chmodSync(target, mode);
  } catch {
    // A file owned by someone else or on a filesystem without modes: not worth failing the cache.
  }
}

/** Creates the (empty) database file as `0600` so it is never visible with the default umask mode. */
function precreatePrivateFile(dbPath: string): void {
  if (process.platform === 'win32') return;
  try {
    writeFileSync(dbPath, '', { flag: 'a', mode: 0o600 });
  } catch {
    // SQLite will report a real problem (read-only location) when it opens the file.
  }
}

/** Tightens the database and its WAL side files; call after SQLite has created them. */
function restrictDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) bestEffortChmod(`${dbPath}${suffix}`, 0o600);
}

/** Moves an unreadable database aside (never deletes user data) together with its WAL files. */
function quarantine(dbPath: string): void {
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  renameSync(dbPath, `${dbPath}.corrupt`);
}

function toEntry(row: EntryRow): CacheEntry {
  const entry: CacheEntry = {
    key: row.key,
    url_redacted: row.url_redacted,
    source: row.source,
    status: row.status,
    body: row.body,
    fetched_at: row.fetched_at,
    expires_at: row.expires_at,
    provenance: row.provenance as Provenance,
  };
  if (row.etag !== null) entry.etag = row.etag;
  if (row.last_modified !== null) entry.last_modified = row.last_modified;
  return entry;
}

/**
 * Opens (creating directories, file and schema as needed) the cache database.
 * `dbPath` is a file path or `':memory:'`. Throws on unrecoverable errors, e.g.
 * a read-only location; callers should treat the cache as best-effort.
 */
export function openCacheStore(dbPath: string, options: CacheStoreOptions = {}): CacheStore {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const sizeCapEnabled = Number.isFinite(maxBytes) && maxBytes > 0;
  const pruneEveryPuts = Math.max(1, Math.floor(options.pruneEveryPuts ?? 100));
  const staleRetentionMs = options.staleRetentionMs ?? MAX_STALE_MS;
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  const inMemory = dbPath === MEMORY_PATH;

  if (!inMemory) {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true, mode: 0o700 });
    precreatePrivateFile(dbPath);
  }

  let db: DatabaseSync;
  try {
    db = initDb(dbPath, busyTimeoutMs);
  } catch (err) {
    if (inMemory || !isUnreadableDatabase(err)) throw err;
    quarantine(dbPath);
    precreatePrivateFile(dbPath);
    db = initDb(dbPath, busyTimeoutMs);
  }
  const database = db;
  if (!inMemory) restrictDbFiles(dbPath);

  const stmts: Record<string, StatementSync> = {};
  const stmt = (sql: string): StatementSync => (stmts[sql] ??= database.prepare(sql));

  let closed = false;
  let putsSinceMaintenance = 0;

  /** Removes entries retained past the stale window, then enforces the size cap. */
  function maintain(): void {
    if (Number.isFinite(staleRetentionMs)) {
      stmt('DELETE FROM http_cache WHERE expires_at < ?').run(now() - staleRetentionMs);
    }
    if (!sizeCapEnabled) return;
    const total = (stmt(`SELECT COALESCE(SUM(${BODY_BYTES_SQL}), 0) AS bytes FROM http_cache`).get() as { bytes: number }).bytes;
    if (total <= maxBytes) return;
    const target = Math.floor(maxBytes * PRUNE_TARGET_RATIO);
    const rows = stmt(`SELECT key, ${BODY_BYTES_SQL} AS size FROM http_cache ORDER BY fetched_at ASC, key ASC`).all() as unknown as Array<{
      key: string;
      size: number;
    }>;
    const doomed: string[] = [];
    let remaining = total;
    for (const row of rows) {
      if (remaining <= target) break;
      doomed.push(row.key);
      remaining -= row.size;
    }
    if (doomed.length === 0) return;
    inTransaction(database, () => {
      const del = stmt('DELETE FROM http_cache WHERE key = ?');
      for (const key of doomed) del.run(key);
    });
  }

  function bestEffortMaintain(): void {
    try {
      maintain();
    } catch {
      // Housekeeping must never fail a cache write that already succeeded.
    }
  }

  bestEffortMaintain();

  return {
    get(key) {
      const row = stmt(
        'SELECT key, url_redacted, source, status, etag, last_modified, body, fetched_at, expires_at, provenance FROM http_cache WHERE key = ?',
      ).get(key) as EntryRow | undefined;
      return row === undefined ? undefined : toEntry(row);
    },

    put(e) {
      stmt(
        `INSERT OR REPLACE INTO http_cache
           (key, url_redacted, source, status, etag, last_modified, body, fetched_at, expires_at, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        e.key,
        e.url_redacted,
        e.source,
        e.status,
        e.etag ?? null,
        e.last_modified ?? null,
        e.body,
        e.fetched_at,
        e.expires_at,
        e.provenance,
      );
      putsSinceMaintenance += 1;
      if (putsSinceMaintenance >= pruneEveryPuts) {
        putsSinceMaintenance = 0;
        bestEffortMaintain();
      }
    },

    touch(key, expires_at) {
      stmt('UPDATE http_cache SET expires_at = ? WHERE key = ?').run(expires_at, key);
    },

    purge(filter) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (filter?.source !== undefined) {
        where.push('source = ?');
        params.push(filter.source);
      }
      if (filter?.olderThanMs !== undefined) {
        where.push('fetched_at < ?');
        params.push(now() - filter.olderThanMs);
      }
      const sql = `DELETE FROM http_cache${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}`;
      return Number(stmt(sql).run(...params).changes);
    },

    stats() {
      const rows = stmt(
        `SELECT source, COUNT(*) AS entries, COALESCE(SUM(${BODY_BYTES_SQL}), 0) AS bytes FROM http_cache GROUP BY source`,
      ).all() as unknown as Array<{ source: string; entries: number; bytes: number }>;
      const by_source: Record<string, number> = {};
      let entries = 0;
      let bytes = 0;
      for (const row of rows) {
        by_source[row.source] = row.entries;
        entries += row.entries;
        bytes += row.bytes;
      }
      return { entries, bytes, by_source };
    },

    getRateLimit(resource) {
      const row = stmt('SELECT resource, lim, remaining, reset_at, updated_at FROM rate_limits WHERE resource = ?').get(
        resource,
      ) as RateLimitRow | undefined;
      if (row === undefined) return undefined;
      const state: RateLimitState = {
        resource: row.resource,
        limit: row.lim,
        remaining: row.remaining,
        reset_at: row.reset_at,
        updated_at: row.updated_at,
      };
      return state;
    },

    setRateLimit(s) {
      stmt(
        `INSERT INTO rate_limits (resource, lim, remaining, reset_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(resource) DO UPDATE SET
           lim = excluded.lim, remaining = excluded.remaining,
           reset_at = excluded.reset_at, updated_at = excluded.updated_at`,
      ).run(s.resource, s.limit, s.remaining, s.reset_at, s.updated_at);
    },

    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}
