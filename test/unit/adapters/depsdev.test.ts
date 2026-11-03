import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalRepoUrl,
  createDepsDevEnricher,
  getDependencies,
  getPackage,
  getProject,
  getVersion,
  truncateDescription,
  weakestProvenance,
} from '../../../src/adapters/depsdev.js';
import { FakeHttpClient, failure, notFound, ok } from '../../helpers/fake-http.js';

function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../fixtures/depsdev/${name}`, import.meta.url), 'utf8')) as T;
}

const BASE = 'https://api.deps.dev/v3';
const PROJECT_URL = `${BASE}/projects/github.com%2Fpallets%2Fflask`;
const PACKAGE_URL = `${BASE}/systems/pypi/packages/flask`;
const VERSION_URL = `${PACKAGE_URL}/versions/3.1.3`;
const DEPS_URL = `${VERSION_URL}:dependencies`;

function flaskHttp(): FakeHttpClient {
  return new FakeHttpClient({
    [PROJECT_URL]: ok(fixture('project.json')),
    [PACKAGE_URL]: ok(fixture('package-flask.json')),
    [VERSION_URL]: ok(fixture('version.json')),
    [DEPS_URL]: ok(fixture('dependencies.json')),
  });
}

describe('getProject', () => {
  it('normalizes stars, forks, open issues, license and scorecard', async () => {
    const http = flaskHttp();
    const res = await getProject(http, 'pallets', 'flask');
    expect(http.urls).toEqual([PROJECT_URL]);
    expect(http.calls[0]!.opts).toMatchObject({ source: 'depsdev', ttlClass: 'depsdev' });
    expect(res.status).toBe('ok');
    expect(res.data).toMatchObject({
      stars: 74905,
      forks: 17042,
      open_issues: 4,
      license: 'BSD-3-Clause',
      scorecard: 7.1,
    });
  });

  it('accepts int64 counts delivered as strings and treats non-standard licenses as unknown', async () => {
    const http = new FakeHttpClient({
      [PROJECT_URL]: ok({ starsCount: '120', forksCount: 3, license: 'non-standard' }),
    });
    const res = await getProject(http, 'pallets', 'flask');
    expect(res.data).toEqual({ stars: 120, forks: 3, license: null });
  });

  it('reports not_found for 404 and error for unusable bodies', async () => {
    const http = new FakeHttpClient({ [PROJECT_URL]: notFound() });
    expect((await getProject(http, 'pallets', 'flask')).status).toBe('not_found');

    http.set(PROJECT_URL, ok('not an object'));
    const bad = await getProject(http, 'pallets', 'flask');
    expect(bad.status).toBe('error');
    expect(bad.data).toBeNull();
  });

  it('maps HTTP failures without throwing', async () => {
    const http = new FakeHttpClient({ [PROJECT_URL]: failure('rate_limited') });
    expect((await getProject(http, 'pallets', 'flask')).status).toBe('rate_limited');
    http.set(PROJECT_URL, failure('offline'));
    expect((await getProject(http, 'pallets', 'flask')).status).toBe('offline');
    http.set(PROJECT_URL, failure('timeout'));
    expect((await getProject(http, 'pallets', 'flask')).status).toBe('error');
  });
});

describe('getPackage', () => {
  it('finds the default version and the latest publish time', async () => {
    const res = await getPackage(flaskHttp(), 'pypi', 'flask');
    expect(res.status).toBe('ok');
    expect(res.data).toEqual({
      default_version: '3.1.3',
      latest_published_at: '2026-02-19T05:00:56.000Z',
      default_version_deprecated: false,
      version_count: 5,
    });
  });

  it('falls back to the newest version when none is flagged default', async () => {
    const http = new FakeHttpClient({
      [`${BASE}/systems/npm/packages/left-pad`]: ok({
        versions: [
          { versionKey: { version: '1.0.0' }, publishedAt: '2016-01-01T00:00:00Z' },
          { versionKey: { version: '1.3.0' }, publishedAt: '2018-04-01T00:00:00Z', isDeprecated: true },
        ],
      }),
    });
    const res = await getPackage(http, 'npm', 'left-pad');
    expect(res.data).toMatchObject({ default_version: '1.3.0', default_version_deprecated: true });
  });

  it('percent-encodes scoped npm names', async () => {
    const http = new FakeHttpClient({ [`${BASE}/systems/npm/packages/%40babel%2Fcore`]: ok({ versions: [] }) });
    const res = await getPackage(http, 'npm', '@babel/core');
    expect(http.urls).toEqual([`${BASE}/systems/npm/packages/%40babel%2Fcore`]);
    expect(res.status).toBe('ok');
    expect(res.data).toEqual({ default_version_deprecated: false, version_count: 0 });
  });
});

describe('getVersion', () => {
  it('returns license and the SOURCE_REPO repository', async () => {
    const res = await getVersion(flaskHttp(), 'pypi', 'flask', '3.1.3');
    expect(res.data).toEqual({
      version: '3.1.3',
      published_at: '2026-02-19T05:00:56.000Z',
      deprecated: false,
      license: 'BSD-3-Clause',
      repository_url: 'https://github.com/pallets/flask',
    });
  });

  it('joins several licenses with AND and drops to null on a non-standard entry', async () => {
    const http = new FakeHttpClient({
      [`${BASE}/systems/npm/packages/a/versions/1.0.0`]: ok({ licenses: ['MIT', 'Apache-2.0', 'MIT'] }),
      [`${BASE}/systems/npm/packages/b/versions/1.0.0`]: ok({ licenses: ['MIT', 'non-standard'] }),
      [`${BASE}/systems/npm/packages/c/versions/1.0.0`]: ok({ licenses: [] }),
    });
    expect((await getVersion(http, 'npm', 'a', '1.0.0')).data?.license).toBe('MIT AND Apache-2.0');
    expect((await getVersion(http, 'npm', 'b', '1.0.0')).data?.license).toBeNull();
    expect((await getVersion(http, 'npm', 'c', '1.0.0')).data?.license).toBeNull();
  });
});

describe('getDependencies', () => {
  it('counts DIRECT nodes only (SELF excluded)', async () => {
    const res = await getDependencies(flaskHttp(), 'pypi', 'flask', '3.1.3');
    expect(res.data).toEqual({ direct: 6, indirect: 0 });
  });

  it('does not count INDIRECT nodes as direct', async () => {
    const http = new FakeHttpClient({ [DEPS_URL]: ok(fixture('dependencies-with-indirect.json')) });
    const res = await getDependencies(http, 'pypi', 'flask', '3.1.3');
    expect(res.data).toEqual({ direct: 6, indirect: 2 });
  });
});

describe('createDepsDevEnricher', () => {
  const ENRICH_OPTS = { deep: false };

  it('supports github, npm and pypi refs only', () => {
    const e = createDepsDevEnricher({ http: flaskHttp() });
    expect(e.supports('github:pallets/flask')).toBe(true);
    expect(e.supports('npm:@babel/core')).toBe(true);
    expect(e.supports('pypi:flask')).toBe(true);
    expect(e.supports('mcp:io.github.x/y')).toBe(false);
    expect(e.supports('web:https://example.org')).toBe(false);
    expect(e.supports('nonsense')).toBe(false);
  });

  it('enriches a github ref from the project lookup', async () => {
    const http = flaskHttp();
    const out = await createDepsDevEnricher({ http }).enrich('github:pallets/flask', ENRICH_OPTS);
    expect(http.urls).toEqual([PROJECT_URL]);
    expect(out).toEqual({
      metrics: { stars: 74905, forks: 17042, open_issues: 4, scorecard: 7.1 },
      license_spdx: 'BSD-3-Clause',
      license_source: 'depsdev',
      repository_url: 'https://github.com/pallets/flask',
      provenance: 'live',
      missing: [],
    });
  });

  it('lists what deps.dev could not provide for a project', async () => {
    const http = new FakeHttpClient({ [PROJECT_URL]: ok({ starsCount: 5, license: '' }) });
    const out = await createDepsDevEnricher({ http }).enrich('github:pallets/flask', ENRICH_OPTS);
    expect(out.metrics).toEqual({ stars: 5 });
    expect(out.license_spdx).toBeNull();
    expect(out.missing).toEqual(['forks', 'open_issues', 'scorecard', 'license']);
  });

  it('returns an empty, fully-missing result (no throw) when the project lookup fails', async () => {
    const http = new FakeHttpClient({ [PROJECT_URL]: failure('rate_limited') });
    const out = await createDepsDevEnricher({ http }).enrich('github:pallets/flask', ENRICH_OPTS);
    expect(out.metrics).toEqual({});
    expect(out.license_spdx).toBeNull();
    expect(out.missing).toEqual(['stars', 'forks', 'open_issues', 'scorecard', 'license']);
  });

  it('enriches a pypi ref through package, version and dependencies', async () => {
    const http = flaskHttp();
    const out = await createDepsDevEnricher({ http }).enrich('pypi:flask', ENRICH_OPTS);
    expect(http.urls).toEqual([PACKAGE_URL, VERSION_URL, DEPS_URL]);
    expect(out).toEqual({
      metrics: { last_release_at: '2026-02-19T05:00:56.000Z', direct_dependencies: 6 },
      license_spdx: 'BSD-3-Clause',
      license_source: 'depsdev',
      repository_url: 'https://github.com/pallets/flask',
      provenance: 'live',
      missing: [],
    });
  });

  it('enriches a scoped npm ref', async () => {
    const http = new FakeHttpClient({
      [`${BASE}/systems/npm/packages/%40babel%2Fcore`]: ok({
        versions: [{ versionKey: { version: '7.0.0' }, publishedAt: '2024-01-01T00:00:00Z', isDefault: true }],
      }),
      [`${BASE}/systems/npm/packages/%40babel%2Fcore/versions/7.0.0`]: ok({ licenses: ['MIT'] }),
      [`${BASE}/systems/npm/packages/%40babel%2Fcore/versions/7.0.0:dependencies`]: ok({
        nodes: [{ relation: 'SELF' }, { relation: 'DIRECT' }, { relation: 'INDIRECT' }],
      }),
    });
    const out = await createDepsDevEnricher({ http }).enrich('npm:@babel/core', ENRICH_OPTS);
    expect(out.metrics.direct_dependencies).toBe(1);
    expect(out.license_spdx).toBe('MIT');
  });

  it('keeps going when the dependency lookup fails and reports it', async () => {
    const http = flaskHttp().set(DEPS_URL, failure('http'));
    const out = await createDepsDevEnricher({ http }).enrich('pypi:flask', ENRICH_OPTS);
    expect(out.metrics).toEqual({ last_release_at: '2026-02-19T05:00:56.000Z' });
    expect(out.license_spdx).toBe('BSD-3-Clause');
    expect(out.missing).toEqual(['direct_dependencies']);
  });

  it('returns missing metrics for an unknown package', async () => {
    const http = new FakeHttpClient({ [`${BASE}/systems/pypi/packages/nope`]: notFound() });
    const out = await createDepsDevEnricher({ http }).enrich('pypi:nope', ENRICH_OPTS);
    expect(out.metrics).toEqual({});
    expect(out.license_spdx).toBeNull();
    expect(out.missing).toEqual(['last_release_at', 'direct_dependencies', 'license']);
  });

  it('reports the least trustworthy provenance of the calls it made', async () => {
    const http = flaskHttp().set(VERSION_URL, ok(fixture('version.json'), { provenance: 'stale_cache' }));
    const out = await createDepsDevEnricher({ http }).enrich('pypi:flask', ENRICH_OPTS);
    expect(out.provenance).toBe('stale_cache');
  });

  it('marks a deprecated default version', async () => {
    const http = new FakeHttpClient({
      [`${BASE}/systems/npm/packages/request`]: ok({
        versions: [
          { versionKey: { version: '2.88.2' }, publishedAt: '2020-02-11T00:00:00Z', isDefault: true, isDeprecated: true },
        ],
      }),
      [`${BASE}/systems/npm/packages/request/versions/2.88.2`]: ok({ licenses: ['Apache-2.0'] }),
      [`${BASE}/systems/npm/packages/request/versions/2.88.2:dependencies`]: ok({ nodes: [] }),
    });
    const out = await createDepsDevEnricher({ http }).enrich('npm:request', ENRICH_OPTS);
    expect(out.metrics.deprecated).toBe(true);
    expect(out.metrics.direct_dependencies).toBe(0);
  });
});

describe('canonicalRepoUrl', () => {
  it.each([
    ['https://github.com/Expressjs/Express', 'https://github.com/expressjs/express'],
    ['git+https://github.com/tj/commander.js.git', 'https://github.com/tj/commander.js'],
    ['git+ssh://git@github.com/alanshaw/markdown-pdf.git', 'https://github.com/alanshaw/markdown-pdf'],
    ['git://github.com/foo/bar.git', 'https://github.com/foo/bar'],
    ['ssh://git@github.com/foo/bar', 'https://github.com/foo/bar'],
    ['git@github.com:Foo/Bar.git', 'https://github.com/foo/bar'],
    ['http://www.github.com/foo/bar/', 'https://github.com/foo/bar'],
    ['github:foo/bar', 'https://github.com/foo/bar'],
    ['foo/bar', 'https://github.com/foo/bar'],
    ['https://github.com/foo/bar/tree/main/packages/x', 'https://github.com/foo/bar'],
    ['https://github.com/foo/bar#readme', 'https://github.com/foo/bar'],
    ['https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/x', 'https://github.com/definitelytyped/definitelytyped'],
    ['https://gitlab.com/group/sub/proj.git', 'https://gitlab.com/group/sub/proj'],
    ['https://gitlab.com/group/proj/-/tree/main', 'https://gitlab.com/group/proj'],
    ['gitlab:group/proj', 'https://gitlab.com/group/proj'],
  ])('%s -> %s', (raw, expected) => {
    expect(canonicalRepoUrl(raw)).toBe(expected);
  });

  it.each([
    'https://github.com/orgonly',
    'https://example.org/foo/bar',
    'https://python-markdown.github.io/',
    'not a url',
    '',
    undefined,
    42,
  ])('rejects %s', (raw) => {
    expect(canonicalRepoUrl(raw)).toBeUndefined();
  });
});

describe('shared helpers', () => {
  it('truncates descriptions to 200 characters and collapses whitespace', () => {
    expect(truncateDescription('  hello \n  world ')).toBe('hello world');
    expect(truncateDescription('')).toBeNull();
    expect(truncateDescription(null)).toBeNull();
    const long = truncateDescription('x'.repeat(500));
    expect(long).toHaveLength(200);
    expect(long!.endsWith('…')).toBe(true);
    // never splits a surrogate pair
    const emoji = truncateDescription('a'.repeat(198) + '😀😀😀');
    expect(emoji!.length).toBeLessThanOrEqual(200);
    expect(emoji).not.toMatch(/[\ud800-\udbff]…$/);
  });

  it('strips control, zero-width and bidi characters from descriptions (prompt-injection hygiene)', () => {
    const hidden = '\u0000\u0007\u001b\u007f\u0085\u009f​‌‍‎‏‪‮⁦⁩﻿';
    expect(truncateDescription(`ig${hidden}nore`)).toBe('ignore');
    expect(truncateDescription(`a\tb\nc\rd`)).toBe('a b c d');
    expect(truncateDescription(hidden)).toBeNull();
    // stripped before truncating: hidden characters do not eat into the 200-char budget
    const padded = truncateDescription(('x​'.repeat(250)));
    expect(padded).toHaveLength(200);
    expect(padded).not.toMatch(/​/);
  });

  it('picks the weakest provenance', () => {
    expect(weakestProvenance(['live', 'local_cache'])).toBe('local_cache');
    expect(weakestProvenance(['live', 'remote_cache', 'local_cache'])).toBe('remote_cache');
    expect(weakestProvenance(['live', 'stale_cache', 'remote_cache'])).toBe('stale_cache');
    expect(weakestProvenance(['live'])).toBe('live');
  });
});
