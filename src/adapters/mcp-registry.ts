/**
 * Official MCP registry adapter and enricher (PLAN §8, T17).
 *
 * Endpoints (https://registry.modelcontextprotocol.io, verified 2026-10-12):
 *   list    GET /v0.1/servers?search=<name substring>&limit=<1..100>&version=latest
 *   detail  GET /v0.1/servers/<url-encoded name>/versions/latest
 * `/v0/...` serves the same shape today and is used as the fallback when the
 * v0.1 request does not produce a usable answer.
 *
 * Response shape: `{ servers: [{ server: {...}, _meta: {
 * "io.modelcontextprotocol.registry/official": { status, publishedAt,
 * updatedAt, isLatest } } }], metadata: { nextCursor, count } }`. The parser is
 * lenient and also accepts the pre-freeze flat layout (no `server` wrapper,
 * `version_detail`, snake_case meta, `registry_name`/`name` packages).
 *
 * The registry `search` parameter is a substring match on the server NAME, so
 * a multi-word query such as "file system" matches nothing. When the whole
 * query yields no hit the adapter searches the individual terms instead.
 */
import { z } from 'zod';
import { stripControlChars } from '../core/sanitize.js';
import { formatRef, parseRef } from '../types.js';
import type {
  Candidate,
  CandidateRef,
  Ecosystem,
  Enricher,
  Evaluation,
  HttpClient,
  HttpRequestOptions,
  HttpResult,
  Provenance,
  SourceAdapter,
  SourceMeta,
} from '../types.js';
import { normalizeRepoUrl } from '../core/dedupe.js';

export const MCP_REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io';

export type McpRegistryApiVersion = 'v0.1' | 'v0';

/** Tried in order; the first usable response wins. */
const API_VERSIONS: readonly McpRegistryApiVersion[] = ['v0.1', 'v0'];

const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;
const DESCRIPTION_MAX = 200;
const MAX_TERM_FALLBACKS = 3;
/** Terms that carry no signal in a registry full of MCP servers. */
const STOP_TERMS = new Set(['mcp', 'server', 'servers']);

const SEARCH_OPTS: HttpRequestOptions = { source: 'mcp_registry', ttlClass: 'search', shareable: true };
const DETAIL_OPTS: HttpRequestOptions = { source: 'mcp_registry', ttlClass: 'registry', shareable: true };

// ---------------------------------------------------------------------------
// URL builders (exported so cache pre-seeding code can reproduce exact URLs)
// ---------------------------------------------------------------------------

export function buildMcpRegistrySearchUrl(
  apiVersion: McpRegistryApiVersion,
  search: string,
  limit: number,
): string {
  return `${MCP_REGISTRY_ORIGIN}/${apiVersion}/servers?search=${encodeURIComponent(search)}&limit=${limit}&version=latest`;
}

export function buildMcpRegistryDetailUrl(apiVersion: McpRegistryApiVersion, name: string): string {
  return `${MCP_REGISTRY_ORIGIN}/${apiVersion}/servers/${encodeURIComponent(name)}/versions/latest`;
}

// ---------------------------------------------------------------------------
// Lenient response parsing
// ---------------------------------------------------------------------------

const optStr = z.string().nullish().catch(undefined);

const RepositorySchema = z.looseObject({ url: optStr, source: optStr, subfolder: optStr });

const PackageSchema = z.looseObject({
  registryType: optStr,
  registry_type: optStr,
  registry_name: optStr,
  identifier: optStr,
  name: optStr,
});

const VersionDetailSchema = z.looseObject({
  version: optStr,
  release_date: optStr,
  is_latest: z.boolean().nullish().catch(undefined),
});

const ServerSchema = z.looseObject({
  name: z.string().min(1),
  title: optStr,
  description: optStr,
  version: optStr,
  status: optStr,
  websiteUrl: optStr,
  website_url: optStr,
  repository: RepositorySchema.nullish().catch(undefined),
  packages: z.array(PackageSchema).nullish().catch(undefined),
  version_detail: VersionDetailSchema.nullish().catch(undefined),
  _meta: z.record(z.string(), z.unknown()).nullish().catch(undefined),
});

interface ParsedServer {
  name: string;
  title?: string;
  description?: string;
  status?: string;
  /** Raw `repository.url`. */
  repositoryUrl?: string;
  subfolder?: string;
  websiteUrl?: string;
  packages: { type: string; id: string }[];
  /** ISO8601 of the registry entry's last update (or publish). */
  updatedAt?: string;
  isLatest?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function validIso(v: unknown): string | undefined {
  const s = str(v);
  return s !== undefined && !Number.isNaN(Date.parse(s)) ? s : undefined;
}

function officialMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isRecord(meta)) return undefined;
  const official = meta[OFFICIAL_META_KEY];
  return isRecord(official) ? official : undefined;
}

/** Accepts `{ server, _meta }` and the legacy flat entry. Undefined = unusable entry. */
function parseEntry(raw: unknown): ParsedServer | undefined {
  if (!isRecord(raw)) return undefined;
  const body = isRecord(raw.server) ? raw.server : raw;
  const parsed = ServerSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const s = parsed.data;
  const meta = officialMeta(raw._meta) ?? officialMeta(s._meta) ?? {};

  const packages: ParsedServer['packages'] = [];
  for (const p of s.packages ?? []) {
    const type = str(p.registryType) ?? str(p.registry_type) ?? str(p.registry_name);
    const id = str(p.identifier) ?? str(p.name);
    if (type !== undefined && id !== undefined) packages.push({ type: type.toLowerCase(), id });
  }

  const isLatest =
    typeof meta.isLatest === 'boolean'
      ? meta.isLatest
      : typeof meta.is_latest === 'boolean'
        ? meta.is_latest
        : (s.version_detail?.is_latest ?? undefined);

  const out: ParsedServer = { name: s.name, packages };
  const title = str(s.title);
  if (title !== undefined) out.title = title;
  const description = str(s.description);
  if (description !== undefined) out.description = description;
  const status = str(meta.status) ?? str(s.status);
  if (status !== undefined) out.status = status.toLowerCase();
  const repositoryUrl = str(s.repository?.url);
  if (repositoryUrl !== undefined) out.repositoryUrl = repositoryUrl;
  const subfolder = str(s.repository?.subfolder);
  if (subfolder !== undefined) out.subfolder = subfolder;
  const websiteUrl = str(s.websiteUrl) ?? str(s.website_url);
  if (websiteUrl !== undefined) out.websiteUrl = websiteUrl;
  const updatedAt =
    validIso(meta.updatedAt) ??
    validIso(meta.updated_at) ??
    validIso(meta.publishedAt) ??
    validIso(meta.published_at) ??
    validIso(s.version_detail?.release_date);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  if (isLatest !== undefined) out.isLatest = isLatest;
  return out;
}

/** The `servers` array of a list response (a bare array is tolerated). */
function extractServers(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.servers)) return data.servers;
  return undefined;
}

// ---------------------------------------------------------------------------
// Mapping to Candidate
// ---------------------------------------------------------------------------

const ECOSYSTEM_BY_REGISTRY: Record<string, Ecosystem> = {
  npm: 'npm',
  pypi: 'pypi',
  nuget: 'nuget',
  maven: 'maven',
};

function truncate(text: string, max: number): string {
  const flat = stripControlChars(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1); // do not split a surrogate pair
  return cut;
}

function safeRef(scheme: 'npm' | 'pypi' | 'mcp', id: string): CandidateRef | undefined {
  try {
    return formatRef(scheme, id);
  } catch {
    return undefined;
  }
}

function candidateUrl(p: ParsedServer, repositoryUrl: string | undefined): string {
  if (repositoryUrl !== undefined) {
    const sub = p.subfolder?.replace(/^\/+|\/+$/g, '');
    if (sub && !sub.split('/').includes('..') && repositoryUrl.startsWith('https://github.com/')) {
      return `${repositoryUrl}/tree/HEAD/${sub}`;
    }
    return repositoryUrl;
  }
  if (p.websiteUrl !== undefined && /^https?:\/\//i.test(p.websiteUrl)) return p.websiteUrl;
  return buildMcpRegistryDetailUrl('v0.1', p.name);
}

function toCandidate(
  p: ParsedServer,
  ctx: { query: string; rank: number; provenance: Provenance },
): Candidate | undefined {
  const ref = safeRef('mcp', p.name);
  if (ref === undefined) return undefined;

  const repositoryUrl = normalizeRepoUrl(p.repositoryUrl);
  const aliases: CandidateRef[] = [];
  let ecosystem: Ecosystem | undefined;
  for (const pkg of p.packages) {
    ecosystem ??= ECOSYSTEM_BY_REGISTRY[pkg.type];
    if (pkg.type === 'npm' || pkg.type === 'pypi') {
      const alias = safeRef(pkg.type, pkg.id);
      if (alias !== undefined && !aliases.includes(alias)) aliases.push(alias);
    }
  }

  const text = p.description ?? p.title;
  const candidate: Candidate = {
    ref,
    source: 'mcp_registry',
    name: p.name,
    url: candidateUrl(p, repositoryUrl),
    description: text === undefined ? null : truncate(text, DESCRIPTION_MAX) || null,
    matched_via: { query: ctx.query, rank: ctx.rank },
    provenance: ctx.provenance,
  };
  if (ecosystem !== undefined) candidate.ecosystem = ecosystem;
  if (p.updatedAt !== undefined) candidate.last_activity = p.updatedAt;
  if (p.status === 'deprecated') candidate.deprecated = true;
  if (repositoryUrl !== undefined) candidate.repository_url = repositoryUrl;
  if (aliases.length > 0) candidate.also_known_as = aliases;
  return candidate;
}

/** Same server name can appear once per published version; keep the best one. */
function pickLatestVersions(entries: readonly ParsedServer[]): ParsedServer[] {
  const best = new Map<string, ParsedServer>();
  const order: string[] = [];
  const better = (a: ParsedServer, b: ParsedServer): boolean => {
    // true when `a` should replace `b`
    if ((a.isLatest === true) !== (b.isLatest === true)) return a.isLatest === true;
    const ta = a.updatedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(a.updatedAt);
    const tb = b.updatedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(b.updatedAt);
    return ta >= tb;
  };
  for (const e of entries) {
    const prior = best.get(e.name);
    if (prior === undefined) {
      best.set(e.name, e);
      order.push(e.name);
    } else if (better(e, prior)) {
      best.set(e.name, e);
    }
  }
  return order.map((name) => best.get(name) as ParsedServer);
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function isSuccess(res: HttpResult): boolean {
  return res.status >= 200 && res.status < 300 && res.error === undefined && res.data !== null;
}

function isRateLimited(res: HttpResult): boolean {
  return res.error === 'rate_limited' || res.status === 429;
}

function networkFailure(): HttpResult {
  return {
    status: 0,
    data: null,
    headers: {},
    provenance: 'live',
    fetched_at: new Date().toISOString(),
    error: 'network',
  };
}

async function safeGet(http: HttpClient, url: string, opts: HttpRequestOptions): Promise<HttpResult> {
  try {
    return await http.getJson(url, opts);
  } catch {
    return networkFailure();
  }
}

function header(res: HttpResult, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

function rateLimitInfo(res: HttpResult): SourceMeta['rate_limit'] | undefined {
  const base = Date.parse(res.fetched_at);
  const now = Number.isNaN(base) ? Date.now() : base;
  const retryAfter = Number(header(res, 'retry-after'));
  const reset = Number(header(res, 'x-ratelimit-reset'));
  let resetMs: number | undefined;
  if (Number.isFinite(retryAfter) && header(res, 'retry-after') !== undefined) {
    resetMs = now + retryAfter * 1000;
  } else if (Number.isFinite(reset) && header(res, 'x-ratelimit-reset') !== undefined) {
    resetMs = reset > 1e9 ? reset * 1000 : now + reset * 1000;
  }
  // Upstream-controlled: an out-of-range epoch would make toISOString() throw a RangeError.
  if (resetMs === undefined || !Number.isFinite(resetMs) || resetMs < 0 || resetMs > 8.64e15) return undefined;
  const remaining = Number(header(res, 'x-ratelimit-remaining'));
  return {
    remaining: Number.isFinite(remaining) && header(res, 'x-ratelimit-remaining') !== undefined ? remaining : 0,
    reset_at: new Date(resetMs).toISOString(),
  };
}

interface FetchedOk {
  ok: true;
  res: HttpResult;
  apiVersion: McpRegistryApiVersion;
  raw: unknown[];
}
type Fetched = FetchedOk | { ok: false; res: HttpResult | undefined };

/** v0.1 first; any answer that is not a usable list falls back to v0 (except rate limit / offline). */
async function fetchList(http: HttpClient, term: string, limit: number): Promise<Fetched> {
  let last: HttpResult | undefined;
  for (const apiVersion of API_VERSIONS) {
    const res = await safeGet(http, buildMcpRegistrySearchUrl(apiVersion, term, limit), SEARCH_OPTS);
    last = res;
    if (isSuccess(res)) {
      const raw = extractServers(res.data);
      if (raw !== undefined) return { ok: true, res, apiVersion, raw };
      continue; // 200 with an unknown shape: let the other API version try
    }
    if (isRateLimited(res) || res.error === 'offline') break;
  }
  return { ok: false, res: last };
}

function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const t of query.toLowerCase().split(/[\s,;]+/)) {
    if (t.length >= 2 && !STOP_TERMS.has(t) && !terms.includes(t)) terms.push(t);
  }
  return terms;
}

function relevance(p: ParsedServer, terms: readonly string[]): number {
  const hay = `${p.name} ${p.title ?? ''} ${p.description ?? ''}`.toLowerCase();
  return terms.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
}

function clampLimit(limit: number): number {
  const n = Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

function failureMeta(res: HttpResult | undefined, query: string): SourceMeta {
  const base = { source: 'mcp_registry' as const, count: 0, query };
  if (res !== undefined && isRateLimited(res)) {
    const meta: SourceMeta = {
      ...base,
      status: 'rate_limited',
      message:
        'MCP registry rate limited. Retry later, or search https://registry.modelcontextprotocol.io manually / use WebSearch and record the findings with rw_record_evidence.',
    };
    const info = rateLimitInfo(res);
    if (info !== undefined) meta.rate_limit = info;
    return meta;
  }
  if (res !== undefined && res.error === 'offline') {
    return {
      ...base,
      status: 'offline',
      message:
        'Offline and no cached MCP registry response. Use WebSearch for "<topic> MCP server", then record the findings with rw_record_evidence.',
    };
  }
  const why = res === undefined ? 'no response' : `${res.error ?? 'http'} (status ${res.status})`;
  return {
    ...base,
    status: 'error',
    message: `MCP registry request failed: ${why}; both /v0.1 and /v0 were tried. Use WebSearch for "<topic> MCP server" and record the findings with rw_record_evidence.`,
  };
}

// ---------------------------------------------------------------------------
// SourceAdapter
// ---------------------------------------------------------------------------

export function createMcpRegistryAdapter(deps: { http: HttpClient }): SourceAdapter {
  const { http } = deps;
  return {
    source: 'mcp_registry',
    async search(q) {
      const query = q.query.trim();
      if (query === '') {
        return {
          candidates: [],
          meta: {
            source: 'mcp_registry',
            status: 'skipped',
            count: 0,
            query: q.query,
            message: 'Empty query; nothing to search in the MCP registry.',
          },
        };
      }
      const limit = clampLimit(q.limit);

      // 1. whole query, 2. (only when it matched nothing) the individual terms.
      const attempts: { fetched: Fetched; term: string }[] = [];
      const first = await fetchList(http, query, limit);
      attempts.push({ fetched: first, term: query });

      const terms = queryTerms(query);
      const firstHasEntries = first.ok && first.raw.length > 0;
      let usedTermFallback = false;
      if (first.ok && !firstHasEntries && /\s/.test(query) && terms.length > 0) {
        usedTermFallback = true;
        for (const term of terms.slice(0, MAX_TERM_FALLBACKS)) {
          attempts.push({ fetched: await fetchList(http, term, limit), term });
        }
      }

      const oks: FetchedOk[] = [];
      for (const a of attempts) if (a.fetched.ok) oks.push(a.fetched);
      if (oks.length === 0) {
        return { candidates: [], meta: failureMeta(first.res, q.query) };
      }

      // Parse, drop unusable/deleted entries, keep the best version per name.
      let dropped = 0;
      const parsed: { server: ParsedServer; provenance: Provenance }[] = [];
      for (const f of oks) {
        for (const raw of f.raw) {
          const p = parseEntry(raw);
          if (p === undefined) dropped += 1;
          else if (p.status !== 'deleted') parsed.push({ server: p, provenance: f.res.provenance });
        }
      }
      const provenanceByName = new Map<string, Provenance>();
      for (const { server, provenance } of parsed) {
        if (!provenanceByName.has(server.name)) provenanceByName.set(server.name, provenance);
      }
      const unique = pickLatestVersions(parsed.map((x) => x.server));

      // The registry lists alphabetically; order by how many query terms a server mentions.
      const scoreTerms = terms.length > 0 ? terms : [query.toLowerCase()];
      const ranked = unique
        .map((server, index) => ({ server, index, score: relevance(server, scoreTerms) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit);

      const candidates: Candidate[] = [];
      for (const { server } of ranked) {
        const candidate = toCandidate(server, {
          query: q.query,
          rank: candidates.length + 1,
          provenance: provenanceByName.get(server.name) ?? 'live',
        });
        if (candidate === undefined) dropped += 1;
        else candidates.push(candidate);
      }

      // Status + notes.
      const notes: string[] = [];
      const anyLive = oks.some((f) => f.res.provenance === 'live');
      const anyFailed = oks.length < attempts.length;
      const usedLegacy = oks.some((f) => f.apiVersion === 'v0');
      if (usedLegacy) notes.push('Answered by the legacy /v0 endpoint because /v0.1 was unavailable.');
      if (usedTermFallback) {
        notes.push(
          `No server name contains the whole query; searched the terms individually (${attempts
            .slice(1)
            .map((a) => a.term)
            .join(', ')}).`,
        );
      }
      if (candidates.length === 0) {
        notes.push(
          'MCP registry search matches server names only (substring); try one short keyword such as "postgres" or "pdf".',
        );
      }
      if (oks.some((f) => f.res.provenance === 'stale_cache')) {
        notes.push('Served from stale cache.');
      }
      if (dropped > 0) notes.push(`${dropped} registry entr${dropped === 1 ? 'y' : 'ies'} could not be parsed and were skipped.`);
      if (anyFailed && usedTermFallback) notes.push('Some per-term requests failed.');

      const status: SourceMeta['status'] =
        dropped > 0 || (anyFailed && usedTermFallback) ? 'partial' : anyLive ? 'ok' : 'cached';
      const meta: SourceMeta = { source: 'mcp_registry', status, count: candidates.length, query: q.query };
      if (notes.length > 0) meta.message = notes.join(' ');
      return { candidates, meta };
    },
  };
}

// ---------------------------------------------------------------------------
// Enricher
// ---------------------------------------------------------------------------

type EnrichResult = Awaited<ReturnType<Enricher['enrich']>>;

function unavailable(provenance: Provenance): EnrichResult {
  return {
    metrics: {},
    license_spdx: null,
    license_source: 'github',
    provenance,
    missing: ['license', 'repository_url', 'registry_detail'],
  };
}

/**
 * Detail lookup for `mcp:<server name>` refs. The registry carries no license
 * or popularity data, so it contributes `repository_url` (the caller continues
 * with the github chain), the last publish time and the deprecation status.
 * Failures never throw: they are reported through `missing`.
 */
export function createMcpRegistryEnricher(deps: { http: HttpClient }): Enricher {
  const { http } = deps;
  return {
    supports(ref) {
      return parseRef(ref)?.scheme === 'mcp';
    },
    async enrich(ref) {
      const parsed = parseRef(ref);
      if (parsed?.scheme !== 'mcp') return unavailable('live');

      let server: ParsedServer | undefined;
      let provenance: Provenance = 'live';
      for (const apiVersion of API_VERSIONS) {
        const res = await safeGet(http, buildMcpRegistryDetailUrl(apiVersion, parsed.id), DETAIL_OPTS);
        provenance = res.provenance;
        if (isSuccess(res)) {
          server = parseEntry(res.data);
          if (server !== undefined) break;
          continue;
        }
        if (isRateLimited(res) || res.error === 'offline') break;
      }
      if (server === undefined) return unavailable(provenance);

      const metrics: Evaluation['metrics'] = {};
      if (server.updatedAt !== undefined) metrics.last_release_at = server.updatedAt;
      if (server.status === 'deprecated') metrics.deprecated = true;

      // The registry has no license data; the github chain (via repository_url) supplies it.
      const result: EnrichResult = {
        metrics,
        license_spdx: null,
        license_source: 'github',
        provenance,
        missing: ['license'],
      };
      const repositoryUrl = normalizeRepoUrl(server.repositoryUrl);
      if (repositoryUrl !== undefined) result.repository_url = repositoryUrl;
      else result.missing.push('repository_url');
      if (server.description !== undefined) {
        const descriptor = truncate(server.description, DESCRIPTION_MAX);
        if (descriptor !== '') result.descriptor = descriptor;
      }
      return result;
    },
  };
}
