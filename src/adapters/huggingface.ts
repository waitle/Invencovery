/**
 * Hugging Face Hub adapter for model weights: `SourceAdapter` (search) and
 * `Enricher` (details). docs/PLAN.md §8.
 *
 *   search : GET huggingface.co/api/models?search=<q>&limit=<n>&sort=downloads&direction=-1
 *   details: GET huggingface.co/api/models/<owner>/<name>
 *
 * Both are unauthenticated public endpoints. Everything read from the Hub
 * (model card fields, tags) is third-party text: it is sanitized and bounded
 * here before it reaches a candidate, an evaluation or the ledger.
 *
 * `downloads` on the Hub counts the LAST 30 DAYS, not a week; it is converted
 * to a weekly equivalent (x 7/30, rounded) so it is comparable with npm/PyPI
 * `downloads_weekly`. `likes` is reported as `stars`.
 */
import { z } from 'zod';
import { formatRef, parseRef } from '../types.js';
import type {
  Candidate,
  Enricher,
  Evaluation,
  HttpClient,
  HttpRequestOptions,
  ModelLicenseFacts,
  Provenance,
  SourceAdapter,
  SourceMeta,
} from '../types.js';
import { stripControlChars } from '../core/sanitize.js';
import { MAX_LICENSE_IDS, hfSpdx } from '../core/model-license.js';
import { failureMeta, fetchStatus, truncateDescription, weakestProvenance } from './depsdev.js';

const API = 'https://huggingface.co';
const MODELS = `${API}/api/models`;
const MAX_LIMIT = 100;
/** The Hub reports downloads of the last 30 days. */
const DOWNLOAD_WINDOW_DAYS = 30;

const SEARCH_REQUEST: HttpRequestOptions = { source: 'hf_models', ttlClass: 'search', shareable: true };
const MODEL_REQUEST: HttpRequestOptions = { source: 'hf_models', ttlClass: 'package', shareable: true };

const MANUAL_ALTERNATIVE =
  'Search https://huggingface.co/models manually (WebSearch), then call rw_record_evidence.';

/** Hub license ids are lowercase words with `.`, `+`, `-` (`apache-2.0`, `llama3.1`, `openrail++`). */
const LICENSE_ID = /^[a-z0-9][a-z0-9.+-]{0,63}$/;
/** `owner/name` as the Hub spells base models. */
const MODEL_ID = /^[A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}$/;
const BASE_MODELS_MAX = 5;
const LICENSE_FIELD_MAX = 200;

/** The normalized URL has this origin and exactly this path (no dot-segment can move the request). */
function pathIs(url: string, pathname: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === API && u.pathname === pathname;
  } catch {
    return false;
  }
}

function weeklyEquivalent(downloads: number | null | undefined): number | undefined {
  if (typeof downloads !== 'number' || !Number.isFinite(downloads) || downloads < 0) return undefined;
  return Math.round((downloads * 7) / DOWNLOAD_WINDOW_DAYS);
}

function toIso(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function count(raw: number | null | undefined): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : undefined;
}

/** Lowercase license ids from the card (`license: x` / `license: [x, y]`) or, failing that, `license:*` tags. */
function licenseIds(card: unknown, tags: readonly string[]): string[] {
  const fromCard: string[] = [];
  if (card !== null && typeof card === 'object') {
    const value = (card as Record<string, unknown>).license;
    for (const v of Array.isArray(value) ? value : [value]) if (typeof v === 'string') fromCard.push(v);
  }
  const raw = fromCard.length > 0 ? fromCard : tags.filter((t) => t.startsWith('license:')).map((t) => t.slice(8));
  const ids = raw.map((s) => stripControlChars(s).trim().toLowerCase()).filter((s) => LICENSE_ID.test(s));
  return [...new Set(ids)].slice(0, MAX_LICENSE_IDS);
}

function cardString(card: unknown, key: string): string | undefined {
  if (card === null || typeof card !== 'object') return undefined;
  const v = (card as Record<string, unknown>)[key];
  if (typeof v !== 'string') return undefined;
  const t = stripControlChars(v).replace(/\s+/g, ' ').trim();
  return t === '' ? undefined : t.slice(0, LICENSE_FIELD_MAX);
}

/** `base_model:<id>` and `base_model:<relation>:<id>` tags; only well-formed `owner/name` ids survive. */
function baseModels(tags: readonly string[]): string[] {
  const ids: string[] = [];
  for (const tag of tags) {
    if (!tag.startsWith('base_model:')) continue;
    const parts = tag.split(':');
    const id = parts[parts.length - 1] ?? '';
    if (MODEL_ID.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, BASE_MODELS_MAX);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const SearchItemSchema = z.looseObject({
  id: z.string().min(1),
  private: z.boolean().nullish(),
  likes: z.number().nullish(),
  downloads: z.number().nullish(),
  tags: z.array(z.string()).nullish(),
  pipeline_tag: z.string().nullish(),
  library_name: z.string().nullish(),
  lastModified: z.string().nullish(),
});

export function createHuggingfaceAdapter(deps: { http: HttpClient }): SourceAdapter {
  const { http } = deps;
  return {
    source: 'hf_models',
    async search(q) {
      const query = q.query.trim();
      if (!query) return skipped(query, 'Empty query.');

      const limit = Math.min(Math.max(Math.trunc(q.limit) || 1, 1), MAX_LIMIT);
      const url = `${MODELS}?search=${encodeURIComponent(query)}&limit=${limit}&sort=downloads&direction=-1`;
      const res = await http.getJson<unknown>(url, SEARCH_REQUEST);
      const status = fetchStatus(res);
      if (status !== 'ok') {
        return {
          candidates: [],
          meta: failureMeta('hf_models', status, query, 'Hugging Face model search', MANUAL_ALTERNATIVE),
        };
      }
      if (!Array.isArray(res.data)) {
        return {
          candidates: [],
          meta: failureMeta(
            'hf_models',
            'error',
            query,
            'Hugging Face model search (unexpected response shape)',
            MANUAL_ALTERNATIVE,
          ),
        };
      }

      const candidates: Candidate[] = [];
      let dropped = 0;
      res.data.forEach((raw, index) => {
        const item = SearchItemSchema.safeParse(raw);
        const candidate = item.success ? toCandidate(item.data, query, index + 1, res.provenance) : undefined;
        if (candidate) candidates.push(candidate);
        else dropped += 1;
      });

      const meta: SourceMeta = {
        source: 'hf_models',
        status: dropped > 0 ? 'partial' : res.provenance === 'live' ? 'ok' : 'cached',
        count: candidates.length,
        query,
      };
      if (dropped > 0) meta.message = `${dropped} Hugging Face search result(s) could not be parsed and were dropped.`;
      return { candidates, meta };
    },
  };
}

function skipped(query: string, message: string): { candidates: Candidate[]; meta: SourceMeta } {
  return { candidates: [], meta: { source: 'hf_models', status: 'skipped', count: 0, query, message } };
}

function toCandidate(
  item: z.infer<typeof SearchItemSchema>,
  query: string,
  rank: number,
  provenance: Provenance,
): Candidate | undefined {
  if (item.private === true) return undefined;
  let ref: string;
  try {
    ref = formatRef('hf', item.id);
  } catch {
    return undefined;
  }
  const tags = item.tags ?? [];
  const summary = [item.pipeline_tag, item.library_name]
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .join(' / ');
  const candidate: Candidate = {
    ref,
    source: 'hf_models',
    name: item.id,
    url: `${API}/${item.id}`,
    description: truncateDescription(summary === '' ? null : `Model weights: ${summary}`),
    ecosystem: 'other',
    matched_via: { query, rank },
    provenance,
  };
  const likes = count(item.likes);
  if (likes !== undefined) candidate.stars = likes;
  const weekly = weeklyEquivalent(item.downloads);
  if (weekly !== undefined) candidate.downloads_weekly = weekly;
  const modified = toIso(item.lastModified);
  if (modified) candidate.last_activity = modified;
  // Only ids the code matrix knows are reported as SPDX; `other` and families stay null (judged at evaluation).
  const [first, ...rest] = licenseIds(undefined, tags);
  const spdx = first !== undefined && rest.length === 0 ? hfSpdx(first) : undefined;
  candidate.license_spdx = spdx ?? null;
  return candidate;
}

// ---------------------------------------------------------------------------
// Enricher
// ---------------------------------------------------------------------------

const ModelSchema = z.looseObject({
  id: z.string().optional(),
  private: z.boolean().nullish(),
  gated: z.union([z.boolean(), z.string()]).nullish(),
  disabled: z.boolean().nullish(),
  likes: z.number().nullish(),
  downloads: z.number().nullish(),
  lastModified: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  pipeline_tag: z.string().nullish(),
  library_name: z.string().nullish(),
  cardData: z.unknown().optional(),
});

/** Name, task and tags as one sanitized line, for the "model weights" heuristic of rw_evaluate. */
function descriptorOf(id: string, doc: z.infer<typeof ModelSchema>): string {
  const topics = (doc.tags ?? []).filter((t) => !t.includes(':')).slice(0, 20);
  const text = [id, doc.pipeline_tag, doc.library_name, ...topics]
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .join(' ');
  return truncateDescription(text) ?? id;
}

/**
 * Enricher for `hf:` refs. HTTP failures do not throw: the result then has empty
 * metrics, `license_spdx: null`, no `model_license` and the unobtained facts in
 * `missing`. A private or disabled model is treated as not found.
 */
export function createHuggingfaceEnricher(deps: { http: HttpClient }): Enricher {
  const { http } = deps;
  return {
    supports: (ref) => parseRef(ref)?.scheme === 'hf',
    async enrich(ref) {
      const parsed = parseRef(ref);
      if (parsed?.scheme !== 'hf') {
        throw new TypeError(`huggingface enricher does not support ${JSON.stringify(ref)}`);
      }
      const url = `${MODELS}/${parsed.id}`;
      // Defense in depth: the request must stay on /api/models/<owner>/<name>.
      if (!pathIs(url, `/api/models/${parsed.id}`)) {
        throw new TypeError(
          `huggingface enricher refused the request: ${JSON.stringify(ref)} does not map to a model endpoint.`,
        );
      }

      const res = await http.getJson<unknown>(url, MODEL_REQUEST);
      const doc = fetchStatus(res) === 'ok' ? ModelSchema.safeParse(res.data) : undefined;
      if (!doc?.success || doc.data.private === true || doc.data.disabled === true) {
        return {
          metrics: {},
          license_spdx: null,
          license_source: 'huggingface',
          provenance: res.provenance,
          missing: ['license', 'stars', 'downloads_weekly', 'last_commit_at'],
        };
      }

      const model = doc.data;
      const tags = model.tags ?? [];
      const metrics: Evaluation['metrics'] = {};
      const missing: string[] = [];

      const likes = count(model.likes);
      if (likes !== undefined) metrics.stars = likes;
      else missing.push('stars');
      const weekly = weeklyEquivalent(model.downloads);
      if (weekly !== undefined) metrics.downloads_weekly = weekly;
      else missing.push('downloads_weekly');
      const modified = toIso(model.lastModified);
      if (modified) metrics.last_commit_at = modified;
      else missing.push('last_commit_at');

      const ids = licenseIds(model.cardData, tags);
      const facts: ModelLicenseFacts = {
        hf_license: ids,
        gated: model.gated === true || model.gated === 'auto' || model.gated === 'manual',
        base_models: baseModels(tags),
      };
      const name = cardString(model.cardData, 'license_name');
      if (name !== undefined) facts.license_name = name;
      const link = cardString(model.cardData, 'license_link');
      if (link !== undefined) facts.license_link = link;
      if (ids.length === 0 && name === undefined) missing.push('license');

      const single = ids.length === 1 && name === undefined ? hfSpdx(ids[0]!) : undefined;
      return {
        metrics,
        license_spdx: single ?? null,
        license_source: 'huggingface',
        provenance: weakestProvenance([res.provenance]),
        missing,
        model_license: facts,
        flags: facts.gated ? ['gated_model'] : [],
        descriptor: descriptorOf(parsed.id, model),
      };
    },
  };
}
