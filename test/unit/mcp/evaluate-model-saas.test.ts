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

const DAYS_30_AGO = '2026-09-12T00:00:00.000Z';

const goodCode = (ref: string, over: Record<string, unknown> = {}) => ({
  metrics: { stars: 10000, last_commit_at: DAYS_30_AGO, direct_dependencies: 2 },
  license_spdx: 'MIT',
  repository_url: `https://github.com/${ref.slice(ref.indexOf(':') + 1)}`,
  ...over,
});

const pick = (ref: string, extra: Record<string, unknown> = {}) => ({
  ref,
  fit: 4,
  fit_reason: 'Covers the needed behaviour well.',
  ...extra,
});

const hfEnricher = (cards: Record<string, Record<string, unknown> | undefined>) =>
  fakeEnricher(['hf'], (ref) => {
    const card = cards[ref];
    if (card === undefined) return { missing: ['license'], license_source: 'huggingface' };
    return {
      metrics: { stars: 169, downloads_weekly: 281710, last_commit_at: DAYS_30_AGO },
      license_source: 'huggingface',
      ...card,
    };
  });

const customCard = {
  model_license: { hf_license: ['other'], license_name: 'livekit-model-license', license_link: 'LICENSE', gated: false, base_models: [] },
};
const apacheCard = {
  license_spdx: 'Apache-2.0',
  model_license: { hf_license: ['apache-2.0'], gated: false, base_models: [] },
};

async function evaluate(args: Record<string, unknown>) {
  const r = await h!.call('rw_evaluate', { component_id: 'turn', ...args });
  return { r, out: r.isError ? undefined : EvaluateOutputSchema.parse(r.structured) };
}

describe('rw_evaluate: hf: candidates (model weights)', () => {
  it('judges the model card and raises custom_model_license for license: other', async () => {
    h = await createHarness({ enrichers: [hfEnricher({ 'hf:livekit/turn-detector': customCard })] });
    await seedComponents(h, [{ name: 'Turn', description: 'turn detection', keywords: ['turn'] }]);
    const { out } = await evaluate({ candidates: [pick('hf:livekit/turn-detector')] });
    const ev = out!.evaluations[0]!;
    expect(ev.license.verdict).toBe('unknown');
    expect(ev.license.candidate_spdx).toBe('livekit-model-license');
    expect(ev.flags).toContain('custom_model_license');
    expect(ev.hint).toBe('reference'); // unknown license caps the hint
    expect(ev.weights_license).toMatchObject({ ref: 'hf:livekit/turn-detector', verdict: 'unknown', license_name: 'livekit-model-license' });
    expect(ev.weights_license!.source).toBe('huggingface');
  });

  it('an Apache-2.0 model card is compatible and has no custom flag', async () => {
    h = await createHarness({ enrichers: [hfEnricher({ 'hf:a/m': apacheCard })] });
    await seedComponents(h, [{ name: 'Turn', description: 'turn detection', keywords: ['turn'] }]);
    const { out } = await evaluate({ candidates: [pick('hf:a/m')] });
    const ev = out!.evaluations[0]!;
    expect(ev.license.verdict).toBe('compatible');
    expect(ev.flags).not.toContain('custom_model_license');
    expect(ev.weights_license).toMatchObject({ verdict: 'compatible', spdx: 'Apache-2.0' });
  });

  it('carries the gated_model flag from the enricher', async () => {
    h = await createHarness({
      enrichers: [hfEnricher({ 'hf:a/gated': { ...apacheCard, flags: ['gated_model'], model_license: { ...apacheCard.model_license, gated: true } } })],
    });
    await seedComponents(h, [{ name: 'Turn', description: 'turn detection', keywords: ['turn'] }]);
    const { out } = await evaluate({ candidates: [pick('hf:a/gated')] });
    expect(out!.evaluations[0]!.flags).toContain('gated_model');
  });

  it('a model that cannot be retrieved is unknown', async () => {
    h = await createHarness({ enrichers: [hfEnricher({})] });
    await seedComponents(h, [{ name: 'Turn', description: 'turn detection', keywords: ['turn'] }]);
    const { out } = await evaluate({ candidates: [pick('hf:a/gone')] });
    expect(out!.evaluations[0]!.license.verdict).toBe('unknown');
  });
});

describe('rw_evaluate: weights_ref', () => {
  const setup = async (cards: Record<string, Record<string, unknown> | undefined>) => {
    h = await createHarness({
      enrichers: [fakeEnricher(['npm'], (ref) => goodCode(ref)), hfEnricher(cards)],
    });
    await seedComponents(h, [{ name: 'Turn', description: 'turn detection', keywords: ['turn'] }]);
  };

  it('the final verdict is the worse of code and weights, and both are recorded', async () => {
    await setup({ 'hf:livekit/turn-detector': customCard });
    const { out } = await evaluate({ candidates: [pick('npm:turn-lib', { weights_ref: 'hf:livekit/turn-detector' })] });
    const ev = out!.evaluations[0]!;
    expect(ev.license.verdict).toBe('unknown');
    expect(ev.flags).toContain('custom_model_license');
    expect(ev.flags).not.toContain('model_weights_unverified');
    expect(ev.hint).toBe('reference');
    expect(ev.weights_license).toMatchObject({
      ref: 'hf:livekit/turn-detector',
      verdict: 'unknown',
      code_verdict: 'compatible',
    });
    // obligations and notes of both
    expect(ev.license.notes.join(' ')).toMatch(/licensed separately from the code/);
  });

  it('a compatible model card leaves a compatible code candidate adoptable', async () => {
    await setup({ 'hf:a/m': apacheCard });
    const { out } = await evaluate({ candidates: [pick('npm:turn-lib', { weights_ref: 'hf:a/m' })] });
    const ev = out!.evaluations[0]!;
    expect(ev.license.verdict).toBe('compatible');
    expect(ev.hint).toBe('adopt');
    expect(ev.weights_license).toMatchObject({ verdict: 'compatible', spdx: 'Apache-2.0' });
  });

  it('an incompatible code license is not improved by good weights', async () => {
    h = await createHarness({
      enrichers: [fakeEnricher(['npm'], (ref) => goodCode(ref, { license_spdx: 'AGPL-3.0-only' })), hfEnricher({ 'hf:a/m': apacheCard })],
    });
    await seedComponents(h, [{ name: 'Turn', description: 'turn detection', keywords: ['turn'] }]);
    const { out } = await evaluate({ candidates: [pick('npm:turn-lib', { weights_ref: 'hf:a/m' })] });
    expect(out!.evaluations[0]!.license.verdict).not.toBe('compatible');
    expect(out!.evaluations[0]!.weights_license!.code_verdict).not.toBe('compatible');
  });

  it('warns when the model card could not be retrieved and treats the weights as unknown', async () => {
    await setup({});
    const { out } = await evaluate({ candidates: [pick('npm:turn-lib', { weights_ref: 'hf:a/gone' })] });
    expect(out!.evaluations[0]!.license.verdict).toBe('unknown');
    expect(out!.warnings!.join(' ')).toContain('hf:a/gone: the model card could not be retrieved');
  });

  it.each([
    ['a non-hf weights_ref', pick('npm:turn-lib', { weights_ref: 'npm:other' })],
    ['weights_ref on an hf candidate', pick('hf:a/m', { weights_ref: 'hf:a/other' })],
  ])('rejects %s', async (_n, candidate) => {
    await setup({ 'hf:a/m': apacheCard });
    const r = await h!.call('rw_evaluate', { component_id: 'turn', candidates: [candidate] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('weights_ref');
  });
});

describe('rw_evaluate: model_weights_unverified heuristic', () => {
  const setup = async (descriptor: string | undefined) => {
    h = await createHarness({
      enrichers: [fakeEnricher(['npm', 'github'], (ref) => goodCode(ref, descriptor !== undefined ? { descriptor } : {}))],
    });
    await seedComponents(h, [{ name: 'Turn', description: 'turn detection', keywords: ['turn'] }]);
  };

  it('flags a package whose name sounds like ML, with a warning and the hint unchanged', async () => {
    await setup(undefined);
    const { out } = await evaluate({ candidates: [pick('npm:livekit-plugins-turn-detector')] });
    const ev = out!.evaluations[0]!;
    expect(ev.flags).toContain('model_weights_unverified');
    expect(ev.hint).toBe('adopt');
    expect(ev.license.verdict).toBe('compatible');
    expect(ev.weights_license).toBeUndefined();
    const warning = out!.warnings!.find((w) => w.includes('may load pretrained model weights'))!;
    expect(warning).toContain('npm:livekit-plugins-turn-detector');
    expect(warning).toContain('weights_ref="hf:<owner>/<model>"');
  });

  it('flags a package whose descriptor has strong ML terms', async () => {
    await setup('Fast ONNX runtime wrapper for voice agents');
    const { out } = await evaluate({ candidates: [pick('github:acme/runner')] });
    expect(out!.evaluations[0]!.flags).toContain('model_weights_unverified');
  });

  it('does not flag weak task words in a free-form descriptor', async () => {
    await setup('A voice recorder utility with a detector for silence');
    const { out } = await evaluate({ candidates: [pick('npm:recorder')] });
    expect(out!.evaluations[0]!.flags).not.toContain('model_weights_unverified');
    expect(out!.warnings ?? []).toEqual([]);
  });

  it('does not flag an ordinary package', async () => {
    await setup('Markdown to PDF converter');
    const { out } = await evaluate({ candidates: [pick('npm:md-pdf')] });
    expect(out!.evaluations[0]!.flags).not.toContain('model_weights_unverified');
  });

  it('is not raised when weights_ref is given', async () => {
    h = await createHarness({
      enrichers: [fakeEnricher(['npm'], (ref) => goodCode(ref)), hfEnricher({ 'hf:a/m': apacheCard })],
    });
    await seedComponents(h, [{ name: 'Turn', description: 'turn detection', keywords: ['turn'] }]);
    const { out } = await evaluate({ candidates: [pick('npm:turn-detector-lib', { weights_ref: 'hf:a/m' })] });
    expect(out!.evaluations[0]!.flags).not.toContain('model_weights_unverified');
  });
});

describe('rw_evaluate: saas: candidates', () => {
  /** Id of the evidence recorded by `setup`: a page on the vendor's own domain (acme.test). */
  let evidenceId = '';
  const terms = (over: Record<string, unknown> = {}) => ({
    maturity: 'ga',
    vendor_domains: ['acme.test'],
    pricing: { checked: true, summary: 'Free tier 1000 req/day', evidence_id: evidenceId },
    data_use: { policy: 'no_training', evidence_id: evidenceId },
    lock_in: 'low',
    exit_path: 'Export transcripts as JSON, swap to another ASR vendor.',
    ...over,
  });
  const setup = async () => {
    h = await createHarness({ enrichers: [fakeEnricher(['npm'], (ref) => goodCode(ref))] });
    await seedComponents(h, [{ name: 'Turn', description: 'turn detection', keywords: ['turn'] }]);
    const ev = await h.call('rw_record_evidence', {
      component_id: 'turn',
      kind: 'web',
      summary: 'Read the pricing and data-use pages of the vendor.',
      results: [{ url: 'https://acme.test/pricing', ref: 'saas:acme/asr' }],
    });
    evidenceId = (ev.structured as { evidence_id: string }).evidence_id;
  };

  it('scores verified terms on the SaaS profile and records the terms', async () => {
    await setup();
    const { out } = await evaluate({ candidates: [pick('saas:acme/asr', { saas: terms({ sdk_ref: 'npm:acme-sdk' }) })] });
    const ev = out!.evaluations[0]!;
    expect(ev.profile).toBe('saas');
    // maturity 20 + terms 20 + lock_in 20 + sdk (MIT compatible 10 + maintenance) + fit 16
    expect(ev.scores).toMatchObject({ maturity: 20, terms: 20, lock_in: 20, fit: 16 });
    expect((ev.scores as { sdk: number }).sdk).toBeGreaterThanOrEqual(10);
    expect(ev.total).toBe(Object.values(ev.scores).reduce((a, b) => a + b, 0));
    expect(ev.saas).toMatchObject({ maturity: 'ga', lock_in: 'low' });
    expect(ev.saas_sdk).toMatchObject({ ref: 'npm:acme-sdk', verdict: 'compatible', spdx: 'MIT' });
    expect(ev.license).toMatchObject({ candidate_spdx: 'Vendor terms of service', verdict: 'conditional', category: 'non_oss', source: 'agent' });
    expect(ev.flags).not.toContain('saas_terms_unverified');
    expect(ev.flags).not.toContain('saas_evidence_missing');
    expect(ev.flags).not.toContain('saas_terms_secondhand');
    expect(ev.flags).not.toContain('no_sdk');
    expect(ev.saas).toMatchObject({
      vendor_domains: ['acme.test'],
      pricing: { source: 'first_party' },
      data_use: { source: 'first_party' },
    });
    expect(ev.metrics).toEqual({});
  });

  it('caps unverified terms at reference and raises saas_terms_unverified', async () => {
    await setup();
    const { out } = await evaluate({
      candidates: [pick('saas:acme/asr', { fit: 5, saas: terms({ pricing: { checked: false } }) })],
    });
    const ev = out!.evaluations[0]!;
    expect(ev.flags).toEqual(expect.arrayContaining(['saas_terms_unverified', 'no_sdk']));
    expect(ev.missing).toContain('pricing');
    expect(ev.hint).toBe('reference');
  });

  it('no SDK scores 0 on the SDK axis and flags no_sdk', async () => {
    await setup();
    const { out } = await evaluate({ candidates: [pick('saas:acme/asr', { saas: terms() })] });
    const ev = out!.evaluations[0]!;
    expect((ev.scores as { sdk: number }).sdk).toBe(0);
    expect(ev.flags).toContain('no_sdk');
    expect(ev.saas_sdk).toBeUndefined();
  });

  it('renders SaaS candidates in their own table', async () => {
    await setup();
    const { r } = await evaluate({ candidates: [pick('saas:acme/asr', { saas: terms() }), pick('npm:md-lib')] });
    expect(r.text).toContain('Lock-in');
    expect(r.text).toContain('saas:acme/asr');
    expect(r.text).toContain('npm:md-lib');
  });

  it('requires the saas block for saas refs and forbids it elsewhere', async () => {
    await setup();
    const missing = await h!.call('rw_evaluate', { component_id: 'turn', candidates: [pick('saas:acme/asr')] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('requires the "saas" block');
    const extra = await h!.call('rw_evaluate', { component_id: 'turn', candidates: [pick('npm:x', { saas: terms() })] });
    expect(extra.isError).toBe(true);
    expect(extra.text).toContain('only for "saas:" refs');
  });

  it('rejects an sdk_ref that is not a package ref and a too-short exit path', async () => {
    await setup();
    const badSdk = await h!.call('rw_evaluate', {
      component_id: 'turn',
      candidates: [pick('saas:acme/asr', { saas: terms({ sdk_ref: 'saas:other/x' }) })],
    });
    expect(badSdk.isError).toBe(true);
    expect(badSdk.text).toContain('sdk_ref');
    const badExit = await h!.call('rw_evaluate', {
      component_id: 'turn',
      candidates: [pick('saas:acme/asr', { saas: terms({ exit_path: 'n/a' }) })],
    });
    expect(badExit.isError).toBe(true);
  });

  it('persists the evaluation so rw_decide can check it', async () => {
    await setup();
    await evaluate({ candidates: [pick('saas:acme/asr', { saas: terms({ pricing: { checked: false } }) })] });
    const state = h!.state();
    expect(state.evaluations[0]).toMatchObject({ ref: 'saas:acme/asr', profile: 'saas' });
    const decide = await h!.call('rw_decide', {
      component_id: 'turn',
      decision: 'adopt',
      ref: 'saas:acme/asr',
      rationale: 'Hosted ASR fits the latency need.',
    });
    expect(decide.isError).toBe(true);
    expect(decide.text).toContain('saas_terms_unverified');
  });
});

describe('rw_decide and rw_record_evidence accept hf: and saas: refs', () => {
  it('adopts a service with verified terms, listing hf and saas alternatives', async () => {
    h = await createHarness({ enrichers: [fakeEnricher(['npm'], (ref) => goodCode(ref))] });
    await seedComponents(h, [{ name: 'Turn', description: 'turn detection', keywords: ['turn'] }]);
    const ev = await h.call('rw_record_evidence', {
      component_id: 'turn',
      kind: 'web',
      summary: 'Read the pricing and data-use pages of the vendor.',
      results: [
        { url: 'https://acme.test/pricing', ref: 'saas:acme/asr' },
        { url: 'https://huggingface.co/livekit/turn-detector', ref: 'hf:livekit/turn-detector' },
      ],
    });
    expect(ev.isError).toBe(false);
    const evidenceId = (ev.structured as { evidence_id: string }).evidence_id;
    await evaluate({
      candidates: [
        pick('saas:acme/asr', {
          saas: {
            maturity: 'ga',
            vendor_domains: ['acme.test'],
            pricing: { checked: true, evidence_id: evidenceId },
            data_use: { policy: 'no_training', evidence_id: evidenceId },
            lock_in: 'low',
            exit_path: 'Export transcripts as JSON, swap vendor.',
          },
        }),
      ],
    });
    const r = await h.call('rw_decide', {
      component_id: 'turn',
      decision: 'adopt',
      ref: 'saas:acme/asr',
      rationale: 'Hosted ASR fits the latency need and the terms were verified.',
      alternatives: [{ ref: 'hf:livekit/turn-detector', why_not: 'Custom model license is unclear for commercial use.' }],
    });
    expect(r.isError).toBe(false);
    const state = h.state();
    expect(state.decisions[0]).toMatchObject({ ref: 'saas:acme/asr', alternatives: [{ ref: 'hf:livekit/turn-detector' }] });
    expect(state.evidence.find((e) => e.id === evidenceId)!.result_refs).toEqual(['saas:acme/asr', 'hf:livekit/turn-detector']);
    const md = await h.call('rw_decide', { component_id: 'turn', decision: 'reference', ref: 'hf:livekit/turn-detector', rationale: 'Reading the model card for ideas only.' });
    expect(md.isError).toBe(false);
  });
});
