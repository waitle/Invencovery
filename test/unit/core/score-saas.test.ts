import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SAAS_LOCK_IN_POINTS,
  SAAS_MATURITY_POINTS,
  SAAS_MAX_SCORES,
  SAAS_SDK_POINTS,
  SAAS_TERMS_POINTS,
  scoreSaas,
} from '../../../src/core/score.js';
import type { SaasScoreInput } from '../../../src/core/score.js';
import type { SaasTerms } from '../../../src/types.js';

function terms(over: Partial<SaasTerms> = {}): SaasTerms {
  return {
    maturity: 'ga',
    vendor_domains: ['vendor.example.com'],
    pricing: { checked: true, evidence_id: 'ev_1', source: 'first_party' },
    data_use: { policy: 'no_training', evidence_id: 'ev_2', source: 'first_party' },
    lock_in: 'low',
    exit_path: 'Export data as JSON and switch vendor.',
    ...over,
  };
}

function input(over: Partial<SaasScoreInput> = {}): SaasScoreInput {
  return {
    saas: terms(),
    sources: { pricing: 'first_party', data_use: 'first_party' },
    sdk: { verdict: 'compatible', maintenance: 25 },
    fit: 5,
    ...over,
  };
}

describe('scoreSaas: axes', () => {
  it('maxima sum to 100', () => {
    expect(Object.values(SAAS_MAX_SCORES).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('a perfect service scores 100 and adopts with no flags', () => {
    const r = scoreSaas(input());
    expect(r.scores).toEqual({ maturity: 20, terms: 20, lock_in: 20, sdk: 20, fit: 20 });
    expect(r.total).toBe(100);
    expect(r.hint).toBe('adopt');
    expect(r.flags).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it.each([
    ['ga', 20],
    ['beta', 12],
    ['preview', 6],
    ['unknown', 0],
  ] as const)('maturity %s -> %i', (maturity, points) => {
    expect(scoreSaas(input({ saas: terms({ maturity }) })).scores.maturity).toBe(points);
    expect(SAAS_MATURITY_POINTS[maturity]).toBe(points);
  });

  it.each([
    ['low', 20],
    ['medium', 12],
    ['high', 4],
  ] as const)('lock_in %s -> %i', (lock_in, points) => {
    expect(scoreSaas(input({ saas: terms({ lock_in }) })).scores.lock_in).toBe(points);
    expect(SAAS_LOCK_IN_POINTS[lock_in]).toBe(points);
  });

  it.each([
    [true, 'no_training', 20], // 8 + 12
    [true, 'opt_out', 16], // 8 + 8
    [true, 'trains', 8],
    [true, 'unknown', 8],
    [false, 'no_training', 12],
    [false, 'opt_out', 8],
    [false, 'unknown', 0],
  ] as const)('terms: pricing checked=%s, data use %s -> %i', (checked, policy, points) => {
    const saas = terms({ pricing: { checked }, data_use: { policy } });
    expect(scoreSaas(input({ saas })).scores.terms).toBe(points);
    expect(SAAS_TERMS_POINTS.pricing.first_party).toBe(8);
  });

  it.each([
    // pricing source, data-use source, policy -> points
    ['first_party', 'first_party', 'no_training', 20],
    ['secondhand', 'first_party', 'no_training', 16], // 4 + 12
    ['first_party', 'secondhand', 'no_training', 14], // 8 + floor(12 / 2)
    ['first_party', 'secondhand', 'opt_out', 12], // 8 + floor(8 / 2)
    ['secondhand', 'secondhand', 'no_training', 10], // 4 + 6
    ['none', 'none', 'no_training', 0],
    ['first_party', 'none', 'no_training', 8],
    ['none', 'first_party', 'opt_out', 8],
  ] as const)('terms by evidence source: pricing %s, data use %s (%s) -> %i', (pricing, data_use, policy, points) => {
    const saas = terms({ data_use: { policy } });
    expect(scoreSaas(input({ saas, sources: { pricing, data_use } })).scores.terms).toBe(points);
  });

  it('documents the source points as constants', () => {
    expect(SAAS_TERMS_POINTS.pricing).toEqual({ first_party: 8, secondhand: 4, none: 0 });
  });

  it.each([
    ['compatible', 25, 20],
    ['compatible', 0, 10],
    ['compatible', 13, 15], // round(13 * 10 / 25) = 5
    ['conditional', 25, 15],
    ['unknown', 25, 10],
    ['incompatible', 25, 10],
    ['incompatible', 0, 0],
  ] as const)('sdk %s with maintenance %i -> %i', (verdict, maintenance, points) => {
    expect(scoreSaas(input({ sdk: { verdict, maintenance } })).scores.sdk).toBe(points);
    expect(SAAS_SDK_POINTS.maintenance).toBe(10);
  });

  it('clamps the SDK maintenance into 0-25', () => {
    expect(scoreSaas(input({ sdk: { verdict: 'compatible', maintenance: 99 } })).scores.sdk).toBe(20);
    expect(scoreSaas(input({ sdk: { verdict: 'compatible', maintenance: -5 } })).scores.sdk).toBe(10);
  });

  it('fit is worth 4 points per step', () => {
    expect(scoreSaas(input({ fit: 3 })).scores.fit).toBe(12);
  });

  it('rejects a non-integer or out-of-range fit', () => {
    expect(() => scoreSaas(input({ fit: 6 as 5 }))).toThrow(RangeError);
    expect(() => scoreSaas(input({ fit: 2.5 as 2 }))).toThrow(RangeError);
  });
});

describe('scoreSaas: flags and the terms gate', () => {
  it('no SDK earns 0 and raises no_sdk', () => {
    const r = scoreSaas(input({ sdk: undefined }));
    expect(r.scores.sdk).toBe(0);
    expect(r.flags).toEqual(['no_sdk']);
    expect(r.total).toBe(80);
  });

  it('unchecked pricing raises saas_terms_unverified and caps the hint at reference', () => {
    const r = scoreSaas(input({ saas: terms({ pricing: { checked: false } }) }));
    expect(r.total).toBeGreaterThanOrEqual(70); // would adopt on the total alone
    expect(r.flags).toContain('saas_terms_unverified');
    expect(r.missing).toContain('pricing');
    expect(r.hint).toBe('reference');
  });

  it('unknown data use raises saas_terms_unverified', () => {
    const r = scoreSaas(input({ saas: terms({ data_use: { policy: 'unknown' } }) }));
    expect(r.flags).toContain('saas_terms_unverified');
    expect(r.missing).toEqual(['data_use']);
    expect(r.hint).toBe('reference');
  });

  it('unverified terms with a weak fit hint build', () => {
    const r = scoreSaas(input({ saas: terms({ pricing: { checked: false } }), fit: 1 }));
    expect(r.hint).toBe('build');
  });

  it('a training policy is flagged but still scores (0 data-use points)', () => {
    const r = scoreSaas(input({ saas: terms({ data_use: { policy: 'trains', evidence_id: 'ev_2' } }) }));
    expect(r.flags).toContain('saas_trains_on_data');
    expect(r.flags).not.toContain('saas_terms_unverified');
    expect(r.scores.terms).toBe(8);
  });

  it('checked pricing or a known policy without ledger evidence raises saas_evidence_missing and caps the hint', () => {
    const noPricing = scoreSaas(input({ sources: { pricing: 'none', data_use: 'first_party' } }));
    expect(noPricing.flags).toContain('saas_evidence_missing');
    expect(noPricing.hint).toBe('reference');
    const noDataUse = scoreSaas(input({ sources: { pricing: 'first_party', data_use: 'none' } }));
    expect(noDataUse.flags).toContain('saas_evidence_missing');
    expect(noDataUse.hint).toBe('reference');
    expect(scoreSaas(input()).flags).not.toContain('saas_evidence_missing');
  });

  it('terms that are not claimed are not judged by their source (unverified covers them)', () => {
    const r = scoreSaas(
      input({ saas: terms({ pricing: { checked: false } }), sources: { pricing: 'none', data_use: 'first_party' } }),
    );
    expect(r.flags).toContain('saas_terms_unverified');
    expect(r.flags).not.toContain('saas_evidence_missing');
  });

  it('secondhand evidence raises saas_terms_secondhand and caps the hint at reference', () => {
    for (const sources of [
      { pricing: 'secondhand', data_use: 'first_party' },
      { pricing: 'first_party', data_use: 'secondhand' },
    ] as const) {
      const r = scoreSaas(input({ sources }));
      expect(r.flags).toContain('saas_terms_secondhand');
      expect(r.flags).not.toContain('saas_evidence_missing');
      expect(r.total).toBeGreaterThanOrEqual(70);
      expect(r.hint).toBe('reference');
    }
    expect(scoreSaas(input({ sources: { pricing: 'secondhand', data_use: 'first_party' }, fit: 1 })).hint).toBe('build');
    expect(scoreSaas(input()).flags).not.toContain('saas_terms_secondhand');
  });

  it('hint follows the OSS thresholds when terms are verified', () => {
    // 20 + 20 + 20 + 0 + 12 = 72, fit 3 -> extend (adopt needs fit 4)
    const extend = scoreSaas(input({ sdk: undefined, fit: 3, saas: terms() }));
    expect(extend.total).toBe(72);
    expect(extend.hint).toBe('extend');
    // fit 2 -> reference
    expect(scoreSaas(input({ sdk: undefined, fit: 2 })).hint).toBe('reference');
    // fit 1 -> build
    expect(scoreSaas(input({ sdk: undefined, fit: 1 })).hint).toBe('build');
  });
});

describe('scoring.md section 11 stays in sync with the code', () => {
  const md = readFileSync(
    fileURLToPath(new URL('../../../skills/recyclewheel/reference/scoring.md', import.meta.url)),
    'utf8',
  );
  const section = md.split(/^## /m).find((p) => p.startsWith('11. '));
  if (section === undefined) throw new Error('scoring.md has no section 11');

  /** Rows `| <key> | <n> |` of the table that follows `heading`, up to the next blank line after it. */
  function table(heading: string): Record<string, number> {
    const start = section!.indexOf(heading);
    if (start === -1) throw new Error(`section 11 has no ${heading}`);
    const lines = section!.slice(start).split('\n').slice(1);
    const out: Record<string, number> = {};
    let seen = false;
    for (const line of lines) {
      const m = line.match(/^\| (\w+) \| (\d+) \|$/);
      if (m) {
        seen = true;
        out[m[1]!] = Number(m[2]);
      } else if (seen && !line.startsWith('|')) break;
    }
    return out;
  }

  it('documents the axis maxima', () => {
    const axes = section.slice(0, section.indexOf('**maturity**'));
    const found = Object.fromEntries([...axes.matchAll(/^\| (\w+) \| (\d+) \|$/gm)].map((m) => [m[1]!, Number(m[2])]));
    expect(found).toEqual(SAAS_MAX_SCORES);
  });

  it('documents maturity, data-use, lock-in and SDK license points', () => {
    expect(table('**maturity**')).toEqual(SAAS_MATURITY_POINTS);
    expect(table('| `data_use.policy` | 점수 |')).toEqual(SAAS_TERMS_POINTS.dataUse);
    expect(table('**lock_in**')).toEqual(SAAS_LOCK_IN_POINTS);
    expect(table('| SDK 라이선스 verdict | 점수 |')).toEqual(SAAS_SDK_POINTS.license);
  });

  it('documents the pricing points by evidence source', () => {
    expect(table('| `pricing.source` | 가격 점수 |')).toEqual(SAAS_TERMS_POINTS.pricing);
  });

  it('documents the pricing and SDK maintenance points', () => {
    expect(section).toContain(`가격 페이지 확인(\`pricing.checked\`) ${SAAS_TERMS_POINTS.pricing.first_party}점`);
    expect(section).toContain(`× ${SAAS_SDK_POINTS.maintenance} / 25`);
  });

  it('documents every SaaS flag in section 9', () => {
    const flags = md.split(/^## /m).find((p) => p.startsWith('9. '))!;
    const emitted = [
      ...scoreSaas(input({ saas: terms({ pricing: { checked: false } }), sdk: undefined })).flags,
      ...scoreSaas(input({ saas: terms({ data_use: { policy: 'trains' } }) })).flags,
      ...scoreSaas(input({ sources: { pricing: 'none', data_use: 'first_party' } })).flags,
      ...scoreSaas(input({ sources: { pricing: 'secondhand', data_use: 'first_party' } })).flags,
    ];
    for (const flag of new Set(emitted)) expect(flags, flag).toContain(`\`${flag}\``);
  });

  it('worked example matches the code', () => {
    const verified = scoreSaas(input({ fit: 4 }));
    expect(verified.total).toBe(96);
    expect(verified.hint).toBe('adopt');
    expect(section).toContain('= **96** → hint `adopt`');
    const unchecked = scoreSaas(input({ fit: 4, saas: terms({ pricing: { checked: false } }) }));
    expect(unchecked.scores.terms).toBe(12);
    expect(unchecked.total).toBe(88);
    expect(unchecked.hint).toBe('reference');
  });
});

describe('scoreSaas: data use not_stated', () => {
  it('is worth 4 points for the vendor page, 2 for a secondhand page and 0 without evidence', () => {
    expect(SAAS_TERMS_POINTS.dataUse.not_stated).toBe(4);
    const saas = terms({ data_use: { policy: 'not_stated' } });
    const terms_ = (data_use: 'first_party' | 'secondhand' | 'none') => scoreSaas(input({ saas, sources: { pricing: 'first_party', data_use } })).scores.terms;
    expect(terms_('first_party')).toBe(12); // 8 + 4
    expect(terms_('secondhand')).toBe(10); // 8 + floor(4 / 2)
    expect(terms_('none')).toBe(8);
    expect(scoreSaas(input({ saas: terms({ pricing: { checked: false }, data_use: { policy: 'not_stated' } }) })).scores.terms).toBe(4);
  });

  it('counts as read: flags saas_data_use_not_stated without saas_terms_unverified, and does not cap the hint', () => {
    const r = scoreSaas(input({ saas: terms({ data_use: { policy: 'not_stated' } }) }));
    expect(r.flags).toEqual(['saas_data_use_not_stated']);
    expect(r.missing).toEqual([]);
    expect(r.total).toBe(92);
    expect(r.hint).toBe('adopt');
  });

  it('still judges its evidence like any claimed term', () => {
    const saas = terms({ data_use: { policy: 'not_stated' } });
    const secondhand = scoreSaas(input({ saas, sources: { pricing: 'first_party', data_use: 'secondhand' } }));
    expect(secondhand.flags).toEqual(['saas_data_use_not_stated', 'saas_terms_secondhand']);
    expect(secondhand.hint).toBe('reference');
    const none = scoreSaas(input({ saas, sources: { pricing: 'first_party', data_use: 'none' } }));
    expect(none.flags).toEqual(['saas_data_use_not_stated', 'saas_evidence_missing']);
    expect(none.hint).toBe('reference');
  });

  it('is not the same as unknown', () => {
    const unknown = scoreSaas(input({ saas: terms({ data_use: { policy: 'unknown' } }) }));
    expect(unknown.flags).toContain('saas_terms_unverified');
    expect(unknown.flags).not.toContain('saas_data_use_not_stated');
    expect(unknown.missing).toEqual(['data_use']);
    expect(unknown.hint).toBe('reference');
  });
});
