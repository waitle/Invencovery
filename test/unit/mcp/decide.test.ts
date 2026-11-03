import { afterEach, describe, expect, it } from 'vitest';
import { DecideOutputSchema } from '../../../src/mcp/tools/decide.js';
import { EvaluateOutputSchema } from '../../../src/mcp/tools/evaluate.js';
import { SearchOutputSchema } from '../../../src/mcp/tools/search.js';
import { cleanupTmpDirs } from '../../helpers/tmp.js';
import { FIXED_NOW, PROJECT, candidate, component, createHarness, fakeAdapter, fakeEnricher, seedComponents } from './_harness.js';
import type { Harness } from './_harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupTmpDirs();
});

const RATIONALE = 'Maintained, MIT licensed and covers every requirement of the component.';

function enricher(license: string) {
  return fakeEnricher(['github'], (ref) => ({
    metrics: { stars: 10000, last_commit_at: '2026-09-12T00:00:00.000Z', direct_dependencies: 2 },
    license_spdx: license,
    repository_url: `https://github.com/${ref.slice('github:'.length)}`,
  }));
}

async function evaluate(harness: Harness, ref = 'github:acme/md'): Promise<void> {
  const r = await harness.call('rw_evaluate', {
    component_id: 'markdown',
    candidates: [{ ref, fit: 4, fit_reason: 'Covers the needed parsing features.' }],
  });
  if (r.isError) throw new Error(r.text);
}

async function webEvidence(harness: Harness, kind: 'web' | 'code_search' = 'web'): Promise<string> {
  const r = await harness.call('rw_record_evidence', {
    component_id: 'markdown',
    kind,
    query: 'markdown parser',
    tool: kind === 'web' ? 'WebSearch' : 'GrepMCP',
    summary: 'Searched; nothing better than what rw_search found.',
    results: [],
  });
  if (r.isError) throw new Error(r.text);
  return (r.structured as { evidence_id: string }).evidence_id;
}

describe('rw_decide', () => {
  it('rejects adopt without an evaluation and points to rw_evaluate', async () => {
    h = await createHarness({ enrichers: [enricher('MIT')] });
    await seedComponents(h);
    const r = await h.call('rw_decide', { component_id: 'markdown', decision: 'adopt', ref: 'github:acme/md', rationale: RATIONALE });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('rw_decide');
    expect(r.text).toContain('rw_evaluate');
    expect(h.state().decisions).toEqual([]);
    expect(h.state().components[0]!.status).toBe('pending');
  });

  it('adopts an evaluated candidate and marks the component decided', async () => {
    h = await createHarness({ enrichers: [enricher('MIT')] });
    await seedComponents(h);
    await evaluate(h);
    const r = await h.call('rw_decide', {
      component_id: 'markdown',
      decision: 'adopt',
      ref: 'github:acme/md',
      version: '1.2.3',
      rationale: RATIONALE,
      alternatives: [{ ref: 'github:acme/other', why_not: 'abandoned' }],
    });
    expect(r.isError).toBe(false);
    const out = DecideOutputSchema.parse(r.structured);
    // The first decision makes the unchecked cross-cutting concerns worth a warning.
    expect(out.warnings).toEqual([
      'cross-cutting concern not checked: cost',
      'cross-cutting concern not checked: distribution_policy',
      'cross-cutting concern not checked: legal_privacy',
      'cross-cutting concern not checked: operations',
      'cross-cutting concern not checked: security',
    ]);
    expect(out.ledger_path).toBe(h.ctx.ledger().path);

    const state = h.state();
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      id: out.decision_id,
      component_id: 'markdown',
      decision: 'adopt',
      ref: 'github:acme/md',
      version: '1.2.3',
      decided_by: 'agent',
      decided_at: FIXED_NOW.toISOString(),
      alternatives: [{ ref: 'github:acme/other', why_not: 'abandoned' }],
    });
    expect(state.decisions[0]!.evidence_ids).toEqual(state.evidence.map((e) => e.id));
    expect(state.components[0]!.status).toBe('decided');
    expect(r.text).toContain(out.decision_id);
  });

  it('rejects an incompatible license, and records an override with warnings', async () => {
    h = await createHarness({ enrichers: [enricher('AGPL-3.0-only')] });
    await seedComponents(h, [component('Markdown')], { ...PROJECT, distribution: 'saas' });
    await evaluate(h);
    const base = { component_id: 'markdown', decision: 'adopt', ref: 'github:acme/md', rationale: RATIONALE };

    const rejected = await h.call('rw_decide', base);
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain('incompatible');
    expect(h.state().decisions).toEqual([]);

    const short = await h.call('rw_decide', { ...base, override: { reason: 'too short' } });
    expect(short.isError).toBe(true);
    expect(short.text).toContain('override.reason');

    const byAgent = await h.call('rw_decide', { ...base, override: { reason: 'The user accepted the AGPL risk in chat.' } });
    expect(byAgent.isError).toBe(false);
    const agentWarnings = DecideOutputSchema.parse(byAgent.structured).warnings;
    expect(agentWarnings.some((w) => w.startsWith('override applied:'))).toBe(true);
    expect(agentWarnings.some((w) => w.includes('decided_by "user"'))).toBe(true);

    const byUser = await h.call('rw_decide', {
      ...base,
      decided_by: 'user',
      override: { reason: 'The user accepted the AGPL risk in chat.' },
    });
    const userWarnings = DecideOutputSchema.parse(byUser.structured).warnings;
    expect(userWarnings.some((w) => w.startsWith('override applied:'))).toBe(true);
    expect(userWarnings.some((w) => w.includes('decided_by "user"'))).toBe(false);
    const state = h.state();
    expect(state.decisions[0]).toMatchObject({ decided_by: 'user', override: { reason: 'The user accepted the AGPL risk in chat.' } });
    expect(state.history).toHaveLength(1);
  });

  it('does not let an exception through for unknown licenses without override', async () => {
    h = await createHarness({ enrichers: [enricher('')] });
    await seedComponents(h);
    await evaluate(h);
    const r = await h.call('rw_decide', { component_id: 'markdown', decision: 'adopt', ref: 'github:acme/md', rationale: RATIONALE });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown|incompatible/);
  });

  it('applies the build rules', async () => {
    h = await createHarness();
    await seedComponents(h);
    const base = { component_id: 'markdown', decision: 'build', rationale: 'Nothing on the market fits, so we implement it ourselves.' };

    const noReason = await h.call('rw_decide', base);
    expect(noReason.isError).toBe(true);
    expect(noReason.text).toContain('build_reason');

    const noEvidence = await h.call('rw_decide', { ...base, build_reason: 'no_candidate' });
    expect(noEvidence.isError).toBe(true);
    expect(noEvidence.text).toContain('>=2 distinct sources');

    await webEvidence(h, 'web');
    const oneSource = await h.call('rw_decide', { ...base, build_reason: 'no_candidate' });
    expect(oneSource.isError).toBe(true);

    await webEvidence(h, 'code_search');
    const ok = await h.call('rw_decide', { ...base, build_reason: 'no_candidate' });
    expect(ok.isError).toBe(false);
    expect(h.state().decisions[0]).toMatchObject({ decision: 'build', build_reason: 'no_candidate' });
    expect(ok.text).toContain('Reference decision id');
  });

  it('allows a trivial build without any evidence', async () => {
    h = await createHarness();
    await seedComponents(h, [component('Markdown', { trivial: true })]);
    const r = await h.call('rw_decide', {
      component_id: 'markdown',
      decision: 'build',
      build_reason: 'trivial',
      rationale: 'A three line helper is not worth a dependency.',
    });
    expect(r.isError).toBe(false);
  });

  it('counts rw_search evidence sources, including zero-hit ones, toward the build rule', async () => {
    h = await createHarness({
      adapters: {
        github_repo: fakeAdapter('github_repo', () => ({ candidates: [] })),
        npm: fakeAdapter('npm', () => ({ candidates: [candidate('npm:nope', 'npm')] })),
      },
    });
    await seedComponents(h);
    SearchOutputSchema.parse((await h.call('rw_search', { component_id: 'markdown' })).structured);
    const r = await h.call('rw_decide', {
      component_id: 'markdown',
      decision: 'build',
      build_reason: 'too_heavy',
      rationale: 'The only hit is far heavier than what the component needs.',
    });
    expect(r.isError).toBe(false);
  });

  it('applies the reference rules and records attribution', async () => {
    h = await createHarness();
    await seedComponents(h);
    const noRef = await h.call('rw_decide', { component_id: 'markdown', decision: 'reference', rationale: RATIONALE });
    expect(noRef.isError).toBe(true);
    expect(noRef.text).toContain('ref');

    const plain = await h.call('rw_decide', {
      component_id: 'markdown',
      decision: 'reference',
      ref: 'web:https://example.com/design',
      rationale: 'Used only as a design reference for the API shape.',
    });
    expect(plain.isError).toBe(false);
    expect(DecideOutputSchema.parse(plain.structured).warnings.join(' ')).toContain('attribution');

    const attributed = await h.call('rw_decide', {
      component_id: 'markdown',
      decision: 'reference',
      ref: 'github:acme/md',
      rationale: 'Copied one helper file; the rest is our own design.',
      attribution: { source_url: 'https://github.com/acme/md', license: 'MIT', files: ['src/util.ts'] },
    });
    expect(attributed.isError).toBe(false);
    expect(h.state().decisions[0]!.attribution).toMatchObject({ license: 'MIT', files: ['src/util.ts'] });
  });

  it('moves a replaced decision to history', async () => {
    h = await createHarness({ enrichers: [enricher('MIT')] });
    await seedComponents(h, [component('Markdown', { trivial: true })]);
    const first = DecideOutputSchema.parse(
      (
        await h.call('rw_decide', {
          component_id: 'markdown',
          decision: 'build',
          build_reason: 'trivial',
          rationale: 'A three line helper is not worth a dependency.',
        })
      ).structured,
    );
    await evaluate(h);
    const second = DecideOutputSchema.parse(
      (await h.call('rw_decide', { component_id: 'markdown', decision: 'adopt', ref: 'github:acme/md', rationale: RATIONALE })).structured,
    );
    const state = h.state();
    expect(state.decisions.map((d) => d.id)).toEqual([second.decision_id]);
    expect(state.history.map((d) => d.id)).toEqual([first.decision_id]);
  });

  it('cites explicit evidence ids and rejects unknown ones', async () => {
    h = await createHarness();
    await seedComponents(h, [component('Markdown', { trivial: true })]);
    const ev1 = await webEvidence(h);
    await webEvidence(h, 'code_search');
    const base = {
      component_id: 'markdown',
      decision: 'build',
      build_reason: 'trivial',
      rationale: 'A three line helper is not worth a dependency.',
    };
    const bad = await h.call('rw_decide', { ...base, evidence_ids: ['ev_missing'] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('ev_missing');

    const ok = await h.call('rw_decide', { ...base, evidence_ids: [ev1] });
    expect(ok.isError).toBe(false);
    expect(h.state().decisions[0]!.evidence_ids).toEqual([ev1]);
  });

  it('rejects unknown components and schema violations, naming rw_decide', async () => {
    h = await createHarness();
    await seedComponents(h);
    const unknown = await h.call('rw_decide', { component_id: 'nope', decision: 'build', build_reason: 'trivial', rationale: RATIONALE });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('rw_decide');
    expect(unknown.text).toContain('rw_decompose');

    const bad = [
      { component_id: 'markdown', decision: 'build', build_reason: 'trivial', rationale: 'too short' },
      { component_id: 'markdown', decision: 'maybe', rationale: RATIONALE },
      { component_id: 'markdown', decision: 'build', build_reason: 'because', rationale: RATIONALE },
      { component_id: 'markdown', decision: 'adopt', ref: 'bogus', rationale: RATIONALE },
    ];
    for (const args of bad) expect((await h.call('rw_decide', args)).isError).toBe(true);
    expect(h.state().decisions).toEqual([]);
  });

  it('runs the full decompose -> search -> evaluate -> decide flow', async () => {
    h = await createHarness({
      adapters: {
        github_repo: fakeAdapter('github_repo', () => ({
          candidates: [candidate('github:acme/md', 'github_repo', { stars: 900, repository_url: 'https://github.com/acme/md' })],
        })),
        npm: fakeAdapter('npm', () => ({ candidates: [] })),
      },
      enrichers: [enricher('MIT')],
    });
    const decomposed = await h.call('rw_decompose', {
      project: { ...PROJECT },
      components: [component('Markdown')],
    });
    expect(decomposed.isError).toBe(false);

    const search = SearchOutputSchema.parse((await h.call('rw_search', { component_id: 'markdown' })).structured);
    const ref = search.candidates[0]!.ref;
    expect(ref).toBe('github:acme/md');

    const evaluated = EvaluateOutputSchema.parse(
      (
        await h.call('rw_evaluate', {
          component_id: 'markdown',
          candidates: [{ ref, fit: 4, fit_reason: 'Covers the needed parsing features.' }],
        })
      ).structured,
    );
    expect(evaluated.recommendation).toMatchObject({ hint: 'adopt', ref });

    const decided = await h.call('rw_decide', { component_id: 'markdown', decision: 'adopt', ref, rationale: RATIONALE });
    expect(decided.isError).toBe(false);

    const state = h.state();
    expect(state.components[0]!.status).toBe('decided');
    expect(state.decisions[0]!.evidence_ids).toEqual([search.evidence_id, evaluated.evidence_id]);
  });
});
