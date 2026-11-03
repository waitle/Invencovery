import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_POINTS,
  DEPENDENCY_BANDS,
  DEPENDENCIES_OVER_POINTS,
  DEPENDENCIES_UNKNOWN_POINTS,
  FIT_FACTOR,
  HINT_THRESHOLDS,
  LICENSE_POINTS,
  MAINTENANCE_BANDS,
  MAINTENANCE_UNKNOWN_POINTS,
  MAX_SCORES,
  RECENT_RELEASE_DAYS,
  SCORECARD_MAINTAINED_FACTOR,
  SCORING_VERSION,
  STALE_AFTER_DAYS,
  pickRecommendation,
  score,
} from '../../../src/core/score.js';
import type { FitValue, RecommendationInput, ScoreInput } from '../../../src/core/score.js';
import type { Evaluation, LicenseVerdict } from '../../../src/types.js';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-12T00:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function verdict(v: LicenseVerdict['verdict'], over: Partial<LicenseVerdict> = {}): LicenseVerdict {
  return {
    candidate_spdx: v === 'unknown' ? null : 'MIT',
    project_spdx: null,
    distribution: 'application',
    category: v === 'unknown' ? 'unknown' : 'permissive',
    verdict: v,
    obligations: [],
    notes: ['Not legal advice'],
    source: 'npm',
    ...over,
  };
}

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return { metrics: {}, license: verdict('compatible'), fit: 3, now: NOW, ...over };
}

function withMetrics(metrics: Evaluation['metrics'], over: Partial<ScoreInput> = {}): ScoreInput {
  return input({ metrics, ...over });
}

describe('score: maintenance', () => {
  it.each([
    [0, 25],
    [90, 25],
    [91, 20],
    [180, 20],
    [181, 14],
    [365, 14],
    [366, 6],
    [730, 6],
    [731, 0],
    [5000, 0],
  ])('last_commit_at %i days ago -> %i points', (days, points) => {
    const r = score(withMetrics({ last_commit_at: daysAgo(days) }));
    expect(r.scores.maintenance).toBe(points);
    expect(r.missing).not.toContain('last_commit_at');
  });

  it('counts whole elapsed days (90 days 23 hours is still 90)', () => {
    const t = NOW.getTime() - (90 * DAY_MS + 23 * 3_600_000);
    expect(score(withMetrics({ last_commit_at: new Date(t).toISOString() })).scores.maintenance).toBe(25);
    expect(score(withMetrics({ last_commit_at: new Date(t - 3_600_000).toISOString() })).scores.maintenance).toBe(20);
  });

  it('falls back to last_release_at when last_commit_at is absent', () => {
    const r = score(withMetrics({ last_release_at: daysAgo(100) }));
    expect(r.scores.maintenance).toBe(20);
    expect(r.missing).not.toContain('last_commit_at');
  });

  it('prefers last_commit_at over a newer last_release_at', () => {
    const r = score(withMetrics({ last_commit_at: daysAgo(400), last_release_at: daysAgo(10) }));
    expect(r.scores.maintenance).toBe(6);
  });

  it('ignores an unparsable last_commit_at and uses last_release_at', () => {
    const r = score(withMetrics({ last_commit_at: 'not-a-date', last_release_at: daysAgo(10) }));
    expect(r.scores.maintenance).toBe(25);
  });

  it('treats a future timestamp (clock skew) as 0 days old', () => {
    const r = score(withMetrics({ last_commit_at: new Date(NOW.getTime() + 5 * DAY_MS).toISOString() }));
    expect(r.scores.maintenance).toBe(25);
  });

  it('gives 0 for archived and deprecated regardless of recency, with flags', () => {
    const archived = score(withMetrics({ last_commit_at: daysAgo(1), archived: true }));
    expect(archived.scores.maintenance).toBe(0);
    expect(archived.flags).toContain('archived');
    expect(archived.flags).not.toContain('stale');

    const deprecated = score(withMetrics({ last_commit_at: daysAgo(1), deprecated: true }));
    expect(deprecated.scores.maintenance).toBe(0);
    expect(deprecated.flags).toContain('deprecated');
  });

  it('does not flag archived when archived is false', () => {
    const r = score(withMetrics({ last_commit_at: daysAgo(1), archived: false, deprecated: false }));
    expect(r.flags).not.toContain('archived');
    expect(r.flags).not.toContain('deprecated');
  });

  it('uses 8 points and records the missing metric when no date is known', () => {
    const r = score(withMetrics({}));
    expect(r.scores.maintenance).toBe(MAINTENANCE_UNKNOWN_POINTS);
    expect(r.scores.maintenance).toBe(8);
    expect(r.missing).toContain('last_commit_at');
  });

  it('flags stale only past 365 days', () => {
    expect(score(withMetrics({ last_commit_at: daysAgo(365) })).flags).not.toContain('stale');
    expect(score(withMetrics({ last_commit_at: daysAgo(366) })).flags).toContain('stale');
  });

  describe('scorecard Maintained check', () => {
    it('raises the score to check x 2.5 when that is higher', () => {
      expect(score(withMetrics({ last_commit_at: daysAgo(800) }, { scorecardMaintained: 10 })).scores.maintenance).toBe(25);
      expect(score(withMetrics({ last_commit_at: daysAgo(800) }, { scorecardMaintained: 6 })).scores.maintenance).toBe(15);
    });

    it('never lowers the rule score', () => {
      expect(score(withMetrics({ last_commit_at: daysAgo(10) }, { scorecardMaintained: 0 })).scores.maintenance).toBe(25);
      expect(score(withMetrics({ last_commit_at: daysAgo(200) }, { scorecardMaintained: 4 })).scores.maintenance).toBe(14);
    });

    it('applies to the unknown-date default and keeps the missing record', () => {
      const r = score(withMetrics({}, { scorecardMaintained: 10 }));
      expect(r.scores.maintenance).toBe(25);
      expect(r.missing).toContain('last_commit_at');
    });

    it('clamps values above 10 and ignores archived/deprecated', () => {
      expect(score(withMetrics({ last_commit_at: daysAgo(800) }, { scorecardMaintained: 99 })).scores.maintenance).toBe(25);
      expect(
        score(withMetrics({ archived: true, last_commit_at: daysAgo(800) }, { scorecardMaintained: 10 })).scores.maintenance,
      ).toBe(0);
    });

    it('rounds half up (check 7 -> 17.5 -> 18)', () => {
      expect(score(withMetrics({ last_commit_at: daysAgo(800) }, { scorecardMaintained: 7 })).scores.maintenance).toBe(18);
    });
  });
});

describe('score: popularity', () => {
  const pop = (metrics: Evaluation['metrics']) => score(withMetrics(metrics)).scores.popularity;

  it.each([
    [0, 0],
    [1, 1],
    [9, 4],
    [99, 8],
    [999, 11],
    [9998, 15],
    [9999, 15],
    [10_000, 15],
    [10_001, 15],
    [5_000_000, 15],
  ])('stars %i -> %i points', (stars, points) => {
    expect(pop({ stars })).toBe(points);
  });

  it.each([
    [0, 0],
    [999, 8],
    [99_999, 13],
    [999_999, 15],
    [1_000_000, 15],
    [50_000_000, 15],
  ])('downloads_weekly %i -> %i points', (downloads_weekly, points) => {
    expect(pop({ downloads_weekly })).toBe(points);
  });

  it('takes the better of stars and downloads', () => {
    expect(pop({ stars: 0, downloads_weekly: 999_999 })).toBe(15);
    expect(pop({ stars: 10_000, downloads_weekly: 0 })).toBe(15);
    expect(pop({ stars: 99, downloads_weekly: 999 })).toBe(8);
  });

  it('is monotonic non-decreasing in stars and in downloads', () => {
    let prevStars = -1;
    let prevDl = -1;
    for (let n = 0; n <= 1_200_000; n = n === 0 ? 1 : Math.ceil(n * 1.37)) {
      const s = pop({ stars: n });
      const d = pop({ downloads_weekly: n });
      expect(s).toBeGreaterThanOrEqual(prevStars);
      expect(d).toBeGreaterThanOrEqual(prevDl);
      prevStars = s;
      prevDl = d;
    }
  });

  it('gives 0 and records both metrics as missing when neither is known', () => {
    const r = score(withMetrics({}));
    expect(r.scores.popularity).toBe(0);
    expect(r.missing).toEqual(expect.arrayContaining(['stars', 'downloads_weekly']));
  });

  it('does not report the absent counterpart as missing when one is present', () => {
    const r = score(withMetrics({ stars: 50 }));
    expect(r.missing).not.toContain('stars');
    expect(r.missing).not.toContain('downloads_weekly');
  });

  it('treats negative and NaN counts as absent', () => {
    const r = score(withMetrics({ stars: -5, downloads_weekly: Number.NaN }));
    expect(r.scores.popularity).toBe(0);
    expect(r.missing).toEqual(expect.arrayContaining(['stars', 'downloads_weekly']));
  });
});

describe('score: community', () => {
  const community = (metrics: Evaluation['metrics']) => score(withMetrics(metrics)).scores.community;

  it('awards 4 for a release within 365 days, none after', () => {
    expect(community({ last_release_at: daysAgo(365) })).toBe(COMMUNITY_POINTS.release);
    expect(community({ last_release_at: daysAgo(366) })).toBe(0);
  });

  it.each([
    [0, 0],
    [1, 0],
    [2, 2],
    [4, 2],
    [5, 4],
    [500, 4],
  ])('contributors %i -> %i points', (contributors, points) => {
    expect(community({ contributors })).toBe(points);
  });

  it.each([
    [4.9, 0],
    [5, 2],
    [10, 2],
  ])('scorecard %f -> %i points', (scorecard, points) => {
    expect(community({ scorecard })).toBe(points);
  });

  it('sums to the 10 point maximum', () => {
    expect(community({ last_release_at: daysAgo(1), contributors: 9, scorecard: 8 })).toBe(MAX_SCORES.community);
  });

  it('gives 0 for absent items and flags metrics_partial with the missing names', () => {
    const r = score(withMetrics({ last_commit_at: daysAgo(1), stars: 1, direct_dependencies: 1 }));
    expect(r.scores.community).toBe(0);
    expect(r.missing).toEqual(['last_release_at', 'contributors', 'scorecard']);
    expect(r.flags).toContain('metrics_partial');
  });

  it('present-but-low values are not "missing"', () => {
    const r = score(withMetrics({ contributors: 1, scorecard: 0, last_release_at: daysAgo(900) }));
    expect(r.missing).not.toContain('contributors');
    expect(r.missing).not.toContain('scorecard');
    expect(r.missing).not.toContain('last_release_at');
  });
});

describe('score: license', () => {
  it.each([
    ['compatible', 20],
    ['conditional', 10],
    ['unknown', 0],
    ['incompatible', 0],
  ] as const)('%s -> %i points', (v, points) => {
    expect(score(input({ license: verdict(v) })).scores.license).toBe(points);
    expect(LICENSE_POINTS[v]).toBe(points);
  });

  it('flags no_license when the SPDX value is null or blank', () => {
    expect(score(input({ license: verdict('unknown') })).flags).toContain('no_license');
    expect(score(input({ license: verdict('unknown', { candidate_spdx: '  ' }) })).flags).toContain('no_license');
  });

  it('flags license_unknown when a value exists but could not be judged', () => {
    const r = score(input({ license: verdict('unknown', { candidate_spdx: 'Some-Custom-1.0' }) }));
    expect(r.flags).toContain('license_unknown');
    expect(r.flags).not.toContain('no_license');
  });

  it('flags license_incompatible', () => {
    expect(score(input({ license: verdict('incompatible', { candidate_spdx: 'AGPL-3.0-only' }) })).flags).toContain(
      'license_incompatible',
    );
  });

  it('flags license_from_remote_cache for any verdict', () => {
    expect(score(input({ license: verdict('compatible', { source: 'remote_cache' }) })).flags).toContain(
      'license_from_remote_cache',
    );
    expect(score(input({ license: verdict('compatible', { source: 'github' }) })).flags).not.toContain(
      'license_from_remote_cache',
    );
  });

  it('adds no license flags for compatible and conditional licenses', () => {
    for (const v of ['compatible', 'conditional'] as const) {
      const flags = score(input({ license: verdict(v) })).flags;
      expect(flags.filter((f) => f.startsWith('license') || f === 'no_license')).toEqual([]);
    }
  });
});

describe('score: dependencies', () => {
  const deps = (direct_dependencies: number) => score(withMetrics({ direct_dependencies })).scores.dependencies;

  it.each([
    [0, 10],
    [3, 10],
    [4, 7],
    [10, 7],
    [11, 4],
    [30, 4],
    [31, 1],
    [500, 1],
  ])('%i direct dependencies -> %i points', (n, points) => {
    expect(deps(n)).toBe(points);
  });

  it('uses 5 points and records the missing metric when unknown', () => {
    const r = score(withMetrics({}));
    expect(r.scores.dependencies).toBe(5);
    expect(r.missing).toContain('direct_dependencies');
  });

  it('is monotonic non-increasing', () => {
    let prev = Infinity;
    for (let n = 0; n <= 60; n++) {
      const v = deps(n);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('score: fit, total and shape', () => {
  it.each([0, 1, 2, 3, 4, 5] as const)('fit %i -> %i points', (fit) => {
    expect(score(input({ fit })).scores.fit).toBe(fit * 4);
  });

  it.each([-1, 6, 2.5, Number.NaN])('rejects fit %s', (fit) => {
    expect(() => score(input({ fit: fit as FitValue }))).toThrow(RangeError);
  });

  it('rejects an invalid now', () => {
    expect(() => score(input({ now: new Date('nope') }))).toThrow(RangeError);
    expect(() => score(input({ now: Number.NaN }))).toThrow(RangeError);
  });

  it('accepts now as epoch milliseconds', () => {
    const metrics = { last_commit_at: daysAgo(91) };
    expect(score(withMetrics(metrics, { now: NOW.getTime() }))).toEqual(score(withMetrics(metrics)));
  });

  it('sums the axes into an integer total in 0-100', () => {
    const r = score(
      withMetrics({
        last_commit_at: daysAgo(10),
        last_release_at: daysAgo(20),
        stars: 2000,
        contributors: 12,
        scorecard: 7,
        direct_dependencies: 5,
      }, { fit: 4 }),
    );
    expect(r.scores).toEqual({ maintenance: 25, popularity: 12, community: 10, license: 20, dependencies: 7, fit: 16 });
    expect(r.total).toBe(90);
  });

  it('caps at 100 for the best possible input', () => {
    const r = score(
      withMetrics(
        {
          last_commit_at: daysAgo(0),
          last_release_at: daysAgo(0),
          stars: 1_000_000,
          contributors: 100,
          scorecard: 10,
          direct_dependencies: 0,
        },
        { fit: 5 },
      ),
    );
    expect(r.total).toBe(100);
    expect(Object.values(r.scores).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('floors at 0 for the worst possible input', () => {
    const r = score(
      withMetrics(
        { last_commit_at: daysAgo(9999), stars: 0, contributors: 0, scorecard: 0, direct_dependencies: 999, archived: true },
        { fit: 0, license: verdict('incompatible') },
      ),
    );
    expect(r.scores).toEqual({ maintenance: 0, popularity: 0, community: 0, license: 0, dependencies: 1, fit: 0 });
    expect(r.total).toBe(1);
    expect(r.hint).toBe('build');
  });

  it('keeps every axis within its maximum and every score an integer', () => {
    const dates = [undefined, daysAgo(0), daysAgo(200), daysAgo(1000)];
    const nums = [undefined, 0, 7, 3000, 2_000_000];
    for (const last_commit_at of dates) {
      for (const stars of nums) {
        for (const contributors of nums) {
          for (const fit of [0, 3, 5] as const) {
            const r = score(withMetrics({ last_commit_at, stars, contributors, direct_dependencies: stars }, { fit }));
            for (const [axis, value] of Object.entries(r.scores)) {
              expect(Number.isInteger(value)).toBe(true);
              expect(value).toBeGreaterThanOrEqual(0);
              expect(value).toBeLessThanOrEqual(MAX_SCORES[axis as keyof typeof MAX_SCORES]);
            }
            expect(Number.isInteger(r.total)).toBe(true);
            expect(r.total).toBeGreaterThanOrEqual(0);
            expect(r.total).toBeLessThanOrEqual(100);
          }
        }
      }
    }
  });

  it('total is monotonic non-decreasing in fit', () => {
    let prev = -1;
    for (const fit of [0, 1, 2, 3, 4, 5] as const) {
      const t = score(withMetrics({ last_commit_at: daysAgo(40), stars: 300 }, { fit })).total;
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it('is deterministic and does not mutate its input', () => {
    const metrics = Object.freeze({ last_commit_at: daysAgo(120), stars: 777, direct_dependencies: 12 });
    const lic = Object.freeze(verdict('conditional'));
    const a = score({ metrics, license: lic, fit: 3, now: NOW });
    const b = score({ metrics, license: lic, fit: 3, now: NOW });
    expect(a).toEqual(b);
    expect(a.flags).not.toBe(b.flags);
  });

  it('reports no duplicate flags or missing names', () => {
    const r = score(withMetrics({ archived: true, deprecated: true }, { license: verdict('unknown', { source: 'remote_cache' }) }));
    expect(new Set(r.flags).size).toBe(r.flags.length);
    expect(new Set(r.missing).size).toBe(r.missing.length);
    expect(r.flags).toEqual(
      expect.arrayContaining(['archived', 'deprecated', 'no_license', 'license_from_remote_cache', 'metrics_partial']),
    );
  });

  it('does not flag metrics_partial when nothing is missing', () => {
    const r = score(
      withMetrics({
        last_commit_at: daysAgo(1),
        last_release_at: daysAgo(1),
        stars: 10,
        contributors: 3,
        scorecard: 6,
        direct_dependencies: 2,
      }),
    );
    expect(r.missing).toEqual([]);
    expect(r.flags).toEqual([]);
  });

  it('exposes scoring version 1 and maximums that sum to 100', () => {
    expect(SCORING_VERSION).toBe(1);
    expect(Object.values(MAX_SCORES).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('score: hint', () => {
  /** fit 4, fresh commits, compatible license, deps unknown (5), community 0 -> total set by stars. */
  function adoptCase(stars: number, fit: FitValue = 4) {
    return score(withMetrics({ last_commit_at: daysAgo(10), stars }, { fit }));
  }

  it('adopts at total 70 with fit 4, not at 69', () => {
    const at70 = adoptCase(9);
    expect(at70.total).toBe(70);
    expect(at70.hint).toBe('adopt');

    const at69 = adoptCase(5);
    expect(at69.total).toBe(69);
    expect(at69.hint).toBe('extend');
  });

  it('does not adopt with fit 3 even at a high total', () => {
    const r = score(
      withMetrics(
        { last_commit_at: daysAgo(1), last_release_at: daysAgo(1), stars: 20_000, contributors: 20, scorecard: 9, direct_dependencies: 0 },
        { fit: 3 },
      ),
    );
    expect(r.total).toBeGreaterThanOrEqual(70);
    expect(r.hint).toBe('extend');
  });

  it('extends at total 50 with fit 3, not at 49', () => {
    const at50 = score(withMetrics({ last_commit_at: daysAgo(800), stars: 2951 }, { fit: 3 }));
    expect(at50.total).toBe(50);
    expect(at50.hint).toBe('extend');

    const at49 = score(withMetrics({ last_commit_at: daysAgo(800), stars: 2000 }, { fit: 3 }));
    expect(at49.total).toBe(49);
    expect(at49.hint).toBe('reference');
  });

  it('falls back to reference at fit 2 and build below 2, whatever the total', () => {
    const strong = { last_commit_at: daysAgo(1), last_release_at: daysAgo(1), stars: 50_000, contributors: 30, scorecard: 9, direct_dependencies: 1 };
    expect(score(withMetrics(strong, { fit: 2 })).hint).toBe('reference');
    expect(score(withMetrics(strong, { fit: 1 })).hint).toBe('build');
    expect(score(withMetrics(strong, { fit: 0 })).hint).toBe('build');
  });

  it('never adopts or extends an incompatible or unknown license', () => {
    const strong = { last_commit_at: daysAgo(1), last_release_at: daysAgo(1), stars: 50_000, contributors: 30, scorecard: 9, direct_dependencies: 1 };
    for (const v of ['incompatible', 'unknown'] as const) {
      expect(score(withMetrics(strong, { fit: 5, license: verdict(v) })).hint).toBe('reference');
      expect(score(withMetrics(strong, { fit: 2, license: verdict(v) })).hint).toBe('reference');
      expect(score(withMetrics(strong, { fit: 1, license: verdict(v) })).hint).toBe('build');
      expect(score(withMetrics(strong, { fit: 0, license: verdict(v) })).hint).toBe('build');
    }
  });

  it('lets a conditional license reach adopt when the total allows', () => {
    const r = score(
      withMetrics(
        { last_commit_at: daysAgo(1), last_release_at: daysAgo(1), stars: 20_000, contributors: 20, scorecard: 9, direct_dependencies: 0 },
        { fit: 5, license: verdict('conditional') },
      ),
    );
    expect(r.total).toBe(90);
    expect(r.hint).toBe('adopt');
  });

  it('archived does not change the hint rules, only the score', () => {
    const r = score(withMetrics({ last_commit_at: daysAgo(1), archived: true, stars: 20_000 }, { fit: 4 }));
    expect(r.scores.maintenance).toBe(0);
    expect(r.hint).toBe(r.total >= 70 ? 'adopt' : 'extend');
  });

  it('thresholds match the documented constants', () => {
    expect(HINT_THRESHOLDS).toEqual({
      adopt: { total: 70, fit: 4 },
      extend: { total: 50, fit: 3 },
      reference: { fit: 2 },
    });
  });
});

describe('pickRecommendation', () => {
  function ev(ref: string, hint: Evaluation['hint'], total: number, fit = 3, v: LicenseVerdict['verdict'] = 'compatible'): RecommendationInput {
    return { ref, hint, total, fit: { value: fit as FitValue, reason: 'because it is relevant' }, license: verdict(v) };
  }

  it('returns build without a ref for an empty list', () => {
    const r = pickRecommendation([]);
    expect(r.hint).toBe('build');
    expect(r.ref).toBeUndefined();
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('prefers hint priority over a higher total', () => {
    const r = pickRecommendation([ev('npm:ref-a', 'reference', 95, 2), ev('npm:ext', 'extend', 55, 3), ev('npm:ado', 'adopt', 71, 4)]);
    expect(r.hint).toBe('adopt');
    expect(r.ref).toBe('npm:ado');
  });

  it('picks extend over reference and reference over build', () => {
    expect(pickRecommendation([ev('npm:r', 'reference', 90, 2), ev('npm:e', 'extend', 52, 3)]).ref).toBe('npm:e');
    expect(pickRecommendation([ev('npm:b', 'build', 90, 1), ev('npm:r', 'reference', 30, 2)])).toMatchObject({
      hint: 'reference',
      ref: 'npm:r',
    });
  });

  it('picks the highest total within the same hint', () => {
    const r = pickRecommendation([ev('npm:low', 'adopt', 72, 4), ev('npm:high', 'adopt', 88, 4), ev('npm:mid', 'adopt', 80, 5)]);
    expect(r.ref).toBe('npm:high');
  });

  it('breaks ties by fit, then by ref, independent of input order', () => {
    const a = ev('github:b/b', 'adopt', 80, 4);
    const b = ev('github:a/a', 'adopt', 80, 4);
    const c = ev('github:z/z', 'adopt', 80, 5);
    const orders = [
      [a, b, c],
      [c, b, a],
      [b, a, c],
    ];
    for (const order of orders) expect(pickRecommendation(order).ref).toBe('github:z/z');
    expect(pickRecommendation([a, b]).ref).toBe('github:a/a');
    expect(pickRecommendation([b, a]).ref).toBe('github:a/a');
  });

  it('returns build without a ref when every candidate is build', () => {
    const r = pickRecommendation([ev('npm:x', 'build', 40, 1), ev('npm:y', 'build', 60, 0, 'incompatible')]);
    expect(r.hint).toBe('build');
    expect(r.ref).toBeUndefined();
    expect(r.reason).toContain('npm:y');
  });

  it('names the chosen ref in the reason', () => {
    const r = pickRecommendation([ev('github:o/r', 'adopt', 77, 4)]);
    expect(r.reason).toContain('github:o/r');
    expect(r.reason).toContain('77');
  });

  it('does not mutate or reorder its input', () => {
    const list = [ev('npm:a', 'build', 10, 0), ev('npm:b', 'adopt', 80, 4)];
    const copy = structuredClone(list);
    pickRecommendation(list);
    expect(list).toEqual(copy);
  });

  it('works on real score() output', () => {
    const strong = score(withMetrics({ last_commit_at: daysAgo(5), stars: 12_000, direct_dependencies: 2 }, { fit: 5 }));
    const weak = score(withMetrics({ last_commit_at: daysAgo(900), stars: 3 }, { fit: 1 }));
    const mk = (ref: string, s: ReturnType<typeof score>, fit: FitValue): RecommendationInput => ({
      ref,
      hint: s.hint,
      total: s.total,
      fit: { value: fit, reason: 'x' },
      license: verdict('compatible'),
    });
    const r = pickRecommendation([mk('npm:weak', weak, 1), mk('npm:strong', strong, 5)]);
    expect(r).toMatchObject({ hint: strong.hint, ref: 'npm:strong' });
  });
});

describe('scoring.md stays in sync with the code', () => {
  const md = readFileSync(
    fileURLToPath(new URL('../../../skills/recyclewheel/reference/scoring.md', import.meta.url)),
    'utf8',
  );

  /** Text of the numbered section `## <n>. ...` up to the next `## `. */
  function section(n: number): string {
    const parts = md.split(/^## /m);
    const found = parts.find((p) => p.startsWith(`${n}. `));
    if (found === undefined) throw new Error(`scoring.md has no section ${n}`);
    return found;
  }

  function rows(text: string, re: RegExp): RegExpMatchArray[] {
    return text.split('\n').flatMap((line) => {
      const m = line.match(re);
      return m ? [m] : [];
    });
  }

  it('documents the axis weights', () => {
    const found = Object.fromEntries(
      rows(section(1), /^\| (\w+) \| (\d+) \|$/).map((m) => [m[1]!, Number(m[2])]),
    );
    expect(found).toEqual(MAX_SCORES);
  });

  it('documents the maintenance bands, defaults and factors', () => {
    const s = section(2);
    const bands = rows(s, /^\| ≤ (\d+) \| (\d+) \|$/).map((m) => ({ maxDays: Number(m[1]), points: Number(m[2]) }));
    expect(bands).toEqual([...MAINTENANCE_BANDS]);
    const over = rows(s, /^\| (\d+) 초과 \| (\d+) \|$/).map((m) => [Number(m[1]), Number(m[2])]);
    expect(over).toEqual([[MAINTENANCE_BANDS.at(-1)!.maxDays, 0]]);
    expect(s).toContain(`**${MAINTENANCE_UNKNOWN_POINTS}점**`);
    expect(s).toContain(`check × ${SCORECARD_MAINTAINED_FACTOR}`);
    expect(s).toContain(`${STALE_AFTER_DAYS}일보다 오래`);
  });

  it('documents popularity reference points that match the code', () => {
    const table = rows(section(3), /^\| (stars|downloads_weekly) (\d+) \| (\d+) \|$/);
    expect(table.length).toBeGreaterThanOrEqual(8);
    for (const m of table) {
      const metrics = m[1] === 'stars' ? { stars: Number(m[2]) } : { downloads_weekly: Number(m[2]) };
      expect(score(withMetrics(metrics)).scores.popularity, `${m[1]} ${m[2]}`).toBe(Number(m[3]));
    }
  });

  it('documents the community points', () => {
    const s = section(4);
    const release = rows(s, /^\| 릴리스 \| `last_release_at`이 (\d+)일 이내 \| (\d+) \|$/);
    expect(release.map((m) => [Number(m[1]), Number(m[2])])).toEqual([[RECENT_RELEASE_DAYS, COMMUNITY_POINTS.release]]);
    const contributors = rows(s, /^\| 기여자 \| `contributors` ≥ (\d+) \| (\d+) \|$/).map((m) => ({
      min: Number(m[1]),
      points: Number(m[2]),
    }));
    expect(contributors).toEqual([COMMUNITY_POINTS.contributorsHigh, COMMUNITY_POINTS.contributorsLow]);
    const card = rows(s, /^\| Scorecard \| `scorecard` ≥ (\d+) \| (\d+) \|$/).map((m) => ({
      min: Number(m[1]),
      points: Number(m[2]),
    }));
    expect(card).toEqual([COMMUNITY_POINTS.scorecard]);
  });

  it('documents the license points', () => {
    const found = Object.fromEntries(
      rows(section(5), /^\| (compatible|conditional|unknown|incompatible) \| (\d+) \|/).map((m) => [m[1]!, Number(m[2])]),
    );
    expect(found).toEqual(LICENSE_POINTS);
  });

  it('documents the dependency bands', () => {
    const s = section(6);
    const first = rows(s, /^\| 0–(\d+) \| (\d+) \|$/).map((m) => ({ maxDeps: Number(m[1]), points: Number(m[2]) }));
    const rest = rows(s, /^\| ≤ (\d+) \| (\d+) \|$/).map((m) => ({ maxDeps: Number(m[1]), points: Number(m[2]) }));
    expect([...first, ...rest]).toEqual([...DEPENDENCY_BANDS]);
    const over = rows(s, /^\| (\d+) 초과 \| (\d+) \|$/).map((m) => [Number(m[1]), Number(m[2])]);
    expect(over).toEqual([[DEPENDENCY_BANDS.at(-1)!.maxDeps, DEPENDENCIES_OVER_POINTS]]);
    expect(rows(s, /^\| 알 수 없음 \| (\d+) /).map((m) => Number(m[1]))).toEqual([DEPENDENCIES_UNKNOWN_POINTS]);
  });

  it('documents the fit factor', () => {
    expect(section(7)).toContain(`× ${FIT_FACTOR}`);
  });

  it('documents the hint thresholds', () => {
    const s = section(8);
    const adopt = rows(s, /^\| \d \| total ≥ (\d+) 이고 fit ≥ (\d) \| adopt \|$/);
    expect(adopt.map((m) => ({ total: Number(m[1]), fit: Number(m[2]) }))).toEqual([HINT_THRESHOLDS.adopt]);
    const extend = rows(s, /^\| \d \| total ≥ (\d+) 이고 fit ≥ (\d) \| extend \|$/);
    expect(extend.map((m) => ({ total: Number(m[1]), fit: Number(m[2]) }))).toEqual([HINT_THRESHOLDS.extend]);
    const reference = rows(s, /^\| \d \| fit ≥ (\d) \| reference \|$/);
    expect(reference.map((m) => ({ fit: Number(m[1]) }))).toEqual([HINT_THRESHOLDS.reference]);
    const gate = rows(s, /^\| 1 \| license가 `incompatible` 또는 `unknown`이고 fit (≥|<) (\d) \| (reference|build) \|$/);
    expect(gate.map((m) => [m[1], Number(m[2]), m[3]])).toEqual([
      ['≥', HINT_THRESHOLDS.reference.fit, 'reference'],
      ['<', HINT_THRESHOLDS.reference.fit, 'build'],
    ]);
  });

  it('documents every flag the code can emit', () => {
    const s = section(9);
    const emitted = score(
      withMetrics({ archived: true, deprecated: true, last_commit_at: daysAgo(900) }, { license: verdict('unknown', { source: 'remote_cache' }) }),
    ).flags;
    const more = [
      ...score(input({ license: verdict('unknown', { candidate_spdx: 'X-1.0' }) })).flags,
      ...score(input({ license: verdict('incompatible') })).flags,
      ...score(withMetrics({ last_commit_at: daysAgo(400) })).flags,
    ];
    for (const flag of new Set([...emitted, ...more])) expect(s, flag).toContain(`\`${flag}\``);
  });

  it('worked examples match the code', () => {
    const s = section(10);
    const full = withMetrics(
      { last_commit_at: daysAgo(30), last_release_at: daysAgo(60), stars: 2000, direct_dependencies: 5, contributors: 12, scorecard: 7 },
      { fit: 4 },
    );
    const a = score(full);
    expect(a.total).toBe(90);
    expect(a.hint).toBe('adopt');
    expect(s).toContain('= **90** → hint `adopt`');

    const b = score({ ...full, license: verdict('incompatible') });
    expect(b.total).toBe(70);
    expect(b.hint).toBe('reference');
    expect(s).toContain('총점은 70이지만');

    const c = score(withMetrics({}, { fit: 3 }));
    expect(c.total).toBe(45);
    expect(c.hint).toBe('reference');
    expect(s).toContain('= **45** → fit ≥ 2이므로 hint `reference`');
  });
});
