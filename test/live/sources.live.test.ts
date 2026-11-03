/**
 * Live smoke test against the real services (docs/PLAN.md §12 T30, §13.4).
 *
 * Runs only with `RECYCLEWHEEL_LIVE=1` (`RW_LIVE=1`, the spelling used in the
 * plan, works too); `npm test` excludes this directory. Unauthenticated: the
 * app is built from an explicit environment without any GitHub token and with
 * the `gh` fallback disabled.
 *
 * Request budget (fresh empty cache, so every call goes upstream):
 *   github repo search 1, github repo detail 1, npm search 1, PyPI json 1,
 *   MCP registry 1 (a second only if /v0.1 is unusable), deps.dev 1
 *   = 6 requests (7 at most). With GITHUB_TOKEN set, one code search is added.
 *
 * A source that is rate limited (HTTP 429 or an exhausted 403) must say so:
 * status `rate_limited` with a message and no invented data. That is accepted
 * with a warning. Any other failure (`error`, `offline`) fails the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProject } from '../../src/adapters/depsdev.js';
import { createApp } from '../../src/app.js';
import type { App } from '../../src/app.js';
import { cleanupTmpDirs, makeTmpDir } from '../helpers/tmp.js';
import type { Candidate, SourceMeta } from '../../src/types.js';

const LIVE = process.env.RECYCLEWHEEL_LIVE === '1' || process.env.RW_LIVE === '1';
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

const ACCEPTED: ReadonlyArray<SourceMeta['status']> = ['ok', 'cached', 'partial', 'rate_limited'];
const warnings: string[] = [];

function plainEnv(cacheDir: string, projectRoot: string, token?: string): NodeJS.ProcessEnv {
  return {
    RECYCLEWHEEL_CACHE_DIR: cacheDir,
    RECYCLEWHEEL_PROJECT_ROOT: projectRoot,
    RECYCLEWHEEL_NO_GH_CLI: '1',
    ...(token !== undefined ? { GITHUB_TOKEN: token } : {}),
  };
}

/**
 * Passes for ok/cached/partial (and then requires real, well-formed data);
 * rate_limited passes with a warning but must carry an explanation and no data.
 */
function expectOkOrHonestRateLimit(label: string, meta: SourceMeta, candidates: Candidate[]): boolean {
  expect(ACCEPTED, `${label}: unexpected status ${meta.status} (${meta.message ?? 'no message'})`).toContain(meta.status);
  if (meta.status === 'rate_limited') {
    warnings.push(`${label}: rate limited${meta.rate_limit ? ` until ${meta.rate_limit.reset_at}` : ''}`);
    expect(candidates, `${label}: rate_limited must not invent candidates`).toEqual([]);
    expect(meta.message ?? '', `${label}: rate_limited needs an explanation`).toMatch(/rate limit/i);
    expect(meta.count).toBe(0);
    return false;
  }
  expect(candidates.length, `${label}: no candidates although status is ${meta.status}`).toBeGreaterThan(0);
  expect(meta.count).toBe(candidates.length);
  for (const c of candidates) {
    expect(c.ref).toMatch(/^[a-z]+:.+/);
    expect(c.name.length).toBeGreaterThan(0);
  }
  return true;
}

describe.skipIf(!LIVE)('live sources (unauthenticated)', () => {
  let app: App;

  beforeAll(() => {
    const cacheDir = makeTmpDir('rw-live-cache-');
    const projectRoot = makeTmpDir('rw-live-project-');
    app = createApp(plainEnv(cacheDir, projectRoot), { cwd: projectRoot });
  });

  afterAll(() => {
    app?.close();
    cleanupTmpDirs();
    if (warnings.length > 0) console.warn(`[live] rate limit warnings:\n- ${warnings.join('\n- ')}`);
  });

  it('starts without a GitHub token', async () => {
    expect(await app.githubAuthSource()).toBe('none');
    expect(app.config.offline).toBe(false);
  });

  it('GitHub repository search (1 request)', async () => {
    const adapter = app.adapters.github_repo;
    expect(adapter).toBeDefined();
    const { candidates, meta } = await adapter!.search({ query: 'markdown it parser', limit: 3, minStars: 100 });
    if (expectOkOrHonestRateLimit('github_repo', meta, candidates)) {
      expect(meta.status).toBe('ok'); // empty cache: the answer is live
      expect(candidates.length).toBeLessThanOrEqual(3);
      for (const c of candidates) {
        expect(c.ref).toMatch(/^github:[^/]+\/[^/]+$/);
        expect(c.provenance).toBe('live');
        expect(c.stars ?? 0).toBeGreaterThanOrEqual(100);
      }
    }
  });

  it('GitHub repository detail through the enricher (1 request)', async () => {
    const enricher = app.enrichers.find((e) => e.supports('github:markdown-it/markdown-it') && !e.supports('npm:a'));
    expect(enricher).toBeDefined();
    const result = await enricher!.enrich('github:markdown-it/markdown-it', { deep: false });
    if (result.metrics.stars !== undefined) {
      expect(result.metrics.stars).toBeGreaterThan(1000);
      expect(result.metrics.last_commit_at).toBeDefined();
      expect(result.repository_url).toBe('https://github.com/markdown-it/markdown-it');
      expect(result.license_spdx).toBe('MIT');
    } else {
      // Not available (rate limit): it must be reported as missing, not made up.
      warnings.push('github detail: no metrics returned (rate limited or unavailable)');
      expect(result.missing).toContain('stars');
      expect(result.metrics).toEqual({});
    }
  });

  it('npm search (1 request)', async () => {
    const { candidates, meta } = await app.adapters.npm!.search({ query: 'markdown', limit: 3, ecosystem: 'npm' });
    if (expectOkOrHonestRateLimit('npm', meta, candidates)) {
      expect(candidates.every((c) => c.ref.startsWith('npm:'))).toBe(true);
      expect(candidates.some((c) => (c.downloads_weekly ?? 0) > 0)).toBe(true);
    }
  });

  it('PyPI package JSON by name (1 request)', async () => {
    const { candidates, meta } = await app.adapters.pypi!.search({
      query: 'markdown',
      limit: 1,
      ecosystem: 'pypi',
      nameHints: ['markdown'],
    });
    if (expectOkOrHonestRateLimit('pypi', meta, candidates)) {
      expect(candidates.map((c) => c.ref)).toEqual(['pypi:markdown']);
      expect(meta.message ?? '').toMatch(/search/i); // the "PyPI has no search API" note
    }
  });

  it('MCP registry search (1 request)', async () => {
    const { candidates, meta } = await app.adapters.mcp_registry!.search({ query: 'filesystem', limit: 3 });
    if (expectOkOrHonestRateLimit('mcp_registry', meta, candidates)) {
      expect(candidates.every((c) => c.ref.startsWith('mcp:'))).toBe(true);
    }
  });

  it('deps.dev project lookup (1 request)', async () => {
    const result = await getProject(app.http, 'pallets', 'flask');
    expect(['ok', 'rate_limited'], `deps.dev status ${result.status}`).toContain(result.status);
    if (result.status === 'ok') {
      expect(result.data?.stars ?? 0).toBeGreaterThan(1000);
      expect(result.data?.license).toBe('BSD-3-Clause');
      expect(result.provenance).toBe('live');
    } else {
      warnings.push('deps.dev: rate limited');
      expect(result.data).toBeNull();
    }
  });

  it('GitHub code search: disabled without a token, one real request with a token', async () => {
    const unauthenticated = createApp(plainEnv(makeTmpDir('rw-live-cache2-'), makeTmpDir('rw-live-project2-')));
    try {
      const { candidates, meta } = await unauthenticated.adapters.github_code!.search({ query: 'markdown pdf', limit: 3 });
      expect(meta.status).toBe('unauthenticated'); // no request is made
      expect(meta.message ?? '').toMatch(/GITHUB_TOKEN/);
      expect(candidates).toEqual([]);
    } finally {
      unauthenticated.close();
    }

    if (TOKEN === undefined) return; // optional extra request, only when a token is configured
    const authed = createApp(plainEnv(makeTmpDir('rw-live-cache3-'), makeTmpDir('rw-live-project3-'), TOKEN));
    try {
      const { candidates, meta } = await authed.adapters.github_code!.search({ query: 'markdown it plugin', limit: 3 });
      expectOkOrHonestRateLimit('github_code', meta, candidates);
      expect(JSON.stringify({ candidates, meta })).not.toContain(TOKEN);
    } finally {
      authed.close();
    }
  });
});
