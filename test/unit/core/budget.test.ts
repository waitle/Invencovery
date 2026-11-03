import { describe, expect, it } from 'vitest';
import {
  budgetSummary,
  checkBudget,
  checkSearchBudget,
  hardLimit,
  usageFor,
} from '../../../src/core/budget.js';
import type { Evaluation, Evidence, LedgerState } from '../../../src/types.js';

const AT = '2026-10-01T00:00:00.000Z';
const limits = { rounds: 3, evals: 5, web: 2 };

function ev(id: string, component: string, kind: Evidence['kind']): Evidence {
  return { id, component_id: component, kind, at: AT, result_refs: [], summary: 'summary text' };
}

function evaluation(component: string, ref: string): Evaluation {
  return {
    ref,
    component_id: component,
    metrics: {},
    scores: { maintenance: 0, popularity: 0, community: 0, license: 0, dependencies: 0, fit: 0 },
    total: 0,
    license: {
      candidate_spdx: null,
      project_spdx: null,
      distribution: 'application',
      category: 'unknown',
      verdict: 'unknown',
      obligations: [],
      notes: [],
      source: 'agent',
    },
    fit: { value: 0, reason: 'none' },
    flags: [],
    missing: [],
    hint: 'build',
    scoring_version: 1,
    provenance: 'live',
  };
}

function state(evidence: Evidence[] = [], evaluations: Evaluation[] = []): LedgerState {
  return { components: [], evidence, evaluations, decisions: [], history: [] };
}

const searches = (n: number, component = 'c1'): Evidence[] =>
  Array.from({ length: n }, (_, i) => ev(`ev_s${component}${i}`, component, 'search'));

describe('usageFor', () => {
  it('counts search evidence, distinct evaluated refs and web evidence per component', () => {
    const s = state(
      [
        ...searches(2),
        ev('w1', 'c1', 'web'),
        ev('cs', 'c1', 'code_search'),
        ev('m', 'c1', 'manual'),
        ev('e', 'c1', 'evaluate'),
        ev('other', 'c2', 'search'),
      ],
      [evaluation('c1', 'npm:a'), evaluation('c1', 'npm:b'), evaluation('c1', 'npm:a'), evaluation('c2', 'npm:z')],
    );
    expect(usageFor(s, 'c1')).toEqual({ rounds: 2, evals: 2, web: 1 });
    expect(usageFor(s, 'c2')).toEqual({ rounds: 1, evals: 1, web: 0 });
    expect(usageFor(s, 'none')).toEqual({ rounds: 0, evals: 0, web: 0 });
  });
});

describe('checkBudget', () => {
  it('hard limit is twice the soft limit', () => {
    expect(hardLimit(3)).toBe(6);
  });

  it.each([
    // used, allowed, warning?
    [0, true, false],
    [1, true, false],
    [2, true, false], // third round is within the limit
    [3, true, true], // fourth round: over the soft limit
    [5, true, true], // sixth round: still under the hard limit
    [6, false, false], // seventh round: refused
  ])('rounds: %i used -> allowed=%s warning=%s', (used, allowed, warns) => {
    const c = checkBudget(state(searches(used)), 'c1', limits, 'rounds');
    expect(c.allowed).toBe(allowed);
    expect(c.warning !== undefined).toBe(warns);
    expect(c.error !== undefined).toBe(!allowed);
    expect(c).toMatchObject({ used, limit: 3, hard_limit: 6, resource: 'rounds' });
  });

  it('remaining never goes below zero', () => {
    expect(checkBudget(state(searches(2)), 'c1', limits, 'rounds').remaining).toBe(1);
    expect(checkBudget(state(searches(4)), 'c1', limits, 'rounds').remaining).toBe(0);
  });

  it('refuses past the hard limit without force, and says how to continue', () => {
    const c = checkBudget(state(searches(6)), 'c1', limits, 'rounds');
    expect(c.error).toContain('rw_decide');
    expect(c.error).toContain('force_reason');
  });

  it('allows force with a reason and records it in the warning', () => {
    const c = checkBudget(state(searches(6)), 'c1', limits, 'rounds', {
      force: true,
      force_reason: 'new requirement appeared',
    });
    expect(c.allowed).toBe(true);
    expect(c.error).toBeUndefined();
    expect(c.warning).toContain('new requirement appeared');
  });

  it.each([
    [{ force: true }],
    [{ force: true, force_reason: '   ' }],
    [{ force_reason: 'has a reason but no force' }],
  ])('keeps refusing when force is incomplete: %j', (opts) => {
    const c = checkBudget(state(searches(6)), 'c1', limits, 'rounds', opts);
    expect(c.allowed).toBe(false);
  });

  it('force does not matter below the hard limit', () => {
    const c = checkBudget(state(searches(4)), 'c1', limits, 'rounds', { force: true });
    expect(c.allowed).toBe(true);
    expect(c.warning).not.toContain('force_reason was given');
  });

  it('counts the evals this call would add', () => {
    const evaluations = ['a', 'b', 'c', 'd'].map((n) => evaluation('c1', `npm:${n}`));
    const s = state([], evaluations);
    expect(checkBudget(s, 'c1', limits, 'evals', { adding: 1 })).toMatchObject({ allowed: true, used: 4 });
    expect(checkBudget(s, 'c1', limits, 'evals', { adding: 1 }).warning).toBeUndefined();
    expect(checkBudget(s, 'c1', limits, 'evals', { adding: 2 }).warning).toBeDefined();
    expect(checkBudget(s, 'c1', limits, 'evals', { adding: 7 }).allowed).toBe(false);
    expect(checkBudget(s, 'c1', limits, 'evals', { adding: 6 }).allowed).toBe(true);
  });

  it('tracks web queries against their own limit', () => {
    const s = state([ev('w1', 'c1', 'web'), ev('w2', 'c1', 'web')]);
    const c = checkBudget(s, 'c1', limits, 'web');
    expect(c).toMatchObject({ allowed: true, used: 2, limit: 2, hard_limit: 4 });
    expect(c.warning).toBeDefined();
  });

  it('is scoped to the component', () => {
    const s = state([...searches(6, 'c2')]);
    expect(checkBudget(s, 'c1', limits, 'rounds')).toMatchObject({ allowed: true, used: 0 });
  });
});

describe('checkSearchBudget', () => {
  it('maps to the rw_search budget output shape', () => {
    const r = checkSearchBudget(state(searches(3)), 'c1', limits);
    expect(r.allowed).toBe(true);
    expect(r.budget).toMatchObject({ rounds_used: 3, rounds_limit: 3, hard_limit: 6 });
    expect(r.budget.warning).toBeDefined();
    expect(r.error).toBeUndefined();
  });

  it('has no warning field while within budget', () => {
    const r = checkSearchBudget(state(searches(1)), 'c1', limits);
    expect(r.budget).toEqual({ rounds_used: 1, rounds_limit: 3, hard_limit: 6 });
  });

  it('surfaces the refusal', () => {
    const r = checkSearchBudget(state(searches(6)), 'c1', limits);
    expect(r.allowed).toBe(false);
    expect(r.error).toBeDefined();
  });
});

describe('budgetSummary', () => {
  it('reports all three resources', () => {
    const s = state([...searches(1), ev('w', 'c1', 'web')], [evaluation('c1', 'npm:a')]);
    expect(budgetSummary(s, 'c1', { rounds: 3, evals: 5, web: 2 })).toEqual({
      rounds: { used: 1, limit: 3, hard_limit: 6 },
      evals: { used: 1, limit: 5, hard_limit: 10 },
      web: { used: 1, limit: 2, hard_limit: 4 },
    });
  });
});
