import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildMcpRegistryDetailUrl,
  buildMcpRegistrySearchUrl,
  createMcpRegistryAdapter,
  createMcpRegistryEnricher,
} from '../../../src/adapters/mcp-registry.js';
import { dedupe } from '../../../src/core/dedupe.js';
import { CandidateSchema, SourceMetaSchema } from '../../../src/types.js';
import type { Candidate } from '../../../src/types.js';
import { FakeHttpClient, failure, notFound, ok } from '../../helpers/fake-http.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/mcp-registry/${name}`, import.meta.url), 'utf8'));
}

const BASE = 'https://registry.modelcontextprotocol.io';
const search = (v: 'v0.1' | 'v0', term: string, limit: number) =>
  `${BASE}/${v}/servers?search=${term}&limit=${limit}&version=latest`;

const latest = fixture('search-v0.1-filesystem-latest.json');
const allVersions = fixture('search-v0.1-filesystem-all-versions.json');
const empty = fixture('search-v0.1-empty.json');
const legacy = fixture('search-v0-legacy-flat.json');
const detail = fixture('detail-v0.1-remote-filesystem.json');

function adapterWith(routes: ConstructorParameters<typeof FakeHttpClient>[0]) {
  const http = new FakeHttpClient(routes);
  return { http, adapter: createMcpRegistryAdapter({ http }) };
}

describe('URL builders', () => {
  it('builds the v0.1 search URL with version=latest and encodes the term', () => {
    expect(buildMcpRegistrySearchUrl('v0.1', 'file system', 8)).toBe(
      `${BASE}/v0.1/servers?search=file%20system&limit=8&version=latest`,
    );
    expect(buildMcpRegistrySearchUrl('v0', 'x', 1)).toBe(`${BASE}/v0/servers?search=x&limit=1&version=latest`);
  });

  it('url-encodes the slash of a server name in the detail URL', () => {
    expect(buildMcpRegistryDetailUrl('v0.1', 'io.github.x/y')).toBe(
      `${BASE}/v0.1/servers/io.github.x%2Fy/versions/latest`,
    );
  });
});

describe('mcp_registry search', () => {
  it('unwraps servers[].server and maps the recorded v0.1 response to candidates', async () => {
    const { http, adapter } = adapterWith({ [search('v0.1', 'filesystem', 8)]: ok(latest) });
    const { candidates, meta } = await adapter.search({ query: 'filesystem', limit: 8 });

    expect(http.urls).toEqual([search('v0.1', 'filesystem', 8)]);
    expect(http.calls[0]?.opts).toMatchObject({ source: 'mcp_registry', ttlClass: 'search' });
    expect(meta).toEqual({ source: 'mcp_registry', status: 'ok', count: 3, query: 'filesystem' });
    for (const c of candidates) expect(CandidateSchema.safeParse(c).success).toBe(true);
    expect(SourceMetaSchema.safeParse(meta).success).toBe(true);

    const remote = candidates.find((c) => c.ref === 'mcp:com.pulsemcp/remote-filesystem');
    expect(remote).toEqual({
      ref: 'mcp:com.pulsemcp/remote-filesystem',
      source: 'mcp_registry',
      name: 'com.pulsemcp/remote-filesystem',
      // monorepo subfolder is kept in the human URL, repository_url stays the plain repo
      url: 'https://github.com/pulsemcp/mcp-servers/tree/HEAD/experimental/remote-filesystem',
      repository_url: 'https://github.com/pulsemcp/mcp-servers',
      description: 'MCP server for remote filesystem operations on cloud storage (Google Cloud Storage).',
      ecosystem: 'npm',
      also_known_as: ['npm:remote-filesystem-mcp-server'],
      last_activity: '2026-06-26T14:07:53.723164Z',
      matched_via: { query: 'filesystem', rank: expect.any(Number) },
      provenance: 'live',
    });

    const scoped = candidates.find((c) => c.ref === 'mcp:io.github.Digital-Defiance/mcp-filesystem');
    expect(scoped?.also_known_as).toEqual(['npm:@ai-capabilities-suite/mcp-filesystem']);
    expect(scoped?.repository_url).toBe('https://github.com/digital-defiance/ai-capabilities-suite');
  });

  it('strips zero-width, bidi and control characters from descriptions', async () => {
    const description = 'safe​ text‮ rev⁦ iso⁩ bom﻿ bell\u0007 nul\u0000 del\u007F c1\u0085 end';
    const body = { servers: [{ server: { name: 'io.github.x/y', description }, _meta: {} }] };
    const { adapter } = adapterWith({ [search('v0.1', 'x', 8)]: ok(body) });
    const { candidates } = await adapter.search({ query: 'x', limit: 8 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.description).toBe('safe text rev iso bom bell nul del c1 end');
  });

  it('handles servers without repository or packages (remote-only)', async () => {
    const { adapter } = adapterWith({ [search('v0.1', 'filesystem', 8)]: ok(latest) });
    const { candidates } = await adapter.search({ query: 'filesystem', limit: 8 });
    const remoteOnly = candidates.find((c) => c.ref === 'mcp:io.github.Evozim/chroot-filesystem-jail-mcp');
    expect(remoteOnly).toBeDefined();
    expect(remoteOnly?.repository_url).toBeUndefined();
    expect(remoteOnly?.ecosystem).toBeUndefined();
    expect(remoteOnly?.also_known_as).toBeUndefined();
    // no repo and no website: falls back to the registry detail URL
    expect(remoteOnly?.url).toBe(`${BASE}/v0.1/servers/io.github.Evozim%2Fchroot-filesystem-jail-mcp/versions/latest`);
  });

  it('numbers ranks from 1 in result order', async () => {
    const { adapter } = adapterWith({ [search('v0.1', 'filesystem', 8)]: ok(latest) });
    const { candidates } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(candidates.map((c) => c.matched_via.rank)).toEqual([1, 2, 3]);
  });

  it('collapses several versions of one server into the most recent entry', async () => {
    const { adapter } = adapterWith({ [search('v0.1', 'filesystem', 8)]: ok(allVersions) });
    const { candidates, meta } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(candidates).toHaveLength(1);
    // neither version is flagged isLatest; the later updatedAt (0.1.3) wins
    expect(candidates[0]?.last_activity).toBe('2026-06-14T17:28:23.553635Z');
    expect(meta.status).toBe('ok');
    expect(meta.count).toBe(1);
  });

  it('prefers the entry flagged isLatest over a newer-looking one', async () => {
    const entry = (version: string, at: string, isLatest: boolean) => ({
      server: { name: 'io.github.a/b', description: 'd', version },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', updatedAt: at, isLatest } },
    });
    const body = { servers: [entry('1.0.0', '2026-01-01T00:00:00Z', true), entry('0.9.0', '2026-02-01T00:00:00Z', false)] };
    const { adapter } = adapterWith({ [search('v0.1', 'b', 5)]: ok(body) });
    const { candidates } = await adapter.search({ query: 'b', limit: 5 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.last_activity).toBe('2026-01-01T00:00:00Z');
  });

  it('truncates descriptions to 200 chars without splitting a surrogate pair', async () => {
    const long = `${'a'.repeat(199)}😀 tail`;
    const body = { servers: [{ server: { name: 'io.github.a/long', description: long } }] };
    const { adapter } = adapterWith({ [search('v0.1', 'long', 5)]: ok(body) });
    const { candidates } = await adapter.search({ query: 'long', limit: 5 });
    const description = candidates[0]?.description ?? '';
    expect(description.length).toBeLessThanOrEqual(200);
    expect(description).toBe('a'.repeat(199));
    expect(CandidateSchema.safeParse(candidates[0]).success).toBe(true);
  });

  it('marks deprecated servers and skips deleted ones', async () => {
    const body = {
      servers: [
        { server: { name: 'io.github.a/old', description: 'x' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } } },
        { server: { name: 'io.github.a/gone', description: 'x' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } } },
        { server: { name: 'io.github.a/fine', description: 'x' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } } },
      ],
    };
    const { adapter } = adapterWith({ [search('v0.1', 'io.github.a', 5)]: ok(body) });
    const { candidates, meta } = await adapter.search({ query: 'io.github.a', limit: 5 });
    expect(candidates.map((c) => c.name).sort()).toEqual(['io.github.a/fine', 'io.github.a/old']);
    expect(candidates.find((c) => c.name === 'io.github.a/old')?.deprecated).toBe(true);
    expect(candidates.find((c) => c.name === 'io.github.a/fine')?.deprecated).toBeUndefined();
    expect(meta.status).toBe('ok');
  });

  it('drops unparsable entries and reports status partial', async () => {
    const body = {
      servers: [
        { server: { description: 'no name here' } },
        'not an object',
        { server: { name: 'io.github.a/ok', description: 'fine' } },
        { server: { name: 'io.github.a/spaced name', description: 'bad ref' } },
      ],
    };
    const { adapter } = adapterWith({ [search('v0.1', 'io.github.a', 5)]: ok(body) });
    const { candidates, meta } = await adapter.search({ query: 'io.github.a', limit: 5 });
    expect(candidates.map((c) => c.name)).toEqual(['io.github.a/ok']);
    expect(meta.status).toBe('partial');
    expect(meta.message).toMatch(/3 registry entries could not be parsed/);
  });

  it('reads the legacy flat layout (version_detail, snake_case meta, registry_name packages)', async () => {
    const { adapter } = adapterWith({ [search('v0.1', 'pdf', 5)]: ok(legacy) });
    const { candidates, meta } = await adapter.search({ query: 'pdf', limit: 5 });
    expect(meta.status).toBe('ok');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      ref: 'mcp:io.github.example/legacy-pdf',
      repository_url: 'https://github.com/example/legacy-pdf',
      ecosystem: 'npm',
      also_known_as: ['npm:legacy-pdf-mcp'],
      last_activity: '2025-08-02T10:00:00Z',
    });
  });

  it('falls back to /v0 when /v0.1 returns 404', async () => {
    const { http, adapter } = adapterWith({
      [search('v0.1', 'filesystem', 8)]: notFound(),
      [search('v0', 'filesystem', 8)]: ok(latest),
    });
    const { candidates, meta } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(http.urls).toEqual([search('v0.1', 'filesystem', 8), search('v0', 'filesystem', 8)]);
    expect(candidates).toHaveLength(3);
    expect(meta.status).toBe('ok');
    expect(meta.message).toMatch(/legacy \/v0 endpoint/);
  });

  it.each([
    ['5xx', failure('http')],
    ['network error', failure('network')],
    ['timeout', failure('timeout')],
  ])('falls back to /v0 on %s', async (_label, bad) => {
    const { http, adapter } = adapterWith({
      [search('v0.1', 'filesystem', 8)]: bad,
      [search('v0', 'filesystem', 8)]: ok(latest),
    });
    const { candidates } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(http.urls).toHaveLength(2);
    expect(candidates).toHaveLength(3);
  });

  it('falls back to /v0 when /v0.1 answers 200 with an unknown shape', async () => {
    const { adapter } = adapterWith({
      [search('v0.1', 'filesystem', 8)]: ok({ unexpected: true }),
      [search('v0', 'filesystem', 8)]: ok(latest),
    });
    const { candidates } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(candidates).toHaveLength(3);
  });

  it('reports error (with an alternative) when both API versions fail', async () => {
    const { http, adapter } = adapterWith({
      [search('v0.1', 'filesystem', 8)]: failure('http'),
      [search('v0', 'filesystem', 8)]: notFound(),
    });
    const { candidates, meta } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(http.urls).toHaveLength(2);
    expect(candidates).toEqual([]);
    expect(meta.status).toBe('error');
    expect(meta.message).toMatch(/WebSearch/);
  });

  it('does not fall back on rate limiting and reports rate_limited with reset_at', async () => {
    const { http, adapter } = adapterWith({
      [search('v0.1', 'filesystem', 8)]: failure('rate_limited', {
        headers: { 'retry-after': '30' },
        fetched_at: '2026-10-12T00:00:00.000Z',
      }),
    });
    const { candidates, meta } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(http.urls).toHaveLength(1);
    expect(candidates).toEqual([]);
    expect(meta.status).toBe('rate_limited');
    expect(meta.rate_limit).toEqual({ remaining: 0, reset_at: '2026-10-12T00:00:30.000Z' });
    expect(SourceMetaSchema.safeParse(meta).success).toBe(true);
  });

  it('reports offline without trying the legacy endpoint', async () => {
    const { http, adapter } = adapterWith({ [search('v0.1', 'filesystem', 8)]: failure('offline') });
    const { meta } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(http.urls).toHaveLength(1);
    expect(meta.status).toBe('offline');
  });

  it('survives a throwing HTTP client as an error status', async () => {
    const adapter = createMcpRegistryAdapter({
      http: {
        getJson() {
          throw new Error('boom');
        },
      },
    });
    const { candidates, meta } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(candidates).toEqual([]);
    expect(meta.status).toBe('error');
  });

  it('labels cache answers as cached and carries provenance into candidates', async () => {
    const { adapter } = adapterWith({
      [search('v0.1', 'filesystem', 8)]: ok(latest, { provenance: 'local_cache' }),
    });
    const { candidates, meta } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(meta.status).toBe('cached');
    expect(new Set(candidates.map((c) => c.provenance))).toEqual(new Set(['local_cache']));
  });

  it('mentions stale cache in the message', async () => {
    const { adapter } = adapterWith({
      [search('v0.1', 'filesystem', 8)]: ok(latest, { provenance: 'stale_cache' }),
    });
    const { meta } = await adapter.search({ query: 'filesystem', limit: 8 });
    expect(meta.status).toBe('cached');
    expect(meta.message).toMatch(/stale/i);
  });

  it('searches the individual terms when a multi-word query matches no server name', async () => {
    const { http, adapter } = adapterWith({
      [search('v0.1', 'remote%20filesystem', 8)]: ok(empty),
      [search('v0.1', 'remote', 8)]: ok(allVersions),
      [search('v0.1', 'filesystem', 8)]: ok(latest),
    });
    const { candidates, meta } = await adapter.search({ query: 'remote filesystem', limit: 8 });
    expect(http.urls).toEqual([
      search('v0.1', 'remote%20filesystem', 8),
      search('v0.1', 'remote', 8),
      search('v0.1', 'filesystem', 8),
    ]);
    // the server whose name carries both terms ranks first
    expect(candidates[0]?.ref).toBe('mcp:com.pulsemcp/remote-filesystem');
    expect(candidates).toHaveLength(3);
    expect(meta.status).toBe('ok');
    expect(meta.message).toMatch(/individually \(remote, filesystem\)/);
  });

  it('does not run per-term searches when the whole query already matched', async () => {
    const { http, adapter } = adapterWith({ [search('v0.1', 'remote%20filesystem', 8)]: ok(latest) });
    await adapter.search({ query: 'remote filesystem', limit: 8 });
    expect(http.urls).toHaveLength(1);
  });

  it('returns an empty ok result with a hint for a single-word query without hits', async () => {
    const { http, adapter } = adapterWith({ [search('v0.1', 'zzz', 8)]: ok(empty) });
    const { candidates, meta } = await adapter.search({ query: 'zzz', limit: 8 });
    expect(http.urls).toHaveLength(1);
    expect(candidates).toEqual([]);
    expect(meta.status).toBe('ok');
    expect(meta.count).toBe(0);
    expect(meta.message).toMatch(/server names only/);
  });

  it('clamps the limit to 1..100 and caps the number of candidates', async () => {
    const { http, adapter } = adapterWith({
      [search('v0.1', 'filesystem', 100)]: ok(latest),
      [search('v0.1', 'filesystem', 1)]: ok(latest),
    });
    expect((await adapter.search({ query: 'filesystem', limit: 500 })).candidates).toHaveLength(3);
    const one = await adapter.search({ query: 'filesystem', limit: 0 });
    expect(one.candidates).toHaveLength(1);
    expect(http.urls).toEqual([search('v0.1', 'filesystem', 100), search('v0.1', 'filesystem', 1)]);
  });

  it('skips an empty query without any request', async () => {
    const { http, adapter } = adapterWith({});
    const { candidates, meta } = await adapter.search({ query: '   ', limit: 5 });
    expect(http.calls).toHaveLength(0);
    expect(candidates).toEqual([]);
    expect(meta.status).toBe('skipped');
  });

  it('merges with a github candidate of the same repository through dedupe', async () => {
    const { adapter } = adapterWith({ [search('v0.1', 'filesystem', 8)]: ok(latest) });
    const { candidates } = await adapter.search({ query: 'filesystem', limit: 8 });
    const github: Candidate = {
      ref: 'github:pulsemcp/mcp-servers',
      source: 'github_repo',
      name: 'pulsemcp/mcp-servers',
      url: 'https://github.com/pulsemcp/mcp-servers',
      description: 'MCP servers',
      stars: 321,
      license_spdx: 'MIT',
      matched_via: { query: 'filesystem', rank: 1 },
      provenance: 'live',
    };
    const merged = dedupe([github, ...candidates]);
    const rep = merged.find((c) => c.ref === 'github:pulsemcp/mcp-servers');
    expect(rep?.also_known_as).toEqual(
      expect.arrayContaining(['mcp:com.pulsemcp/remote-filesystem', 'npm:remote-filesystem-mcp-server']),
    );
    expect(merged).toHaveLength(3); // github(+remote-filesystem), digital-defiance, evozim
  });
});

describe('mcp_registry enricher', () => {
  const name = 'com.pulsemcp/remote-filesystem';
  const v01 = `${BASE}/v0.1/servers/com.pulsemcp%2Fremote-filesystem/versions/latest`;
  const v0 = `${BASE}/v0/servers/com.pulsemcp%2Fremote-filesystem/versions/latest`;

  it('supports mcp refs only', () => {
    const enricher = createMcpRegistryEnricher({ http: new FakeHttpClient() });
    expect(enricher.supports(`mcp:${name}`)).toBe(true);
    expect(enricher.supports('github:a/b')).toBe(false);
    expect(enricher.supports('npm:left-pad')).toBe(false);
    expect(enricher.supports('not a ref')).toBe(false);
  });

  it('returns the repository url so the github chain can continue', async () => {
    const http = new FakeHttpClient({ [v01]: ok(detail) });
    const result = await createMcpRegistryEnricher({ http }).enrich(`mcp:${name}`, { deep: false });
    expect(http.urls).toEqual([v01]);
    expect(http.calls[0]?.opts).toMatchObject({ source: 'mcp_registry', ttlClass: 'registry' });
    expect(result).toEqual({
      metrics: { last_release_at: '2026-06-26T14:07:53.723164Z' },
      license_spdx: null,
      license_source: 'github',
      repository_url: 'https://github.com/pulsemcp/mcp-servers',
      provenance: 'live',
      missing: ['license'],
      descriptor: 'MCP server for remote filesystem operations on cloud storage (Google Cloud Storage).',
    });
  });

  it('falls back to /v0 and reports deprecation', async () => {
    const deprecated = {
      server: { name, repository: { url: 'git+https://github.com/PulseMCP/mcp-servers.git' } },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated', updatedAt: '2026-01-01T00:00:00Z' } },
    };
    const http = new FakeHttpClient({ [v01]: notFound(), [v0]: ok(deprecated, { provenance: 'remote_cache' }) });
    const result = await createMcpRegistryEnricher({ http }).enrich(`mcp:${name}`, { deep: true });
    expect(http.urls).toEqual([v01, v0]);
    expect(result.metrics).toEqual({ last_release_at: '2026-01-01T00:00:00Z', deprecated: true });
    expect(result.repository_url).toBe('https://github.com/pulsemcp/mcp-servers');
    expect(result.provenance).toBe('remote_cache');
  });

  it('records repository_url as missing when the server has none', async () => {
    const http = new FakeHttpClient({ [v01]: ok({ server: { name }, _meta: {} }) });
    const result = await createMcpRegistryEnricher({ http }).enrich(`mcp:${name}`, { deep: false });
    expect(result.repository_url).toBeUndefined();
    expect(result.missing).toEqual(['license', 'repository_url']);
  });

  it('never throws: both endpoints failing reports missing registry_detail', async () => {
    const http = new FakeHttpClient({ [v01]: failure('http'), [v0]: failure('network') });
    const result = await createMcpRegistryEnricher({ http }).enrich(`mcp:${name}`, { deep: false });
    expect(result.metrics).toEqual({});
    expect(result.license_spdx).toBeNull();
    expect(result.missing).toEqual(['license', 'repository_url', 'registry_detail']);
  });

  it('stops at a rate limit instead of hitting the legacy endpoint', async () => {
    const http = new FakeHttpClient({ [v01]: failure('rate_limited') });
    const result = await createMcpRegistryEnricher({ http }).enrich(`mcp:${name}`, { deep: false });
    expect(http.urls).toEqual([v01]);
    expect(result.missing).toContain('registry_detail');
  });
});
