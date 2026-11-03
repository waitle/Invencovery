/**
 * GitHub adapters (docs/PLAN.md §8): `github_repo` and `github_code`
 * SourceAdapters plus the `github:` Enricher.
 *
 * Every request goes through `HttpClient.getJson` (caching, ETag revalidation,
 * rate-limit bookkeeping and the Authorization header are the client's job).
 * The adapters never see the token: they only ask `hasToken()` whether code
 * search can work. Responses are parsed leniently; items that fail to parse are
 * dropped and the source status becomes `partial`.
 *
 * Conventions: `matched_via.rank` is 1-based; private items are kept (the
 * sanitize layer, not the adapter, decides what leaves the machine).
 */
import { z } from 'zod';
import { redactGithubToken } from '../auth/github-token.js';
import { collectSecrets, maskSecrets } from '../config.js';
import { stripControlChars } from '../core/sanitize.js';
import { formatRef, parseRef } from '../types.js';
import type {
  Candidate,
  Ecosystem,
  Enricher,
  HttpClient,
  HttpRequestOptions,
  HttpResult,
  Provenance,
  RateLimitState,
  SourceAdapter,
  SourceMeta,
} from '../types.js';

export interface GithubAdapterDeps {
  http: HttpClient;
  /**
   * Whether `auth: true` requests will carry a token. Only a boolean crosses
   * this boundary; adapters never receive the token itself.
   */
  hasToken: () => boolean | Promise<boolean>;
  now?: () => Date;
  /**
   * Last known limits from the cache store (`ctx.store.getRateLimit`). Used only
   * to fill in `reset_at` when a rate-limited response carries no headers.
   */
  getRateLimit?: (resource: string) => RateLimitState | undefined;
}

const API = 'https://api.github.com';
/** Largest valid JS Date (epoch ms); a larger header value cannot be rendered as an ISO string. */
const MAX_EPOCH_MS = 8.64e15;
const GITHUB_JSON = 'application/vnd.github+json';
const GITHUB_TEXT_MATCH = 'application/vnd.github.text-match+json';

const MAX_DESCRIPTION = 200;
const MAX_QUERY_LENGTH = 256; // GitHub search rejects longer q values
const MAX_PER_PAGE = 100;
const CODE_PER_PAGE_FACTOR = 3; // several hits per repo collapse into one candidate
const MAX_PATHS_IN_MATCHED_VIA = 3;

const REPO_FALLBACK =
  'Fallback: search manually with WebSearch or `gh search repos "<query>"`, then record findings with rw_record_evidence.';
const CODE_FALLBACK =
  'Fallback: use a Grep MCP server (grep.app) or `gh search code "<query>"`, then record findings with rw_record_evidence.';
const TOKEN_HINT = 'A GitHub token (GITHUB_TOKEN, GH_TOKEN or `gh auth login`) raises the limit.';

const ECOSYSTEM_LANGUAGE: Partial<Record<Ecosystem, string>> = {
  pypi: 'Python',
  cargo: 'Rust',
  go: 'Go',
  maven: 'Java',
  nuget: 'C#',
};

// ---------------------------------------------------------------------------
// Response shapes (only the fields we use; everything else passes through)
// ---------------------------------------------------------------------------

const LicenseSchema = z
  .looseObject({
    spdx_id: z.string().nullish(),
  })
  .nullish();

const RepoSchema = z.looseObject({
  // Must be a valid github ref id too (no dot segments or path characters), or the item is dropped.
  full_name: z.string().refine((s) => parseRef(`github:${s}`) !== undefined),
  html_url: z.string().nullish(),
  description: z.string().nullish(),
  topics: z.array(z.string()).nullish(),
  stargazers_count: z.number().nullish(),
  forks_count: z.number().nullish(),
  open_issues_count: z.number().nullish(),
  license: LicenseSchema,
  pushed_at: z.string().nullish(),
  archived: z.boolean().nullish(),
  private: z.boolean().nullish(),
});
type Repo = z.infer<typeof RepoSchema>;

const SearchBodySchema = z.looseObject({
  incomplete_results: z.boolean().nullish(),
  items: z.array(z.unknown()),
});

const CodeItemSchema = z.looseObject({
  path: z.string().nullish(),
  repository: RepoSchema,
});

const ReleaseSchema = z.looseObject({
  published_at: z.string().nullish(),
  created_at: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function count(n: number | null | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : undefined;
}

function validIso(s: string | null | undefined): string | undefined {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? s : undefined;
}

/** Collapses whitespace and cuts to 200 UTF-16 units (the Candidate limit), never splitting a surrogate pair. */
function truncateDescription(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = stripControlChars(s).replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  if (t.length <= MAX_DESCRIPTION) return t;
  let cut = t.slice(0, MAX_DESCRIPTION - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** SPDX id from GitHub's license object; NOASSERTION ("Other") and absence both mean unknown (null). */
function licenseSpdx(license: Repo['license']): string | null {
  const id = license?.spdx_id;
  return id && id !== 'NOASSERTION' ? id : null;
}

function repoUrl(fullName: string): string {
  return `https://github.com/${fullName.toLowerCase()}`;
}

function clampLimit(limit: number): number {
  return Math.min(MAX_PER_PAGE, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 1)));
}

function quoteQualifier(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** True when `new URL(url)` stays on https://api.github.com and its normalized path is `prefix` or below it. */
function isPathUnder(url: string, prefix: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === API && (u.pathname === prefix || u.pathname.startsWith(`${prefix}/`));
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  // Pattern redaction for GitHub tokens, then value masking of every configured secret
  // (a thrown error may quote an upstream body or a header that holds one).
  return maskSecrets(redactGithubToken(err instanceof Error ? err.message : String(err)), collectSecrets());
}

/**
 * Appends only the qualifiers the caller asked for and the query does not
 * already carry, then trims the free-text part so the whole q fits GitHub's cap.
 */
function buildQuery(
  query: string,
  extras: { language?: string; pushedSince?: string; minStars?: number },
): string {
  const qualifiers: string[] = [];
  if (extras.language && !/\blanguage:/i.test(query)) {
    qualifiers.push(`language:${quoteQualifier(extras.language)}`);
  }
  if (extras.pushedSince && !/\bpushed:/i.test(query)) qualifiers.push(`pushed:>=${extras.pushedSince}`);
  if (extras.minStars && extras.minStars > 0 && !/\bstars:/i.test(query)) {
    qualifiers.push(`stars:>=${Math.trunc(extras.minStars)}`);
  }
  const tail = qualifiers.join(' ');
  let base = query;
  const budget = MAX_QUERY_LENGTH - (tail ? tail.length + 1 : 0);
  if (base.length > budget) {
    base = base.slice(0, Math.max(1, budget));
    const lastSpace = base.lastIndexOf(' ');
    if (lastSpace > 0) base = base.slice(0, lastSpace);
  }
  return tail ? `${base} ${tail}` : base;
}

function searchUrl(path: string, q: string, perPage: number): string {
  return `${API}${path}?q=${encodeURIComponent(q)}&per_page=${perPage}`;
}

// ---------------------------------------------------------------------------
// Rate-limit and failure surfacing
// ---------------------------------------------------------------------------

interface RateInfo {
  remaining: number;
  reset_at: string;
}

function rateInfo(
  deps: GithubAdapterDeps,
  res: HttpResult<unknown>,
  resources: readonly string[],
): RateInfo | undefined {
  const remainingRaw = header(res.headers, 'x-ratelimit-remaining');
  const resetRaw = header(res.headers, 'x-ratelimit-reset'); // epoch seconds
  const retryRaw = header(res.headers, 'retry-after'); // seconds
  if (remainingRaw !== undefined && resetRaw !== undefined) {
    const remaining = Number(remainingRaw);
    const resetSec = Number(resetRaw);
    if (Number.isFinite(remaining) && Number.isFinite(resetSec) && resetSec > 0) {
      const reset = isoFromMs(resetSec * 1000);
      if (reset !== undefined) return { remaining, reset_at: reset };
    }
  }
  if (retryRaw !== undefined) {
    const retry = Number(retryRaw);
    if (Number.isFinite(retry) && retry >= 0) {
      const now = (deps.now ?? (() => new Date()))().getTime();
      const reset = isoFromMs(now + retry * 1000);
      if (reset !== undefined) return { remaining: 0, reset_at: reset };
    }
  }
  for (const resource of resources) {
    const state = deps.getRateLimit?.(resource);
    if (state && state.reset_at > 0) {
      const reset = isoFromMs(state.reset_at);
      if (reset !== undefined) return { remaining: state.remaining, reset_at: reset };
    }
  }
  return undefined;
}

/** ISO string for an epoch-ms value, or undefined when `Date` cannot represent it (never throws a RangeError). */
function isoFromMs(ms: number): string | undefined {
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_EPOCH_MS ? new Date(ms).toISOString() : undefined;
}

async function failureMeta(
  deps: GithubAdapterDeps,
  source: 'github_repo' | 'github_code',
  query: string,
  res: HttpResult<unknown>,
): Promise<SourceMeta> {
  const resources = source === 'github_code' ? ['github:code_search', 'github:search'] : ['github:search'];
  const fallback = source === 'github_code' ? CODE_FALLBACK : REPO_FALLBACK;
  const what = source === 'github_code' ? 'code search' : 'repository search';
  const rate = rateInfo(deps, res, resources);
  const limited =
    res.error === 'rate_limited' ||
    res.status === 429 ||
    (res.status === 403 && rate !== undefined && rate.remaining === 0);
  const base = { source, count: 0, query } as const;

  if (limited) {
    const when = rate ? `resets at ${rate.reset_at}` : 'retry in about a minute';
    const hint = (await deps.hasToken()) ? '' : ` ${TOKEN_HINT}`;
    return {
      ...base,
      status: 'rate_limited',
      ...(rate ? { rate_limit: { remaining: Math.max(0, rate.remaining), reset_at: rate.reset_at } } : {}),
      message: `GitHub ${what} rate limit reached (${when}).${hint} ${fallback}`,
    };
  }
  if (res.error === 'offline' || res.error === 'network') {
    return {
      ...base,
      status: 'offline',
      message: `GitHub ${what} unavailable: offline or network unreachable, and no cached result for this query. ${fallback}`,
    };
  }
  if (res.status === 401) {
    return {
      ...base,
      status: 'error',
      message: `GitHub rejected the token (HTTP 401) for ${what}. Check or unset GITHUB_TOKEN / GH_TOKEN. ${fallback}`,
    };
  }
  const reason = res.error === 'timeout' ? 'timed out' : res.status > 0 ? `HTTP ${res.status}` : 'failed';
  return { ...base, status: 'error', message: `GitHub ${what} ${reason}. ${fallback}` };
}

type SearchFetch =
  | { ok: false; meta: SourceMeta }
  | { ok: true; res: HttpResult<unknown>; items: unknown[]; incomplete: boolean };

async function fetchSearch(
  deps: GithubAdapterDeps,
  source: 'github_repo' | 'github_code',
  query: string,
  url: string,
  accept: string,
): Promise<SearchFetch> {
  let res: HttpResult<unknown>;
  try {
    res = await deps.http.getJson<unknown>(url, {
      source,
      ttlClass: 'search',
      auth: true,
      accept,
      shareable: true,
    });
  } catch (err) {
    const fallback = source === 'github_code' ? CODE_FALLBACK : REPO_FALLBACK;
    return {
      ok: false,
      meta: {
        source,
        status: 'error',
        count: 0,
        query,
        message: `GitHub request failed unexpectedly: ${errorText(err)}. ${fallback}`,
      },
    };
  }
  if (res.data === null || res.status < 200 || res.status >= 300) {
    return { ok: false, meta: await failureMeta(deps, source, query, res) };
  }
  const body = SearchBodySchema.safeParse(res.data);
  if (!body.success) {
    return {
      ok: false,
      meta: {
        source,
        status: 'error',
        count: 0,
        query,
        message: 'GitHub returned an unexpected response shape; ignoring it.',
      },
    };
  }
  return { ok: true, res, items: body.data.items, incomplete: body.data.incomplete_results === true };
}

function successMeta(
  deps: GithubAdapterDeps,
  source: 'github_repo' | 'github_code',
  query: string,
  res: HttpResult<unknown>,
  candidateCount: number,
  extra: { dropped: number; incomplete: boolean; notes?: string[] },
): SourceMeta {
  const notes = [...(extra.notes ?? [])];
  if (extra.dropped > 0) notes.push(`${extra.dropped} malformed item(s) skipped.`);
  if (extra.incomplete) notes.push('GitHub reported incomplete results (upstream search timed out); some matches may be missing.');
  if (res.provenance === 'stale_cache') {
    notes.push('Served from stale cache because GitHub was rate-limited or unreachable.');
  }
  const partial = extra.dropped > 0 || extra.incomplete;
  const status: SourceMeta['status'] = partial ? 'partial' : res.provenance === 'live' ? 'ok' : 'cached';
  const rate = rateInfo(deps, res, []);
  return {
    source,
    status,
    count: candidateCount,
    query,
    ...(rate ? { rate_limit: { remaining: Math.max(0, rate.remaining), reset_at: rate.reset_at } } : {}),
    ...(notes.length > 0 ? { message: notes.join(' ') } : {}),
  };
}

// ---------------------------------------------------------------------------
// github_repo
// ---------------------------------------------------------------------------

export function createGithubRepoAdapter(deps: GithubAdapterDeps): SourceAdapter {
  const now = deps.now ?? (() => new Date());
  return {
    source: 'github_repo',
    async search(q) {
      const query = q.query.trim();
      if (query === '') {
        return {
          candidates: [],
          meta: { source: 'github_repo', status: 'skipped', count: 0, message: 'Empty query; nothing to search.' },
        };
      }
      const limit = clampLimit(q.limit);
      const language = q.language ?? (q.ecosystem ? ECOSYSTEM_LANGUAGE[q.ecosystem] : undefined);
      const pushedSince =
        q.pushedWithinDays !== undefined && q.pushedWithinDays > 0
          ? new Date(now().getTime() - q.pushedWithinDays * 86_400_000).toISOString().slice(0, 10)
          : undefined;
      const effective = buildQuery(query, {
        ...(language ? { language } : {}),
        ...(pushedSince ? { pushedSince } : {}),
        ...(q.minStars !== undefined ? { minStars: q.minStars } : {}),
      });

      const got = await fetchSearch(
        deps,
        'github_repo',
        query,
        searchUrl('/search/repositories', effective, limit),
        GITHUB_JSON,
      );
      if (!got.ok) return { candidates: [], meta: got.meta };

      const candidates: Candidate[] = [];
      let dropped = 0;
      let privateCount = 0;
      for (const raw of got.items) {
        const parsed = RepoSchema.safeParse(raw);
        if (!parsed.success) {
          dropped++;
          continue;
        }
        if (candidates.length >= limit) continue;
        if (parsed.data.private === true) privateCount++;
        candidates.push(repoCandidate(parsed.data, query, candidates.length + 1, got.res.provenance));
      }
      const notes =
        privateCount > 0
          ? [`${privateCount} result(s) are private repositories visible only to your token; do not copy them into shared artifacts.`]
          : [];
      return {
        candidates,
        meta: successMeta(deps, 'github_repo', query, got.res, candidates.length, {
          dropped,
          incomplete: got.incomplete,
          notes,
        }),
      };
    },
  };
}

function repoCandidate(repo: Repo, query: string, rank: number, provenance: Provenance): Candidate {
  const stars = count(repo.stargazers_count);
  const forks = count(repo.forks_count);
  const lastActivity = validIso(repo.pushed_at);
  return {
    ref: formatRef('github', repo.full_name),
    source: 'github_repo',
    name: repo.full_name,
    url: repo.html_url || `https://github.com/${repo.full_name}`,
    description: truncateDescription(repo.description),
    ...(stars !== undefined ? { stars } : {}),
    ...(forks !== undefined ? { forks } : {}),
    license_spdx: licenseSpdx(repo.license),
    ...(lastActivity ? { last_activity: lastActivity } : {}),
    ...(repo.archived != null ? { archived: repo.archived } : {}),
    repository_url: repoUrl(repo.full_name),
    matched_via: { query, rank },
    provenance,
  };
}

// ---------------------------------------------------------------------------
// github_code
// ---------------------------------------------------------------------------

export function createGithubCodeAdapter(deps: GithubAdapterDeps): SourceAdapter {
  return {
    source: 'github_code',
    async search(q) {
      const query = q.query.trim();
      if (query === '') {
        return {
          candidates: [],
          meta: { source: 'github_code', status: 'skipped', count: 0, message: 'Empty query; nothing to search.' },
        };
      }
      if (!(await deps.hasToken())) {
        return {
          candidates: [],
          meta: {
            source: 'github_code',
            status: 'unauthenticated',
            count: 0,
            query,
            message:
              'GitHub code search requires an authenticated token and none was found (set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`). ' +
              CODE_FALLBACK,
          },
        };
      }
      const limit = clampLimit(q.limit);
      const language = q.language ?? (q.ecosystem ? ECOSYSTEM_LANGUAGE[q.ecosystem] : undefined);
      const effective = buildQuery(query, language ? { language } : {});
      const perPage = Math.min(MAX_PER_PAGE, limit * CODE_PER_PAGE_FACTOR);

      const got = await fetchSearch(
        deps,
        'github_code',
        query,
        searchUrl('/search/code', effective, perPage),
        GITHUB_TEXT_MATCH,
      );
      if (!got.ok) return { candidates: [], meta: got.meta };

      // Group hits per repository, keeping first-seen order.
      const groups = new Map<string, { repo: Repo; paths: string[] }>();
      let dropped = 0;
      let privateCount = 0;
      for (const raw of got.items) {
        const parsed = CodeItemSchema.safeParse(raw);
        if (!parsed.success) {
          dropped++;
          continue;
        }
        const key = parsed.data.repository.full_name.toLowerCase();
        let group = groups.get(key);
        if (!group) {
          group = { repo: parsed.data.repository, paths: [] };
          groups.set(key, group);
          if (parsed.data.repository.private === true) privateCount++;
        }
        const path = parsed.data.path;
        if (path && !group.paths.includes(path)) group.paths.push(path);
      }

      const candidates: Candidate[] = [];
      for (const { repo, paths } of groups.values()) {
        if (candidates.length >= limit) break;
        // Candidate.matched_via only has {query, rank}: the matching paths ride along in `query`.
        const shown = paths.slice(0, MAX_PATHS_IN_MATCHED_VIA).join(', ');
        const matchedQuery = shown ? `${query} :: ${shown}` : query;
        candidates.push({
          ref: formatRef('github', repo.full_name),
          source: 'github_code',
          name: repo.full_name,
          url: repo.html_url || `https://github.com/${repo.full_name}`,
          description: truncateDescription(repo.description),
          ...(repo.archived != null ? { archived: repo.archived } : {}),
          repository_url: repoUrl(repo.full_name),
          matched_via: { query: matchedQuery, rank: candidates.length + 1 },
          provenance: got.res.provenance,
        });
      }
      const notes =
        privateCount > 0
          ? [`${privateCount} result(s) are private repositories visible only to your token; do not copy them into shared artifacts.`]
          : [];
      return {
        candidates,
        meta: successMeta(deps, 'github_code', query, got.res, candidates.length, {
          dropped,
          incomplete: got.incomplete,
          notes,
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Enricher (`github:owner/repo`)
// ---------------------------------------------------------------------------

type EnrichResult = Awaited<ReturnType<Enricher['enrich']>>;

const PROVENANCE_ORDER: readonly Provenance[] = ['stale_cache', 'remote_cache', 'local_cache', 'live'];

/** The least fresh / least trusted provenance among the calls that contributed data. */
function worstProvenance(list: Provenance[]): Provenance {
  return PROVENANCE_ORDER.find((p) => list.includes(p)) ?? 'live';
}

function lastPageFromLink(link: string | undefined): number | undefined {
  if (!link) return undefined;
  const m = /<([^>]*)>\s*;\s*rel="?last"?/.exec(link);
  if (!m?.[1]) return undefined;
  try {
    const page = Number(new URL(m[1]).searchParams.get('page'));
    return Number.isInteger(page) && page >= 0 ? page : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GitHub-only detail lookup. `missing` lists only what this enricher is
 * responsible for and tried to get (stars, forks, open_issues, last_commit_at,
 * archived, license, and with `deep` last_release_at and contributors).
 * scorecard and direct_dependencies come from deps.dev and are left to the
 * chain. A repo with no release (404) is a valid answer, not a gap.
 */
export function createGithubEnricher(deps: Pick<GithubAdapterDeps, 'http'>): Enricher {
  const optsFor = (ttlClass: 'repo' | 'repo_aux'): HttpRequestOptions => ({
    source: 'github_repo',
    ttlClass,
    auth: true,
    accept: GITHUB_JSON,
    shareable: true,
  });

  async function get(url: string, ttlClass: 'repo' | 'repo_aux'): Promise<HttpResult<unknown> | undefined> {
    try {
      return await deps.http.getJson<unknown>(url, optsFor(ttlClass));
    } catch {
      return undefined;
    }
  }
  const usable = (r: HttpResult<unknown> | undefined): r is HttpResult<unknown> =>
    r !== undefined && r.data !== null && r.status >= 200 && r.status < 300;

  return {
    supports: (ref) => parseRef(ref)?.scheme === 'github',

    async enrich(ref, { deep }): Promise<EnrichResult> {
      const parsed = parseRef(ref);
      const coreMissing = ['stars', 'forks', 'open_issues', 'last_commit_at', 'archived', 'license'];
      const deepMissing = ['last_release_at', 'contributors'];
      const emptyResult = (repository_url?: string): EnrichResult => ({
        metrics: {},
        license_spdx: null,
        license_source: 'github',
        ...(repository_url ? { repository_url } : {}),
        provenance: 'live',
        missing: deep ? [...coreMissing, ...deepMissing] : coreMissing,
      });
      if (!parsed || parsed.scheme !== 'github') return emptyResult();

      const [owner = '', name = ''] = parsed.id.split('/');
      const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
      const base = `${API}${repoPath}`;
      // Defense in depth: the normalized URL must still be this repository's endpoint
      // (a dot segment would otherwise redirect an authenticated request elsewhere).
      if (!isPathUnder(base, repoPath)) {
        throw new Error('github enricher refused the request: the ref does not map to a /repos/<owner>/<name> endpoint.');
      }
      const fallbackUrl = repoUrl(parsed.id);

      const repoRes = await get(base, 'repo');
      const repo = usable(repoRes) ? RepoSchema.safeParse(repoRes.data) : undefined;
      if (!repoRes || !repo?.success) return emptyResult(fallbackUrl);

      const detail = repo.data;
      const provenances: Provenance[] = [repoRes.provenance];
      const metrics: EnrichResult['metrics'] = {};
      const missing: string[] = [];

      const stars = count(detail.stargazers_count);
      const forks = count(detail.forks_count);
      const issues = count(detail.open_issues_count);
      const pushed = validIso(detail.pushed_at);
      if (stars !== undefined) metrics.stars = stars;
      else missing.push('stars');
      if (forks !== undefined) metrics.forks = forks;
      else missing.push('forks');
      if (issues !== undefined) metrics.open_issues = issues;
      else missing.push('open_issues');
      if (pushed) metrics.last_commit_at = pushed; // pushed_at: last push to any branch
      else missing.push('last_commit_at');
      if (detail.archived != null) metrics.archived = detail.archived;
      else missing.push('archived');
      // license: null means "repository has no license", which is an answer, not a gap.
      if (detail.license === undefined) missing.push('license');

      if (deep) {
        const [releaseRes, contributorsRes] = await Promise.all([
          get(`${base}/releases/latest`, 'repo_aux'),
          get(`${base}/contributors?per_page=1&anon=1`, 'repo_aux'),
        ]);

        if (releaseRes?.status === 404) {
          // No published release: valid, nothing to record.
        } else if (usable(releaseRes)) {
          const release = ReleaseSchema.safeParse(releaseRes.data);
          const at = release.success ? validIso(release.data.published_at) ?? validIso(release.data.created_at) : undefined;
          if (at) {
            metrics.last_release_at = at;
            provenances.push(releaseRes.provenance);
          } else {
            missing.push('last_release_at');
          }
        } else {
          missing.push('last_release_at');
        }

        let contributors: number | undefined;
        if (contributorsRes?.status === 204) contributors = 0; // empty repository
        else if (usable(contributorsRes)) contributors = contributorsCount(contributorsRes);
        if (contributors !== undefined && contributorsRes) {
          metrics.contributors = contributors;
          provenances.push(contributorsRes.provenance);
        } else {
          missing.push('contributors');
        }
      }

      const provenance = worstProvenance(provenances);
      const repository_url = repoUrl(detail.full_name);
      const descriptor = truncateDescription(
        [detail.description, ...(detail.topics ?? []).slice(0, 20)].filter((t) => typeof t === 'string').join(' '),
      );
      return {
        metrics,
        license_spdx: licenseSpdx(detail.license),
        license_source: repoRes.provenance === 'remote_cache' ? 'remote_cache' : 'github',
        repository_url,
        provenance,
        missing,
        ...(descriptor !== null ? { descriptor } : {}),
      };
    },
  };
}

/**
 * Contributor count from a `per_page=1` response: the Link header's last page
 * is the count. Without a Link header the body is the whole list, but cached
 * responses do not retain headers, so a non-live single-element body is
 * ambiguous (1, or "Link header lost") and reported as unknown.
 */
function contributorsCount(res: HttpResult<unknown>): number | undefined {
  const last = lastPageFromLink(header(res.headers, 'link'));
  if (last !== undefined) return last;
  if (!Array.isArray(res.data)) return undefined;
  if (res.data.length === 0) return 0;
  return res.provenance === 'live' && res.data.length === 1 ? 1 : undefined;
}
