/**
 * deps.dev v3 lookups and the evaluation `Enricher` (docs/PLAN.md §8, §7.4).
 *
 * deps.dev is the preferred metadata source for evaluation: stars, forks, open
 * issues, license and OpenSSF Scorecard for GitHub projects, and license,
 * release time and DIRECT dependency count for npm/PyPI packages, all without
 * spending GitHub rate limit.
 *
 * Four lookups (`getProject`, `getPackage`, `getVersion`, `getDependencies`)
 * map a deps.dev response to a small domain object. They never throw for
 * HTTP-level problems; the returned `status` says what happened.
 *
 * The bottom of this file also hosts the small helpers shared by the other
 * registry adapters (npm, pypi, librariesio). They live here because
 * `src/adapters/depsdev.ts` is the only registry file all of them already
 * depend on.
 */
import { z } from 'zod';
import { stripControlChars } from '../core/sanitize.js';
import { parseRef } from '../types.js';
import type {
  Enricher,
  Evaluation,
  HttpClient,
  HttpRequestOptions,
  HttpResult,
  Provenance,
  Source,
  SourceMeta,
} from '../types.js';

// ---------------------------------------------------------------------------
// Shared helpers (used by npm.ts, pypi.ts, librariesio.ts)
// ---------------------------------------------------------------------------

export const DESCRIPTION_MAX = 200;

/**
 * Strips control, zero-width and bidi-control characters, collapses whitespace
 * and truncates to `DESCRIPTION_MAX` UTF-16 units (contract: max 200 chars).
 * Stripping first keeps hidden characters from hiding text in the cut-off tail
 * or from surviving the whitespace collapse (security review M-5).
 */
export function truncateDescription(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = stripControlChars(text).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= DESCRIPTION_MAX) return t;
  let cut = t.slice(0, DESCRIPTION_MAX - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // do not split a surrogate pair
  return `${cut.trimEnd()}…`;
}

const PROVENANCE_WEAKEST_FIRST: readonly Provenance[] = [
  'stale_cache',
  'remote_cache',
  'local_cache',
  'live',
];

/** Combines the provenance of several responses into the least trustworthy one. */
export function weakestProvenance(list: readonly Provenance[]): Provenance {
  for (const p of PROVENANCE_WEAKEST_FIRST) if (list.includes(p)) return p;
  return 'live';
}

const FORGE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

/**
 * Normalizes a repository reference to `https://<host>/<owner>/<repo>`
 * (lowercase, no `.git`, no `tree/...` sub path). Accepts `git+https://`,
 * `git://`, `ssh://git@`, scp-like `git@host:owner/repo.git`, npm shorthands
 * (`github:o/r`, `o/r`). Returns `undefined` for anything that is not a
 * repository on a well-known forge (github.com, gitlab.com, bitbucket.org,
 * codeberg.org).
 */
export function canonicalRepoUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let s = raw.trim();
  if (!s) return undefined;

  const shorthand = /^(github|gitlab|bitbucket):([^/\s]+\/[^/\s]+)$/i.exec(s);
  if (shorthand) {
    const forge = shorthand[1]!.toLowerCase();
    s = `https://${forge}.${forge === 'bitbucket' ? 'org' : 'com'}/${shorthand[2]}`;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    s = `https://github.com/${s}`; // npm "owner/repo" shorthand means GitHub
  }

  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(s);
  if (scp) s = `https://${scp[1]}/${scp[2]}`;

  s = s.replace(/^git\+/i, '').replace(/^(?:git|ssh|http|https):\/\/(?:[^@/]+@)?/i, 'https://');

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!FORGE_HOSTS.has(host)) return undefined;

  let parts = url.pathname.split('/').filter(Boolean);
  const dash = parts.indexOf('-'); // gitlab "/-/tree/..."
  if (dash >= 0) parts = parts.slice(0, dash);
  if (host === 'github.com') parts = parts.slice(0, 2);
  if (parts.length < 2) return undefined;
  parts[parts.length - 1] = parts[parts.length - 1]!.replace(/\.git$/i, '');
  if (parts.some((p) => p.length === 0)) return undefined;
  return `https://${host}/${parts.join('/').toLowerCase()}`;
}

/** What a single HTTP lookup amounted to. */
export type FetchStatus = 'ok' | 'not_found' | 'rate_limited' | 'offline' | 'error';

export function fetchStatus(r: HttpResult): FetchStatus {
  if (r.data !== null && r.status >= 200 && r.status < 300) return 'ok';
  if (r.status === 404) return 'not_found';
  if (r.error === 'rate_limited' || r.status === 429) return 'rate_limited';
  if (r.error === 'offline') return 'offline';
  return 'error';
}

/** `SourceMeta` for a request that produced no usable data. Never put URLs (they may carry keys) in `label`. */
export function failureMeta(
  source: Source,
  status: Exclude<FetchStatus, 'ok'>,
  query: string,
  label: string,
  alternative: string,
): SourceMeta {
  const reason: Record<Exclude<FetchStatus, 'ok'>, string> = {
    rate_limited: `${label} rate limit reached`,
    offline: `${label} is unreachable (offline mode or no network)`,
    not_found: `${label} returned no result`,
    error: `${label} request failed`,
  };
  const metaStatus: SourceMeta['status'] =
    status === 'rate_limited' ? 'rate_limited' : status === 'offline' ? 'offline' : 'error';
  return { source, status: metaStatus, count: 0, query, message: `${reason[status]}. ${alternative}` };
}

// ---------------------------------------------------------------------------
// deps.dev lookups
// ---------------------------------------------------------------------------

const BASE = 'https://api.deps.dev/v3';
const REQUEST: HttpRequestOptions = { source: 'depsdev', ttlClass: 'depsdev', shareable: true };

export type DepsDevSystem = 'npm' | 'pypi';

export interface DepsDevLookup<T> {
  /** `null` unless `status === 'ok'`. */
  data: T | null;
  status: FetchStatus;
  provenance: Provenance;
}

/** int64 fields may arrive as JSON numbers or decimal strings. */
const CountLike = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .transform((n) => (Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined));

const NON_SPDX = new Set(['', 'non-standard', 'noassertion', 'none', 'unknown']);

function cleanSpdx(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return NON_SPDX.has(s.toLowerCase()) ? null : s;
}

function isoOrUndefined(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

async function lookup<S extends z.ZodType, T>(
  http: HttpClient,
  url: string,
  schema: S,
  map: (parsed: z.infer<S>) => T,
): Promise<DepsDevLookup<T>> {
  const res = await http.getJson<unknown>(url, REQUEST);
  const status = fetchStatus(res);
  if (status !== 'ok') return { data: null, status, provenance: res.provenance };
  const parsed = schema.safeParse(res.data);
  if (!parsed.success) return { data: null, status: 'error', provenance: res.provenance };
  return { data: map(parsed.data), status: 'ok', provenance: res.provenance };
}

// --- project -----------------------------------------------------------------

const ProjectSchema = z.looseObject({
  starsCount: CountLike.nullish(),
  forksCount: CountLike.nullish(),
  openIssuesCount: CountLike.nullish(),
  license: z.string().nullish(),
  description: z.string().nullish(),
  homepage: z.string().nullish(),
  scorecard: z.looseObject({ overallScore: z.number().nullish() }).nullish(),
});

export interface DepsDevProject {
  stars?: number;
  forks?: number;
  open_issues?: number;
  /** SPDX expression as reported by deps.dev; `null` when absent or "non-standard". */
  license: string | null;
  /** OpenSSF Scorecard overall score, 0-10. */
  scorecard?: number;
  description?: string;
  homepage?: string;
}

/** `GET /v3/projects/github.com%2F{owner}%2F{repo}` */
export function getProject(
  http: HttpClient,
  owner: string,
  repo: string,
): Promise<DepsDevLookup<DepsDevProject>> {
  const id = encodeURIComponent(`github.com/${owner}/${repo}`);
  return lookup(http, `${BASE}/projects/${id}`, ProjectSchema, (p): DepsDevProject => {
    const score = p.scorecard?.overallScore;
    const project: DepsDevProject = { license: cleanSpdx(p.license) };
    if (p.starsCount != null) project.stars = p.starsCount;
    if (p.forksCount != null) project.forks = p.forksCount;
    if (p.openIssuesCount != null) project.open_issues = p.openIssuesCount;
    if (typeof score === 'number' && score >= 0 && score <= 10) project.scorecard = score;
    if (p.description) project.description = p.description;
    if (p.homepage) project.homepage = p.homepage;
    return project;
  });
}

// --- package -----------------------------------------------------------------

const PackageSchema = z.looseObject({
  versions: z
    .array(
      z.looseObject({
        versionKey: z.looseObject({ version: z.string() }),
        publishedAt: z.string().nullish(),
        isDefault: z.boolean().nullish(),
        isDeprecated: z.boolean().nullish(),
      }),
    )
    .nullish(),
});

export interface DepsDevPackage {
  /** The version deps.dev marks as default; falls back to the most recently published one. */
  default_version?: string;
  /** ISO8601 publish time of the most recently published version. */
  latest_published_at?: string;
  default_version_deprecated: boolean;
  version_count: number;
}

/** `GET /v3/systems/{system}/packages/{name}` */
export function getPackage(
  http: HttpClient,
  system: DepsDevSystem,
  name: string,
): Promise<DepsDevLookup<DepsDevPackage>> {
  const url = `${BASE}/systems/${system}/packages/${encodeURIComponent(name)}`;
  return lookup(http, url, PackageSchema, (p): DepsDevPackage => {
    const versions = (p.versions ?? []).map((v) => ({
      version: v.versionKey.version,
      published: isoOrUndefined(v.publishedAt),
      isDefault: v.isDefault === true,
      deprecated: v.isDeprecated === true,
    }));
    let latest: (typeof versions)[number] | undefined;
    for (const v of versions) {
      if (v.published && (!latest?.published || v.published > latest.published)) latest = v;
    }
    const def = versions.find((v) => v.isDefault) ?? latest;
    const pkg: DepsDevPackage = {
      default_version_deprecated: def?.deprecated ?? false,
      version_count: versions.length,
    };
    if (def) pkg.default_version = def.version;
    if (latest?.published) pkg.latest_published_at = latest.published;
    return pkg;
  });
}

// --- version -----------------------------------------------------------------

const VersionSchema = z.looseObject({
  publishedAt: z.string().nullish(),
  isDeprecated: z.boolean().nullish(),
  licenses: z.array(z.string()).nullish(),
  links: z
    .array(z.looseObject({ label: z.string().nullish(), url: z.string().nullish() }))
    .nullish(),
  relatedProjects: z
    .array(z.looseObject({ projectKey: z.looseObject({ id: z.string().nullish() }).nullish() }))
    .nullish(),
});

export interface DepsDevVersion {
  version: string;
  published_at?: string;
  deprecated: boolean;
  /**
   * SPDX expression for the version. Several licenses are joined with `AND`
   * (deps.dev flattens `A OR B` to a list, so AND is the conservative reading).
   * `null` when none is declared or any entry is non-standard.
   */
  license: string | null;
  /** Normalized repository URL from the SOURCE_REPO link or related project. */
  repository_url?: string;
}

/** `GET /v3/systems/{system}/packages/{name}/versions/{version}` */
export function getVersion(
  http: HttpClient,
  system: DepsDevSystem,
  name: string,
  version: string,
): Promise<DepsDevLookup<DepsDevVersion>> {
  const url = `${BASE}/systems/${system}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  return lookup(http, url, VersionSchema, (v): DepsDevVersion => {
    const raw = v.licenses ?? [];
    const cleaned = raw.map(cleanSpdx);
    const license =
      raw.length === 0 || cleaned.some((l) => l === null)
        ? null
        : [...new Set(cleaned as string[])].join(' AND ');

    let repository_url: string | undefined;
    for (const link of v.links ?? []) {
      if (link.label === 'SOURCE_REPO') repository_url ??= canonicalRepoUrl(link.url);
    }
    for (const rp of v.relatedProjects ?? []) {
      const id = rp.projectKey?.id;
      if (id) repository_url ??= canonicalRepoUrl(`https://${id}`);
    }

    const out: DepsDevVersion = { version, deprecated: v.isDeprecated === true, license };
    const published = isoOrUndefined(v.publishedAt);
    if (published) out.published_at = published;
    if (repository_url) out.repository_url = repository_url;
    return out;
  });
}

// --- dependencies --------------------------------------------------------------

const DependenciesSchema = z.looseObject({
  nodes: z
    .array(z.looseObject({ relation: z.string().nullish() }))
    .nullish(),
});

export interface DepsDevDependencies {
  /** Nodes with relation DIRECT. SELF and INDIRECT are not counted. */
  direct: number;
  indirect: number;
}

/** `GET /v3/systems/{system}/packages/{name}/versions/{version}:dependencies` */
export function getDependencies(
  http: HttpClient,
  system: DepsDevSystem,
  name: string,
  version: string,
): Promise<DepsDevLookup<DepsDevDependencies>> {
  const url = `${BASE}/systems/${system}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}:dependencies`;
  return lookup(http, url, DependenciesSchema, (d): DepsDevDependencies => {
    let direct = 0;
    let indirect = 0;
    for (const n of d.nodes ?? []) {
      if (n.relation === 'DIRECT') direct += 1;
      else if (n.relation === 'INDIRECT') indirect += 1;
    }
    return { direct, indirect };
  });
}

// ---------------------------------------------------------------------------
// Enricher
// ---------------------------------------------------------------------------

type EnrichResult = Awaited<ReturnType<Enricher['enrich']>>;
type Metrics = Evaluation['metrics'];

/**
 * Enricher backed by deps.dev. Supports `github:`, `npm:` and `pypi:` refs.
 *
 * - `github:o/r`  -> project lookup: stars, forks, open_issues, scorecard, license.
 * - `npm:` / `pypi:` -> package, default version, DIRECT dependency count:
 *   last_release_at, direct_dependencies, deprecated, license, repository_url.
 *
 * HTTP-level failures do not throw: the result carries empty metrics,
 * `license_spdx: null` and the unobtained metric names in `missing`
 * (`license` is listed whenever the license could not be determined).
 */
export function createDepsDevEnricher(deps: { http: HttpClient }): Enricher {
  const { http } = deps;
  return {
    supports(ref) {
      const p = parseRef(ref);
      return p?.scheme === 'github' || p?.scheme === 'npm' || p?.scheme === 'pypi';
    },
    async enrich(ref): Promise<EnrichResult> {
      const parsed = parseRef(ref);
      if (!parsed) throw new TypeError(`deps.dev enricher: invalid ref ${JSON.stringify(ref)}`);
      if (parsed.scheme === 'github') return enrichProject(http, parsed.id);
      if (parsed.scheme === 'npm' || parsed.scheme === 'pypi') {
        return enrichPackage(http, parsed.scheme, parsed.id);
      }
      throw new TypeError(`deps.dev enricher does not support ${ref}`);
    },
  };
}

async function enrichProject(http: HttpClient, id: string): Promise<EnrichResult> {
  const [owner, repo] = id.split('/') as [string, string];
  const res = await getProject(http, owner, repo);
  const metrics: Metrics = {};
  const missing: string[] = [];
  const p = res.data;
  if (p?.stars !== undefined) metrics.stars = p.stars;
  else missing.push('stars');
  if (p?.forks !== undefined) metrics.forks = p.forks;
  else missing.push('forks');
  if (p?.open_issues !== undefined) metrics.open_issues = p.open_issues;
  else missing.push('open_issues');
  if (p?.scorecard !== undefined) metrics.scorecard = p.scorecard;
  else missing.push('scorecard');
  const license = p?.license ?? null;
  if (license === null) missing.push('license');
  return {
    metrics,
    license_spdx: license,
    license_source: 'depsdev',
    repository_url: canonicalRepoUrl(`https://github.com/${id}`),
    provenance: res.provenance,
    missing,
  };
}

async function enrichPackage(
  http: HttpClient,
  system: DepsDevSystem,
  name: string,
): Promise<EnrichResult> {
  const pkg = await getPackage(http, system, name);
  const metrics: Metrics = {};
  const missing: string[] = [];
  const provenance: Provenance[] = [pkg.provenance];
  let license: string | null = null;
  let repository_url: string | undefined;

  if (pkg.data?.latest_published_at) metrics.last_release_at = pkg.data.latest_published_at;
  else missing.push('last_release_at');
  if (pkg.data?.default_version_deprecated) metrics.deprecated = true;

  const version = pkg.data?.default_version;
  if (version) {
    const [ver, dep] = await Promise.all([
      getVersion(http, system, name, version),
      getDependencies(http, system, name, version),
    ]);
    provenance.push(ver.provenance, dep.provenance);
    if (ver.data) {
      license = ver.data.license;
      repository_url = ver.data.repository_url;
      if (ver.data.deprecated) metrics.deprecated = true;
    }
    if (dep.data) metrics.direct_dependencies = dep.data.direct;
    else missing.push('direct_dependencies');
  } else {
    missing.push('direct_dependencies');
  }
  if (license === null) missing.push('license');

  const out: EnrichResult = {
    metrics,
    license_spdx: license,
    license_source: 'depsdev',
    provenance: weakestProvenance(provenance),
    missing,
  };
  if (repository_url) out.repository_url = repository_url;
  return out;
}
