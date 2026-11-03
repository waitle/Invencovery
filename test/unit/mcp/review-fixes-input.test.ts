/**
 * Regression tests of the independent review, input side: secrets in URLs,
 * public-suffix vendor domains, https-only first-party pages, all-or-nothing
 * writes, no duplicate vendor evidence, and contradictory source_url input.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EvaluateOutputSchema } from '../../../src/mcp/tools/evaluate.js';
import { cleanupTmpDirs } from '../../helpers/tmp.js';
import { createHarness, fakeEnricher, seedComponents } from './_harness.js';
import type { Harness } from './_harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupTmpDirs();
});

const MINIMAL = { vendor_domains: ['deepgram.com'], lock_in: 'low', exit_path: 'Swap to another STT vendor behind the same interface.' };
const pick = (ref: string, extra: Record<string, unknown> = {}) => ({ ref, fit: 5, fit_reason: 'Covers the needed behaviour well.', ...extra });
const service = (saas: Record<string, unknown>) => pick('saas:deepgram/stt', { saas });

async function setup() {
  h = await createHarness({
    enrichers: [
      fakeEnricher(['npm', 'pypi', 'github', 'mcp'], (ref) => ({
        metrics: { stars: 10000, last_commit_at: '2026-09-12T00:00:00.000Z', direct_dependencies: 2 },
        license_spdx: 'MIT',
        repository_url: `https://github.com/${ref.slice(ref.indexOf(':') + 1)}`,
      })),
    ],
  });
  await seedComponents(h, [{ name: 'Speech', description: 'speech recognition', keywords: ['speech'] }]);
}
const evaluate = (candidates: Record<string, unknown>[]) => h!.call('rw_evaluate', { component_id: 'speech', candidates });

describe('source_url secrets', () => {
  it('rejects userinfo in source_url', async () => {
    await setup();
    const r = await evaluate([service({ ...MINIMAL, pricing: { source_url: 'https://user:tok@deepgram.com/pricing' } })]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('userinfo');
    expect(h!.ledgerText()).not.toContain('tok@');
  });

  it('redacts secret query values before the ledger and the output see them', async () => {
    await setup();
    const r = await evaluate([service({ ...MINIMAL, pricing: { source_url: 'https://deepgram.com/p?api_key=SECRET&plan=x' } })]);
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain('SECRET');
    expect(JSON.stringify(r.structured)).not.toContain('SECRET');
    expect(h!.ledgerText()).not.toContain('SECRET');
    const out = EvaluateOutputSchema.parse(r.structured);
    expect(out.recorded_evidence![0]!.url).toContain('api_key=REDACTED');
    expect(out.recorded_evidence![0]!.source).toBe('first_party');
  });

  it('redacts rw_record_evidence result urls and query', async () => {
    await setup();
    const r = await h!.call('rw_record_evidence', {
      component_id: 'speech',
      kind: 'web',
      query: 'see https://u:p@example.com/x?token=SECRET&a=1 for details',
      results: [{ url: 'https://me:pw@example.com/doc?access_token=SECRET2#frag', title: 't' }],
      summary: 'Searched the web and found a page.',
    });
    expect(r.isError).toBe(false);
    for (const secret of ['SECRET', 'SECRET2', 'me:pw', 'u:p@']) {
      expect(r.text).not.toContain(secret);
      expect(h!.ledgerText()).not.toContain(secret);
    }
    const ev = h!.state().evidence.at(-1)!;
    expect(ev.results![0]!.url).toBe('https://example.com/doc?access_token=REDACTED');
    expect(ev.query).toContain('token=REDACTED');
  });
});

describe('vendor_domains', () => {
  it.each(['github.io', 'co.kr', 'vercel.app'])('rejects the public suffix %s', async (domain) => {
    await setup();
    const r = await evaluate([service({ ...MINIMAL, vendor_domains: [domain] })]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('public suffix');
    expect(h!.state().evaluations).toHaveLength(0);
  });

  it('still accepts a registrable domain under a public suffix', async () => {
    await setup();
    const r = await evaluate([service({ ...MINIMAL, vendor_domains: ['acme.co.kr', 'acme.github.io'] })]);
    expect(r.isError).toBe(false);
  });

  it('counts only https pages as first party', async () => {
    await setup();
    const r = await evaluate([service({ ...MINIMAL, pricing: { source_url: 'http://deepgram.com/pricing' } })]);
    expect(r.isError).toBe(false);
    const out = EvaluateOutputSchema.parse(r.structured);
    expect(out.evaluations[0]!.saas?.pricing.source).toBe('secondhand');
  });
});

describe('rw_evaluate writes all or nothing', () => {
  it('writes no vendor evidence when a later event cannot be serialised', async () => {
    await setup();
    const r = await evaluate([service({ ...MINIMAL, pricing: { source_url: 'https://deepgram.com/pricing' } }), pick('npm:bad​name')]);
    expect(r.text).toContain('Ledger event');
    expect(r.isError).toBe(true);
    expect(h!.state().evidence).toHaveLength(0);
    expect(h!.state().evaluations).toHaveLength(0);
  });
});

describe('vendor evidence is reused', () => {
  it('does not record the same vendor page twice on a repeated call', async () => {
    await setup();
    const saas = { ...MINIMAL, pricing: { source_url: 'https://deepgram.com/pricing' }, data_use: { policy: 'no_training', source_url: 'https://deepgram.com/privacy' } };
    const first = EvaluateOutputSchema.parse((await evaluate([service(saas)])).structured);
    const second = EvaluateOutputSchema.parse((await evaluate([service(saas)])).structured);
    expect(h!.state().evidence.filter((e) => e.kind === 'manual')).toHaveLength(2);
    expect(second.recorded_evidence!.map((e) => e.evidence_id)).toEqual(first.recorded_evidence!.map((e) => e.evidence_id));
    expect(second.evaluations[0]!.saas?.pricing.source).toBe('first_party');
    // A different URL is a different page.
    await evaluate([service({ ...saas, pricing: { source_url: 'https://deepgram.com/pricing/v2' } })]);
    expect(h!.state().evidence.filter((e) => e.kind === 'manual')).toHaveLength(3);
  });
});

describe('contradictory source_url input', () => {
  it('rejects data_use.policy unknown together with source_url', async () => {
    await setup();
    const r = await evaluate([service({ ...MINIMAL, data_use: { policy: 'unknown', source_url: 'https://deepgram.com/privacy' } })]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('unknown');
    expect(h!.state().evaluations).toHaveLength(0);
  });
});
