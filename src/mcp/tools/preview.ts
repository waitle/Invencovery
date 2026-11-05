/**
 * Candidate preview for `rw_search` (docs/PLAN.md §7.3): a cheap pre-evaluation
 * of the top candidates so the agent sees the license verdict and the score
 * axes that need no judgment (maintenance, popularity, community, license,
 * dependencies: 0-80) before choosing what to `rw_evaluate`.
 *
 * Only enrichers that are not rate limited run (deps.dev and the registries;
 * never the GitHub API), nothing is recorded in the ledger, and a failure
 * leaves the candidate without a preview. `rw_evaluate` stays the recorded,
 * complete evaluation (fit, GitHub detail, weights, services).
 */
import { judge } from '../../core/license.js';
import { score } from '../../core/score.js';
import type { AppContext, Candidate, Distribution, Enricher } from '../../types.js';
import { enrichRef, mergeEnrichment, orderEnrichers } from './evaluate.js';

/** Candidates previewed per search call, in merged order. */
export const PREVIEW_TOP_K = 5;

/** Enrichers whose calls are rate limited per client and therefore not spent on previews. */
const RATE_LIMITED_ENRICHERS: ReadonlySet<string> = new Set(['github']);

/** Flags worth showing in a preview; `metrics_partial` is the normal case for a shallow lookup. */
const HIDDEN_FLAGS: ReadonlySet<string> = new Set(['metrics_partial']);

export interface PreviewOptions {
  projectLicense: string | undefined;
  distribution: Distribution;
  topK?: number;
}

export function previewEnrichers(enrichers: readonly Enricher[]): Enricher[] {
  return orderEnrichers(enrichers.filter((e) => e.name === undefined || !RATE_LIMITED_ENRICHERS.has(e.name)));
}

/**
 * Returns a copy of `candidates` where the first `topK` carry `preview` (when
 * their enrichment produced anything) and a missing `license_spdx` is filled
 * from the enrichment. Order and the other candidates are unchanged.
 */
export async function previewCandidates(
  ctx: AppContext,
  candidates: readonly Candidate[],
  opts: PreviewOptions,
): Promise<Candidate[]> {
  const enrichers = previewEnrichers(ctx.enrichers);
  if (enrichers.length === 0) return [...candidates];
  const topK = opts.topK ?? PREVIEW_TOP_K;
  const now = ctx.now();
  const previewed = await Promise.all(
    candidates.slice(0, topK).map(async (candidate): Promise<Candidate> => {
      try {
        const scheme = candidate.ref.slice(0, candidate.ref.indexOf(':'));
        if (scheme === 'web' || scheme === 'saas') return candidate;
        const results = await enrichRef(enrichers, candidate.ref, false, []);
        if (results.length === 0) return candidate;
        const merged = mergeEnrichment(results);
        // Search metadata already known for the candidate fills the gaps of a shallow lookup.
        const metrics = {
          ...merged.metrics,
          ...(merged.metrics.stars === undefined && candidate.stars !== undefined ? { stars: candidate.stars } : {}),
          ...(merged.metrics.downloads_weekly === undefined && candidate.downloads_weekly !== undefined
            ? { downloads_weekly: candidate.downloads_weekly }
            : {}),
          ...(merged.metrics.last_commit_at === undefined && merged.metrics.last_release_at === undefined && candidate.last_activity !== undefined
            ? { last_commit_at: candidate.last_activity }
            : {}),
          ...(candidate.archived === true ? { archived: true } : {}),
          ...(candidate.deprecated === true ? { deprecated: true } : {}),
        };
        const spdx = merged.license_spdx ?? candidate.license_spdx ?? null;
        const license = judge({
          candidate: spdx,
          project: opts.projectLicense,
          distribution: opts.distribution,
          source: merged.license_source,
        });
        const scored = score({ metrics, license, fit: 0, now });
        return {
          ...candidate,
          ...(candidate.license_spdx == null && spdx !== null ? { license_spdx: spdx } : {}),
          preview: {
            base_score: scored.total,
            license_verdict: license.verdict,
            license_spdx: spdx,
            flags: [
              ...scored.flags.filter((f) => !HIDDEN_FLAGS.has(f)),
              ...(candidate.license_by_ref !== undefined ? ['license_differs_by_source'] : []),
            ],
          },
        };
      } catch {
        return candidate;
      }
    }),
  );
  return [...previewed, ...candidates.slice(topK)];
}
