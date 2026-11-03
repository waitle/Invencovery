import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_SHARE_BODY_BYTES, SHAREABLE_SOURCES, sanitize } from '../../../src/cache/sanitize.js';
import type { CacheEntry } from '../../../src/types.js';

const KEY = 'a'.repeat(64);
const T0 = 1_800_000_000_000;

function fixture(name: string): { body: unknown } {
  const url = new URL(`../../fixtures/github/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as { body: unknown };
}

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    key: KEY,
    url_redacted: 'https://api.github.com/search/repositories?q=secret-query&api_key=REDACTED',
    source: 'npm',
    status: 200,
    body: JSON.stringify({ name: 'left-pad' }),
    fetched_at: T0,
    expires_at: T0 + 3_600_000,
    provenance: 'live',
    ...overrides,
  };
}

function repoEntry(body: unknown, source = 'github_repo', status = 200): CacheEntry {
  return entry({ source, status, body: JSON.stringify(body) });
}

describe('sanitize: common rules', () => {
  it('blanks url_redacted and keeps etag and last_modified only', () => {
    const out = sanitize(entry({ etag: 'W/"abc"', last_modified: 'Tue, 01 Oct 2026 00:00:00 GMT' }));
    expect(out).toBeDefined();
    expect(out?.url_redacted).toBe('');
    expect(out?.etag).toBe('W/"abc"');
    expect(out?.last_modified).toBe('Tue, 01 Oct 2026 00:00:00 GMT');
    expect(Object.keys(out ?? {}).sort()).toEqual(
      ['body', 'etag', 'expires_at', 'fetched_at', 'key', 'last_modified', 'provenance', 'source', 'status', 'url_redacted'].sort(),
    );
  });

  it('omits empty or oversized validators', () => {
    const out = sanitize(entry({ etag: '', last_modified: 'x'.repeat(600) }));
    expect(out).toBeDefined();
    expect(out).not.toHaveProperty('etag');
    expect(out).not.toHaveProperty('last_modified');
  });

  it('is idempotent', () => {
    const once = sanitize(entry({ etag: '"e"' }));
    expect(once).toBeDefined();
    expect(sanitize(once as CacheEntry)).toEqual(once);
  });

  it('does not modify its input', () => {
    const input = entry();
    const snapshot = JSON.stringify(input);
    sanitize(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it.each(['pypi', 'npm', 'mcp_registry', 'depsdev', 'github_repo', 'github_code'])('%s is a shareable source', (s) => {
    expect(SHAREABLE_SOURCES).toContain(s);
  });

  it('never uploads libraries.io or unknown sources', () => {
    expect(sanitize(entry({ source: 'librariesio' }))).toBeUndefined();
    expect(sanitize(entry({ source: 'something_else' }))).toBeUndefined();
  });

  it('accepts only status 200 and 404', () => {
    expect(sanitize(entry({ status: 200 }))).toBeDefined();
    expect(sanitize(entry({ status: 404, body: 'null' }))).toBeDefined();
    for (const status of [201, 204, 301, 403, 429, 500]) {
      expect(sanitize(entry({ status }))).toBeUndefined();
    }
  });

  it('forces a 404 body to null', () => {
    expect(sanitize(entry({ status: 404, body: '{"message":"Not Found for secret-query"}' }))?.body).toBe('null');
  });

  it('rejects a 200 body that is not valid JSON', () => {
    expect(sanitize(entry({ body: '<html>oops</html>' }))).toBeUndefined();
    expect(sanitize(entry({ body: '' }))).toBeUndefined();
  });

  it('rejects bodies over the 1 MB limit', () => {
    const big = JSON.stringify({ pad: 'x'.repeat(MAX_SHARE_BODY_BYTES) });
    expect(sanitize(entry({ body: big }))).toBeUndefined();
  });

  it.each(['ghp_TESTTOKEN123456', 'github_pat_11ABCDEFG_abcdefghijklmnop', 'gho_abcdefghijklmnop12'])(
    'never uploads a body containing the token %s',
    (token) => {
      expect(sanitize(entry({ body: JSON.stringify({ readme: `export GITHUB_TOKEN=${token}` }) }))).toBeUndefined();
    },
  );

  it('passes npm, pypi, mcp_registry and depsdev bodies through unchanged', () => {
    for (const source of ['npm', 'pypi', 'mcp_registry', 'depsdev']) {
      const body = JSON.stringify({ items: [{ private: true }], total_count: 5 });
      expect(sanitize(entry({ source, body }))?.body).toBe(body);
    }
  });
});

describe('sanitize: github_repo search', () => {
  it('removes private items and corrects total_count (fixture)', () => {
    const { body } = fixture('search-repositories.json');
    const input = body as { total_count: number; items: Array<{ full_name: string; private: boolean }> };
    const privateCount = input.items.filter((i) => i.private).length;
    expect(privateCount).toBeGreaterThan(0);

    const out = sanitize(repoEntry(body));
    expect(out).toBeDefined();
    const parsed = JSON.parse(out?.body ?? '{}') as { total_count: number; items: Array<{ full_name: string }> };
    expect(parsed.items).toHaveLength(input.items.length - privateCount);
    expect(parsed.total_count).toBe(input.total_count - privateCount);
    expect(out?.body).not.toContain('acme-corp/internal-docs-tool');
  });

  it('removes items whose visibility is internal or private even if private is false', () => {
    const body = {
      total_count: 3,
      incomplete_results: false,
      items: [
        { full_name: 'a/public', private: false, visibility: 'public' },
        { full_name: 'a/internal', private: false, visibility: 'internal' },
        { full_name: 'a/no-visibility-field', private: false },
      ],
    };
    const parsed = JSON.parse(sanitize(repoEntry(body))?.body ?? '{}') as { total_count: number; items: Array<{ full_name: string }> };
    expect(parsed.items.map((i) => i.full_name)).toEqual(['a/public', 'a/no-visibility-field']);
    expect(parsed.total_count).toBe(2);
  });

  it('removes items that do not state their visibility at all', () => {
    const body = { total_count: 2, items: [{ full_name: 'a/b' }, { full_name: 'c/d', private: false }] };
    const parsed = JSON.parse(sanitize(repoEntry(body))?.body ?? '{}') as { items: Array<{ full_name: string }> };
    expect(parsed.items.map((i) => i.full_name)).toEqual(['c/d']);
  });

  it('never lets total_count go negative and keeps other fields', () => {
    const body = { total_count: 1, incomplete_results: true, items: [{ private: true }, { private: true }] };
    const parsed = JSON.parse(sanitize(repoEntry(body))?.body ?? '{}') as Record<string, unknown>;
    expect(parsed.total_count).toBe(0);
    expect(parsed.incomplete_results).toBe(true);
    expect(parsed.items).toEqual([]);
  });

  it('uploads an empty result as is', () => {
    const out = sanitize(repoEntry({ total_count: 0, incomplete_results: false, items: [] }));
    expect(JSON.parse(out?.body ?? '{}')).toEqual({ total_count: 0, incomplete_results: false, items: [] });
  });
});

describe('sanitize: github_repo details and other endpoints', () => {
  it('uploads a public repo detail (fixture)', () => {
    const { body } = fixture('repo-detail.json');
    const out = sanitize(repoEntry(body));
    expect(out).toBeDefined();
    expect(JSON.parse(out?.body ?? '{}')).toEqual(body);
  });

  it('does not upload a private repo detail', () => {
    const { body } = fixture('repo-detail.json');
    expect(sanitize(repoEntry({ ...(body as object), private: true }))).toBeUndefined();
  });

  it('does not upload a repo detail without a visibility statement', () => {
    const { private: _omit, ...rest } = fixture('repo-detail.json').body as Record<string, unknown>;
    expect(sanitize(repoEntry(rest))).toBeUndefined();
  });

  it('does not upload an internal repo detail', () => {
    const { body } = fixture('repo-detail.json');
    expect(sanitize(repoEntry({ ...(body as object), visibility: 'internal' }))).toBeUndefined();
  });

  it('does not upload releases or contributors (visibility cannot be proven)', () => {
    expect(sanitize(repoEntry(fixture('release-latest.json').body))).toBeUndefined();
    expect(sanitize(repoEntry([{ login: 'a', contributions: 3 }]))).toBeUndefined();
  });

  it('uploads a repo 404 as a negative entry', () => {
    const out = sanitize(entry({ source: 'github_repo', status: 404, body: 'null' }));
    expect(out?.status).toBe(404);
    expect(out?.body).toBe('null');
  });
});

describe('sanitize: github_code', () => {
  it('uploads when every hit is in a public repository (fixture)', () => {
    const { body } = fixture('search-code.json');
    const out = sanitize(repoEntry(body, 'github_code'));
    expect(out).toBeDefined();
    expect(JSON.parse(out?.body ?? '{}')).toEqual(body);
  });

  it('does not upload when any hit is in a private repository', () => {
    const { body } = fixture('search-code.json');
    const tainted = structuredClone(body) as { items: Array<{ repository: { private: boolean } }> };
    tainted.items[1]!.repository.private = true;
    expect(sanitize(repoEntry(tainted, 'github_code'))).toBeUndefined();
  });

  it('does not upload when a hit does not state repository.private', () => {
    const body = { total_count: 1, items: [{ path: 'a.ts', repository: { full_name: 'o/r' } }] };
    expect(sanitize(repoEntry(body, 'github_code'))).toBeUndefined();
    expect(sanitize(repoEntry({ total_count: 1, items: [{ path: 'a.ts' }] }, 'github_code'))).toBeUndefined();
  });

  it('does not upload an unrecognised shape', () => {
    expect(sanitize(repoEntry({ message: 'hi' }, 'github_code'))).toBeUndefined();
    expect(sanitize(repoEntry([], 'github_code'))).toBeUndefined();
  });
});
