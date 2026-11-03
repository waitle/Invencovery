/**
 * Regression tests of the independent review, core side: autolinks in escaped
 * Markdown, linear-time ML term matching, and prototype keys as license ids.
 */
import { describe, expect, it } from 'vitest';
import { createHuggingfaceEnricher } from '../../../src/adapters/huggingface.js';
import { HF_SPDX_IDS, judgeModelLicense } from '../../../src/core/model-license.js';
import { soundsLikeMl, mlTermsIn } from '../../../src/core/ml-terms.js';
import { escapeMd } from '../../../src/core/sanitize.js';
import { LicenseVerdictSchema } from '../../../src/types.js';
import type { ModelLicenseFacts } from '../../../src/types.js';
import { FakeHttpClient, ok } from '../../helpers/fake-http.js';

describe('escapeMd defangs autolinks', () => {
  it('breaks bare URLs and www hosts so they cannot render as links', () => {
    const out = escapeMd('see https://evil.example/x?a=1 and www.evil.example, mailto:a@b.c');
    expect(out).not.toMatch(/[^\\]:\/\//);
    expect(out).not.toMatch(/www\./i);
    expect(out).toContain('https\\://evil');
  });
});

describe('ml-terms runs in linear time on hostile input', () => {
  const LONG = 200_000;
  it.each([
    ['dashes', `${'-'.repeat(LONG)}x`],
    ['dots', `${'.'.repeat(LONG)}x`],
    ['mixed', `${'.-'.repeat(LONG / 2)}x`],
  ])('%s', (_name, text) => {
    const start = performance.now();
    expect(mlTermsIn(text, 'any')).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('still finds terms next to punctuation', () => {
    expect(soundsLikeMl('A speech- to-text. tool', 'strong')).toBe(true);
    expect(soundsLikeMl('a markdown parser', 'any')).toBe(false);
  });
});

const facts = (hf_license: string[], over: Partial<ModelLicenseFacts> = {}): ModelLicenseFacts => ({ hf_license, gated: false, base_models: [], ...over });
const judgeIn = (f: ModelLicenseFacts) => judgeModelLicense(f, { project: 'MIT', distribution: 'application', source: 'huggingface' });

describe('prototype keys as license ids', () => {
  it.each(['constructor', '__proto__', 'tostring', 'valueof', 'hasownproperty', '__definegetter__'])(
    '%s is a custom model license',
    (id) => {
      expect(Object.hasOwn(HF_SPDX_IDS, id)).toBe(false);
      const r = judgeIn(facts([id]));
      expect(r.custom).toBe(true);
      expect(r.license.verdict).toBe('unknown');
      expect(r.license.candidate_spdx).toBe(id);
      expect(LicenseVerdictSchema.safeParse(r.license).success).toBe(true);
    },
  );

  it('judges at most 5 ids and keeps candidate_spdx short', () => {
    const ids = Array.from({ length: 40 }, (_v, i) => `custom-license-number-${String(i).padStart(2, '0')}-${'x'.repeat(30)}`);
    const r = judgeIn(facts(ids));
    expect(r.license.candidate_spdx!.split(' AND ')).toHaveLength(5);
    expect(r.license.candidate_spdx!.length).toBeLessThanOrEqual(2000);
    expect(r.license.notes.join(' ')).toContain('only the first 5');
  });

  it('the Hugging Face enricher reports no SPDX for "constructor" and caps the ids', async () => {
    const card = { id: 'a/b', likes: 1, downloads: 30, lastModified: '2026-01-01T00:00:00Z', tags: [] as string[], cardData: { license: 'constructor' } };
    const http = new FakeHttpClient().set(/models\/a\/b$/, ok(card));
    const out = await createHuggingfaceEnricher({ http }).enrich('hf:a/b', { deep: false });
    expect(out.license_spdx).toBeNull();
    expect(out.model_license?.hf_license).toEqual(['constructor']);

    const many = { ...card, cardData: { license: Array.from({ length: 30 }, (_v, i) => `lic-${i}`) } };
    const http2 = new FakeHttpClient().set(/models\/a\/b$/, ok(many));
    const out2 = await createHuggingfaceEnricher({ http: http2 }).enrich('hf:a/b', { deep: false });
    expect(out2.model_license?.hf_license).toHaveLength(5);
  });
});
