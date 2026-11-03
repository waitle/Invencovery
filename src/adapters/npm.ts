/**
 * npm registry adapter: `SourceAdapter` (search) and `Enricher` (details).
 * docs/PLAN.md §8.
 *
 *   search : GET registry.npmjs.org/-/v1/search?text=<q>&size=<n>
 *   details: GET registry.npmjs.org/{name}/latest
 *            GET api.npmjs.org/downloads/point/last-week/{name}
 *
 * `last_release_at` is not available from `/latest`; the deps.dev enricher
 * supplies it. The repository is returned as `repository_url` so the caller
 * can continue with the GitHub chain.
 */
import { z } from 'zod';
import { formatRef, parseRef } from '../types.js';
import type {
  Candidate,
  Enricher,
  Evaluation,
  HttpClient,
  HttpRequestOptions,
  Provenance,
  SourceAdapter,
  SourceMeta,
} from '../types.js';
import {
  canonicalRepoUrl,
  failureMeta,
  fetchStatus,
  truncateDescription,
  weakestProvenance,
} from './depsdev.js';

const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week';
const MAX_SIZE = 250;

const SEARCH_REQUEST: HttpRequestOptions = { source: 'npm', ttlClass: 'search', shareable: true };
const PACKAGE_REQUEST: HttpRequestOptions = { source: 'npm', ttlClass: 'package', shareable: true };
const DOWNLOADS_REQUEST: HttpRequestOptions = { source: 'npm', ttlClass: 'downloads', shareable: true };

const MANUAL_ALTERNATIVE =
  'Use `npm search --json <query>` or WebSearch manually, then call rw_record_evidence.';

/** Registry document path for a package: `@scope/name` becomes `@scope%2Fname`. */
export function encodeNpmName(name: string): string {
  return name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
}

/** The downloads API takes the plain `@scope/name`; only unsafe characters are escaped. */
function downloadsPath(name: string): string {
  return name.replace(/[^@/A-Za-z0-9._~-]/g, (c) => encodeURIComponent(c));
}

/** The normalized URL still has the given origin and exactly this path. */
function pathIs(url: string, origin: string, pathname: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === origin && u.pathname === pathname;
  } catch {
    return false;
  }
}

/** The normalized URL stays strictly below `base` (same origin, longer path). */
function pathUnder(url: string, base: string): boolean {
  try {
    const u = new URL(url);
    const b = new URL(base);
    return u.origin === b.origin && u.pathname.startsWith(`${b.pathname}/`) && u.pathname.length > b.pathname.length + 1;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const SearchResponseSchema = z.looseObject({ objects: z.array(z.unknown()) });

const SearchItemSchema = z.looseObject({
  downloads: z.looseObject({ weekly: z.number().nullish() }).nullish(),
  package: z.looseObject({
    name: z.string().min(1),
    description: z.string().nullish(),
    date: z.string().nullish(),
    license: z.string().nullish(),
    links: z
      .looseObject({
        npm: z.string().nullish(),
        repository: z.string().nullish(),
        homepage: z.string().nullish(),
      })
      .nullish(),
  }),
});

function toIso(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function createNpmAdapter(deps: { http: HttpClient }): SourceAdapter {
  const { http } = deps;
  return {
    source: 'npm',
    async search(q) {
      const query = q.query.trim();
      if (q.ecosystem !== undefined && q.ecosystem !== 'npm' && q.ecosystem !== 'other') {
        return skipped(query, `npm search is for the npm ecosystem; component ecosystem is ${q.ecosystem}.`);
      }
      if (!query) return skipped(query, 'Empty query.');

      const size = Math.min(Math.max(Math.trunc(q.limit) || 1, 1), MAX_SIZE);
      const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=${size}`;
      const res = await http.getJson<unknown>(url, SEARCH_REQUEST);
      const status = fetchStatus(res);
      if (status !== 'ok') {
        return { candidates: [], meta: failureMeta('npm', status, query, 'npm registry search', MANUAL_ALTERNATIVE) };
      }
      const body = SearchResponseSchema.safeParse(res.data);
      if (!body.success) {
        return {
          candidates: [],
          meta: failureMeta('npm', 'error', query, 'npm registry search (unexpected response shape)', MANUAL_ALTERNATIVE),
        };
      }

      const candidates: Candidate[] = [];
      let dropped = 0;
      body.data.objects.forEach((raw, index) => {
        const item = SearchItemSchema.safeParse(raw);
        const candidate = item.success ? toCandidate(item.data, query, index + 1, res.provenance) : undefined;
        if (candidate) candidates.push(candidate);
        else dropped += 1;
      });

      const meta: SourceMeta = {
        source: 'npm',
        status: dropped > 0 ? 'partial' : res.provenance === 'live' ? 'ok' : 'cached',
        count: candidates.length,
        query,
      };
      if (dropped > 0) meta.message = `${dropped} npm search result(s) could not be parsed and were dropped.`;
      return { candidates, meta };
    },
  };
}

function skipped(query: string, message: string): { candidates: Candidate[]; meta: SourceMeta } {
  return { candidates: [], meta: { source: 'npm', status: 'skipped', count: 0, query, message } };
}

function toCandidate(
  item: z.infer<typeof SearchItemSchema>,
  query: string,
  rank: number,
  provenance: Provenance,
): Candidate | undefined {
  const pkg = item.package;
  let ref: string;
  try {
    ref = formatRef('npm', pkg.name);
  } catch {
    return undefined;
  }
  const candidate: Candidate = {
    ref,
    source: 'npm',
    name: pkg.name,
    url: pkg.links?.npm || `https://www.npmjs.com/package/${pkg.name}`,
    description: truncateDescription(pkg.description),
    ecosystem: 'npm',
    matched_via: { query, rank },
    provenance,
  };
  const weekly = item.downloads?.weekly;
  if (typeof weekly === 'number' && weekly >= 0) candidate.downloads_weekly = Math.round(weekly);
  const date = toIso(pkg.date);
  if (date) candidate.last_activity = date;
  const repo = canonicalRepoUrl(pkg.links?.repository);
  if (repo) candidate.repository_url = repo;
  if (pkg.license) candidate.license_spdx = pkg.license;
  return candidate;
}

// ---------------------------------------------------------------------------
// Enricher
// ---------------------------------------------------------------------------

const LatestSchema = z.looseObject({
  description: z.string().nullish(),
  keywords: z.array(z.string()).nullish(),
  license: z.union([z.string(), z.looseObject({ type: z.string().nullish() })]).nullish(),
  licenses: z.array(z.looseObject({ type: z.string().nullish() })).nullish(),
  dependencies: z.record(z.string(), z.unknown()).nullish(),
  deprecated: z.union([z.string(), z.boolean()]).nullish(),
  repository: z.union([z.string(), z.looseObject({ url: z.string().nullish() })]).nullish(),
});

const DownloadsSchema = z.looseObject({ downloads: z.number().nonnegative() });

/** `SEE LICENSE IN ...` and `UNLICENSED` carry no SPDX identifier. */
function npmLicense(doc: z.infer<typeof LatestSchema>): string | null {
  const types: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) types.push(v.trim());
  };
  if (typeof doc.license === 'string') add(doc.license);
  else if (doc.license) add(doc.license.type);
  if (types.length === 0) for (const l of doc.licenses ?? []) add(l.type);
  const usable = [...new Set(types)].filter((t) => !/^(SEE LICENSE|UNLICENSED$)/i.test(t));
  if (usable.length === 0) return null;
  return usable.length === 1 ? usable[0]! : usable.join(' AND ');
}

/**
 * Enricher for `npm:` refs. HTTP failures do not throw: the result then has
 * empty metrics, `license_spdx: null` and the unobtained metrics in `missing`
 * (license, direct_dependencies, deprecated, downloads_weekly).
 */
export function createNpmEnricher(deps: { http: HttpClient }): Enricher {
  const { http } = deps;
  return {
    supports: (ref) => parseRef(ref)?.scheme === 'npm',
    async enrich(ref) {
      const parsed = parseRef(ref);
      if (parsed?.scheme !== 'npm') {
        throw new TypeError(`npm enricher does not support ${JSON.stringify(ref)}`);
      }
      const name = parsed.id;
      const latestUrl = `${REGISTRY}/${encodeNpmName(name)}/latest`;
      const downloadsUrl = `${DOWNLOADS}/${downloadsPath(name)}`;
      // Defense in depth: a dot segment must not move the request to another path.
      if (
        !pathIs(latestUrl, REGISTRY, `/${encodeNpmName(name)}/latest`) ||
        !pathUnder(downloadsUrl, DOWNLOADS)
      ) {
        throw new TypeError(`npm enricher refused the request: ${JSON.stringify(ref)} does not map to a package endpoint.`);
      }
      const [latest, downloads] = await Promise.all([
        http.getJson<unknown>(latestUrl, PACKAGE_REQUEST),
        http.getJson<unknown>(downloadsUrl, DOWNLOADS_REQUEST),
      ]);

      const metrics: Evaluation['metrics'] = {};
      const missing: string[] = [];
      const provenance: Provenance[] = [latest.provenance, downloads.provenance];
      let license: string | null = null;
      let repository_url: string | undefined;

      const doc = fetchStatus(latest) === 'ok' ? LatestSchema.safeParse(latest.data) : undefined;
      if (doc?.success) {
        license = npmLicense(doc.data);
        metrics.direct_dependencies = Object.keys(doc.data.dependencies ?? {}).length;
        metrics.deprecated =
          doc.data.deprecated === true ||
          (typeof doc.data.deprecated === 'string' && doc.data.deprecated.trim().length > 0);
        const repo = doc.data.repository;
        repository_url = canonicalRepoUrl(typeof repo === 'string' ? repo : repo?.url);
      } else {
        missing.push('direct_dependencies', 'deprecated');
      }
      if (license === null) missing.push('license');

      const dl = fetchStatus(downloads) === 'ok' ? DownloadsSchema.safeParse(downloads.data) : undefined;
      if (dl?.success) metrics.downloads_weekly = Math.round(dl.data.downloads);
      else missing.push('downloads_weekly');

      const out: Awaited<ReturnType<Enricher['enrich']>> = {
        metrics,
        license_spdx: license,
        license_source: 'npm',
        provenance: weakestProvenance(provenance),
        missing,
      };
      if (repository_url) out.repository_url = repository_url;
      const descriptor = doc?.success
        ? truncateDescription([doc.data.description, ...(doc.data.keywords ?? []).slice(0, 20)].filter((t) => typeof t === 'string').join(' '))
        : null;
      if (descriptor !== null) out.descriptor = descriptor;
      return out;
    },
  };
}
