import { afterEach, describe, expect, it } from 'vitest';
import { StatusReportSchema, VERSION } from '../../../src/doctor.js';
import { statusTool } from '../../../src/mcp/tools/status.js';
import { cleanupTmpDirs } from '../../helpers/tmp.js';
import { connect, makeCtx, offRemote, seedLedger } from './_t20-helpers.js';
import type { Connected } from './_t20-helpers.js';

let conn: Connected | undefined;
afterEach(async () => {
  await conn?.close();
  conn = undefined;
  cleanupTmpDirs();
});

async function status(opts: Parameters<typeof makeCtx>[0] = {}, args: Record<string, unknown> = {}) {
  const t = makeCtx(opts);
  await conn?.close();
  conn = await connect(statusTool, t.ctx);
  const r = await conn.call('rw_status', args);
  return { t, r, report: StatusReportSchema.parse(r.structured) };
}

describe('rw_status', () => {
  it('advertises input and output schemas and is read-only', async () => {
    const t = makeCtx();
    conn = await connect(statusTool, t.ctx);
    const { tools } = await conn.client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('rw_status');
    expect(tools[0]?.inputSchema).toBeDefined();
    expect(tools[0]?.outputSchema).toBeDefined();
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  });

  it('returns a schema-valid report with a Markdown summary', async () => {
    const { t, r, report } = await status({ githubAuth: 'env' });
    expect(r.isError).toBe(false);
    expect(report.version).toBe(VERSION);
    expect(report.github_auth).toBe('env');
    expect(report.project_root).toBe(t.root);
    expect(report.ledger_exists).toBe(false);
    expect(report.budget).toEqual({ rounds_per_component: 3, evals_per_component: 5, web_per_component: 2 });
    expect(report.remote_cache).toEqual({ mode: 'off' });
    expect(report.cache.path).toBe(t.ctx.config.cacheDbPath);
    expect(r.text).toContain('| source | enabled | note |');
  });

  it('marks code search disabled without a token and enabled with one', async () => {
    const none = (await status({ githubAuth: 'none' })).report.adapters.find((a) => a.source === 'github_code');
    expect(none).toEqual({ source: 'github_code', enabled: false, note: 'needs GITHUB_TOKEN; consider Grep MCP' });
    const tok = (await status({ githubAuth: 'gh_cli' })).report.adapters.find((a) => a.source === 'github_code');
    expect(tok?.enabled).toBe(true);
  });

  it('reports sources disabled by RECYCLEWHEEL_SOURCES', async () => {
    const { report } = await status({ env: { RECYCLEWHEEL_SOURCES: 'npm,pypi' }, adapters: {} });
    expect(report.adapters.find((a) => a.source === 'github_repo')?.note).toMatch(/RECYCLEWHEEL_SOURCES/);
    expect(report.adapters).toHaveLength(6);
  });

  it('lists only known rate limits, and the ledger flag follows the file', async () => {
    const t = makeCtx();
    t.store.setRateLimit({ resource: 'github:search:anon', limit: 10, remaining: 0, reset_at: 5, updated_at: 1 });
    seedLedger(t.root);
    conn = await connect(statusTool, t.ctx);
    const report = StatusReportSchema.parse((await conn.call('rw_status', {})).structured);
    expect(report.rate_limits.map((s) => s.resource)).toEqual(['github:search:anon']);
    expect(report.ledger_exists).toBe(true);
  });

  it('shows only the host of a reachable remote cache, never credentials or path', async () => {
    const remote = { ...offRemote, mode: 'readwrite' as const, healthy: async () => true };
    const { report, r } = await status({
      remote,
      env: {
        RECYCLEWHEEL_REMOTE_CACHE_URL: 'https://user:pw-secret@cache.example.com:8443/team?x=1',
        RECYCLEWHEEL_REMOTE_CACHE_MODE: 'readwrite',
        RECYCLEWHEEL_REMOTE_CACHE_TOKEN: 'remote-token-xyz',
      },
    });
    expect(report.remote_cache).toEqual({ mode: 'readwrite', host: 'cache.example.com:8443', reachable: true });
    const all = JSON.stringify(r);
    for (const secret of ['pw-secret', 'remote-token-xyz', 'user:']) expect(all).not.toContain(secret);
  });

  it('reports an unreachable remote cache within the timeout', async () => {
    const remote = { ...offRemote, mode: 'read' as const, healthy: () => new Promise<boolean>(() => undefined) };
    const started = Date.now();
    const { report } = await status({
      remote,
      env: { RECYCLEWHEEL_REMOTE_CACHE_URL: 'https://c.example.com', RECYCLEWHEEL_REMOTE_CACHE_MODE: 'read' },
    });
    expect(report.remote_cache.reachable).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('resolves a relative project_root against the configured root', async () => {
    const { t, report } = await status({}, { project_root: 'sub/dir' });
    expect(report.project_root.replace(/\\/g, '/')).toBe(`${t.root.replace(/\\/g, '/')}/sub/dir`);
  });
});
