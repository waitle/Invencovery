import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { USER_AGENT, createApp } from '../../src/app.js';
import type { App } from '../../src/app.js';
import { VERSION } from '../../src/doctor.js';
import { cleanupTmpDirs, makeTmpDir } from '../helpers/tmp.js';

const apps: App[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.close();
  cleanupTmpDirs();
});

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(calls: Call[], body: unknown = {}): typeof globalThis.fetch {
  return (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(input), headers: { ...(init?.headers ?? {}) } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}

function make(env: Record<string, string> = {}, opts: Parameters<typeof createApp>[1] = {}): { app: App; dir: string } {
  const dir = makeTmpDir('rw-app-');
  const app = createApp(
    { RECYCLEWHEEL_CACHE_DIR: join(dir, 'cache'), RECYCLEWHEEL_PROJECT_ROOT: dir, RECYCLEWHEEL_NO_GH_CLI: '1', ...env },
    { cwd: dir, ...opts },
  );
  apps.push(app);
  return { app, dir };
}

describe('createApp', () => {
  it('wires all six sources by default and keeps libraries.io out of the map', () => {
    const { app } = make();
    expect(Object.keys(app.adapters).sort()).toEqual(['github_code', 'github_repo', 'hf_models', 'mcp_registry', 'npm', 'pypi']);
    expect(app.remote.mode).toBe('off');
  });

  it('honours RECYCLEWHEEL_SOURCES', () => {
    const { app } = make({ RECYCLEWHEEL_SOURCES: 'npm,pypi' });
    expect(Object.keys(app.adapters).sort()).toEqual(['npm', 'pypi']);
  });

  it('orders the enrichers deps.dev, github, npm, pypi, mcp-registry, huggingface', () => {
    const { app } = make();
    const supporting = (ref: string) => app.enrichers.map((e, i) => (e.supports(ref) ? i : -1)).filter((i) => i >= 0);
    expect(app.enrichers).toHaveLength(6);
    expect(supporting('github:o/r')).toEqual([0, 1]);
    expect(supporting('npm:zod')).toEqual([0, 2]);
    expect(supporting('pypi:flask')).toEqual([0, 3]);
    expect(supporting('mcp:io.github.x/y')).toEqual([4]);
    expect(supporting('hf:livekit/turn-detector')).toEqual([5]);
  });

  it('sends the User-Agent everywhere and the GitHub token only to api.github.com', async () => {
    const calls: Call[] = [];
    const { app } = make({ GITHUB_TOKEN: 'ghp_TESTTOKEN123' }, { fetch: fakeFetch(calls, { items: [], total_count: 0, objects: [] }) });
    await app.adapters.github_repo?.search({ query: 'markdown', limit: 3 });
    await app.adapters.npm?.search({ query: 'markdown', limit: 3 });
    const gh = calls.find((c) => c.url.startsWith('https://api.github.com/'));
    const npm = calls.find((c) => c.url.startsWith('https://registry.npmjs.org/'));
    expect(gh?.headers.authorization).toBe('Bearer ghp_TESTTOKEN123');
    expect(npm?.headers.authorization).toBeUndefined();
    expect(gh?.headers['user-agent']).toBe(USER_AGENT);
    expect(npm?.headers['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(new RegExp(`^recyclewheel/${VERSION.replace(/\./g, '\\.')} \\(\\+https://github\\.com/`));
    expect(await app.githubAuthSource()).toBe('env');
  });

  it('reports no token source when none is configured', async () => {
    const { app } = make({}, { runGh: async () => { throw new Error('no gh'); } });
    expect(await app.githubAuthSource()).toBe('none');
  });

  it('makes no network call in offline mode', async () => {
    const calls: Call[] = [];
    const { app } = make({ RECYCLEWHEEL_OFFLINE: '1' }, { fetch: fakeFetch(calls) });
    const r = await app.adapters.npm?.search({ query: 'markdown', limit: 3 });
    expect(calls).toHaveLength(0);
    expect(r?.meta.status).toBe('offline');
  });

  it('falls back to an in-memory cache, with a warning, when the cache path is unusable', () => {
    const dir = makeTmpDir('rw-app-');
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file, not a directory');
    const app = createApp(
      { RECYCLEWHEEL_CACHE_DIR: join(blocker, 'sub'), RECYCLEWHEEL_PROJECT_ROOT: dir, RECYCLEWHEEL_NO_GH_CLI: '1' },
      { cwd: dir },
    );
    apps.push(app);
    expect(app.config.warnings.join(' ')).toMatch(/in-memory cache/);
    expect(app.store.stats().entries).toBe(0);
  });

  it('builds the ledger for the configured root and close() is idempotent', () => {
    const { app, dir } = make();
    expect(app.ledger().path).toBe(join(dir, '.recyclewheel', 'ledger.jsonl'));
    app.close();
    expect(() => app.close()).not.toThrow();
  });

  it('enables the remote cache only with a URL and a mode', () => {
    const { app } = make({ RECYCLEWHEEL_REMOTE_CACHE_URL: 'https://cache.example.com', RECYCLEWHEEL_REMOTE_CACHE_MODE: 'read' });
    expect(app.remote.mode).toBe('read');
  });
});
