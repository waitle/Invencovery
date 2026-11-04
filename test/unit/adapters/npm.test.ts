import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CandidateSchema } from '../../../src/types.js';
import { NPM_SEARCH_TEXT_MAX, clampNpmSearchText, createNpmAdapter, createNpmEnricher, encodeNpmName } from '../../../src/adapters/npm.js';
import { FakeHttpClient, failure, notFound, ok } from '../../helpers/fake-http.js';

function fixture<T = Record<string, any>>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../fixtures/npm/${name}`, import.meta.url), 'utf8')) as T;
}

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=markdown%20pdf&size=4';
const LATEST_SCOPED_URL = 'https://registry.npmjs.org/@babel%2Fcore/latest';
const DOWNLOADS_SCOPED_URL = 'https://api.npmjs.org/downloads/point/last-week/@babel/core';
const ENRICH = { deep: false };

describe('encodeNpmName', () => {
  it('encodes the scope separator but keeps the @', () => {
    expect(encodeNpmName('@babel/core')).toBe('@babel%2Fcore');
    expect(encodeNpmName('left-pad')).toBe('left-pad');
  });
});

describe('npm search adapter', () => {
  const query = { query: 'markdown pdf', limit: 4 };

  it('normalizes the recorded search response', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: ok(fixture('search.json')) });
    const { candidates, meta } = await createNpmAdapter({ http }).search(query);

    expect(http.urls).toEqual([SEARCH_URL]);
    expect(http.calls[0]!.opts).toMatchObject({ source: 'npm', ttlClass: 'search' });
    expect(meta).toEqual({ source: 'npm', status: 'ok', count: 4, query: 'markdown pdf' });
    expect(candidates).toHaveLength(4);
    for (const c of candidates) expect(CandidateSchema.safeParse(c).success).toBe(true);

    expect(candidates[0]).toEqual({
      ref: 'npm:@types/markdown-pdf',
      source: 'npm',
      name: '@types/markdown-pdf',
      url: 'https://www.npmjs.com/package/@types/markdown-pdf',
      description: 'TypeScript definitions for markdown-pdf',
      ecosystem: 'npm',
      downloads_weekly: 3481,
      license_spdx: 'MIT',
      last_activity: '2023-11-07T10:50:51.093Z',
      repository_url: 'https://github.com/definitelytyped/definitelytyped',
      matched_via: { query: 'markdown pdf', rank: 1 },
      provenance: 'live',
    });
    // git+ssh and git+https repository links are normalized
    expect(candidates[1]!.repository_url).toBe('https://github.com/shift-labs-ai/markit');
    expect(candidates[2]).toMatchObject({
      ref: 'npm:markdown-pdf',
      repository_url: 'https://github.com/alanshaw/markdown-pdf',
      matched_via: { rank: 3 },
    });
  });

  it('truncates long descriptions to 200 characters', async () => {
    const body = fixture('search.json');
    body.objects[0].package.description = 'long '.repeat(100);
    const http = new FakeHttpClient({ [SEARCH_URL]: ok(body) });
    const { candidates } = await createNpmAdapter({ http }).search(query);
    expect(candidates[0]!.description).toHaveLength(200);
  });

  it('url-encodes the query and clamps size', async () => {
    const http = new FakeHttpClient().set(/registry\.npmjs\.org\/-\/v1\/search/, ok({ objects: [] }));
    await createNpmAdapter({ http }).search({ query: 'a&b #c', limit: 9999 });
    expect(http.urls[0]).toBe('https://registry.npmjs.org/-/v1/search?text=a%26b%20%23c&size=250');
  });

  it('cuts a query longer than 64 characters at a word boundary and says so (the registry returns 400 otherwise)', async () => {
    const http = new FakeHttpClient().set(/registry\.npmjs\.org\/-\/v1\/search/, ok({ objects: [] }));
    const long = 'react native audio player track player background audio lock screen controls hls streaming';
    const { meta } = await createNpmAdapter({ http }).search({ query: long, limit: 8 });
    const sent = new URL(http.urls[0]!).searchParams.get('text')!;
    expect(sent).toBe('react native audio player track player background audio lock');
    expect(sent.length).toBeLessThanOrEqual(NPM_SEARCH_TEXT_MAX);
    expect(meta.status).toBe('ok');
    expect(meta.message).toContain('cut to');
    expect(clampNpmSearchText('x'.repeat(100))).toHaveLength(64);
    expect(clampNpmSearchText('short query')).toBe('short query');
  });

  it('skips a one-character query instead of asking the registry', async () => {
    const http = new FakeHttpClient();
    const { meta } = await createNpmAdapter({ http }).search({ query: 'a', limit: 8 });
    expect(meta.status).toBe('skipped');
    expect(http.calls).toHaveLength(0);
  });

  it('marks cache-served results as cached', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: ok(fixture('search.json'), { provenance: 'local_cache' }) });
    const { candidates, meta } = await createNpmAdapter({ http }).search(query);
    expect(meta.status).toBe('cached');
    expect(candidates[0]!.provenance).toBe('local_cache');
  });

  it('drops unparsable items and reports partial', async () => {
    const body = fixture('search.json');
    body.objects.push({ package: { description: 'no name' } }, 'garbage');
    const http = new FakeHttpClient({ [SEARCH_URL]: ok(body) });
    const { candidates, meta } = await createNpmAdapter({ http }).search(query);
    expect(candidates).toHaveLength(4);
    expect(meta.status).toBe('partial');
    expect(meta.message).toContain('2 npm search result(s)');
  });

  it('surfaces rate limiting with a manual alternative', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: failure('rate_limited') });
    const { candidates, meta } = await createNpmAdapter({ http }).search(query);
    expect(candidates).toEqual([]);
    expect(meta.status).toBe('rate_limited');
    expect(meta.message).toContain('npm search');
    expect(meta.message).toContain('rw_record_evidence');
  });

  it('reports offline and generic errors', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: failure('offline') });
    expect((await createNpmAdapter({ http }).search(query)).meta.status).toBe('offline');
    http.set(SEARCH_URL, failure('network'));
    expect((await createNpmAdapter({ http }).search(query)).meta.status).toBe('error');
    http.set(SEARCH_URL, ok({ unexpected: true }));
    expect((await createNpmAdapter({ http }).search(query)).meta.status).toBe('error');
  });

  it('is skipped for other ecosystems and empty queries without calling the network', async () => {
    const http = new FakeHttpClient();
    const adapter = createNpmAdapter({ http });
    const mismatch = await adapter.search({ ...query, ecosystem: 'pypi' });
    expect(mismatch.meta.status).toBe('skipped');
    const empty = await adapter.search({ query: '   ', limit: 5 });
    expect(empty.meta.status).toBe('skipped');
    expect(http.calls).toHaveLength(0);
  });
});

describe('npm enricher', () => {
  it('supports npm refs only', () => {
    const e = createNpmEnricher({ http: new FakeHttpClient() });
    expect(e.supports('npm:@babel/core')).toBe(true);
    expect(e.supports('pypi:flask')).toBe(false);
    expect(e.supports('github:a/b')).toBe(false);
  });

  it('encodes scoped names and maps license, dependencies, downloads and repository', async () => {
    const http = new FakeHttpClient({
      [LATEST_SCOPED_URL]: ok(fixture('latest-scoped.json')),
      [DOWNLOADS_SCOPED_URL]: ok(fixture('downloads.json')),
    });
    const out = await createNpmEnricher({ http }).enrich('npm:@babel/core', ENRICH);
    expect([...http.urls].sort()).toEqual([DOWNLOADS_SCOPED_URL, LATEST_SCOPED_URL].sort());
    expect(out).toEqual({
      metrics: { direct_dependencies: 16, deprecated: false, downloads_weekly: 189388655 },
      license_spdx: 'MIT',
      license_source: 'npm',
      repository_url: 'https://github.com/babel/babel',
      provenance: 'live',
      missing: [],
      descriptor: 'Babel compiler core.',
    });
  });

  it('flags deprecated packages', async () => {
    const http = new FakeHttpClient({
      'https://registry.npmjs.org/request/latest': ok(fixture('latest-deprecated.json')),
      'https://api.npmjs.org/downloads/point/last-week/request': ok({ downloads: 1000 }),
    });
    const out = await createNpmEnricher({ http }).enrich('npm:request', ENRICH);
    expect(out.metrics.deprecated).toBe(true);
    expect(out.metrics.direct_dependencies).toBe(20);
    expect(out.license_spdx).toBe('Apache-2.0');
    expect(out.repository_url).toBe('https://github.com/request/request');
  });

  it('counts zero dependencies as 0, not missing', async () => {
    const http = new FakeHttpClient({
      'https://registry.npmjs.org/commander/latest': ok(fixture('latest-nodeps.json')),
      'https://api.npmjs.org/downloads/point/last-week/commander': ok({ downloads: 5 }),
    });
    const out = await createNpmEnricher({ http }).enrich('npm:commander', ENRICH);
    expect(out.metrics.direct_dependencies).toBe(0);
    expect(out.missing).toEqual([]);
  });

  it.each([
    [{ license: { type: 'ISC', url: 'x' } }, 'ISC'],
    [{ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }, 'MIT AND Apache-2.0'],
    [{ license: 'SEE LICENSE IN LICENSE.md' }, null],
    [{ license: 'UNLICENSED' }, null],
    [{}, null],
  ])('derives the license from %j', async (doc, expected) => {
    const http = new FakeHttpClient({
      'https://registry.npmjs.org/x/latest': ok({ name: 'x', ...doc }),
      'https://api.npmjs.org/downloads/point/last-week/x': ok({ downloads: 1 }),
    });
    const out = await createNpmEnricher({ http }).enrich('npm:x', ENRICH);
    expect(out.license_spdx).toBe(expected);
    expect(out.missing.includes('license')).toBe(expected === null);
  });

  it('degrades to missing metrics instead of throwing', async () => {
    const http = new FakeHttpClient({
      'https://registry.npmjs.org/gone/latest': notFound(),
      'https://api.npmjs.org/downloads/point/last-week/gone': failure('rate_limited'),
    });
    const out = await createNpmEnricher({ http }).enrich('npm:gone', ENRICH);
    expect(out.metrics).toEqual({});
    expect(out.license_spdx).toBeNull();
    expect(out.missing).toEqual(['direct_dependencies', 'deprecated', 'license', 'downloads_weekly']);
  });

  it('keeps registry data when only the downloads call fails', async () => {
    const http = new FakeHttpClient({
      [LATEST_SCOPED_URL]: ok(fixture('latest-scoped.json'), { provenance: 'local_cache' }),
      [DOWNLOADS_SCOPED_URL]: failure('timeout'),
    });
    const out = await createNpmEnricher({ http }).enrich('npm:@babel/core', ENRICH);
    expect(out.metrics.direct_dependencies).toBe(16);
    expect(out.metrics.downloads_weekly).toBeUndefined();
    expect(out.missing).toEqual(['downloads_weekly']);
    expect(out.provenance).toBe('local_cache');
  });
});

describe('npm enricher: path-manipulating refs', () => {
  it.each(['npm:..', 'npm:.', 'npm:@scope/..', 'npm:@../x', 'npm:%2e%2e', 'npm:a%2fb', 'npm:a b', 'npm:a?x', 'npm:a#x'])(
    'rejects %s without any request',
    async (ref) => {
      const http = new FakeHttpClient();
      const e = createNpmEnricher({ http });
      expect(e.supports(ref)).toBe(false);
      await expect(e.enrich(ref, ENRICH)).rejects.toThrow(TypeError);
      expect(http.calls).toHaveLength(0);
    },
  );
});
