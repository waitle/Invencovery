/**
 * PyPI adapter: `SourceAdapter` (name probes) and `Enricher` (details).
 * docs/PLAN.md §8.
 *
 * PyPI has no search API. Discovery therefore probes package names:
 * `GET pypi.org/pypi/{name}/json` for each name hint (404 = no such package,
 * a normal outcome). When a libraries.io adapter is supplied it contributes
 * real search results. The limitation is surfaced in `SourceMeta.message`.
 *
 * License inference order: `info.license_expression`, `info.license`,
 * trove classifiers (limited to the 15 most common, see CLASSIFIER_LICENSES).
 */
import parseSpdx from 'spdx-expression-parse';
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
  fetchStatus,
  truncateDescription,
  weakestProvenance,
} from './depsdev.js';
import type { FetchStatus } from './depsdev.js';

const PYPI_JSON = 'https://pypi.org/pypi';
const REQUEST: HttpRequestOptions = { source: 'pypi', ttlClass: 'package', shareable: true };

/** Always present in the meta of a PyPI search (PLAN §8). */
export const PYPI_NO_SEARCH_MESSAGE =
  'PyPI has no search API; discovery relies on name probes + github_repo language:Python';

const MAX_PROBES = 8;
const MAX_GENERATED_HINTS = 6;
const VALID_PYPI_NAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;

// ---------------------------------------------------------------------------
// Name hints
// ---------------------------------------------------------------------------

/** PEP 503 normalized name, or `undefined` when it cannot be a PyPI project name. */
function normalizeProbeName(raw: string): string | undefined {
  const name = raw.trim().toLowerCase().replace(/[-_.]+/g, '-');
  return VALID_PYPI_NAME.test(name) ? name : undefined;
}

/**
 * Candidate project names for a free-text query: adjacent 2-grams joined with
 * `-` first (most specific), then single tokens. `"markdown pdf"` ->
 * `["markdown-pdf", "markdown", "pdf"]`.
 */
export function generateNameHints(query: string, max = MAX_GENERATED_HINTS): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  const out = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i += 1) out.add(`${tokens[i]}-${tokens[i + 1]}`);
  for (const t of tokens) out.add(t);
  return [...out].slice(0, max);
}

function probeNames(q: { query: string; nameHints?: string[] }): string[] {
  const raw = q.nameHints && q.nameHints.length > 0 ? q.nameHints : generateNameHints(q.query);
  const names = new Set<string>();
  for (const hint of raw) {
    const n = normalizeProbeName(hint);
    if (n) names.add(n);
  }
  return [...names].slice(0, MAX_PROBES);
}

// ---------------------------------------------------------------------------
// License inference
// ---------------------------------------------------------------------------

/** Approximations noted inline: `BSD License` has no clause count, `Apache Software License` no version. */
const CLASSIFIER_LICENSES: readonly (readonly [string, string])[] = [
  ['License :: OSI Approved :: MIT License', 'MIT'],
  ['License :: OSI Approved :: Apache Software License', 'Apache-2.0'],
  ['License :: OSI Approved :: BSD License', 'BSD-3-Clause'],
  ['License :: OSI Approved :: GNU General Public License v3 (GPLv3)', 'GPL-3.0-only'],
  ['License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)', 'GPL-3.0-or-later'],
  ['License :: OSI Approved :: GNU General Public License v2 (GPLv2)', 'GPL-2.0-only'],
  ['License :: OSI Approved :: GNU General Public License v2 or later (GPLv2+)', 'GPL-2.0-or-later'],
  ['License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)', 'LGPL-3.0-only'],
  ['License :: OSI Approved :: GNU Lesser General Public License v3 or later (LGPLv3+)', 'LGPL-3.0-or-later'],
  ['License :: OSI Approved :: GNU Affero General Public License v3', 'AGPL-3.0-only'],
  ['License :: OSI Approved :: GNU Affero General Public License v3 or later (AGPLv3+)', 'AGPL-3.0-or-later'],
  ['License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)', 'MPL-2.0'],
  ['License :: OSI Approved :: ISC License (ISCL)', 'ISC'],
  ['License :: OSI Approved :: Python Software Foundation License', 'PSF-2.0'],
  ['License :: OSI Approved :: The Unlicense (Unlicense)', 'Unlicense'],
];

const LICENSE_STOP_WORDS = new Set(['the', 'license', 'licence', 'version']);

/** Order- and punctuation-insensitive key: "3-clause BSD License" and "BSD 3-Clause" collide. */
function licenseKey(text: string): string {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9.+]+/)
    .filter((t) => t && !LICENSE_STOP_WORDS.has(t));
  return [...new Set(tokens)].sort().join(' ');
}

const LICENSE_ALIASES = new Map<string, string>();
for (const [spdx, names] of [
  ['MIT', ['MIT', 'MIT License', 'The MIT License (MIT)', 'Expat']],
  [
    'Apache-2.0',
    ['Apache', 'Apache 2', 'Apache2', 'Apache 2.0', 'Apache License 2.0', 'Apache Software License', 'ASL 2.0'],
  ],
  [
    'BSD-3-Clause',
    ['BSD', 'BSD License', 'New BSD License', 'Modified BSD License', '3-clause BSD License', 'BSD 3-Clause'],
  ],
  ['BSD-2-Clause', ['2-clause BSD License', 'BSD 2-Clause', 'Simplified BSD License', 'FreeBSD']],
  ['ISC', ['ISC', 'ISC License', 'ISCL']],
  ['MPL-2.0', ['MPL 2.0', 'Mozilla Public License 2.0']],
  ['GPL-3.0-only', ['GPLv3', 'GPL 3', 'GPL 3.0', 'GNU GPL v3', 'GNU General Public License v3']],
  ['GPL-2.0-only', ['GPLv2', 'GPL 2', 'GPL 2.0', 'GNU GPL v2', 'GNU General Public License v2']],
  ['LGPL-3.0-only', ['LGPLv3', 'LGPL 3', 'LGPL 3.0', 'GNU Lesser General Public License v3']],
  ['AGPL-3.0-only', ['AGPLv3', 'AGPL 3', 'AGPL 3.0', 'GNU Affero General Public License v3']],
  ['PSF-2.0', ['PSF', 'Python Software Foundation License']],
  ['Unlicense', ['Unlicense', 'The Unlicense']],
] as const) {
  for (const n of names) LICENSE_ALIASES.set(licenseKey(n), spdx);
}

function isSpdxExpression(text: string): boolean {
  try {
    parseSpdx(text);
    return true;
  } catch {
    return false;
  }
}

/** Short, single-line text is matched whole; pasted license text is matched on its first line. */
function licenseFromField(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const firstLine = text.split(/\r?\n/, 1)[0]!.trim();
  const candidate = text.length <= 100 && !/\r?\n/.test(text) ? text : firstLine;
  if (!candidate || candidate.length > 100) return null;
  return LICENSE_ALIASES.get(licenseKey(candidate)) ?? (isSpdxExpression(candidate) ? candidate : null);
}

/**
 * SPDX expression for a PyPI `info` block, or `null` when it cannot be
 * determined. Several distinct classifiers are joined with `AND` (the
 * conservative reading of "dual licensed").
 */
export function inferPypiLicense(info: {
  license_expression?: string | null;
  license?: string | null;
  classifiers?: readonly string[] | null;
}): string | null {
  const expression = info.license_expression?.trim();
  if (expression) return expression;

  if (info.license) {
    const fromField = licenseFromField(info.license);
    if (fromField) return fromField;
  }

  const found: string[] = [];
  const classifiers = new Set(info.classifiers ?? []);
  for (const [classifier, spdx] of CLASSIFIER_LICENSES) {
    if (classifiers.has(classifier) && !found.includes(spdx)) found.push(spdx);
  }
  return found.length === 0 ? null : found.join(' AND ');
}

// ---------------------------------------------------------------------------
// PyPI JSON parsing
// ---------------------------------------------------------------------------

const UploadSchema = z.looseObject({
  upload_time_iso_8601: z.string().nullish(),
  yanked: z.boolean().nullish(),
});

const PypiDocSchema = z.looseObject({
  info: z.looseObject({
    name: z.string().min(1),
    version: z.string().nullish(),
    summary: z.string().nullish(),
    keywords: z.string().nullish(),
    license: z.string().nullish(),
    license_expression: z.string().nullish(),
    classifiers: z.array(z.string()).nullish(),
    requires_dist: z.array(z.string()).nullish(),
    project_urls: z.record(z.string(), z.unknown()).nullish(),
    home_page: z.string().nullish(),
    package_url: z.string().nullish(),
    yanked: z.boolean().nullish(),
  }),
  urls: z.array(UploadSchema).nullish(),
});
type PypiDoc = z.infer<typeof PypiDocSchema>;

const REPO_URL_KEYS = ['source', 'source code', 'repository', 'code', 'github', 'homepage', 'home'];

function repositoryUrl(info: PypiDoc['info']): string | undefined {
  const entries = Object.entries(info.project_urls ?? {}).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  );
  for (const key of REPO_URL_KEYS) {
    for (const [label, url] of entries) {
      if (label.toLowerCase() === key) {
        const repo = canonicalRepoUrl(url);
        if (repo) return repo;
      }
    }
  }
  for (const [, url] of entries) {
    const repo = canonicalRepoUrl(url);
    if (repo) return repo;
  }
  return canonicalRepoUrl(info.home_page);
}

function lastUploadAt(doc: PypiDoc): string | undefined {
  let latest = Number.NaN;
  for (const u of doc.urls ?? []) {
    const t = u.upload_time_iso_8601 ? Date.parse(u.upload_time_iso_8601) : Number.NaN;
    if (!Number.isNaN(t) && !(t <= latest)) latest = t;
  }
  return Number.isNaN(latest) ? undefined : new Date(latest).toISOString();
}

function isInactiveOrYanked(doc: PypiDoc): boolean {
  if (doc.info.yanked === true) return true;
  return (doc.info.classifiers ?? []).includes('Development Status :: 7 - Inactive');
}

/** Requirements without an `extra ==` marker, i.e. installed by default. */
function countRuntimeRequirements(requires: readonly string[]): number {
  return requires.filter((r) => !/;.*\bextra\b/.test(r)).length;
}

async function fetchDoc(
  http: HttpClient,
  name: string,
): Promise<{ status: FetchStatus; doc?: PypiDoc; provenance: Provenance }> {
  const res = await http.getJson<unknown>(`${PYPI_JSON}/${encodeURIComponent(name)}/json`, REQUEST);
  const status = fetchStatus(res);
  if (status !== 'ok') return { status, provenance: res.provenance };
  const parsed = PypiDocSchema.safeParse(res.data);
  if (!parsed.success) return { status: 'error', provenance: res.provenance };
  return { status: 'ok', doc: parsed.data, provenance: res.provenance };
}

// ---------------------------------------------------------------------------
// Search (name probes + optional libraries.io)
// ---------------------------------------------------------------------------

function toCandidate(doc: PypiDoc, query: string, provenance: Provenance): Candidate | undefined {
  let ref: string;
  try {
    ref = formatRef('pypi', doc.info.name);
  } catch {
    return undefined;
  }
  const candidate: Candidate = {
    ref,
    source: 'pypi',
    name: doc.info.name,
    url: doc.info.package_url || `https://pypi.org/project/${encodeURIComponent(doc.info.name)}/`,
    description: truncateDescription(doc.info.summary),
    ecosystem: 'pypi',
    license_spdx: inferPypiLicense(doc.info),
    matched_via: { query, rank: 0 },
    provenance,
  };
  const last = lastUploadAt(doc);
  if (last) candidate.last_activity = last;
  const repo = repositoryUrl(doc.info);
  if (repo) candidate.repository_url = repo;
  if (isInactiveOrYanked(doc)) candidate.deprecated = true;
  return candidate;
}

/** Fills fields the probe could not know (stars, forks, ...) from a libraries.io hit for the same ref. */
function mergeCandidates(probe: Candidate, extra: Candidate): Candidate {
  const merged: Candidate = { ...extra };
  for (const [key, value] of Object.entries(probe)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  if (probe.license_spdx == null && extra.license_spdx != null) merged.license_spdx = extra.license_spdx;
  return merged;
}

export function createPypiAdapter(deps: { http: HttpClient; librariesIo?: SourceAdapter }): SourceAdapter {
  const { http, librariesIo } = deps;
  return {
    source: 'pypi',
    async search(q) {
      const query = q.query.trim();
      if (q.ecosystem !== undefined && q.ecosystem !== 'pypi' && q.ecosystem !== 'other') {
        return {
          candidates: [],
          meta: {
            source: 'pypi',
            status: 'skipped',
            count: 0,
            query,
            message: `PyPI search is for the pypi ecosystem; component ecosystem is ${q.ecosystem}.`,
          },
        };
      }

      const names = probeNames({ query, nameHints: q.nameHints });
      const [probes, lio] = await Promise.all([
        Promise.all(names.map((n) => fetchDoc(http, n))),
        librariesIo ? librariesIo.search(q) : Promise.resolve(undefined),
      ]);

      const found: Candidate[] = [];
      const failures: FetchStatus[] = [];
      let unparsable = 0;
      let allCached = true;
      for (const probe of probes) {
        if (probe.provenance === 'live') allCached = false;
        if (probe.status === 'ok' && probe.doc) {
          const c = toCandidate(probe.doc, query, probe.provenance);
          if (c) found.push(c);
          else unparsable += 1;
        } else if (probe.status !== 'not_found') {
          failures.push(probe.status);
        }
      }

      // Merge libraries.io results after the exact-name probes.
      const byRef = new Map<string, number>(found.map((c, i) => [c.ref, i]));
      for (const c of lio?.candidates ?? []) {
        const at = byRef.get(c.ref);
        if (at === undefined) {
          byRef.set(c.ref, found.length);
          found.push(c);
        } else {
          found[at] = mergeCandidates(found[at]!, c);
        }
      }
      const candidates = found.slice(0, Math.max(q.limit, 0));
      candidates.forEach((c, i) => {
        c.matched_via = { query, rank: i + 1 };
      });

      const lioFailed =
        lio !== undefined && lio.meta.status !== 'ok' && lio.meta.status !== 'cached' && lio.meta.status !== 'skipped';
      const notes = [PYPI_NO_SEARCH_MESSAGE];
      if (names.length === 0 && !librariesIo) notes.push('no usable package-name hints could be derived from the query');
      if (failures.length > 0) {
        notes.push(`${failures.length} of ${names.length} name probes failed (${[...new Set(failures)].join(', ')})`);
      }
      if (unparsable > 0) notes.push(`${unparsable} PyPI response(s) could not be parsed`);
      if (lioFailed && lio?.meta.message) notes.push(lio.meta.message);

      const everyProbeFailed = names.length > 0 && failures.length === names.length;
      let status: SourceMeta['status'];
      if (everyProbeFailed && candidates.length === 0) {
        status = worstFailure(failures);
        notes.push('Use WebSearch or `pip index versions <name>` manually, then call rw_record_evidence.');
      } else if (failures.length > 0 || unparsable > 0 || lioFailed) {
        status = 'partial';
      } else if (names.length === 0 && !librariesIo) {
        status = 'skipped';
      } else {
        status = allCached && probes.length > 0 ? 'cached' : 'ok';
      }
      return {
        candidates,
        meta: { source: 'pypi', status, count: candidates.length, query, message: notes.join('; ') + '.' },
      };
    },
  };
}

function worstFailure(failures: FetchStatus[]): 'rate_limited' | 'offline' | 'error' {
  for (const f of ['rate_limited', 'offline'] as const) if (failures.includes(f)) return f;
  return 'error';
}

// ---------------------------------------------------------------------------
// Enricher
// ---------------------------------------------------------------------------

/**
 * Enricher for `pypi:` refs, backed by `pypi.org/pypi/{name}/json`.
 * `downloads_weekly` is always listed as missing (the JSON API reports -1).
 * HTTP failures do not throw; `missing` lists what could not be obtained.
 */
export function createPypiEnricher(deps: { http: HttpClient }): Enricher {
  const { http } = deps;
  return {
    name: 'pypi',
    supports: (ref) => parseRef(ref)?.scheme === 'pypi',
    async enrich(ref) {
      const parsed = parseRef(ref);
      if (parsed?.scheme !== 'pypi') {
        throw new TypeError(`pypi enricher does not support ${JSON.stringify(ref)}`);
      }
      const res = await fetchDoc(http, parsed.id);
      const metrics: Evaluation['metrics'] = {};
      const out: Awaited<ReturnType<Enricher['enrich']>> = {
        metrics,
        license_spdx: null,
        license_source: 'pypi',
        provenance: weakestProvenance([res.provenance]),
        missing: [],
      };
      if (!res.doc) {
        out.missing.push('license', 'last_release_at', 'direct_dependencies', 'downloads_weekly');
        return out;
      }
      const { doc } = res;

      out.license_spdx = inferPypiLicense(doc.info);
      if (out.license_spdx === null) out.missing.push('license');

      const released = lastUploadAt(doc);
      if (released) metrics.last_release_at = released;
      else out.missing.push('last_release_at');

      if (doc.info.requires_dist) {
        metrics.direct_dependencies = countRuntimeRequirements(doc.info.requires_dist);
      } else {
        out.missing.push('direct_dependencies');
      }
      out.missing.push('downloads_weekly');
      if (isInactiveOrYanked(doc)) metrics.deprecated = true;

      const repo = repositoryUrl(doc.info);
      if (repo) out.repository_url = repo;
      const descriptor = truncateDescription([doc.info.summary, doc.info.keywords].filter((t) => typeof t === 'string').join(' '));
      if (descriptor !== null) out.descriptor = descriptor;
      return out;
    },
  };
}
