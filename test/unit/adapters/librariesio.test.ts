import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CandidateSchema } from '../../../src/types.js';
import { createLibrariesIoAdapter } from '../../../src/adapters/librariesio.js';
import { FakeHttpClient, failure, ok } from '../../helpers/fake-http.js';

const KEY = 'lio_TESTKEY_0123456789';
const SEARCH_URL = `https://libraries.io/api/search?q=markdown+pdf&platforms=PyPI&per_page=8&api_key=${KEY}`;

function fixture(): { response: Record<string, any>[] } {
  return JSON.parse(
    readFileSync(new URL('../../fixtures/librariesio/search.json', import.meta.url), 'utf8'),
  ) as { response: Record<string, any>[] };
}

const query = { query: 'markdown pdf', limit: 8 };

describe('libraries.io adapter', () => {
  it('is skipped without an API key and makes no request', async () => {
    const http = new FakeHttpClient();
    for (const adapter of [
      createLibrariesIoAdapter({ http }),
      createLibrariesIoAdapter({ http, apiKey: '   ' }),
    ]) {
      const { candidates, meta } = await adapter.search(query);
      expect(candidates).toEqual([]);
      expect(meta).toMatchObject({ source: 'pypi', status: 'skipped', count: 0 });
      expect(meta.message).toContain('LIBRARIES_IO_API_KEY');
    }
    expect(http.calls).toHaveLength(0);
  });

  it('reports itself as the pypi source', () => {
    expect(createLibrariesIoAdapter({ http: new FakeHttpClient() }).source).toBe('pypi');
  });

  it('normalizes results to pypi candidates', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: ok(fixture().response) });
    const { candidates, meta } = await createLibrariesIoAdapter({ http, apiKey: KEY }).search(query);

    expect(http.urls).toEqual([SEARCH_URL]);
    expect(http.calls[0]!.opts).toMatchObject({ source: 'librariesio', ttlClass: 'search', shareable: false });
    expect(meta).toEqual({ source: 'pypi', status: 'ok', count: 3, query: 'markdown pdf' });
    for (const c of candidates) expect(CandidateSchema.safeParse(c).success).toBe(true);

    expect(candidates[0]).toEqual({
      ref: 'pypi:markdown',
      source: 'pypi',
      name: 'Markdown',
      url: 'https://pypi.org/project/Markdown/',
      description: "Python implementation of John Gruber's Markdown.",
      ecosystem: 'pypi',
      stars: 3900,
      forks: 880,
      license_spdx: 'BSD-3-Clause',
      last_activity: '2026-09-25T13:46:22.000Z',
      repository_url: 'https://github.com/python-markdown/markdown',
      matched_via: { query: 'markdown pdf', rank: 1 },
      provenance: 'live',
    });
    // deprecated status, empty license list -> null, scp-like repository url
    expect(candidates[1]).toMatchObject({
      ref: 'pypi:markdown-old-tool',
      deprecated: true,
      license_spdx: null,
      repository_url: 'https://github.com/someone/markdown_old_tool',
    });
    // several licenses are joined conservatively; missing optional fields stay absent
    expect(candidates[2]).toMatchObject({
      ref: 'pypi:md2pdf',
      description: null,
      license_spdx: 'MIT AND Apache-2.0',
      url: 'https://pypi.org/project/md2pdf/',
    });
    expect(candidates[2]!.last_activity).toBeUndefined();
    expect(candidates[2]!.repository_url).toBeUndefined();
  });

  it('never leaks the API key into candidates or meta', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: ok(fixture().response) });
    const adapter = createLibrariesIoAdapter({ http, apiKey: KEY });
    const okResult = await adapter.search(query);
    expect(JSON.stringify(okResult)).not.toContain(KEY);

    for (const response of [failure('http', { status: 500 }), failure('rate_limited'), { status: 401, data: null }, { status: 403, data: null }]) {
      http.set(SEARCH_URL, response);
      const res = await adapter.search(query);
      expect(JSON.stringify(res)).not.toContain(KEY);
      expect(JSON.stringify(res)).not.toContain('api_key');
    }
  });

  it('maps 401/403 to unauthenticated', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: { status: 401, data: null, error: 'http' } });
    const { meta } = await createLibrariesIoAdapter({ http, apiKey: KEY }).search(query);
    expect(meta.status).toBe('unauthenticated');
    expect(meta.message).toContain('LIBRARIES_IO_API_KEY');
  });

  it('maps rate limiting and outages with a manual alternative', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: failure('rate_limited') });
    const adapter = createLibrariesIoAdapter({ http, apiKey: KEY });
    const limited = await adapter.search(query);
    expect(limited.meta.status).toBe('rate_limited');
    expect(limited.meta.message).toContain('rw_record_evidence');

    http.set(SEARCH_URL, failure('offline'));
    expect((await adapter.search(query)).meta.status).toBe('offline');
    http.set(SEARCH_URL, ok({ message: 'not an array' }));
    expect((await adapter.search(query)).meta.status).toBe('error');
  });

  it('drops unparsable entries (partial) and ignores other platforms', async () => {
    const rows = fixture().response;
    rows.push({ description: 'no name' }, { name: 'left-pad', platform: 'NPM' });
    const http = new FakeHttpClient({ [SEARCH_URL]: ok(rows) });
    const { candidates, meta } = await createLibrariesIoAdapter({ http, apiKey: KEY }).search(query);
    expect(candidates.map((c) => c.ref)).toEqual(['pypi:markdown', 'pypi:markdown-old-tool', 'pypi:md2pdf']);
    expect(meta.status).toBe('partial');
    expect(meta.message).toContain('1 libraries.io result(s)');
  });

  it('caps per_page at 100 and skips non-pypi ecosystems', async () => {
    const http = new FakeHttpClient().set(/libraries\.io\/api\/search/, ok([]));
    const adapter = createLibrariesIoAdapter({ http, apiKey: KEY });
    await adapter.search({ query: 'x y', limit: 500 });
    expect(http.urls[0]).toContain('per_page=100');

    const skipped = await adapter.search({ query: 'x', limit: 5, ecosystem: 'npm' });
    expect(skipped.meta.status).toBe('skipped');
    expect(http.calls).toHaveLength(1);
  });
});
