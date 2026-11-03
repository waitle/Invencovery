import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createGithubCodeAdapter,
  createGithubEnricher,
  createGithubRepoAdapter,
} from '../../../src/adapters/github.js';
import type { GithubAdapterDeps } from '../../../src/adapters/github.js';
import { CandidateSchema, EvaluationMetricsSchema, SourceMetaSchema } from '../../../src/types.js';
import type { RateLimitState } from '../../../src/types.js';
import { FakeHttpClient, failure, notFound, ok } from '../../helpers/fake-http.js';

const TOKEN = 'ghp_TESTTOKEN123';
const NOW = new Date('2026-10-12T00:00:00Z');

interface Fixture {
  headers: Record<string, string>;
  body: unknown;
}
function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`../../fixtures/github/${name}.json`, import.meta.url), 'utf8')) as Fixture;
}
const searchRepos = fixture('search-repositories');
const searchCode = fixture('search-code');
const repoDetail = fixture('repo-detail');
const releaseLatest = fixture('release-latest');
const contributorsPage = fixture('contributors-page');

const REPO_SEARCH = (u: string) => u.startsWith('https://api.github.com/search/repositories?');
const CODE_SEARCH = (u: string) => u.startsWith('https://api.github.com/search/code?');

function deps(http: FakeHttpClient, extra: Partial<GithubAdapterDeps> = {}): GithubAdapterDeps {
  return { http, hasToken: () => true, now: () => NOW, ...extra };
}
function qOf(url: string): string {
  return new URL(url).searchParams.get('q') ?? '';
}

describe('github_repo adapter', () => {
  it('normalizes the search fixture into candidates', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, ok(searchRepos.body, { headers: searchRepos.headers }));
    const { candidates, meta } = await createGithubRepoAdapter(deps(http)).search({
      query: 'markdown pdf',
      limit: 8,
    });

    expect(meta).toMatchObject({ source: 'github_repo', status: 'ok', count: 5, query: 'markdown pdf' });
    expect(SourceMetaSchema.safeParse(meta).success).toBe(true);
    expect(candidates.map((c) => c.ref)).toEqual([
      'github:markdown-it/markdown-it',
      'github:Mixed-Owner/Pdf-Kit',
      'github:old-org/legacy-md2pdf',
      'github:someone/no-license-tool',
      'github:acme-corp/internal-docs-tool',
    ]);
    for (const c of candidates) {
      expect(CandidateSchema.safeParse(c).success, c.ref).toBe(true);
      expect(c.source).toBe('github_repo');
      expect(c.provenance).toBe('live');
      expect(c.matched_via.query).toBe('markdown pdf');
      expect(c.repository_url).toBe(c.repository_url?.toLowerCase());
      expect(c.repository_url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    }
    expect(candidates.map((c) => c.matched_via.rank)).toEqual([1, 2, 3, 4, 5]);

    const [mdit, pdfkit, legacy, nolic] = candidates;
    expect(mdit).toMatchObject({
      name: 'markdown-it/markdown-it',
      url: 'https://github.com/markdown-it/markdown-it',
      stars: 19250,
      forks: 2310,
      license_spdx: 'MIT',
      last_activity: '2026-09-18T14:03:09Z',
      archived: false,
      repository_url: 'https://github.com/markdown-it/markdown-it',
    });
    expect(pdfkit?.repository_url).toBe('https://github.com/mixed-owner/pdf-kit');
    expect(pdfkit?.license_spdx).toBe('Apache-2.0');
    expect(legacy).toMatchObject({ archived: true, license_spdx: null });
    expect(nolic).toMatchObject({ description: null, license_spdx: null });
  });

  it('truncates descriptions to 200 chars and collapses whitespace', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, ok(searchRepos.body));
    const { candidates } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 8 });
    const long = candidates[1]?.description ?? '';
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
    expect(long.startsWith('A very long description')).toBe(true);
    expect(candidates[0]?.description?.length).toBeLessThanOrEqual(200);
  });

  it('never splits a surrogate pair when truncating', async () => {
    const body = {
      items: [{ full_name: 'a/b', description: `${'x'.repeat(198)}😀😀`, license: null }],
    };
    const http = new FakeHttpClient().set(REPO_SEARCH, ok(body));
    const { candidates } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 1 });
    const d = candidates[0]?.description ?? '';
    expect(d.length).toBeLessThanOrEqual(200);
    expect(d).not.toMatch(/[\ud800-\udbff]…$/);
    expect(CandidateSchema.safeParse(candidates[0]).success).toBe(true);
  });

  it('strips zero-width, bidi and control characters from descriptions', async () => {
    const description = 'safe​ text‮ rev⁦ iso⁩ bom﻿ bell\u0007 nul\u0000 del\u007F c1\u0085 end';
    const body = { items: [{ full_name: 'a/b', description, license: null }] };
    const http = new FakeHttpClient().set(REPO_SEARCH, ok(body));
    const { candidates } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 1 });
    expect(candidates[0]?.description).toBe('safe text rev iso bom bell nul del c1 end');
  });

  it('requests the search endpoint with auth, accept header and shareable flag', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, ok(searchRepos.body));
    await createGithubRepoAdapter(deps(http)).search({ query: 'markdown pdf', limit: 8 });
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.github.com/search/repositories');
    expect(url.searchParams.get('per_page')).toBe('8');
    expect(url.searchParams.get('q')).toBe('markdown pdf');
    expect(call.opts).toEqual({
      source: 'github_repo',
      ttlClass: 'search',
      auth: true,
      accept: 'application/vnd.github+json',
      shareable: true,
    });
  });

  it('appends language, pushed and stars qualifiers without duplicating existing ones', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, ok({ items: [] }));
    const adapter = createGithubRepoAdapter(deps(http));

    await adapter.search({
      query: 'pdf render archived:false',
      limit: 5,
      ecosystem: 'pypi',
      pushedWithinDays: 730,
      minStars: 50,
    });
    expect(qOf(http.urls[0]!)).toBe('pdf render archived:false language:Python pushed:>=2024-10-12 stars:>=50');

    await adapter.search({
      query: 'pdf language:Rust stars:>10 pushed:>2025-01-01',
      limit: 5,
      ecosystem: 'pypi',
      language: 'Go',
      pushedWithinDays: 30,
      minStars: 5,
    });
    expect(qOf(http.urls[1]!)).toBe('pdf language:Rust stars:>10 pushed:>2025-01-01');

    await adapter.search({ query: 'pdf', limit: 5, language: 'Objective C', minStars: 0 });
    expect(qOf(http.urls[2]!)).toBe('pdf language:"Objective C"');

    await adapter.search({ query: 'pdf', limit: 5, ecosystem: 'npm' });
    expect(qOf(http.urls[3]!)).toBe('pdf');
  });

  it('keeps the query within GitHub\'s 256 character cap', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, ok({ items: [] }));
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    await createGithubRepoAdapter(deps(http)).search({ query: words, limit: 5, pushedWithinDays: 365 });
    const q = qOf(http.urls[0]!);
    expect(q.length).toBeLessThanOrEqual(256);
    expect(q.endsWith('pushed:>=2025-10-12')).toBe(true);
  });

  it('clamps per_page to 1..100', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, ok({ items: [] }));
    const adapter = createGithubRepoAdapter(deps(http));
    await adapter.search({ query: 'a', limit: 500 });
    await adapter.search({ query: 'a', limit: 0 });
    expect(new URL(http.urls[0]!).searchParams.get('per_page')).toBe('100');
    expect(new URL(http.urls[1]!).searchParams.get('per_page')).toBe('1');
  });

  it('returns at most `limit` candidates', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, ok(searchRepos.body));
    const { candidates, meta } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 2 });
    expect(candidates).toHaveLength(2);
    expect(meta.count).toBe(2);
  });

  it('keeps private items and says so in the message', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, ok(searchRepos.body));
    const { candidates, meta } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 8 });
    expect(candidates.some((c) => c.ref === 'github:acme-corp/internal-docs-tool')).toBe(true);
    expect(meta.status).toBe('ok');
    expect(meta.message).toMatch(/1 result\(s\) are private/);
  });

  it('drops malformed items and reports partial', async () => {
    const body = {
      items: [
        { full_name: 'ok/one', stargazers_count: 3 },
        { full_name: 'not-a-full-name' },
        { name: 'missing-full-name' },
        'garbage',
        { full_name: 'ok/two', stargazers_count: 'many' },
      ],
    };
    const http = new FakeHttpClient().set(REPO_SEARCH, ok(body));
    const { candidates, meta } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 10 });
    expect(candidates.map((c) => c.ref)).toEqual(['github:ok/one']);
    expect(meta.status).toBe('partial');
    expect(meta.count).toBe(1);
    expect(meta.message).toMatch(/4 malformed/);
  });

  it('reports partial when GitHub says results are incomplete', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, ok({ incomplete_results: true, items: [{ full_name: 'a/b' }] }));
    const { candidates, meta } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 3 });
    expect(candidates).toHaveLength(1);
    expect(meta.status).toBe('partial');
    expect(meta.message).toMatch(/incomplete/);
  });

  it('marks cache hits as cached and carries provenance onto candidates', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, ok(searchRepos.body, { provenance: 'local_cache' }));
    const { candidates, meta } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 3 });
    expect(meta.status).toBe('cached');
    expect(candidates.every((c) => c.provenance === 'local_cache')).toBe(true);
  });

  it('flags stale cache served during a rate limit', async () => {
    const http = new FakeHttpClient().set(
      REPO_SEARCH,
      ok(searchRepos.body, { provenance: 'stale_cache', error: 'rate_limited' }),
    );
    const { candidates, meta } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 3 });
    expect(candidates).toHaveLength(3);
    expect(meta.status).toBe('cached');
    expect(meta.message).toMatch(/stale cache/);
    expect(candidates.every((c) => c.provenance === 'stale_cache')).toBe(true);
  });

  it('surfaces rate limits from response headers (reset is epoch seconds)', async () => {
    const http = new FakeHttpClient().set(
      REPO_SEARCH,
      failure('rate_limited', {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791802860' },
      }),
    );
    const { candidates, meta } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 3 });
    expect(candidates).toEqual([]);
    expect(meta.status).toBe('rate_limited');
    expect(meta.rate_limit).toEqual({ remaining: 0, reset_at: '2026-10-12T11:01:00.000Z' });
    expect(meta.message).toMatch(/resets at 2026-10-12T11:01:00\.000Z/);
    expect(meta.message).toMatch(/rw_record_evidence/);
    expect(SourceMetaSchema.safeParse(meta).success).toBe(true);
  });

  it('falls back to stored rate-limit state and to retry-after', async () => {
    const stored: RateLimitState = {
      resource: 'github:search',
      limit: 10,
      remaining: 0,
      reset_at: Date.parse('2026-10-12T00:01:00Z'),
      updated_at: NOW.getTime(),
    };
    const blocked = new FakeHttpClient().set(REPO_SEARCH, failure('rate_limited'));
    const r1 = await createGithubRepoAdapter(
      deps(blocked, { getRateLimit: (res) => (res === 'github:search' ? stored : undefined) }),
    ).search({ query: 'x', limit: 3 });
    expect(r1.meta.rate_limit).toEqual({ remaining: 0, reset_at: '2026-10-12T00:01:00.000Z' });

    const retry = new FakeHttpClient().set(REPO_SEARCH, failure('rate_limited', { headers: { 'retry-after': '60' } }));
    const r2 = await createGithubRepoAdapter(deps(retry)).search({ query: 'x', limit: 3 });
    expect(r2.meta.rate_limit).toEqual({ remaining: 0, reset_at: '2026-10-12T00:01:00.000Z' });
  });

  it('suggests a token only when there is none', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, failure('rate_limited'));
    const noToken = await createGithubRepoAdapter(deps(http, { hasToken: () => false })).search({
      query: 'x',
      limit: 3,
    });
    expect(noToken.meta.status).toBe('rate_limited');
    expect(noToken.meta.rate_limit).toBeUndefined();
    expect(noToken.meta.message).toMatch(/GITHUB_TOKEN/);
    const withToken = await createGithubRepoAdapter(deps(http, { hasToken: async () => true })).search({
      query: 'x',
      limit: 3,
    });
    expect(withToken.meta.message).not.toMatch(/GITHUB_TOKEN/);
  });

  it('maps offline, network, http and 401 failures', async () => {
    const run = async (r: Parameters<FakeHttpClient['set']>[1]) => {
      const http = new FakeHttpClient().set(REPO_SEARCH, r);
      return (await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 3 })).meta;
    };
    expect((await run(failure('offline'))).status).toBe('offline');
    expect((await run(failure('network'))).status).toBe('offline');
    const http500 = await run(failure('http'));
    expect(http500.status).toBe('error');
    expect(http500.message).toMatch(/HTTP 500/);
    expect((await run(failure('timeout'))).message).toMatch(/timed out/);
    const unauthorized = await run({ status: 401, data: null, error: 'http' });
    expect(unauthorized.status).toBe('error');
    expect(unauthorized.message).toMatch(/rejected the token/);
    expect((await run({ status: 403, data: null, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791802860' } })).status).toBe(
      'rate_limited',
    );
    expect((await run(ok({ unexpected: true }))).status).toBe('error');
  });

  it('survives a thrown client error without leaking a token', async () => {
    const http = new FakeHttpClient().set(REPO_SEARCH, () => {
      throw new Error(`boom with ${TOKEN} inside`);
    });
    const result = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 3 });
    expect(result.meta.status).toBe('error');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it.each(['1e300', '99999999999999999', 'NaN', 'Infinity', '8640000000001'])(
    'does not throw on an absurd x-ratelimit-reset (%s)',
    async (reset) => {
      const http = new FakeHttpClient().set(
        REPO_SEARCH,
        failure('rate_limited', { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } }),
      );
      const { meta } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 3 });
      expect(meta.status).toBe('rate_limited');
      expect(meta.rate_limit).toBeUndefined();
      expect(SourceMetaSchema.safeParse(meta).success).toBe(true);
    },
  );

  it('falls through from an unrepresentable reset to retry-after', async () => {
    const http = new FakeHttpClient().set(
      REPO_SEARCH,
      failure('rate_limited', {
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1e300', 'retry-after': '60' },
      }),
    );
    const { meta } = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 3 });
    expect(meta.rate_limit).toEqual({ remaining: 0, reset_at: '2026-10-12T00:01:00.000Z' });
  });

  it('masks configured secret values (not just ghp_ patterns) in a thrown client error', async () => {
    const secret = 'plain-secret-value-9876';
    const previous = process.env.LIBRARIES_IO_API_KEY;
    process.env.LIBRARIES_IO_API_KEY = secret;
    try {
      const http = new FakeHttpClient().set(REPO_SEARCH, () => {
        throw new Error(`upstream said ${secret}`);
      });
      const result = await createGithubRepoAdapter(deps(http)).search({ query: 'x', limit: 3 });
      expect(result.meta.status).toBe('error');
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.LIBRARIES_IO_API_KEY;
      else process.env.LIBRARIES_IO_API_KEY = previous;
    }
  });

  it('skips an empty query without calling the network', async () => {
    const http = new FakeHttpClient();
    const { candidates, meta } = await createGithubRepoAdapter(deps(http)).search({ query: '   ', limit: 3 });
    expect(candidates).toEqual([]);
    expect(meta.status).toBe('skipped');
    expect(http.calls).toHaveLength(0);
  });
});

describe('github_code adapter', () => {
  it('degrades to unauthenticated without a token and does not call the network', async () => {
    const http = new FakeHttpClient();
    const { candidates, meta } = await createGithubCodeAdapter(deps(http, { hasToken: () => false })).search({
      query: 'renderMarkdownToPdf',
      limit: 5,
    });
    expect(candidates).toEqual([]);
    expect(meta).toMatchObject({ source: 'github_code', status: 'unauthenticated', count: 0 });
    expect(meta.message).toMatch(/Grep MCP/);
    expect(meta.message).toMatch(/GITHUB_TOKEN/);
    expect(http.calls).toHaveLength(0);
    expect(SourceMetaSchema.safeParse(meta).success).toBe(true);
  });

  it('groups hits per repository and records the matching paths', async () => {
    const http = new FakeHttpClient().set(CODE_SEARCH, ok(searchCode.body, { headers: searchCode.headers }));
    const { candidates, meta } = await createGithubCodeAdapter(deps(http)).search({
      query: 'renderMarkdownToPdf',
      limit: 5,
    });

    expect(meta).toMatchObject({ source: 'github_code', status: 'ok', count: 2 });
    expect(candidates).toHaveLength(2);
    const [first, second] = candidates;
    expect(first).toMatchObject({
      ref: 'github:octo-org/md-render',
      source: 'github_code',
      name: 'octo-org/md-render',
      url: 'https://github.com/octo-org/md-render',
      description: 'Render markdown to HTML and PDF',
      repository_url: 'https://github.com/octo-org/md-render',
      provenance: 'live',
    });
    expect(first?.matched_via).toEqual({
      query: 'renderMarkdownToPdf :: src/render.ts, src/pdf.ts',
      rank: 1,
    });
    expect(second).toMatchObject({
      ref: 'github:Other-Org/Pdf-Helpers',
      description: null,
      repository_url: 'https://github.com/other-org/pdf-helpers',
    });
    expect(second?.matched_via).toEqual({ query: 'renderMarkdownToPdf :: lib/helpers.py', rank: 2 });
    for (const c of candidates) expect(CandidateSchema.safeParse(c).success).toBe(true);
  });

  it('asks for text matches, authenticated, with room for per-repo grouping', async () => {
    const http = new FakeHttpClient().set(CODE_SEARCH, ok({ items: [] }));
    await createGithubCodeAdapter(deps(http)).search({ query: 'foo', limit: 5, language: 'TypeScript' });
    const call = http.calls[0]!;
    const url = new URL(call.url);
    expect(url.pathname).toBe('/search/code');
    expect(url.searchParams.get('q')).toBe('foo language:TypeScript');
    expect(url.searchParams.get('per_page')).toBe('15');
    expect(call.opts).toEqual({
      source: 'github_code',
      ttlClass: 'search',
      auth: true,
      accept: 'application/vnd.github.text-match+json',
      shareable: true,
    });

    await createGithubCodeAdapter(deps(http)).search({ query: 'foo', limit: 80 });
    expect(new URL(http.urls[1]!).searchParams.get('per_page')).toBe('100');
  });

  it('caps candidates at `limit` repositories', async () => {
    const http = new FakeHttpClient().set(CODE_SEARCH, ok(searchCode.body));
    const { candidates } = await createGithubCodeAdapter(deps(http)).search({ query: 'x', limit: 1 });
    expect(candidates.map((c) => c.ref)).toEqual(['github:octo-org/md-render']);
  });

  it('propagates rate limits and token rejection', async () => {
    const limited = new FakeHttpClient().set(
      CODE_SEARCH,
      failure('rate_limited', { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791802860' } }),
    );
    const r1 = await createGithubCodeAdapter(deps(limited)).search({ query: 'x', limit: 3 });
    expect(r1.meta).toMatchObject({
      source: 'github_code',
      status: 'rate_limited',
      rate_limit: { remaining: 0, reset_at: '2026-10-12T11:01:00.000Z' },
    });

    const rejected = new FakeHttpClient().set(CODE_SEARCH, { status: 401, data: null, error: 'http' });
    const r2 = await createGithubCodeAdapter(deps(rejected)).search({ query: 'x', limit: 3 });
    expect(r2.meta.status).toBe('error');
    expect(r2.meta.message).toMatch(/rejected the token/);
  });
});

describe('github enricher', () => {
  const BASE = 'https://api.github.com/repos/markdown-it/markdown-it';

  function routed(): FakeHttpClient {
    return new FakeHttpClient({
      [BASE]: ok(repoDetail.body, { headers: repoDetail.headers }),
      [`${BASE}/releases/latest`]: ok(releaseLatest.body, { headers: releaseLatest.headers }),
      [`${BASE}/contributors?per_page=1&anon=1`]: ok(contributorsPage.body, { headers: contributorsPage.headers }),
    });
  }

  it('supports only github refs', () => {
    const e = createGithubEnricher({ http: new FakeHttpClient() });
    expect(e.supports('github:a/b')).toBe(true);
    for (const ref of ['npm:a', 'pypi:a', 'mcp:io.github.a/b', 'web:https://github.com/a/b', 'github:nope', 'x']) {
      expect(e.supports(ref), ref).toBe(false);
    }
  });

  it('fills metrics from /repos only when not deep', async () => {
    const http = routed();
    const r = await createGithubEnricher({ http }).enrich('github:markdown-it/markdown-it', { deep: false });
    expect(http.urls).toEqual([BASE]);
    expect(http.calls[0]!.opts).toEqual({
      source: 'github_repo',
      ttlClass: 'repo',
      auth: true,
      accept: 'application/vnd.github+json',
      shareable: true,
    });
    expect(r).toEqual({
      metrics: {
        stars: 19250,
        forks: 2310,
        open_issues: 21,
        last_commit_at: '2026-09-18T14:03:09Z',
        archived: false,
      },
      license_spdx: 'MIT',
      license_source: 'github',
      repository_url: 'https://github.com/markdown-it/markdown-it',
      provenance: 'live',
      missing: [],
      descriptor: 'Markdown parser, done right. 100% CommonMark support, extensions, syntax plugins & high speed commonmark markdown markdown-it parser',
    });
    expect(EvaluationMetricsSchema.safeParse(r.metrics).success).toBe(true);
  });

  it('adds the latest release and the Link-header contributor count when deep', async () => {
    const http = routed();
    const r = await createGithubEnricher({ http }).enrich('github:markdown-it/markdown-it', { deep: true });
    expect(http.urls).toEqual([BASE, `${BASE}/releases/latest`, `${BASE}/contributors?per_page=1&anon=1`]);
    expect(http.calls[1]!.opts.ttlClass).toBe('repo_aux');
    expect(http.calls[2]!.opts.ttlClass).toBe('repo_aux');
    expect(r.metrics.last_release_at).toBe('2026-09-10T11:42:17Z');
    expect(r.metrics.contributors).toBe(412);
    expect(r.missing).toEqual([]);
    expect(EvaluationMetricsSchema.safeParse(r.metrics).success).toBe(true);
  });

  it('treats a missing release (404) as normal, not as a gap', async () => {
    const http = routed().set(`${BASE}/releases/latest`, notFound());
    const r = await createGithubEnricher({ http }).enrich('github:markdown-it/markdown-it', { deep: true });
    expect(r.metrics.last_release_at).toBeUndefined();
    expect(r.metrics.contributors).toBe(412);
    expect(r.missing).toEqual([]);
  });

  it('counts contributors without a Link header only when that is unambiguous', async () => {
    const one = [{ login: 'solo' }];
    const url = `${BASE}/contributors?per_page=1&anon=1`;
    const enrich = async (res: Parameters<FakeHttpClient['set']>[1]) => {
      const http = routed().set(url, res);
      return createGithubEnricher({ http }).enrich('github:markdown-it/markdown-it', { deep: true });
    };

    expect((await enrich(ok(one, { provenance: 'live' }))).metrics.contributors).toBe(1);
    expect((await enrich(ok([]))).metrics.contributors).toBe(0);
    expect((await enrich({ status: 204, data: null })).metrics.contributors).toBe(0);

    // A cache hit does not retain the Link header: one element could be 1 or 412.
    const cached = await enrich(ok(one, { provenance: 'local_cache' }));
    expect(cached.metrics.contributors).toBeUndefined();
    expect(cached.missing).toEqual(['contributors']);

    const tooLarge = await enrich({ status: 403, data: null, error: 'http' });
    expect(tooLarge.missing).toEqual(['contributors']);
  });

  it('keeps GitHub metrics and records missing when auxiliary calls fail', async () => {
    const http = routed()
      .set(`${BASE}/releases/latest`, failure('rate_limited'))
      .set(`${BASE}/contributors?per_page=1&anon=1`, failure('offline'));
    const r = await createGithubEnricher({ http }).enrich('github:markdown-it/markdown-it', { deep: true });
    expect(r.metrics).toMatchObject({ stars: 19250, forks: 2310, open_issues: 21, archived: false });
    expect(r.license_spdx).toBe('MIT');
    expect(r.missing).toEqual(['last_release_at', 'contributors']);
  });

  it('returns everything missing, without extra calls, when the repo cannot be read', async () => {
    for (const res of [notFound(), failure('rate_limited'), failure('offline'), ok({ message: 'weird' })]) {
      const http = new FakeHttpClient().set(BASE, res);
      const r = await createGithubEnricher({ http }).enrich('github:markdown-it/markdown-it', { deep: true });
      expect(http.urls).toEqual([BASE]);
      expect(r.metrics).toEqual({});
      expect(r.license_spdx).toBeNull();
      expect(r.repository_url).toBe('https://github.com/markdown-it/markdown-it');
      expect(r.missing).toEqual([
        'stars',
        'forks',
        'open_issues',
        'last_commit_at',
        'archived',
        'license',
        'last_release_at',
        'contributors',
      ]);
    }
  });

  it('reports a repository without a license as null, not as missing', async () => {
    const body = { ...(repoDetail.body as object), license: null };
    const http = new FakeHttpClient().set(BASE, ok(body));
    const r = await createGithubEnricher({ http }).enrich('github:markdown-it/markdown-it', { deep: false });
    expect(r.license_spdx).toBeNull();
    expect(r.missing).toEqual([]);
  });

  it('maps NOASSERTION to null and archived to a metric', async () => {
    const body = {
      ...(repoDetail.body as object),
      license: { key: 'other', name: 'Other', spdx_id: 'NOASSERTION' },
      archived: true,
    };
    const http = new FakeHttpClient().set(BASE, ok(body));
    const r = await createGithubEnricher({ http }).enrich('github:markdown-it/markdown-it', { deep: false });
    expect(r.license_spdx).toBeNull();
    expect(r.metrics.archived).toBe(true);
  });

  it('labels license data from the remote cache and reports the least fresh provenance', async () => {
    const remote = routed().set(BASE, ok(repoDetail.body, { provenance: 'remote_cache' }));
    const r1 = await createGithubEnricher({ http: remote }).enrich('github:markdown-it/markdown-it', { deep: false });
    expect(r1.license_source).toBe('remote_cache');
    expect(r1.provenance).toBe('remote_cache');

    const stale = routed().set(`${BASE}/releases/latest`, ok(releaseLatest.body, { provenance: 'stale_cache' }));
    const r2 = await createGithubEnricher({ http: stale }).enrich('github:markdown-it/markdown-it', { deep: true });
    expect(r2.license_source).toBe('github');
    expect(r2.provenance).toBe('stale_cache');
  });

  it('survives a thrown client error', async () => {
    const http = new FakeHttpClient().set(BASE, () => {
      throw new Error(`down ${TOKEN}`);
    });
    const r = await createGithubEnricher({ http }).enrich('github:markdown-it/markdown-it', { deep: false });
    expect(r.metrics).toEqual({});
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('encodes owner and repo path segments', async () => {
    const http = new FakeHttpClient().set(() => true, notFound());
    await createGithubEnricher({ http }).enrich('github:own er/re po', { deep: false });
    // refs with whitespace are rejected by parseRef, so no request is made at all
    expect(http.calls).toHaveLength(0);
    // '%' is not a valid ref character either
    await createGithubEnricher({ http }).enrich('github:ow%ner/re.po', { deep: false });
    expect(http.calls).toHaveLength(0);
    await createGithubEnricher({ http }).enrich('github:own-er/re.po', { deep: false });
    expect(http.urls[0]).toBe('https://api.github.com/repos/own-er/re.po');
  });

  it.each(['github:../user', 'github:%2e%2e/user', 'github:owner/..', 'github:owner/.', 'github:./repo', 'github:o/r%2f..'])(
    'never requests anything for the path-manipulating ref %s',
    async (ref) => {
      const http = new FakeHttpClient().set(() => true, notFound());
      const enricher = createGithubEnricher({ http });
      const r = await enricher.enrich(ref, { deep: true });
      expect(http.calls).toHaveLength(0);
      expect(r.metrics).toEqual({});
    },
  );
});
