/**
 * libraries.io search (PyPI platform only). docs/PLAN.md §8.
 *
 *   GET libraries.io/api/search?q=<q>&platforms=PyPI&per_page=<n>&api_key=...
 *
 * Active only when an API key is configured (`LIBRARIES_IO_API_KEY`); without
 * one `search` returns `status: 'skipped'` and performs no request. Results are
 * normalized to `source: 'pypi'` and are meant to be merged into the PyPI
 * adapter (`createPypiAdapter({ librariesIo })`).
 *
 * The key travels in the URL query. The HTTP layer strips it from cache keys
 * and logs; this module never puts a URL or the key into `SourceMeta.message`.
 */
import { z } from 'zod';
import { formatRef } from '../types.js';
import type { Candidate, HttpClient, HttpRequestOptions, SourceAdapter, SourceMeta } from '../types.js';
import {
  canonicalRepoUrl,
  failureMeta,
  fetchStatus,
  truncateDescription,
} from './depsdev.js';

const SEARCH_URL = 'https://libraries.io/api/search';
const MAX_PER_PAGE = 100;

// Public registry data is shareable elsewhere, but libraries.io responses are
// bound to the API key's data policy and must not be uploaded (PLAN §9.4).
const REQUEST: HttpRequestOptions = { source: 'librariesio', ttlClass: 'search', shareable: false };

const ALTERNATIVE =
  'PyPI discovery falls back to name probes and github_repo (language:Python); try WebSearch and rw_record_evidence.';

const ItemSchema = z.looseObject({
  name: z.string().min(1),
  platform: z.string().nullish(),
  description: z.string().nullish(),
  homepage: z.string().nullish(),
  repository_url: z.string().nullish(),
  stars: z.number().nullish(),
  forks: z.number().nullish(),
  normalized_licenses: z.array(z.string()).nullish(),
  licenses: z.string().nullish(),
  latest_release_published_at: z.string().nullish(),
  status: z.string().nullish(),
  package_manager_url: z.string().nullish(),
});

const DEPRECATED_STATUSES = new Set(['deprecated', 'unmaintained', 'removed']);

export function createLibrariesIoAdapter(deps: { http: HttpClient; apiKey?: string }): SourceAdapter {
  const { http } = deps;
  const apiKey = deps.apiKey?.trim() || undefined;

  return {
    source: 'pypi',
    async search(q) {
      const query = q.query.trim();
      const skip = (message: string) => ({
        candidates: [] as Candidate[],
        meta: { source: 'pypi', status: 'skipped', count: 0, query, message } satisfies SourceMeta,
      });
      if (!apiKey) {
        return skip(
          'libraries.io search is disabled: set LIBRARIES_IO_API_KEY to enable it. PyPI discovery relies on name probes + github_repo language:Python.',
        );
      }
      if (q.ecosystem !== undefined && q.ecosystem !== 'pypi' && q.ecosystem !== 'other') {
        return skip(`libraries.io search is limited to PyPI; component ecosystem is ${q.ecosystem}.`);
      }
      if (!query) return skip('Empty query.');

      const perPage = Math.min(Math.max(Math.trunc(q.limit) || 1, 1), MAX_PER_PAGE);
      const params = new URLSearchParams({ q: query, platforms: 'PyPI', per_page: String(perPage), api_key: apiKey });
      const res = await http.getJson<unknown>(`${SEARCH_URL}?${params.toString()}`, REQUEST);

      if (res.status === 401 || res.status === 403) {
        return {
          candidates: [],
          meta: {
            source: 'pypi',
            status: 'unauthenticated',
            count: 0,
            query,
            message: `libraries.io rejected the configured API key (HTTP ${res.status}). Check LIBRARIES_IO_API_KEY. ${ALTERNATIVE}`,
          },
        };
      }
      const status = fetchStatus(res);
      if (status !== 'ok') {
        return { candidates: [], meta: failureMeta('pypi', status, query, 'libraries.io search', ALTERNATIVE) };
      }
      if (!Array.isArray(res.data)) {
        return {
          candidates: [],
          meta: failureMeta('pypi', 'error', query, 'libraries.io search (unexpected response shape)', ALTERNATIVE),
        };
      }

      const candidates: Candidate[] = [];
      let dropped = 0;
      res.data.forEach((raw: unknown, index: number) => {
        const item = ItemSchema.safeParse(raw);
        if (!item.success) {
          dropped += 1;
          return;
        }
        if (item.data.platform && item.data.platform.toLowerCase() !== 'pypi') return;
        const c = toCandidate(item.data, query, index + 1, res.provenance);
        if (c) candidates.push(c);
        else dropped += 1;
      });

      const meta: SourceMeta = {
        source: 'pypi',
        status: dropped > 0 ? 'partial' : res.provenance === 'live' ? 'ok' : 'cached',
        count: candidates.length,
        query,
      };
      if (dropped > 0) meta.message = `${dropped} libraries.io result(s) could not be parsed and were dropped.`;
      return { candidates, meta };
    },
  };
}

function toCandidate(
  item: z.infer<typeof ItemSchema>,
  query: string,
  rank: number,
  provenance: Candidate['provenance'],
): Candidate | undefined {
  let ref: string;
  try {
    ref = formatRef('pypi', item.name);
  } catch {
    return undefined;
  }
  const candidate: Candidate = {
    ref,
    source: 'pypi',
    name: item.name,
    url: item.package_manager_url || `https://pypi.org/project/${encodeURIComponent(item.name)}/`,
    description: truncateDescription(item.description),
    ecosystem: 'pypi',
    matched_via: { query, rank },
    provenance,
  };
  if (typeof item.stars === 'number' && item.stars >= 0) candidate.stars = Math.round(item.stars);
  if (typeof item.forks === 'number' && item.forks >= 0) candidate.forks = Math.round(item.forks);

  if (item.normalized_licenses) {
    const ids = [...new Set(item.normalized_licenses.map((l) => l.trim()).filter(Boolean))];
    candidate.license_spdx = ids.length === 0 ? null : ids.join(' AND ');
  }
  const released = item.latest_release_published_at ? Date.parse(item.latest_release_published_at) : NaN;
  if (!Number.isNaN(released)) candidate.last_activity = new Date(released).toISOString();

  const repo = canonicalRepoUrl(item.repository_url) ?? canonicalRepoUrl(item.homepage);
  if (repo) candidate.repository_url = repo;
  if (item.status && DEPRECATED_STATUSES.has(item.status.toLowerCase())) candidate.deprecated = true;
  return candidate;
}
