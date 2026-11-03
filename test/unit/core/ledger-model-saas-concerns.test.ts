import { describe, expect, it } from 'vitest';
import { concernWebUsage, usageFor } from '../../../src/core/budget.js';
import {
  distinctEvidenceSources,
  parseLedgerText,
  reduceEvents,
  renderMarkdown,
  renderNotices,
  strictEventProblem,
  validateDecision,
} from '../../../src/core/ledger.js';
import type { DecisionInput } from '../../../src/core/ledger.js';
import type {
  Component,
  Decision,
  Evaluation,
  Evidence,
  LedgerEvent,
  LedgerState,
  LicenseVerdict,
  ProjectInfo,
  SaasTerms,
  WeightsLicense,
} from '../../../src/types.js';

const AT = '2026-10-01T00:00:00.000Z';

const project: ProjectInfo = {
  name: 'Voice App',
  summary: 'A voice agent',
  license: 'MIT',
  distribution: 'application',
  ecosystems: ['npm'],
};

const component = (id: string): Component => ({ id, name: `Comp ${id}`, description: 'd', keywords: ['k'], status: 'pending' });

function evidence(id: string, componentId: string, over: Partial<Evidence> = {}): Evidence {
  return { id, component_id: componentId, kind: 'web', at: AT, result_refs: [], summary: 'summary text', ...over };
}

function license(verdict: LicenseVerdict['verdict'], over: Partial<LicenseVerdict> = {}): LicenseVerdict {
  return {
    candidate_spdx: 'MIT',
    project_spdx: 'MIT',
    distribution: 'application',
    category: 'permissive',
    verdict,
    obligations: [],
    notes: ['Not legal advice'],
    source: 'github',
    ...over,
  };
}

function evaluation(componentId: string, ref: string, over: Partial<Evaluation> = {}): Evaluation {
  return {
    ref,
    component_id: componentId,
    metrics: {},
    scores: { maintenance: 25, popularity: 10, community: 5, license: 20, dependencies: 10, fit: 16 },
    total: 86,
    license: license('compatible'),
    fit: { value: 4, reason: 'covers the use case' },
    flags: [],
    missing: [],
    hint: 'adopt',
    scoring_version: 1,
    provenance: 'live',
    ...over,
  };
}

const saasTerms: SaasTerms = {
  maturity: 'ga',
  vendor_domains: ['acme.test'],
  pricing: { checked: true, evidence_id: 'ev_p', source: 'first_party' },
  data_use: { policy: 'no_training', evidence_id: 'ev_d', source: 'first_party' },
  lock_in: 'low',
  exit_path: 'Export all data as JSON.',
};

function saasEvaluation(componentId: string, ref: string, over: Partial<Evaluation> = {}): Evaluation {
  return evaluation(componentId, ref, {
    profile: 'saas',
    scores: { maturity: 20, terms: 20, lock_in: 20, sdk: 0, fit: 16 },
    license: license('conditional', { candidate_spdx: 'Vendor terms of service', category: 'non_oss', source: 'agent' }),
    saas: saasTerms,
    flags: ['no_sdk'],
    ...over,
  });
}

function weights(over: Partial<WeightsLicense> = {}): WeightsLicense {
  return {
    ref: 'hf:livekit/turn-detector',
    verdict: 'unknown',
    code_verdict: 'compatible',
    spdx: null,
    license_name: 'livekit-model-license',
    source: 'huggingface',
    ...over,
  };
}

function stateOf(parts: Partial<Pick<LedgerState, 'components' | 'evidence' | 'evaluations' | 'decisions'>>): LedgerState {
  return {
    project,
    components: parts.components ?? [component('c1')],
    evidence: parts.evidence ?? [],
    evaluations: parts.evaluations ?? [],
    decisions: parts.decisions ?? [],
    history: [],
  };
}

const base = (over: Partial<DecisionInput>): DecisionInput => ({
  component_id: 'c1',
  decision: 'adopt',
  rationale: 'A sufficiently long rationale text.',
  ...over,
});

describe('validateDecision: model weights', () => {
  const customWeights = () =>
    stateOf({
      evaluations: [
        evaluation('c1', 'npm:turn-lib', {
          license: license('unknown', { candidate_spdx: 'MIT AND livekit-model-license' }),
          weights_license: weights({ ref: 'hf:livekit/turn-detector', verdict: 'unknown', code_verdict: 'compatible' }),
          flags: ['custom_model_license'],
        }),
      ],
    });

  it('rejects adopting when the weights license is unknown, naming the weights', () => {
    const r = validateDecision(customWeights(), base({ ref: 'npm:turn-lib' }));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('"unknown"');
    expect(r.errors[0]).toContain('model weights');
    expect(r.errors[0]).toContain('hf:livekit/turn-detector');
  });

  it('demotes the model-license violation to a warning when decided_by is user', () => {
    const r = validateDecision(customWeights(), base({ ref: 'npm:turn-lib', decided_by: 'user' }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toContain('proceeding because decided_by is "user"');
    expect(r.warnings.join(' ')).toContain('Read the model license text first');
  });

  it('an override also demotes it, like any violation', () => {
    const r = validateDecision(customWeights(), base({ ref: 'npm:turn-lib', override: { reason: 'Vendor confirmed commercial use in writing.' } }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('keeps a bad CODE license strict even for the user', () => {
    const s = stateOf({
      evaluations: [
        evaluation('c1', 'npm:turn-lib', {
          license: license('incompatible', { candidate_spdx: 'GPL-3.0-only' }),
          weights_license: weights({ verdict: 'unknown', code_verdict: 'incompatible' }),
        }),
      ],
    });
    const r = validateDecision(s, base({ ref: 'npm:turn-lib', decided_by: 'user' }));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).not.toContain('model weights');
  });

  it('an hf: candidate whose license is unknown is a model-license violation the user may accept', () => {
    const s = stateOf({
      evaluations: [
        evaluation('c1', 'hf:livekit/turn-detector', {
          license: license('unknown', { candidate_spdx: 'livekit-model-license', source: 'huggingface' }),
          weights_license: weights({ code_verdict: 'unknown' }),
          flags: ['custom_model_license'],
        }),
      ],
    });
    expect(validateDecision(s, base({ ref: 'hf:livekit/turn-detector' })).errors).toHaveLength(1);
    const user = validateDecision(s, base({ ref: 'hf:livekit/turn-detector', decided_by: 'user' }));
    expect(user.errors).toEqual([]);
    expect(user.warnings.join(' ')).toContain('decided_by is "user"');
  });

  it('a conditional weights verdict only warns', () => {
    const s = stateOf({
      evaluations: [
        evaluation('c1', 'npm:turn-lib', {
          license: license('conditional', { obligations: ['Accept the Llama community license'] }),
          weights_license: weights({ verdict: 'conditional', code_verdict: 'compatible', spdx: null }),
        }),
      ],
    });
    const r = validateDecision(s, base({ ref: 'npm:turn-lib' }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toContain('Llama community license');
  });

  it('warns on model_weights_unverified without blocking', () => {
    const s = stateOf({ evaluations: [evaluation('c1', 'npm:voice-lib', { flags: ['model_weights_unverified'] })] });
    const r = validateDecision(s, base({ ref: 'npm:voice-lib' }));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('model_weights_unverified');
    expect(r.warnings[0]).toContain('weights_ref="hf:<owner>/<model>"');
  });
});

describe('validateDecision: SaaS', () => {
  const unverified = () =>
    stateOf({
      evaluations: [
        saasEvaluation('c1', 'saas:acme/voice', {
          saas: { ...saasTerms, pricing: { checked: false } },
          flags: ['saas_terms_unverified', 'no_sdk'],
          hint: 'reference',
        }),
      ],
    });

  it('rejects adopt/extend while the terms are unverified', () => {
    for (const decision of ['adopt', 'extend'] as const) {
      const r = validateDecision(unverified(), base({ decision, ref: 'saas:acme/voice' }));
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain('saas_terms_unverified');
      expect(r.errors[0]).toContain('choose "reference"');
    }
  });

  it('demotes to a warning when decided_by is user, or with an override', () => {
    const user = validateDecision(unverified(), base({ ref: 'saas:acme/voice', decided_by: 'user' }));
    expect(user.errors).toEqual([]);
    expect(user.warnings.join(' ')).toContain('Proceeding because decided_by is "user"');
    const override = validateDecision(unverified(), base({ ref: 'saas:acme/voice', override: { reason: 'Pricing page is behind a sales call.' } }));
    expect(override.errors).toEqual([]);
  });

  it('allows reference while the terms are unverified', () => {
    const r = validateDecision(unverified(), base({ decision: 'reference', ref: 'saas:acme/voice' }));
    expect(r.errors).toEqual([]);
  });

  it('accepts verified terms with cited evidence in the ledger, warning on the conditional vendor terms', () => {
    const s = stateOf({
      evaluations: [saasEvaluation('c1', 'saas:acme/voice')],
      evidence: [evidence('ev_p', 'c1'), evidence('ev_d', 'c1')],
    });
    const r = validateDecision(s, base({ ref: 'saas:acme/voice' }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toContain('conditional');
    expect(r.warnings.join(' ')).not.toContain('not in the ledger');
  });

  it('warns about evidence ids that are not in the ledger', () => {
    const s = stateOf({ evaluations: [saasEvaluation('c1', 'saas:acme/voice', { flags: ['no_sdk'] })] });
    const w = validateDecision(s, base({ ref: 'saas:acme/voice' })).warnings.join(' ');
    expect(w).toContain('not in the ledger');
    expect(w).toContain('ev_p');
  });

  describe.each([
    ['saas_evidence_missing', 'cite no evidence that is in the ledger'],
    ['saas_terms_secondhand', 'outside the vendor domains'],
  ])('gate flag %s', (flag, wording) => {
    const gated = () =>
      stateOf({
        evaluations: [saasEvaluation('c1', 'saas:acme/voice', { flags: [flag, 'no_sdk'], hint: 'reference' })],
        evidence: [evidence('ev_p', 'c1'), evidence('ev_d', 'c1')],
      });

    it('blocks adopt and extend with the next action in the message', () => {
      for (const decision of ['adopt', 'extend'] as const) {
        const r = validateDecision(gated(), base({ decision, ref: 'saas:acme/voice' }));
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toContain(flag);
        expect(r.errors[0]).toContain(wording);
        expect(r.errors[0]).toContain('rw_record_evidence');
        expect(r.errors[0]).toContain('rw_evaluate');
        expect(r.errors[0]).toContain('choose "reference"');
        expect(r.errors[0]).toContain('acme.test');
      }
    });

    it('allows reference and demotes to a warning when decided_by is user', () => {
      expect(validateDecision(gated(), base({ decision: 'reference', ref: 'saas:acme/voice' })).errors).toEqual([]);
      const user = validateDecision(gated(), base({ ref: 'saas:acme/voice', decided_by: 'user' }));
      expect(user.errors).toEqual([]);
      expect(user.warnings.join(' ')).toContain(flag);
      expect(user.warnings.join(' ')).toContain('Proceeding because decided_by is "user"');
    });
  });

  it('warns when the vendor trains on submitted data', () => {
    const s = stateOf({
      evaluations: [saasEvaluation('c1', 'saas:acme/voice', { flags: ['saas_trains_on_data', 'no_sdk'] })],
      evidence: [evidence('ev_p', 'c1'), evidence('ev_d', 'c1')],
    });
    expect(validateDecision(s, base({ ref: 'saas:acme/voice' })).warnings.join(' ')).toContain('train on submitted data');
  });
});

describe('ledger strict load: concern', () => {
  const evidenceLine = (concern: unknown): string =>
    JSON.stringify({
      v: 1,
      type: 'evidence.add',
      at: AT,
      evidence: { id: 'ev_1', component_id: '_unscoped', kind: 'web', at: AT, result_refs: [], summary: 'summary text', concern },
    });

  it.each(['cost', 'distribution_policy', 'legal_privacy', 'operations', 'security'])('keeps evidence for the concern %s', (concern) => {
    const { events, warnings } = parseLedgerText(`${evidenceLine(concern)}\n`);
    expect(warnings).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it.each(['Cost', 'privacy', '', 'cost\nsecurity', 7])('skips a line whose concern is %j', (concern) => {
    const { events, warnings } = parseLedgerText(`${evidenceLine(concern)}\n${evidenceLine('cost')}\n`);
    expect(events).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^ledger line 1 skipped: not a valid ledger event/);
  });

  it('strictEventProblem accepts evidence without a concern (older ledgers)', () => {
    const e = JSON.parse(evidenceLine('cost')) as { evidence: Record<string, unknown> };
    delete e.evidence.concern;
    expect(strictEventProblem(e as unknown as LedgerEvent)).toBeUndefined();
  });
});

describe('ledger strict load: saas terms', () => {
  const line = (saas: unknown): string =>
    JSON.stringify({
      v: 1,
      type: 'evaluation.add',
      at: AT,
      evaluation: { ...saasEvaluation('c1', 'saas:acme/voice'), saas },
    });

  it('loads terms with vendor domains and sources', () => {
    const { events, warnings } = parseLedgerText(`${line(saasTerms)}
`);
    expect(warnings).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('loads terms written before vendor_domains and source existed', () => {
    const old = {
      maturity: 'ga',
      pricing: { checked: true, evidence_id: 'ev_p' },
      data_use: { policy: 'no_training', evidence_id: 'ev_d' },
      lock_in: 'low',
      exit_path: 'Export all data as JSON.',
    };
    const { events, warnings } = parseLedgerText(`${line(old)}
`);
    expect(warnings).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it.each([
    ['a URL as vendor domain', { ...saasTerms, vendor_domains: ['https://acme.test'] }],
    ['an uppercase vendor domain', { ...saasTerms, vendor_domains: ['Acme.test'] }],
    ['six vendor domains', { ...saasTerms, vendor_domains: ['a1.test', 'a2.test', 'a3.test', 'a4.test', 'a5.test', 'a6.test'] }],
    ['an unknown source', { ...saasTerms, pricing: { checked: true, source: 'vendor' } }],
  ])('skips a line with %s', (_what, saas) => {
    const { events, warnings } = parseLedgerText(`${line(saas)}
`);
    expect(events).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^ledger line 1 skipped: not a valid ledger event/);
  });
});

describe('budget and source counting exclude concern evidence', () => {
  const state = stateOf({
    evidence: [
      evidence('ev_1', 'c1', { kind: 'web' }),
      evidence('ev_2', 'c1', { kind: 'web', concern: 'cost' }),
      evidence('ev_3', 'c1', { kind: 'code_search', concern: 'security' }),
      evidence('ev_4', '_unscoped', { kind: 'web', concern: 'cost' }),
    ],
  });

  it('usageFor ignores concern evidence', () => {
    expect(usageFor(state, 'c1')).toEqual({ rounds: 0, evals: 0, web: 1 });
  });

  it('concernWebUsage counts only web evidence of that concern, project-wide', () => {
    expect(concernWebUsage(state, 'cost')).toBe(2);
    expect(concernWebUsage(state, 'security')).toBe(0); // code_search is not a web query
    expect(concernWebUsage(state, 'operations')).toBe(0);
  });

  it('distinctEvidenceSources ignores concern evidence', () => {
    expect([...distinctEvidenceSources(state.evidence.filter((e) => e.component_id === 'c1'))]).toEqual(['web']);
  });
});

describe('renderMarkdown: Services, weights and cross-cutting checks', () => {
  const decision = (over: Partial<Decision>): Decision => ({
    id: 'dec_1',
    component_id: 'c1',
    decision: 'adopt',
    ref: 'saas:acme/voice',
    rationale: 'Hosted speech service fits.',
    alternatives: [],
    evidence_ids: [],
    decided_at: AT,
    decided_by: 'agent',
    ...over,
  });

  it('lists decided services in a Services (SaaS) table with terms and exit path', () => {
    const s = stateOf({
      evaluations: [saasEvaluation('c1', 'saas:acme/voice')],
      decisions: [decision({})],
    });
    const md = renderMarkdown(s);
    expect(md).toContain('## Services (SaaS)');
    const section = md.slice(md.indexOf('## Services (SaaS)'));
    expect(section).toContain('saas:acme/voice');
    expect(section).toContain('Export all data as JSON.');
    expect(section).toMatch(/no_training/);
  });

  it('has no Services section without a saas decision', () => {
    const s = stateOf({ evaluations: [evaluation('c1', 'npm:lib')], decisions: [decision({ ref: 'npm:lib' })] });
    expect(renderMarkdown(s)).not.toContain('## Services (SaaS)');
  });

  it('shows the weights license in the license cell', () => {
    const s = stateOf({
      evaluations: [
        evaluation('c1', 'npm:turn-lib', {
          license: license('unknown'),
          weights_license: weights({ spdx: null, license_name: 'livekit-model-license' }),
        }),
      ],
      decisions: [decision({ ref: 'npm:turn-lib', decided_by: 'user' })],
    });
    expect(renderMarkdown(s)).toMatch(/weights [^|]*\(unknown\)/);
  });

  it('reports every concern as not checked or checked with an evidence count', () => {
    const s = stateOf({
      evaluations: [evaluation('c1', 'npm:lib')],
      decisions: [decision({ ref: 'npm:lib' })],
      evidence: [
        evidence('ev_c1', '_unscoped', { concern: 'cost', summary: 'Free tier covers 10k requests per month.' }),
        evidence('ev_c2', '_unscoped', { concern: 'cost', summary: 'Second source confirms.' }),
      ],
    });
    const md = renderMarkdown(s);
    const section = md.slice(md.indexOf('## Cross-cutting checks'));
    expect(section).toContain('- cost: checked (2 evidence)');
    expect(section).toContain('Second source confirms.');
    expect(section.match(/\*\*not checked\*\*/g)).toHaveLength(4);
  });

  it('omits the Cross-cutting section for an empty ledger', () => {
    expect(renderMarkdown(stateOf({}))).not.toContain('## Cross-cutting checks');
  });

  it('escapes concern evidence summaries', () => {
    const s = stateOf({
      decisions: [decision({ ref: 'npm:lib' })],
      evidence: [evidence('ev_c1', '_unscoped', { concern: 'security', summary: '<img src=x onerror=1>\n# injected heading' })],
    });
    const md = renderMarkdown(s);
    expect(md).not.toContain('<img');
    expect(md).not.toMatch(/^# injected/m);
  });
});

describe('renderNotices: services are not third-party code', () => {
  it('skips saas decisions', () => {
    const s = stateOf({
      evaluations: [saasEvaluation('c1', 'saas:acme/voice')],
      decisions: [
        {
          id: 'dec_1',
          component_id: 'c1',
          decision: 'adopt',
          ref: 'saas:acme/voice',
          rationale: 'Hosted.',
          alternatives: [],
          evidence_ids: [],
          decided_at: AT,
          decided_by: 'agent',
          attribution: { source_url: 'https://acme.test', license: 'Vendor terms' },
        },
      ],
    });
    expect(renderNotices(s)).not.toContain('saas:acme/voice');
    expect(renderNotices(s)).not.toContain('acme.test');
  });
});

describe('reduceEvents keeps weights and saas fields', () => {
  it('round-trips an evaluation with weights_license and saas blocks', () => {
    const ev = saasEvaluation('c1', 'saas:acme/voice', { weights_license: weights() });
    const state = reduceEvents([
      { v: 1, type: 'project.set', at: AT, project },
      { v: 1, type: 'component.upsert', at: AT, component: component('c1') },
      { v: 1, type: 'evaluation.add', at: AT, evaluation: ev },
    ]);
    expect(state.evaluations[0]).toMatchObject({ profile: 'saas', saas: saasTerms, weights_license: { verdict: 'unknown' } });
  });
});
