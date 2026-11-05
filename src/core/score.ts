/**
 * Deterministic candidate scoring (docs/PLAN.md section 7.4, scoring_version 1).
 *
 * Pure functions only: no I/O, no clock, no randomness. Time-dependent rules
 * take `now` as an argument. Every axis score is an integer, `total` is the
 * sum of the axis scores (0-100), so a reader can verify the total by hand.
 *
 * Human-readable twin: skills/recyclewheel/reference/scoring.md. A unit test
 * keeps that document and the constants below in sync.
 */
import { isCustomLicenseText } from './license.js';
import type {
  CandidateRef,
  DecisionKind,
  Evaluation,
  LicenseVerdict,
  OssScores,
  SaasEvidenceSource,
  SaasScores,
  SaasTerms,
} from '../types.js';

export const SCORING_VERSION = 1 as const;

const DAY_MS = 86_400_000;

/** Maximum points per axis. The values sum to 100. */
export const MAX_SCORES = {
  maintenance: 25,
  popularity: 15,
  community: 10,
  license: 20,
  dependencies: 10,
  fit: 20,
} as const;

/** Maintenance bands: elapsed whole days <= `maxDays` earns `points`. Older than the last band earns 0. */
export const MAINTENANCE_BANDS = [
  { maxDays: 90, points: 25 },
  { maxDays: 180, points: 20 },
  { maxDays: 365, points: 14 },
  { maxDays: 730, points: 6 },
] as const;

/** Maintenance points when neither last_commit_at nor last_release_at is known. */
export const MAINTENANCE_UNKNOWN_POINTS = 8;

/** Activity older than this many whole days gets the `stale` flag. */
export const STALE_AFTER_DAYS = 365;

/** Scorecard `Maintained` check (0-10) is worth `check * SCORECARD_MAINTAINED_FACTOR` maintenance points. */
export const SCORECARD_MAINTAINED_FACTOR = 2.5;

/** Popularity reaches full points at 10^4 stars or 10^6 weekly downloads (log scale, `+1` offset). */
export const POPULARITY_LOG_SPAN = { stars: 4, downloadsWeekly: 6 } as const;

/** Community: release within this many whole days earns `COMMUNITY_POINTS.release`. */
export const RECENT_RELEASE_DAYS = 365;

export const COMMUNITY_POINTS = {
  release: 4,
  contributorsHigh: { min: 5, points: 4 },
  contributorsLow: { min: 2, points: 2 },
  scorecard: { min: 5, points: 2 },
} as const;

export const LICENSE_POINTS = { compatible: 20, conditional: 10, unknown: 0, incompatible: 0 } as const;

/** Dependencies bands: direct dependency count <= `maxDeps` earns `points`. */
export const DEPENDENCY_BANDS = [
  { maxDeps: 3, points: 10 },
  { maxDeps: 10, points: 7 },
  { maxDeps: 30, points: 4 },
] as const;
export const DEPENDENCIES_OVER_POINTS = 1;
export const DEPENDENCIES_UNKNOWN_POINTS = 5;

/** Fit (0-5, supplied by the agent) is multiplied by this factor. */
export const FIT_FACTOR = 4;

/** Hint thresholds, checked top to bottom after the license gate. */
export const HINT_THRESHOLDS = {
  adopt: { total: 70, fit: 4 },
  extend: { total: 50, fit: 3 },
  /** Minimum fit for `reference`, also used by the license gate. */
  reference: { fit: 2 },
} as const;

export type FitValue = Evaluation['fit']['value'];

export interface ScoreInput {
  metrics: Evaluation['metrics'];
  license: LicenseVerdict;
  /** Agent judgment, integer 0-5. */
  fit: FitValue;
  /** Evaluation time. `Date` or epoch milliseconds. */
  now: Date | number;
  /**
   * OpenSSF Scorecard `Maintained` check value (0-10). `Evaluation['metrics']`
   * carries only the overall scorecard, so callers supply this when they have it.
   */
  scorecardMaintained?: number;
}

export interface ScoreResult {
  scores: OssScores;
  /** Integer 0-100, the sum of `scores`. */
  total: number;
  flags: string[];
  missing: string[];
  hint: DecisionKind;
}

export type RecommendationInput = Pick<Evaluation, 'ref' | 'total' | 'hint' | 'fit' | 'license'>;

export interface Recommendation {
  hint: DecisionKind;
  ref?: CandidateRef;
  reason: string;
}

/** A finite, non-negative number, or `undefined` for anything else (absent, NaN, negative). */
function count(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Whole days elapsed since `iso`, never negative. `undefined` when absent or unparsable. */
function ageDays(iso: string | undefined, nowMs: number): number | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function scoreMaintenance(
  input: ScoreInput,
  nowMs: number,
  flags: string[],
  missing: string[],
): number {
  const { metrics } = input;
  const archived = metrics.archived === true;
  const deprecated = metrics.deprecated === true;
  if (archived) addUnique(flags, 'archived');
  if (deprecated) addUnique(flags, 'deprecated');

  const age = ageDays(metrics.last_commit_at, nowMs) ?? ageDays(metrics.last_release_at, nowMs);
  let points: number;
  if (age === undefined) {
    addUnique(missing, 'last_commit_at');
    points = MAINTENANCE_UNKNOWN_POINTS;
  } else {
    points = MAINTENANCE_BANDS.find((band) => age <= band.maxDays)?.points ?? 0;
    if (!archived && !deprecated && age > STALE_AFTER_DAYS) addUnique(flags, 'stale');
  }

  if (archived || deprecated) return 0;

  const check = count(input.scorecardMaintained);
  if (check !== undefined) {
    points = Math.max(points, Math.min(check, 10) * SCORECARD_MAINTAINED_FACTOR);
  }
  return Math.round(Math.min(points, MAX_SCORES.maintenance));
}

function scorePopularity(metrics: Evaluation['metrics'], missing: string[]): number {
  const stars = count(metrics.stars);
  const downloads = count(metrics.downloads_weekly);
  if (stars === undefined && downloads === undefined) {
    addUnique(missing, 'stars');
    addUnique(missing, 'downloads_weekly');
    return 0;
  }
  const fromStars =
    stars === undefined ? 0 : (MAX_SCORES.popularity * Math.log10(stars + 1)) / POPULARITY_LOG_SPAN.stars;
  const fromDownloads =
    downloads === undefined
      ? 0
      : (MAX_SCORES.popularity * Math.log10(downloads + 1)) / POPULARITY_LOG_SPAN.downloadsWeekly;
  return Math.round(Math.min(MAX_SCORES.popularity, Math.max(fromStars, fromDownloads)));
}

function scoreCommunity(metrics: Evaluation['metrics'], nowMs: number, missing: string[]): number {
  let points = 0;

  const releaseAge = ageDays(metrics.last_release_at, nowMs);
  if (releaseAge === undefined) addUnique(missing, 'last_release_at');
  else if (releaseAge <= RECENT_RELEASE_DAYS) points += COMMUNITY_POINTS.release;

  const contributors = count(metrics.contributors);
  if (contributors === undefined) addUnique(missing, 'contributors');
  else if (contributors >= COMMUNITY_POINTS.contributorsHigh.min) points += COMMUNITY_POINTS.contributorsHigh.points;
  else if (contributors >= COMMUNITY_POINTS.contributorsLow.min) points += COMMUNITY_POINTS.contributorsLow.points;

  const scorecard = count(metrics.scorecard);
  if (scorecard === undefined) addUnique(missing, 'scorecard');
  else if (scorecard >= COMMUNITY_POINTS.scorecard.min) points += COMMUNITY_POINTS.scorecard.points;

  return Math.min(points, MAX_SCORES.community);
}

function scoreLicense(license: LicenseVerdict, flags: string[]): number {
  if (license.verdict === 'unknown') {
    const spdx = license.candidate_spdx;
    addUnique(flags, spdx === null || spdx.trim() === '' ? 'no_license' : 'license_unknown');
    if (isCustomLicenseText(spdx)) addUnique(flags, 'custom_license');
  } else if (license.verdict === 'incompatible') {
    addUnique(flags, 'license_incompatible');
  }
  if (license.source === 'remote_cache') addUnique(flags, 'license_from_remote_cache');
  return LICENSE_POINTS[license.verdict];
}

function scoreDependencies(metrics: Evaluation['metrics'], missing: string[]): number {
  const deps = count(metrics.direct_dependencies);
  if (deps === undefined) {
    addUnique(missing, 'direct_dependencies');
    return DEPENDENCIES_UNKNOWN_POINTS;
  }
  return DEPENDENCY_BANDS.find((band) => deps <= band.maxDeps)?.points ?? DEPENDENCIES_OVER_POINTS;
}

function hintFor(total: number, fit: number, verdict: LicenseVerdict['verdict']): DecisionKind {
  const { adopt, extend, reference } = HINT_THRESHOLDS;
  if (verdict === 'incompatible' || verdict === 'unknown') {
    return fit >= reference.fit ? 'reference' : 'build';
  }
  if (total >= adopt.total && fit >= adopt.fit) return 'adopt';
  if (total >= extend.total && fit >= extend.fit) return 'extend';
  if (fit >= reference.fit) return 'reference';
  return 'build';
}

/**
 * Scores one candidate. Throws `RangeError` when `fit` is not an integer in
 * 0-5 or `now` is not a valid time; the tool layer validates both beforehand.
 */
export function score(input: ScoreInput): ScoreResult {
  const { metrics, license, fit } = input;
  if (!Number.isInteger(fit) || fit < 0 || fit > 5) {
    throw new RangeError(`fit must be an integer between 0 and 5, got ${String(fit)}`);
  }
  const nowMs = input.now instanceof Date ? input.now.getTime() : input.now;
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('now must be a valid Date or epoch milliseconds');
  }

  const flags: string[] = [];
  const missing: string[] = [];

  const scores: OssScores = {
    maintenance: scoreMaintenance(input, nowMs, flags, missing),
    popularity: scorePopularity(metrics, missing),
    community: scoreCommunity(metrics, nowMs, missing),
    license: scoreLicense(license, flags),
    dependencies: scoreDependencies(metrics, missing),
    fit: fit * FIT_FACTOR,
  };
  if (missing.length > 0) addUnique(flags, 'metrics_partial');

  const sum =
    scores.maintenance + scores.popularity + scores.community + scores.license + scores.dependencies + scores.fit;
  const total = Math.min(100, Math.max(0, sum));

  return { scores, total, flags, missing, hint: hintFor(total, fit, license.verdict) };
}

// ---------------------------------------------------------------------------
// Hosted services (profile `saas`, ref scheme `saas:`)
// ---------------------------------------------------------------------------

/** Maximum points per SaaS axis. The values sum to 100. */
export const SAAS_MAX_SCORES = { maturity: 20, terms: 20, lock_in: 20, sdk: 20, fit: 20 } as const;

export const SAAS_MATURITY_POINTS = { ga: 20, beta: 12, preview: 6, unknown: 0 } as const;

/**
 * Terms axis: a checked pricing page plus the vendor's data-use policy, capped at
 * `SAAS_MAX_SCORES.terms`. Pricing earns points by whose page the evidence is
 * (`first_party`: the vendor's own domain, `secondhand`: any other page, `none`:
 * no usable evidence). The data-use policy points are kept for `first_party`,
 * halved (rounded down) for `secondhand` and zero for `none`. `not_stated` (the
 * vendor page was read and does not say whether it trains on data) is worth 4.
 */
export const SAAS_TERMS_POINTS = {
  pricing: { first_party: 8, secondhand: 4, none: 0 },
  dataUse: { no_training: 12, opt_out: 8, not_stated: 4, trains: 0, unknown: 0 },
} as const;

function dataUsePoints(policy: SaasTerms['data_use']['policy'], source: SaasEvidenceSource): number {
  const base = SAAS_TERMS_POINTS.dataUse[policy];
  return source === 'first_party' ? base : source === 'secondhand' ? Math.floor(base / 2) : 0;
}

export const SAAS_LOCK_IN_POINTS = { low: 20, medium: 12, high: 4 } as const;

/** SDK axis: license part plus maintenance part (SDK maintenance axis scaled to `maintenance` points). No SDK earns 0. */
export const SAAS_SDK_POINTS = {
  license: { compatible: 10, conditional: 5, unknown: 0, incompatible: 0 },
  maintenance: 10,
} as const;

export interface SaasSdkInput {
  verdict: LicenseVerdict['verdict'];
  /** Maintenance axis (0-25) of the SDK evaluated as a package. */
  maintenance: number;
}

function sdkMaintenancePoints(maintenance: number): number {
  const bounded = Math.min(Math.max(maintenance, 0), MAX_SCORES.maintenance);
  return Math.round((bounded * SAAS_SDK_POINTS.maintenance) / MAX_SCORES.maintenance);
}

/** Source judgment of the two terms, computed by the caller from the ledger (see `rw_evaluate`). */
export interface SaasSourcesInput {
  pricing: SaasEvidenceSource;
  data_use: SaasEvidenceSource;
}

export interface SaasScoreInput {
  saas: SaasTerms;
  /** Whose page the cited evidence of each term is. The `source` fields inside `saas` are not read. */
  sources: SaasSourcesInput;
  /** Evaluation of `saas.sdk_ref`; absent when the service has no SDK or it was not evaluated. */
  sdk?: SaasSdkInput;
  /** Agent judgment, integer 0-5. */
  fit: FitValue;
}

export interface SaasScoreResult {
  scores: SaasScores;
  total: number;
  flags: string[];
  missing: string[];
  hint: DecisionKind;
}

/**
 * Scores a hosted service. There are no repository metrics: the agent verifies
 * maturity, pricing, data use and lock-in on the vendor's pages and records
 * them (`SaasTerms`). Terms that are not verified (pricing not checked, or the
 * data-use policy unknown), claimed without usable evidence
 * (`saas_evidence_missing`) or backed only by a page that is not the vendor's own
 * (`saas_terms_secondhand`) cap the hint at `reference`, whatever the total says.
 * A policy that is `not_stated` on the vendor's page counts as read: it only raises
 * `saas_data_use_not_stated` (a warning, no cap), while its evidence is judged like any other.
 */
export function scoreSaas(input: SaasScoreInput): SaasScoreResult {
  const { saas, sdk, fit, sources } = input;
  if (!Number.isInteger(fit) || fit < 0 || fit > 5) {
    throw new RangeError(`fit must be an integer between 0 and 5, got ${String(fit)}`);
  }
  const flags: string[] = [];
  const missing: string[] = [];

  const pricingPoints = saas.pricing.checked ? SAAS_TERMS_POINTS.pricing[sources.pricing] : 0;
  const scores: SaasScores = {
    maturity: SAAS_MATURITY_POINTS[saas.maturity],
    terms: Math.min(SAAS_MAX_SCORES.terms, pricingPoints + dataUsePoints(saas.data_use.policy, sources.data_use)),
    lock_in: SAAS_LOCK_IN_POINTS[saas.lock_in],
    sdk:
      sdk === undefined
        ? 0
        : SAAS_SDK_POINTS.license[sdk.verdict] + sdkMaintenancePoints(sdk.maintenance),
    fit: fit * FIT_FACTOR,
  };

  if (!saas.pricing.checked) missing.push('pricing');
  if (saas.data_use.policy === 'unknown') missing.push('data_use');
  const unverified = !saas.pricing.checked || saas.data_use.policy === 'unknown';
  if (unverified) flags.push('saas_terms_unverified');
  if (saas.data_use.policy === 'trains') flags.push('saas_trains_on_data');
  if (saas.data_use.policy === 'not_stated') flags.push('saas_data_use_not_stated');
  // Only the terms the agent claims to have verified are judged by their evidence.
  const claimed: Array<SaasEvidenceSource> = [
    ...(saas.pricing.checked ? [sources.pricing] : []),
    ...(saas.data_use.policy !== 'unknown' ? [sources.data_use] : []),
  ];
  const evidenceMissing = claimed.includes('none');
  const secondhand = claimed.includes('secondhand');
  if (evidenceMissing) flags.push('saas_evidence_missing');
  if (secondhand) flags.push('saas_terms_secondhand');
  if (sdk === undefined) flags.push('no_sdk');

  const total = Math.min(100, Math.max(0, scores.maturity + scores.terms + scores.lock_in + scores.sdk + scores.fit));
  // Reuse the OSS thresholds. Terms that are unverified, without evidence or secondhand behave like a failed license gate: at most `reference`.
  const hint = hintFor(total, fit, unverified || evidenceMissing || secondhand ? 'unknown' : 'compatible');
  return { scores, total, flags, missing, hint };
}

const HINT_PRIORITY: readonly DecisionKind[] = ['adopt', 'extend', 'reference', 'build'];

/**
 * Picks the recommendation across evaluated candidates: the best hint by
 * priority adopt > extend > reference > build, and within that hint the
 * highest total (ties: higher fit, then `ref` ascending, so the result does
 * not depend on input order). `ref` is omitted for `build`.
 */
export function pickRecommendation(evaluations: readonly RecommendationInput[]): Recommendation {
  if (evaluations.length === 0) {
    return { hint: 'build', reason: 'No candidates were evaluated; nothing to adopt, extend or reference.' };
  }

  const ranked = [...evaluations].sort(
    (a, b) =>
      HINT_PRIORITY.indexOf(a.hint) - HINT_PRIORITY.indexOf(b.hint) ||
      b.total - a.total ||
      b.fit.value - a.fit.value ||
      (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
  );
  const best = ranked[0]!;
  const detail = `total ${best.total}/100, fit ${best.fit.value}/5, license ${best.license.verdict}`;

  switch (best.hint) {
    case 'adopt':
      return { hint: 'adopt', ref: best.ref, reason: `${best.ref} is the strongest adopt candidate (${detail}).` };
    case 'extend':
      return {
        hint: 'extend',
        ref: best.ref,
        reason: `${best.ref} is the strongest extend candidate (${detail}); wrap or extend it, no candidate reaches adopt.`,
      };
    case 'reference':
      return {
        hint: 'reference',
        ref: best.ref,
        reason: `${best.ref} is the best reference (${detail}); no candidate is adoptable as is. Take design ideas, and copy code only if its license allows.`,
      };
    case 'build':
      return {
        hint: 'build',
        reason: `No candidate qualifies for adopt, extend or reference (best: ${best.ref}, ${detail}).`,
      };
  }
}
