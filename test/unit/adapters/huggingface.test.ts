import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CandidateSchema } from '../../../src/types.js';
import { createHuggingfaceAdapter, createHuggingfaceEnricher } from '../../../src/adapters/huggingface.js';
import { FakeHttpClient, failure, notFound, ok } from '../../helpers/fake-http.js';

function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../fixtures/huggingface/${name}`, import.meta.url), 'utf8')) as T;
}

const SEARCH_URL = 'https://huggingface.co/api/models?search=turn%20detector&limit=3&sort=downloads&direction=-1';
const MODEL_URL = 'https://huggingface.co/api/models/livekit/turn-detector';
const ENRICH = { deep: false };

describe('huggingface search adapter', () => {
  const query = { query: 'turn detector', limit: 3 };

  it('normalizes the recorded search response', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: ok(fixture('search-turn-detector.json')) });
    const { candidates, meta } = await createHuggingfaceAdapter({ http }).search(query);

    expect(http.urls).toEqual([SEARCH_URL]);
    expect(http.calls[0]!.opts).toMatchObject({ source: 'hf_models', ttlClass: 'search' });
    expect(meta).toEqual({ source: 'hf_models', status: 'ok', count: 3, query: 'turn detector' });
    for (const c of candidates) expect(CandidateSchema.safeParse(c).success).toBe(true);

    expect(candidates[0]).toEqual({
      ref: 'hf:livekit/turn-detector',
      source: 'hf_models',
      name: 'livekit/turn-detector',
      url: 'https://huggingface.co/livekit/turn-detector',
      description: 'Model weights: text-classification / transformers',
      ecosystem: 'other',
      stars: 169,
      // last 30 days -> weekly equivalent: round(1207327 * 7 / 30)
      downloads_weekly: 281710,
      license_spdx: null, // license:other is judged at evaluation, not reported as SPDX
      matched_via: { query: 'turn detector', rank: 1 },
      provenance: 'live',
    });
    // a single mapped Hub id is reported as SPDX
    expect(candidates[1]).toMatchObject({ ref: 'hf:videosdk-live/Namo-Turn-Detector-v1-Korean', license_spdx: 'Apache-2.0' });
  });

  it('converts 30-day downloads to a weekly equivalent', async () => {
    const http = new FakeHttpClient().set(/huggingface\.co\/api\/models\?/, ok([{ id: 'a/b', downloads: 300 }, { id: 'a/c', downloads: 0 }]));
    const { candidates } = await createHuggingfaceAdapter({ http }).search(query);
    expect(candidates.map((c) => c.downloads_weekly)).toEqual([70, 0]);
  });

  it('drops private models and unparsable items and reports partial', async () => {
    const body = [{ id: 'a/public' }, { id: 'a/hidden', private: true }, { nope: 1 }, { id: '../x' }];
    const http = new FakeHttpClient().set(/huggingface\.co\/api\/models\?/, ok(body));
    const { candidates, meta } = await createHuggingfaceAdapter({ http }).search(query);
    expect(candidates.map((c) => c.ref)).toEqual(['hf:a/public']);
    expect(meta.status).toBe('partial');
    expect(meta.message).toMatch(/3 Hugging Face search result/);
  });

  it('url-encodes the query and clamps the limit to 100', async () => {
    const http = new FakeHttpClient().set(/huggingface\.co\/api\/models\?/, ok([]));
    await createHuggingfaceAdapter({ http }).search({ query: 'a&b #c', limit: 9999 });
    expect(http.urls[0]).toBe('https://huggingface.co/api/models?search=a%26b%20%23c&limit=100&sort=downloads&direction=-1');
  });

  it('skips an empty query without a request', async () => {
    const http = new FakeHttpClient();
    const { meta } = await createHuggingfaceAdapter({ http }).search({ query: '  ', limit: 3 });
    expect(meta.status).toBe('skipped');
    expect(http.calls).toHaveLength(0);
  });

  it('marks cache-served results as cached', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: ok(fixture('search-turn-detector.json'), { provenance: 'local_cache' }) });
    const { candidates, meta } = await createHuggingfaceAdapter({ http }).search(query);
    expect(meta.status).toBe('cached');
    expect(candidates[0]!.provenance).toBe('local_cache');
  });

  it('reports a failure with a manual alternative', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: failure('rate_limited') });
    const { candidates, meta } = await createHuggingfaceAdapter({ http }).search(query);
    expect(candidates).toEqual([]);
    expect(meta.status).toBe('rate_limited');
    expect(meta.message).toContain('huggingface.co/models');
  });

  it('treats a non-array body as an error', async () => {
    const http = new FakeHttpClient({ [SEARCH_URL]: ok({ error: 'x' }) });
    const { meta } = await createHuggingfaceAdapter({ http }).search(query);
    expect(meta.status).toBe('error');
  });
});

describe('huggingface enricher', () => {
  it('supports only hf refs', () => {
    const e = createHuggingfaceEnricher({ http: new FakeHttpClient() });
    expect(e.supports('hf:livekit/turn-detector')).toBe(true);
    expect(e.supports('github:a/b')).toBe(false);
    expect(e.supports('saas:acme/x')).toBe(false);
  });

  it('extracts metrics, license facts and the descriptor from the recorded model', async () => {
    const http = new FakeHttpClient({ [MODEL_URL]: ok(fixture('model-turn-detector.json')) });
    const out = await createHuggingfaceEnricher({ http }).enrich('hf:livekit/turn-detector', ENRICH);

    expect(http.calls[0]!.opts).toMatchObject({ source: 'hf_models', ttlClass: 'package' });
    expect(out.metrics).toEqual({ stars: 169, downloads_weekly: 281710, last_commit_at: '2026-02-11T15:04:40.000Z' });
    expect(out.license_spdx).toBeNull();
    expect(out.license_source).toBe('huggingface');
    expect(out.missing).toEqual([]);
    expect(out.model_license).toEqual({
      hf_license: ['other'],
      license_name: 'livekit-model-license',
      license_link: 'LICENSE',
      gated: false,
      base_models: ['Qwen/Qwen2.5-0.5B-Instruct'],
    });
    expect(out.flags).toEqual([]);
    expect(out.descriptor).toContain('livekit/turn-detector');
    expect(out.descriptor).toContain('text-classification');
  });

  it('reports a single mapped license as SPDX', async () => {
    const body = { id: 'a/b', likes: 1, downloads: 30, lastModified: '2026-01-01T00:00:00Z', tags: ['license:apache-2.0'], cardData: { license: 'Apache-2.0' } };
    const http = new FakeHttpClient().set(/models\/a\/b$/, ok(body));
    const out = await createHuggingfaceEnricher({ http }).enrich('hf:a/b', ENRICH);
    expect(out.license_spdx).toBe('Apache-2.0');
    expect(out.model_license?.hf_license).toEqual(['apache-2.0']);
  });

  it('falls back to license: tags when the card has none', async () => {
    const body = { id: 'a/b', likes: 1, downloads: 30, lastModified: '2026-01-01T00:00:00Z', tags: ['license:cc-by-nc-4.0'] };
    const http = new FakeHttpClient().set(/models\/a\/b$/, ok(body));
    const out = await createHuggingfaceEnricher({ http }).enrich('hf:a/b', ENRICH);
    expect(out.model_license?.hf_license).toEqual(['cc-by-nc-4.0']);
    expect(out.license_spdx).toBeNull();
  });

  it.each([
    [true, true],
    ['auto', true],
    ['manual', true],
    [false, false],
  ])('gated=%s -> gated_model flag %s', async (gated, flagged) => {
    const http = new FakeHttpClient().set(/models\/a\/b$/, ok({ id: 'a/b', gated, cardData: { license: 'llama3.1' } }));
    const out = await createHuggingfaceEnricher({ http }).enrich('hf:a/b', ENRICH);
    expect(out.model_license?.gated).toBe(flagged);
    expect(out.flags).toEqual(flagged ? ['gated_model'] : []);
  });

  it('marks missing facts when the card has no license', async () => {
    const http = new FakeHttpClient().set(/models\/a\/b$/, ok({ id: 'a/b', likes: 2 }));
    const out = await createHuggingfaceEnricher({ http }).enrich('hf:a/b', ENRICH);
    expect(out.missing).toEqual(['downloads_weekly', 'last_commit_at', 'license']);
    expect(out.model_license?.hf_license).toEqual([]);
  });

  it('sanitizes and bounds third-party card text', async () => {
    const body = {
      id: 'a/b',
      tags: ['base_model:evil/../x', 'base_model:finetune:ok/base', 'base_model:bad id/x', 'license:<script>'],
      cardData: {
        license: ['other', 'Bad License!'],
        license_name: `my\u0000 license\n${'x'.repeat(500)}`,
        license_link: 'https://e.test/l‮',
      },
    };
    const http = new FakeHttpClient().set(/models\/a\/b$/, ok(body));
    const out = await createHuggingfaceEnricher({ http }).enrich('hf:a/b', ENRICH);
    const facts = out.model_license!;
    expect(facts.hf_license).toEqual(['other']);
    expect(facts.base_models).toEqual(['ok/base']);
    expect(facts.license_name!.length).toBeLessThanOrEqual(200);
    expect(facts.license_name).not.toMatch(/[\u0000\n]/);
    expect(facts.license_link).not.toContain('‮');
  });

  it.each([
    ['private', { id: 'a/b', private: true }],
    ['disabled', { id: 'a/b', disabled: true }],
  ])('treats a %s model as not found', async (_n, body) => {
    const http = new FakeHttpClient().set(/models\/a\/b$/, ok(body));
    const out = await createHuggingfaceEnricher({ http }).enrich('hf:a/b', ENRICH);
    expect(out.metrics).toEqual({});
    expect(out.model_license).toBeUndefined();
    expect(out.missing).toEqual(['license', 'stars', 'downloads_weekly', 'last_commit_at']);
  });

  it('does not throw on 404 or network failure', async () => {
    for (const res of [notFound(), failure('network')]) {
      const http = new FakeHttpClient().set(/models\/a\/b$/, res);
      const out = await createHuggingfaceEnricher({ http }).enrich('hf:a/b', ENRICH);
      expect(out.metrics).toEqual({});
      expect(out.license_spdx).toBeNull();
      expect(out.model_license).toBeUndefined();
      expect(out.missing).toContain('license');
    }
  });

  it('refuses a non-hf ref and requests only /api/models/<owner>/<name>', async () => {
    const http = new FakeHttpClient().set(/models\/a\/b$/, ok({ id: 'a/b' }));
    const e = createHuggingfaceEnricher({ http });
    await expect(e.enrich('github:a/b', ENRICH)).rejects.toThrow(TypeError);
    await e.enrich('hf:a/b', ENRICH);
    expect(http.urls).toEqual(['https://huggingface.co/api/models/a/b']);
  });
});
