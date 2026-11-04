/**
 * Candidate de-duplication across sources (PLAN §7.3 step 3, T17).
 *
 * The same project often shows up as a GitHub repo, an npm package, a PyPI
 * project and an MCP registry entry. `dedupe` merges those into one candidate,
 * keeps the other refs in `also_known_as` (the merge evidence) and unions the
 * metrics. Pure functions, no I/O, inputs are never mutated.
 *
 * What counts as "same project":
 *   1. identical ref (github refs compare case-insensitively, pypi refs are
 *      PEP 503 normalized);
 *   2. a candidate lists another candidate's ref in `also_known_as`
 *      (for example an MCP registry entry that declares its npm package);
 *   3. identical normalized repository URL, but only when that is unambiguous.
 *      A monorepo publishes many packages from one URL, so when two different
 *      refs of the same scheme share a URL (`@babel/core` and `@babel/parser`),
 *      those refs are different projects and are left unmerged.
 */
import { formatRef, parseRef } from '../types.js';
import type { Candidate, CandidateRef, Provenance, Source } from '../types.js';

// ---------------------------------------------------------------------------
// Repository URL normalization
// ---------------------------------------------------------------------------

const SHORTHAND_HOSTS: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

/** Hosts whose repository path is always exactly `owner/repo`. */
const TWO_SEGMENT_HOSTS = new Set(['github.com', 'bitbucket.org', 'codeberg.org']);

/** Path segments that start a sub-page (`/-/tree/...`, `/issues`, ...) on hosts with nested groups. */
const SUBPAGE_MARKERS = new Set([
  '-',
  'tree',
  'blob',
  'raw',
  'src',
  'issues',
  'pull',
  'pulls',
  'merge_requests',
  'commit',
  'commits',
  'releases',
  'tags',
  'branches',
  'compare',
  'wiki',
  'actions',
]);

/**
 * Normalizes a repository URL to `https://<host>/<owner>/<repo>`: lowercase,
 * no credentials, port, query, fragment, `.git` suffix, trailing slash or
 * sub-path (`/tree/main/...`). Understands `git+https://`, `git://`,
 * `ssh://git@host/...`, scp-style `git@host:owner/repo.git`, npm shorthands
 * (`github:o/r`, bare `o/r`) and scheme-less `github.com/o/r`.
 * Returns `undefined` when the input is not a recognizable repository URL.
 */
export function normalizeRepoUrl(input: string | null | undefined): string | undefined {
  if (typeof input !== 'string') return undefined;
  let s = input.trim().replace(/^git\+/i, '');
  if (s === '') return undefined;

  const shorthand = /^(github|gitlab|bitbucket):(?!\/\/)(.+)$/i.exec(s);
  if (shorthand) {
    const host = SHORTHAND_HOSTS[(shorthand[1] ?? '').toLowerCase()];
    if (!host) return undefined;
    s = `https://${host}/${shorthand[2] ?? ''}`;
  } else if (!s.includes('://')) {
    const scp = /^(?:[^@\s/]+@)?([a-z0-9.-]+\.[a-z]{2,}):(?!\d+(?:\/|$))(\S+)$/i.exec(s);
    if (scp) {
      s = `https://${scp[1] ?? ''}/${(scp[2] ?? '').replace(/^\/+/, '')}`;
    } else if (/^[\w-]+\/[\w.-]+$/.test(s)) {
      s = `https://github.com/${s}`; // npm bare "owner/repo" shorthand
    } else if (/^[a-z0-9.-]+\.[a-z]{2,}\/\S+$/i.test(s)) {
      s = `https://${s}`;
    } else {
      return undefined;
    }
  }

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:', 'git:', 'ssh:'].includes(url.protocol)) return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === '' || !host.includes('.')) return undefined;

  let segments = url.pathname
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => seg.toLowerCase());
  if (TWO_SEGMENT_HOSTS.has(host)) {
    segments = segments.slice(0, 2);
  } else {
    // A marker only counts after owner + repo, so a project literally named "src" survives.
    const cut = segments.findIndex((seg, i) => i >= 2 && SUBPAGE_MARKERS.has(seg));
    if (cut >= 0) segments = segments.slice(0, cut);
  }
  const last = segments.length - 1;
  if (last >= 0) segments[last] = (segments[last] ?? '').replace(/\.git$/, '');
  if (segments.length < 2 || segments.some((seg) => seg === '')) return undefined;
  return `https://${host}/${segments.join('/')}`;
}

// ---------------------------------------------------------------------------
// Identity keys
// ---------------------------------------------------------------------------

/** Canonical comparison key for a ref (case-folds github/npm, normalizes pypi). */
export function refKey(ref: CandidateRef): string {
  const parsed = parseRef(ref);
  if (!parsed) return ref;
  switch (parsed.scheme) {
    case 'github':
    case 'npm':
      return `${parsed.scheme}:${parsed.id.toLowerCase()}`;
    case 'pypi':
      return formatRef('pypi', parsed.id);
    default:
      return ref;
  }
}

function schemeOf(ref: CandidateRef): string {
  return parseRef(ref)?.scheme ?? 'other';
}

/** Normalized repository URL identifying the candidate's project, if known. */
function repoKeyOf(c: Candidate): string | undefined {
  const parsed = parseRef(c.ref);
  if (parsed?.scheme === 'github') return `https://github.com/${parsed.id.toLowerCase()}`;
  return normalizeRepoUrl(c.repository_url);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Representative preference: github first, then registries. */
const SOURCE_PRIORITY: readonly Source[] = ['github_repo', 'github_code', 'npm', 'pypi', 'mcp_registry', 'hf_models'];

/** Least trusted wins when members disagree. */
const PROVENANCE_ORDER: readonly Provenance[] = ['live', 'local_cache', 'remote_cache', 'stale_cache'];

function sourceRank(source: Source): number {
  const i = SOURCE_PRIORITY.indexOf(source);
  return i === -1 ? SOURCE_PRIORITY.length : i;
}

function firstDefined<T>(values: readonly (T | undefined)[]): T | undefined {
  return values.find((v) => v !== undefined);
}

function timeOf(iso: string | undefined): number {
  if (iso === undefined) return Number.NaN;
  return Date.parse(iso);
}

/** `members` must be ordered representative-first. */
function mergeGroup(members: readonly Candidate[], repoKey: string | undefined): Candidate {
  const rep = members[0] as Candidate;
  const merged: Candidate = { ...rep };

  // Alias refs: the other members' refs first, then refs members declared themselves.
  const seen = new Set<string>([refKey(rep.ref)]);
  const aliases: CandidateRef[] = [];
  const addAlias = (ref: CandidateRef): void => {
    const key = refKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push(ref);
  };
  for (const m of members.slice(1)) addAlias(m.ref);
  for (const m of members) for (const a of m.also_known_as ?? []) addAlias(a);
  if (aliases.length > 0) merged.also_known_as = aliases;
  else delete merged.also_known_as;

  // Metrics union: representative wins, gaps are filled in priority order.
  const description = members.map((m) => m.description).find((d) => d !== null && d !== '');
  merged.description = description ?? rep.description;

  const assignIfDefined = <K extends 'ecosystem' | 'stars' | 'forks' | 'downloads_weekly'>(key: K): void => {
    const value = firstDefined(members.map((m) => m[key]));
    if (value !== undefined) merged[key] = value as Candidate[K];
  };
  assignIfDefined('ecosystem');
  assignIfDefined('stars');
  assignIfDefined('forks');
  assignIfDefined('downloads_weekly');

  const license = members.map((m) => m.license_spdx).find((v) => typeof v === 'string' && v !== '');
  if (license !== undefined) merged.license_spdx = license;
  else if (members.some((m) => m.license_spdx === null)) merged.license_spdx = null;
  else delete merged.license_spdx;

  // Freshest signal wins.
  let latest: string | undefined;
  for (const m of members) {
    const t = timeOf(m.last_activity);
    if (Number.isNaN(t)) continue;
    if (latest === undefined || t > Date.parse(latest)) latest = m.last_activity;
  }
  if (latest !== undefined) merged.last_activity = latest;

  // Risk flags: any member reporting a problem makes the project flagged.
  for (const key of ['archived', 'deprecated'] as const) {
    const values = members.map((m) => m[key]);
    if (values.some((v) => v === true)) merged[key] = true;
    else {
      const v = firstDefined(values);
      if (v !== undefined) merged[key] = v;
    }
  }

  const repositoryUrl = firstDefined(members.map((m) => normalizeRepoUrl(m.repository_url))) ?? repoKey;
  if (repositoryUrl !== undefined) merged.repository_url = repositoryUrl;

  // Best (lowest) rank keeps the merged candidate high in the interleaved list; hits add up across members.
  const best = members.reduce((a, b) => (b.matched_via.rank < a.matched_via.rank ? b : a));
  const hits = members.reduce((sum, m) => sum + (m.matched_via.hits ?? 1), 0);
  merged.matched_via = { query: best.matched_via.query, rank: best.matched_via.rank, ...(hits > 1 ? { hits } : {}) };

  merged.provenance = members.reduce<Provenance>(
    (worst, m) =>
      PROVENANCE_ORDER.indexOf(m.provenance) > PROVENANCE_ORDER.indexOf(worst) ? m.provenance : worst,
    rep.provenance,
  );
  return merged;
}

// ---------------------------------------------------------------------------
// dedupe
// ---------------------------------------------------------------------------

/**
 * Merges candidates describing the same project. Output keeps the position of
 * each group's earliest member. Singletons are returned as the same object.
 * The representative is the github candidate when present, otherwise
 * npm > pypi > mcp_registry; its `also_known_as` lists every merged ref.
 */
export function dedupe(candidates: readonly Candidate[]): Candidate[] {
  const n = candidates.length;
  const parent = candidates.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur] as number;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the smaller index as root so groups are ordered by first appearance.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  // Pass A: identical refs and declared aliases (strong evidence).
  const byRef = new Map<string, number>();
  candidates.forEach((c, i) => {
    const key = refKey(c.ref);
    const prior = byRef.get(key);
    if (prior === undefined) byRef.set(key, i);
    else union(prior, i);
  });
  candidates.forEach((c, i) => {
    for (const alias of c.also_known_as ?? []) {
      const target = byRef.get(refKey(alias));
      if (target !== undefined) union(target, i);
    }
  });

  // Pass B: same repository URL, only when no scheme is ambiguous.
  const byRepo = new Map<string, number[]>();
  const repoKeys = candidates.map((c) => repoKeyOf(c));
  repoKeys.forEach((key, i) => {
    if (key === undefined) return;
    const list = byRepo.get(key);
    if (list) list.push(i);
    else byRepo.set(key, [i]);
  });
  for (const indices of byRepo.values()) {
    // Components of this URL group, in first-appearance order.
    const comps = new Map<number, number[]>();
    for (const i of indices) {
      const root = find(i);
      const list = comps.get(root);
      if (list) list.push(i);
      else comps.set(root, [i]);
    }
    if (comps.size < 2) continue;

    // Schemes each component stands for (own refs plus declared aliases).
    const compSchemes = new Map<number, Set<string>>();
    const schemeCount = new Map<string, number>();
    for (const root of comps.keys()) {
      const schemes = new Set<string>();
      for (let i = 0; i < n; i++) {
        if (find(i) !== root) continue;
        const c = candidates[i] as Candidate;
        schemes.add(schemeOf(c.ref));
        for (const alias of c.also_known_as ?? []) schemes.add(schemeOf(alias));
      }
      compSchemes.set(root, schemes);
      for (const scheme of schemes) schemeCount.set(scheme, (schemeCount.get(scheme) ?? 0) + 1);
    }
    const ambiguous = (root: number): boolean =>
      [...(compSchemes.get(root) ?? [])].some((scheme) => (schemeCount.get(scheme) ?? 0) > 1);

    const roots = [...comps.keys()];
    const githubRoot = roots.find((root) => compSchemes.get(root)?.has('github'));
    if (githubRoot !== undefined) {
      for (const root of roots) {
        if (root !== githubRoot && !ambiguous(root)) union(githubRoot, root);
      }
    } else if (!roots.some(ambiguous)) {
      const [anchor, ...rest] = roots;
      for (const root of rest) union(anchor as number, root);
    }
  }

  // Collect groups ordered by first appearance.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }

  const out: Candidate[] = [];
  for (const indices of [...groups.values()].sort((a, b) => (a[0] as number) - (b[0] as number))) {
    if (indices.length === 1) {
      out.push(candidates[indices[0] as number] as Candidate);
      continue;
    }
    const ordered = [...indices].sort((a, b) => {
      const ca = candidates[a] as Candidate;
      const cb = candidates[b] as Candidate;
      return (
        sourceRank(ca.source) - sourceRank(cb.source) ||
        ca.matched_via.rank - cb.matched_via.rank ||
        a - b
      );
    });
    const members = ordered.map((i) => candidates[i] as Candidate);
    const repoKey = firstDefined(ordered.map((i) => repoKeys[i]));
    out.push(mergeGroup(members, repoKey));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interleave
// ---------------------------------------------------------------------------

/**
 * Orders candidates by `matched_via.rank`, breaking ties by `matched_via.hits`
 * (more queries or sources returned it: a relevance signal), then by the order
 * in which each source first appears, then by input order (stable). With
 * consecutive per-source ranks this is a round-robin across sources: every
 * source's best hit first, then every source's second hit, and so on.
 */
export function interleaveByRank(candidates: readonly Candidate[]): Candidate[] {
  const sourceOrder = new Map<Source, number>();
  for (const c of candidates) {
    if (!sourceOrder.has(c.source)) sourceOrder.set(c.source, sourceOrder.size);
  }
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        a.candidate.matched_via.rank - b.candidate.matched_via.rank ||
        (b.candidate.matched_via.hits ?? 1) - (a.candidate.matched_via.hits ?? 1) ||
        (sourceOrder.get(a.candidate.source) ?? 0) - (sourceOrder.get(b.candidate.source) ?? 0) ||
        a.index - b.index,
    )
    .map((x) => x.candidate);
}

/**
 * `rw_search` post-processing: `dedupe` the per-source lists, interleave by
 * rank and optionally cap the total (`limit_per_source x sources`).
 */
export function mergeSearchResults(
  perSource: readonly (readonly Candidate[])[],
  maxTotal?: number,
): Candidate[] {
  const merged = interleaveByRank(dedupe(perSource.flat()));
  return maxTotal === undefined ? merged : merged.slice(0, Math.max(0, maxTotal));
}
