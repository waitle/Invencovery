import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CandidateSchema } from '../../../src/types.js';
import type { Candidate, SourceAdapter } from '../../../src/types.js';
import {
  PYPI_NO_SEARCH_MESSAGE,
  createPypiAdapter,
  createPypiEnricher,
  generateNameHints,
  inferPypiLicense,
} from '../../../src/adapters/pypi.js';
import { FakeHttpClient, failure, notFound, ok } from '../../helpers/fake-http.js';

function fixture<T = Record<string, any>>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../fixtures/pypi/${name}`, import.meta.url), 'utf8')) as T;
}

const url = (name: string) => `https://pypi.org/pypi/${name}/json`;
const ENRICH = { deep: false };

function probeHttp(): FakeHttpClient {
  return new FakeHttpClient({
    [url('markdown')]: ok(fixture('markdown.json')),
    [url('python-markdown-math')]: ok(fixture('python-markdown-math.json')),
    [url('no-such-package')]: notFound(),
  });
}

describe('generateNameHints', () => {
  it('puts adjacent 2-grams before single tokens', () => {
    expect(generateNameHints('markdown pdf')).toEqual(['markdown-pdf', 'markdown', 'pdf']);
    expect(generateNameHints('Fast HTTP client, async')).toEqual([
      'fast-http',
      'http-client',
      'client-async',
      'fast',
      'http',
      'client',
    ]);
  });

  it('handles empty input and respects max', () => {
    expect(generateNameHints('   !!! ')).toEqual([]);
    expect(generateNameHints('a bb cc dd', 2)).toEqual(['bb-cc', 'cc-dd']);
  });
});

describe('inferPypiLicense', () => {
  it('prefers license_expression over everything else', () => {
    expect(
      inferPypiLicense({
        license_expression: 'Apache-2.0 OR MIT',
        license: 'GPL',
        classifiers: ['License :: OSI Approved :: MIT License'],
      }),
    ).toBe('Apache-2.0 OR MIT');
  });

  it.each([
    ['MIT', 'MIT'],
    ['MIT License', 'MIT'],
    ['The MIT License (MIT)', 'MIT'],
    ['Apache 2.0', 'Apache-2.0'],
    ['Apache License, Version 2.0', 'Apache-2.0'],
    ['Apache Software License', 'Apache-2.0'],
    ['BSD', 'BSD-3-Clause'],
    ['3-Clause BSD License', 'BSD-3-Clause'],
    ['BSD 2-Clause', 'BSD-2-Clause'],
    ['GPLv3', 'GPL-3.0-only'],
    ['Apache-2.0', 'Apache-2.0'],
    ['GPL-3.0-or-later', 'GPL-3.0-or-later'],
    ['MIT OR Apache-2.0', 'MIT OR Apache-2.0'],
  ])('maps the license field %j to %s', (license, expected) => {
    expect(inferPypiLicense({ license })).toBe(expected);
  });

  it('uses the first line of pasted license text', () => {
    expect(inferPypiLicense({ license: `MIT License\n\nCopyright (c) 2020 X\n${'text '.repeat(50)}` })).toBe('MIT');
  });

  it('falls back to classifiers and joins distinct ones with AND', () => {
    expect(
      inferPypiLicense({
        license: 'UNKNOWN',
        classifiers: [
          'Programming Language :: Python :: 3',
          'License :: OSI Approved :: MIT License',
          'License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)',
        ],
      }),
    ).toBe('MIT AND GPL-3.0-or-later');
  });

  it.each([
    ['License :: OSI Approved :: MIT License', 'MIT'],
    ['License :: OSI Approved :: Apache Software License', 'Apache-2.0'],
    ['License :: OSI Approved :: BSD License', 'BSD-3-Clause'],
    ['License :: OSI Approved :: GNU General Public License v3 (GPLv3)', 'GPL-3.0-only'],
    ['License :: OSI Approved :: GNU General Public License v2 (GPLv2)', 'GPL-2.0-only'],
    ['License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)', 'LGPL-3.0-only'],
    ['License :: OSI Approved :: GNU Affero General Public License v3', 'AGPL-3.0-only'],
    ['License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)', 'MPL-2.0'],
    ['License :: OSI Approved :: ISC License (ISCL)', 'ISC'],
    ['License :: OSI Approved :: Python Software Foundation License', 'PSF-2.0'],
    ['License :: OSI Approved :: The Unlicense (Unlicense)', 'Unlicense'],
  ])('maps classifier %s to %s', (classifier, expected) => {
    expect(inferPypiLicense({ classifiers: [classifier] })).toBe(expected);
  });

  it('returns null when nothing identifies a license', () => {
    expect(inferPypiLicense({})).toBeNull();
    expect(inferPypiLicense({ license: 'Proprietary, see the LICENSE file' })).toBeNull();
    expect(inferPypiLicense({ license: '   ', classifiers: ['License :: Other/Proprietary License'] })).toBeNull();
  });
});

describe('pypi search adapter (name probes)', () => {
  it('probes each hint, treats 404 as normal and normalizes the rest', async () => {
    const http = probeHttp();
    const { candidates, meta } = await createPypiAdapter({ http }).search({
      query: 'markdown math',
      limit: 8,
      nameHints: ['Markdown', 'python_markdown.math', 'no-such-package'],
    });

    expect(http.urls).toEqual([url('markdown'), url('python-markdown-math'), url('no-such-package')]);
    expect(http.calls[0]!.opts).toMatchObject({ source: 'pypi', ttlClass: 'package' });
    expect(meta.status).toBe('ok');
    expect(meta.count).toBe(2);
    expect(meta.message).toContain(PYPI_NO_SEARCH_MESSAGE);
    expect(candidates).toHaveLength(2);
    for (const c of candidates) expect(CandidateSchema.safeParse(c).success).toBe(true);

    expect(candidates[0]).toEqual({
      ref: 'pypi:markdown',
      source: 'pypi',
      name: 'Markdown',
      url: 'https://pypi.org/project/Markdown/',
      description: "Python implementation of John Gruber's Markdown.",
      ecosystem: 'pypi',
      license_spdx: 'BSD-3-Clause',
      last_activity: '2026-09-25T13:46:22.163Z',
      repository_url: 'https://github.com/python-markdown/markdown',
      matched_via: { query: 'markdown math', rank: 1 },
      provenance: 'live',
    });
    expect(candidates[1]).toMatchObject({
      ref: 'pypi:python-markdown-math',
      repository_url: 'https://github.com/mitya57/python-markdown-math',
      matched_via: { rank: 2 },
    });
  });

  it('derives probes from the query when no hints are given and skips invalid names', async () => {
    const http = probeHttp();
    http.set(url('markdown-math'), notFound()).set(url('math'), notFound());
    const { meta } = await createPypiAdapter({ http }).search({ query: 'markdown math', limit: 5 });
    expect(http.urls).toEqual([url('markdown-math'), url('markdown'), url('math')]);
    expect(meta.message).toContain(PYPI_NO_SEARCH_MESSAGE);

    const guarded = new FakeHttpClient({ [url('ok-name')]: notFound() });
    await createPypiAdapter({ http: guarded }).search({
      query: 'x',
      limit: 5,
      nameHints: ['../etc/passwd', 'has space', 'ok_name', '', '-bad-'],
    });
    expect(guarded.urls).toEqual([url('ok-name')]);
  });

  it('returns status ok with zero candidates when every probe is a 404', async () => {
    const http = new FakeHttpClient({ [url('nope-a')]: notFound(), [url('nope-b')]: notFound() });
    const { candidates, meta } = await createPypiAdapter({ http }).search({
      query: 'nope',
      limit: 5,
      nameHints: ['nope-a', 'nope-b'],
    });
    expect(candidates).toEqual([]);
    expect(meta).toMatchObject({ status: 'ok', count: 0 });
    expect(meta.message).toContain(PYPI_NO_SEARCH_MESSAGE);
  });

  it('reports rate limiting when every probe fails that way', async () => {
    const http = new FakeHttpClient({ [url('a-b')]: failure('rate_limited'), [url('a')]: failure('rate_limited') });
    const { candidates, meta } = await createPypiAdapter({ http }).search({
      query: 'a b',
      limit: 5,
      nameHints: ['a-b', 'a'],
    });
    expect(candidates).toEqual([]);
    expect(meta.status).toBe('rate_limited');
    expect(meta.message).toContain(PYPI_NO_SEARCH_MESSAGE);
    expect(meta.message).toContain('rw_record_evidence');
  });

  it('reports partial when only some probes fail', async () => {
    const http = probeHttp().set(url('flaky'), failure('network'));
    const { candidates, meta } = await createPypiAdapter({ http }).search({
      query: 'markdown',
      limit: 5,
      nameHints: ['markdown', 'flaky'],
    });
    expect(candidates).toHaveLength(1);
    expect(meta.status).toBe('partial');
    expect(meta.message).toContain('1 of 2 name probes failed');
  });

  it('reports cached when everything came from a cache, and applies limit', async () => {
    const http = new FakeHttpClient({
      [url('markdown')]: ok(fixture('markdown.json'), { provenance: 'local_cache' }),
      [url('python-markdown-math')]: ok(fixture('python-markdown-math.json'), { provenance: 'local_cache' }),
    });
    const { candidates, meta } = await createPypiAdapter({ http }).search({
      query: 'markdown',
      limit: 1,
      nameHints: ['markdown', 'python-markdown-math'],
    });
    expect(meta.status).toBe('cached');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.provenance).toBe('local_cache');
  });

  it('is skipped for other ecosystems or when no names can be derived', async () => {
    const http = new FakeHttpClient();
    const adapter = createPypiAdapter({ http });
    expect((await adapter.search({ query: 'markdown', limit: 3, ecosystem: 'npm' })).meta.status).toBe('skipped');
    const none = await adapter.search({ query: '!!!', limit: 3 });
    expect(none.meta.status).toBe('skipped');
    expect(none.meta.message).toContain(PYPI_NO_SEARCH_MESSAGE);
    expect(http.calls).toHaveLength(0);
  });

  it('flags inactive projects as deprecated', async () => {
    const http = new FakeHttpClient({ [url('multi-license')]: ok(fixture('license-classifier-only.json')) });
    const { candidates } = await createPypiAdapter({ http }).search({
      query: 'x',
      limit: 3,
      nameHints: ['multi-license'],
    });
    expect(candidates[0]).toMatchObject({
      ref: 'pypi:multi-license',
      deprecated: true,
      license_spdx: 'MIT AND Apache-2.0',
    });
  });

  describe('with a libraries.io adapter', () => {
    const lioCandidate: Candidate = {
      ref: 'pypi:markdown',
      source: 'pypi',
      name: 'Markdown',
      url: 'https://pypi.org/project/Markdown/',
      description: 'from libraries.io',
      ecosystem: 'pypi',
      stars: 3900,
      forks: 880,
      license_spdx: 'BSD-3-Clause',
      matched_via: { query: 'markdown', rank: 1 },
      provenance: 'live',
    };
    const extra: Candidate = {
      ...lioCandidate,
      ref: 'pypi:markdown2',
      name: 'markdown2',
      url: 'https://pypi.org/project/markdown2/',
      stars: 100,
    };
    const lio = (candidates: Candidate[], status: 'ok' | 'rate_limited' | 'skipped' = 'ok'): SourceAdapter => ({
      source: 'pypi',
      search: async () => ({
        candidates,
        meta: { source: 'pypi', status, count: candidates.length, message: status === 'ok' ? undefined : 'lio note' },
      }),
    });

    it('merges its results after the probes and fills fields the probe lacks', async () => {
      const http = probeHttp();
      const { candidates, meta } = await createPypiAdapter({ http, librariesIo: lio([lioCandidate, extra]) }).search({
        query: 'markdown',
        limit: 8,
        nameHints: ['markdown'],
      });
      expect(candidates.map((c) => c.ref)).toEqual(['pypi:markdown', 'pypi:markdown2']);
      expect(candidates[0]).toMatchObject({
        stars: 3900,
        forks: 880,
        description: "Python implementation of John Gruber's Markdown.", // probe wins
        repository_url: 'https://github.com/python-markdown/markdown',
      });
      expect(candidates.map((c) => c.matched_via.rank)).toEqual([1, 2]);
      expect(meta.status).toBe('ok');
      expect(meta.count).toBe(2);
    });

    it('turns a libraries.io failure into partial without losing probe results', async () => {
      const http = probeHttp();
      const { candidates, meta } = await createPypiAdapter({ http, librariesIo: lio([], 'rate_limited') }).search({
        query: 'markdown',
        limit: 8,
        nameHints: ['markdown'],
      });
      expect(candidates).toHaveLength(1);
      expect(meta.status).toBe('partial');
      expect(meta.message).toContain('lio note');
    });

    it('ignores a skipped libraries.io adapter', async () => {
      const http = probeHttp();
      const { meta } = await createPypiAdapter({ http, librariesIo: lio([], 'skipped') }).search({
        query: 'markdown',
        limit: 8,
        nameHints: ['markdown'],
      });
      expect(meta.status).toBe('ok');
    });
  });
});

describe('pypi enricher', () => {
  it('supports pypi refs only', () => {
    const e = createPypiEnricher({ http: new FakeHttpClient() });
    expect(e.supports('pypi:markdown')).toBe(true);
    expect(e.supports('npm:markdown')).toBe(false);
  });

  it('maps license, release time, runtime requirements and repository', async () => {
    const http = probeHttp();
    const out = await createPypiEnricher({ http }).enrich('pypi:markdown', ENRICH);
    expect(http.urls).toEqual([url('markdown')]);
    expect(out).toEqual({
      metrics: { last_release_at: '2026-09-25T13:46:22.163Z', direct_dependencies: 0 },
      license_spdx: 'BSD-3-Clause',
      license_source: 'pypi',
      repository_url: 'https://github.com/python-markdown/markdown',
      provenance: 'live',
      missing: ['downloads_weekly'],
      descriptor: "Python implementation of John Gruber's Markdown. markdown, markdown-parser, python-markdown, markdown-to-html",
    });
  });

  it('counts requirements that carry no extra marker', async () => {
    const http = new FakeHttpClient({ [url('mystery-pkg')]: ok(fixture('license-unknown.json')) });
    const out = await createPypiEnricher({ http }).enrich('pypi:mystery-pkg', ENRICH);
    expect(out.metrics.direct_dependencies).toBe(2); // requests, tomli; `rich; extra == "cli"` excluded
    expect(out.license_spdx).toBeNull();
    expect(out.missing).toEqual(['license', 'downloads_weekly']);
  });

  it('infers licenses from pasted text and classifiers', async () => {
    const http = new FakeHttpClient({
      [url('legacy-pkg')]: ok(fixture('license-free-text.json')),
      [url('multi-license')]: ok(fixture('license-classifier-only.json')),
    });
    const e = createPypiEnricher({ http });
    expect((await e.enrich('pypi:legacy-pkg', ENRICH)).license_spdx).toBe('MIT');
    const multi = await e.enrich('pypi:multi-license', ENRICH);
    expect(multi.license_spdx).toBe('MIT AND Apache-2.0');
    expect(multi.metrics.deprecated).toBe(true);
  });

  it('lists direct_dependencies as missing when requires_dist is absent', async () => {
    const body = fixture('python-markdown-math.json');
    body.info.requires_dist = null;
    const http = new FakeHttpClient({ [url('python-markdown-math')]: ok(body) });
    const out = await createPypiEnricher({ http }).enrich('pypi:python-markdown-math', ENRICH);
    expect(out.metrics.direct_dependencies).toBeUndefined();
    expect(out.missing).toContain('direct_dependencies');
  });

  it('does not throw when the package is missing or the registry is unreachable', async () => {
    const http = new FakeHttpClient({ [url('gone')]: notFound(), [url('down')]: failure('offline') });
    const e = createPypiEnricher({ http });
    for (const name of ['gone', 'down']) {
      const out = await e.enrich(`pypi:${name}`, ENRICH);
      expect(out.metrics).toEqual({});
      expect(out.license_spdx).toBeNull();
      expect(out.missing).toEqual(['license', 'last_release_at', 'direct_dependencies', 'downloads_weekly']);
    }
  });
});
