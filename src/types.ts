/**
 * Shared contracts for recyclewheel (docs/PLAN.md §6).
 *
 * Every other module imports from this file and never edits it. Changing a
 * contract means changing PLAN.md first, then this file.
 *
 * Data shapes are zod schemas with `z.infer` types. Infrastructure shapes that
 * carry functions are plain TypeScript interfaces.
 *
 * Time units: `CacheEntry.fetched_at/expires_at` and every `RateLimitState`
 * timestamp are epoch milliseconds (`Date.now()`). Fields typed as ISO8601
 * strings are the only human-readable timestamps.
 */
import { randomUUID } from 'node:crypto';
import { getPublicSuffix } from 'tldts';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ---------------------------------------------------------------------------
// Identifiers and enums
// ---------------------------------------------------------------------------

export const SourceSchema = z.enum(['github_repo', 'github_code', 'npm', 'pypi', 'mcp_registry', 'hf_models']);
export type Source = z.infer<typeof SourceSchema>;

export const EvidenceKindSchema = z.enum(['search', 'evaluate', 'web', 'code_search', 'manual']);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const ProvenanceSchema = z.enum(['live', 'local_cache', 'remote_cache', 'stale_cache']);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const DecisionKindSchema = z.enum(['adopt', 'extend', 'reference', 'build']);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const BuildReasonSchema = z.enum([
  'no_candidate',
  'license_incompatible',
  'unmaintained_or_risky',
  'too_heavy',
  'core_differentiator',
  'trivial',
  'integration_glue',
]);
export type BuildReason = z.infer<typeof BuildReasonSchema>;

/** Cross-cutting concerns that package research does not reveal (cost, store policy, law, operations, security). */
export const CONCERNS = ['cost', 'distribution_policy', 'legal_privacy', 'operations', 'security'] as const;
export const ConcernSchema = z.enum(CONCERNS);
export type Concern = z.infer<typeof ConcernSchema>;

export const DistributionSchema = z.enum(['library', 'application', 'saas', 'internal']);
export type Distribution = z.infer<typeof DistributionSchema>;

/** Target market: ISO 3166-1 alpha-2 country code in capitals, or `EU`. Echoed in output, so the shape is fixed. */
export const MarketCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'a market is an ISO 3166-1 alpha-2 country code in capital letters (e.g. "KR", "US", "JP") or "EU"');
export type MarketCode = z.infer<typeof MarketCodeSchema>;

export const EcosystemSchema = z.enum(['npm', 'pypi', 'go', 'cargo', 'maven', 'nuget', 'other']);
export type Ecosystem = z.infer<typeof EcosystemSchema>;

export const TtlClassSchema = z.enum([
  'search',
  'repo',
  'repo_aux',
  'package',
  'downloads',
  'depsdev',
  'registry',
]);
export type TtlClass = z.infer<typeof TtlClassSchema>;

// ---------------------------------------------------------------------------
// CandidateRef: "<scheme>:<id>"
//   github:owner/repo | npm:@scope/name | pypi:name (PEP 503 normalized)
//   mcp:io.github.x/y | web:https://... | hf:owner/name (Hugging Face model)
//   saas:vendor/product (hosted service; no automatic metrics)
// ---------------------------------------------------------------------------

export type CandidateRef = string;

export type RefScheme = 'github' | 'npm' | 'pypi' | 'mcp' | 'web' | 'hf' | 'saas';

const REF_SCHEMES: readonly RefScheme[] = ['github', 'npm', 'pypi', 'mcp', 'web', 'hf', 'saas'];

/** PEP 503: lowercase, runs of `-`, `_`, `.` collapse to a single `-`. */
function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Path-manipulation characters never valid in a registry/API path segment. */
// eslint-disable-next-line no-control-regex
const UNSAFE_ID_CHARS = /[%\\?#\u0000-\u001f\u007f]/;

function isDotSegment(segment: string): boolean {
  return segment === '.' || segment === '..';
}

/** GitHub: owner is alphanumeric/hyphen (EMU suffix `_` allowed), repo is `[A-Za-z0-9._-]`; `.`/`..` are never valid. */
const GITHUB_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** Hugging Face Hub model id: `owner/name`, each segment `[A-Za-z0-9._-]` (up to 96 characters on the Hub). */
const HF_ID = /^[A-Za-z0-9._-]{1,96}\/[A-Za-z0-9._-]{1,96}$/;
/** Hosted service id: lowercase `vendor/product`, each segment starts with a letter or digit. */
const SAAS_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;
/** PyPI project names (before PEP 503 normalization). */
const PYPI_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Characters that can end or alter Markdown link syntax or a table cell when a
 * URL is echoed: backslash, brackets, parentheses, angle brackets, backtick and
 * `|`. Refused in `web:` refs; percent-encoded forms (`%5B`) are fine.
 */
const REF_MARKUP_CHARS = /[\\[\]()<>`|]/;
/** Longest ref id; keeps the whole ref below `LEDGER_TEXT_MAX`. */
const REF_ID_MAX = 1000;

/** A `web:` id is an http(s) URL that WHATWG URL parsing accepts and whose raw text has none of `REF_MARKUP_CHARS`. */
function isPlainWebUrl(id: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(id) || REF_MARKUP_CHARS.test(id)) return false;
  try {
    const url = new URL(id);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidRefId(scheme: RefScheme, id: string): boolean {
  if (id.length === 0 || id.length > REF_ID_MAX || /\s/.test(id)) return false;
  if (scheme !== 'web' && UNSAFE_ID_CHARS.test(id)) return false;
  switch (scheme) {
    case 'github': {
      if (!GITHUB_ID.test(id)) return false;
      return !id.split('/').some(isDotSegment);
    }
    case 'npm': {
      if (!/^(@[^/@]+\/)?[^/@]+$/.test(id)) return false;
      return !id.replace(/^@/, '').split('/').some(isDotSegment);
    }
    case 'web':
      return isPlainWebUrl(id);
    case 'pypi':
      return PYPI_ID.test(id);
    case 'mcp':
      return !id.split('/').some(isDotSegment);
    case 'hf':
      return HF_ID.test(id) && !id.split('/').some(isDotSegment);
    case 'saas':
      return SAAS_ID.test(id) && !id.split('/').some(isDotSegment);
  }
}

/**
 * Builds a ref. pypi ids are PEP 503 normalized; every other scheme is kept
 * verbatim. Throws on an unknown scheme or an id that is empty or malformed
 * for the scheme (programmer error; use `parseRef` for external input).
 */
export function formatRef(scheme: RefScheme, id: string): CandidateRef {
  if (!REF_SCHEMES.includes(scheme)) {
    throw new TypeError(`Unknown ref scheme: ${String(scheme)}`);
  }
  const normalized = scheme === 'pypi' ? normalizePypiName(id) : id;
  if (!isValidRefId(scheme, normalized)) {
    throw new TypeError(`Invalid ${scheme} ref id: ${JSON.stringify(id)}`);
  }
  return `${scheme}:${normalized}`;
}

/**
 * Splits a ref at the first `:`. Returns `undefined` (never throws) when the
 * scheme is unknown or the id is empty or malformed for the scheme.
 * `parseRef('npm:@a/b')` -> `{ scheme: 'npm', id: '@a/b' }`.
 */
export function parseRef(ref: string): { scheme: RefScheme; id: string } | undefined {
  const sep = ref.indexOf(':');
  if (sep <= 0) return undefined;
  const scheme = ref.slice(0, sep) as RefScheme;
  const id = ref.slice(sep + 1);
  if (!REF_SCHEMES.includes(scheme) || !isValidRefId(scheme, id)) return undefined;
  return { scheme, id };
}

export const CandidateRefSchema = z
  .string()
  .refine((ref) => parseRef(ref) !== undefined, { message: 'Invalid CandidateRef; expected "<scheme>:<id>"' });

/** `<prefix>_<12 hex chars>` from `crypto.randomUUID()` (hyphens removed). Prefixes: ev, eval, dec. */
export function newId(prefix: 'ev' | 'eval' | 'dec'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** ISO8601 timestamp string; any value `Date.parse` understands. */
const IsoDateSchema = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'Expected an ISO8601 date-time string',
});

const CountSchema = z.number().int().nonnegative();

/** Longest free-text field of a ledger event (name, rationale, reason, note, title, ...); `serializeEvent` shortens longer input. */
export const LEDGER_TEXT_MAX = 2000;
/** Longest evidence summary (the 50KB cap of `rw_record_evidence`). */
export const LEDGER_SUMMARY_MAX = 50 * 1024;
/** A ledger text field: free text from agents or third parties, bounded so a hostile ledger cannot inflate output. */
const LedgerText = z.string().max(LEDGER_TEXT_MAX);

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

export const CandidateSchema = z.object({
  ref: CandidateRefSchema,
  source: SourceSchema,
  name: z.string(),
  url: z.string(),
  /** At most 200 chars (adapters truncate). */
  description: z.string().max(200).nullable(),
  ecosystem: EcosystemSchema.optional(),
  stars: CountSchema.optional(),
  forks: CountSchema.optional(),
  downloads_weekly: CountSchema.optional(),
  /** null = no license / unknown. */
  license_spdx: z.string().nullable().optional(),
  /** ISO8601: pushed_at or last publish. */
  last_activity: IsoDateSchema.optional(),
  archived: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  /** Normalized: https://github.com/owner/repo (lowercase, no .git). */
  repository_url: z.string().optional(),
  /**
   * Set by dedupe when the merged sources disagree on the license (for example
   * the GitHub repository says none or NOASSERTION while the npm package says
   * Apache-2.0): every member's ref and license. Often a license change between
   * the repository's default branch and the published version.
   */
  license_by_ref: z.array(z.object({ ref: CandidateRefSchema, license: z.string().nullable() })).optional(),
  /** Refs of the same project from other sources, merged by dedupe. */
  also_known_as: z.array(CandidateRefSchema).optional(),
  /**
   * Cheap pre-evaluation computed by `rw_search` for the top candidates from
   * deps.dev and the registries (no GitHub API call, no agent `fit`): the score
   * axes except fit (0-80), the license verdict against the project, and the
   * risk flags. Not an evaluation; `rw_evaluate` records the real one.
   */
  preview: z
    .object({
      base_score: CountSchema,
      license_verdict: z.enum(['compatible', 'conditional', 'incompatible', 'unknown']),
      license_spdx: z.string().nullable(),
      flags: z.array(z.string()),
    })
    .optional(),
  matched_via: z.object({
    /** The first query that returned the candidate. */
    query: z.string(),
    rank: CountSchema,
    /** Number of query variants (and merged sources) that returned it; present when more than one. A relevance signal. */
    hits: CountSchema.optional(),
  }),
  provenance: ProvenanceSchema,
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const SourceMetaSchema = z.object({
  source: SourceSchema,
  status: z.enum([
    'ok',
    'cached',
    'partial',
    'rate_limited',
    'unauthenticated',
    'offline',
    'error',
    'skipped',
  ]),
  count: CountSchema,
  query: z.string().optional(),
  rate_limit: z.object({ remaining: z.number(), reset_at: IsoDateSchema }).optional(),
  /** Human-readable reason plus an alternative. Never contains secrets. */
  message: z.string().optional(),
});
export type SourceMeta = z.infer<typeof SourceMetaSchema>;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export const LicenseVerdictSchema = z.object({
  candidate_spdx: LedgerText.nullable(),
  project_spdx: LedgerText.nullable(),
  distribution: DistributionSchema,
  category: z.enum([
    'permissive',
    'weak_copyleft',
    'strong_copyleft',
    'network_copyleft',
    'non_oss',
    'unknown',
  ]),
  verdict: z.enum(['compatible', 'conditional', 'incompatible', 'unknown']),
  /** e.g. "Retain copyright notice", "Include NOTICE file". */
  obligations: z.array(LedgerText),
  /** e.g. "Not legal advice". */
  notes: z.array(LedgerText),
  source: z.enum(['github', 'npm', 'pypi', 'depsdev', 'huggingface', 'remote_cache', 'agent']),
});
export type LicenseVerdict = z.infer<typeof LicenseVerdictSchema>;

export const EvaluationMetricsSchema = z.object({
  stars: CountSchema.optional(),
  forks: CountSchema.optional(),
  open_issues: CountSchema.optional(),
  contributors: CountSchema.optional(),
  last_commit_at: IsoDateSchema.optional(),
  last_release_at: IsoDateSchema.optional(),
  downloads_weekly: CountSchema.optional(),
  direct_dependencies: CountSchema.optional(),
  /** OpenSSF Scorecard overall score, 0-10. */
  scorecard: z.number().min(0).max(10).optional(),
  /** OpenSSF Scorecard "Maintained" check, 0-10. Optional input to scoring. */
  scorecard_maintained: z.number().min(0).max(10).optional(),
  archived: z.boolean().optional(),
  deprecated: z.boolean().optional(),
});
export type EvaluationMetrics = z.infer<typeof EvaluationMetricsSchema>;

export const FitValueSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

/** Axis scores of an open-source candidate (profile `oss`; PLAN §7.4). */
export const OssScoresSchema = z.object({
  maintenance: z.number().min(0),
  popularity: z.number().min(0),
  community: z.number().min(0),
  license: z.number().min(0),
  dependencies: z.number().min(0),
  fit: z.number().min(0),
});
export type OssScores = z.infer<typeof OssScoresSchema>;

/** Axis scores of a hosted service (profile `saas`; PLAN §7.4). */
export const SaasScoresSchema = z.object({
  maturity: z.number().min(0),
  terms: z.number().min(0),
  lock_in: z.number().min(0),
  sdk: z.number().min(0),
  fit: z.number().min(0),
});
export type SaasScores = z.infer<typeof SaasScoresSchema>;

export const SaasMaturitySchema = z.enum(['ga', 'beta', 'preview', 'unknown']);
/**
 * What the vendor says about training on submitted data. `unknown`: the vendor's
 * pages were not read yet. `not_stated`: they were read and say nothing about it.
 */
export const SaasDataPolicySchema = z.enum(['no_training', 'opt_out', 'trains', 'not_stated', 'unknown']);
export const SaasLockInSchema = z.enum(['low', 'medium', 'high']);

/**
 * Whose page a term was read from, judged by the server: `first_party` when a
 * result URL of the cited evidence is on one of the vendor's own domains,
 * `secondhand` when the evidence exists but none of its URLs is, `none` when no
 * evidence is cited or the cited id is not in the ledger.
 */
export const SaasEvidenceSourceSchema = z.enum(['first_party', 'secondhand', 'none']);
export type SaasEvidenceSource = z.infer<typeof SaasEvidenceSourceSchema>;

/** Lowercase hostname with at least one dot and an alphabetic top-level label: no scheme, path, port, IP address or wildcard. */
const VENDOR_DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const VendorDomainSchema = z
  .string()
  .regex(
    VENDOR_DOMAIN,
    'vendor_domains entries must be lowercase hostnames such as "deepgram.com": no scheme (https://), path, port, IP address or wildcard (*.)',
  )
  .refine((value) => getPublicSuffix(value, { allowPrivateDomains: true }) !== value, {
    message:
      'vendor_domains entries must be a registrable domain such as "deepgram.com", not a public suffix (github.io, co.kr, vercel.app): every subdomain of a public suffix belongs to someone else',
  });
export const VendorDomainsSchema = z
  .array(VendorDomainSchema, { error: "vendor_domains is required: the vendor's own domains, e.g. [\"deepgram.com\"]" })
  .min(1, 'vendor_domains needs 1-5 hostnames, e.g. ["deepgram.com"]')
  .max(5, 'vendor_domains needs 1-5 hostnames, e.g. ["deepgram.com"]');

/** An absolute http(s) URL of at most 2000 characters (the same rule as the results of `rw_record_evidence`). */
export const HttpUrlSchema = z
  .string()
  .max(2000)
  .refine(
    (value) => {
      if (!/^https?:\/\//i.test(value)) return false;
      try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
      } catch {
        return false;
      }
    },
    { message: 'source_url must be an absolute http(s) URL without userinfo (no user:password@ in the URL)' },
  );

const SaasPricingFields = {
  checked: z.boolean(),
  summary: z.string().max(300).optional(),
  evidence_id: LedgerText.optional(),
};
const SaasDataUseFields = {
  policy: SaasDataPolicySchema,
  retention: z.string().max(200).optional(),
  evidence_id: LedgerText.optional(),
};
const SaasTermsFields = {
  maturity: SaasMaturitySchema,
  lock_in: SaasLockInSchema,
  exit_path: z.string().min(10).max(300),
  sdk_ref: CandidateRefSchema.optional(),
};

/**
 * What the agent passes to `rw_evaluate` about a hosted service
 * (`saas:vendor/product`). `source` is judged by the server and is not an input:
 * the strict objects reject it. Only `vendor_domains`, `lock_in` and `exit_path`
 * are required: a service whose terms are not read yet is registered with the
 * defaults (maturity unknown, pricing not checked, data use unknown), which caps
 * its hint at `reference`. `source_url` is the vendor page the agent read: the
 * server records it as evidence itself (see `rw_evaluate`).
 */
export const SaasTermsInputSchema = z.object({
  ...SaasTermsFields,
  maturity: SaasMaturitySchema.optional(),
  vendor_domains: VendorDomainsSchema,
  pricing: z
    .strictObject({ ...SaasPricingFields, checked: z.boolean().optional(), source_url: HttpUrlSchema.optional() })
    .optional(),
  data_use: z.strictObject({ ...SaasDataUseFields, source_url: HttpUrlSchema.optional() }).optional(),
});
export type SaasTermsInput = z.infer<typeof SaasTermsInputSchema>;

/**
 * The terms as recorded with the evaluation: the input plus the server's
 * `source` judgment per term. `vendor_domains` and `source` are optional here
 * because ledgers written before they existed carry neither.
 */
export const SaasTermsSchema = z.object({
  ...SaasTermsFields,
  vendor_domains: VendorDomainsSchema.optional(),
  pricing: z.object({ ...SaasPricingFields, source: SaasEvidenceSourceSchema.optional() }),
  data_use: z.object({ ...SaasDataUseFields, source: SaasEvidenceSourceSchema.optional() }),
});
export type SaasTerms = z.infer<typeof SaasTermsSchema>;

/** SDK of a hosted service, evaluated like any package; informational except its license points. */
export const SaasSdkSchema = z.object({
  ref: CandidateRefSchema,
  verdict: LicenseVerdictSchema.shape.verdict,
  spdx: LedgerText.nullable(),
  /** Maintenance axis (0-25) of the SDK, not part of the SaaS total. */
  maintenance: z.number().min(0),
});

/** License of the model weights behind a candidate (`weights_ref`, or the `hf:` candidate itself). */
export const WeightsLicenseSchema = z.object({
  ref: CandidateRefSchema,
  verdict: LicenseVerdictSchema.shape.verdict,
  /** Verdict of the candidate's code license before it was merged with the weights verdict. */
  code_verdict: LicenseVerdictSchema.shape.verdict,
  /** SPDX expression when the Hugging Face license maps to one. */
  spdx: LedgerText.nullable(),
  license_name: LedgerText.optional(),
  license_link: LedgerText.optional(),
  source: LicenseVerdictSchema.shape.source,
});
export type WeightsLicense = z.infer<typeof WeightsLicenseSchema>;

export const EvaluationSchema = z.object({
  ref: CandidateRefSchema,
  component_id: LedgerText,
  /** Scoring profile; absent in older ledgers (read as `oss`). */
  profile: z.enum(['oss', 'saas']).optional(),
  metrics: EvaluationMetricsSchema,
  /** Point allocation per axis: PLAN §7.4 (`oss` axes, or the `saas` axes when `profile` is `saas`). */
  scores: z.union([OssScoresSchema, SaasScoresSchema]),
  /** Integer 0-100. */
  total: z.number().int().min(0).max(100),
  license: LicenseVerdictSchema,
  /** Present when model weights were checked (`weights_ref`) or the candidate is an `hf:` model. */
  weights_license: WeightsLicenseSchema.optional(),
  /** Why a code candidate needs no weights check (`weights_exempt_reason`); the `model_weights_unverified` flag is not raised then. */
  weights_exempt_reason: LedgerText.optional(),
  /** `saas:` ref of the hosted service this code candidate is a client or plugin of (`service_ref`). */
  service_ref: CandidateRefSchema.optional(),
  /** Why a code candidate that looks like a service client is not one (`no_service_reason`); the `service_client_suspected` flag is not raised then. */
  no_service_reason: LedgerText.optional(),

  /** Present for profile `saas`. */
  saas: SaasTermsSchema.optional(),
  saas_sdk: SaasSdkSchema.optional(),
  fit: z.object({ value: FitValueSchema, reason: LedgerText }),
  /** 'archived', 'deprecated', 'stale', 'no_license', 'license_from_remote_cache', 'metrics_partial', ... */
  flags: z.array(LedgerText),
  /** Names of metrics that could not be obtained. */
  missing: z.array(LedgerText),
  /** Decision aid (PLAN §7.4). */
  hint: DecisionKindSchema,
  scoring_version: z.literal(1),
  provenance: ProvenanceSchema,
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

// ---------------------------------------------------------------------------
// Ledger (JSONL events)
// ---------------------------------------------------------------------------

export const ProjectInfoSchema = z.object({
  name: LedgerText,
  summary: LedgerText,
  license: LedgerText.optional(),
  distribution: DistributionSchema,
  ecosystems: z.array(EcosystemSchema),
  /** Target markets (laws and store rules differ per country); absent in older ledgers. */
  markets: z.array(MarketCodeSchema).min(1).max(10).optional(),
  /** `input`: given by the agent; `inferred`: derived from the project text. */
  markets_source: z.enum(['input', 'inferred']).optional(),
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

export const ComponentSchema = z.object({
  id: LedgerText,
  name: LedgerText,
  description: LedgerText,
  keywords: z.array(LedgerText),
  ecosystem: EcosystemSchema.optional(),
  kind: z.enum(['library', 'service', 'tool', 'ui', 'glue']).optional(),
  parent_id: LedgerText.optional(),
  trivial: z.boolean().optional(),
  status: z.enum(['pending', 'searching', 'decided']),
});
export type Component = z.infer<typeof ComponentSchema>;

export const EvidenceSchema = z.object({
  id: LedgerText,
  component_id: LedgerText,
  kind: EvidenceKindSchema,
  at: IsoDateSchema,
  query: LedgerText.optional(),
  sources: z.array(SourceSchema).optional(),
  tool: LedgerText.optional(),
  result_refs: z.array(CandidateRefSchema),
  results: z
    .array(z.object({ url: LedgerText, title: LedgerText.optional(), note: LedgerText.optional() }))
    .optional(),
  summary: z.string().max(LEDGER_SUMMARY_MAX),
  provenance: z.array(ProvenanceSchema).optional(),
  /** Cross-cutting concern this evidence covers (cost, legal_privacy, ...). */
  concern: ConcernSchema.optional(),
  /** Market a `concern` evidence covers (e.g. the privacy law of `KR`); only meaningful together with `concern`. */
  market: MarketCodeSchema.optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const DecisionSchema = z.object({
  id: LedgerText,
  component_id: LedgerText,
  decision: DecisionKindSchema,
  ref: CandidateRefSchema.optional(),
  version: LedgerText.optional(),
  rationale: LedgerText,
  build_reason: BuildReasonSchema.optional(),
  alternatives: z.array(z.object({ ref: CandidateRefSchema, why_not: LedgerText })),
  attribution: z
    .object({
      source_url: LedgerText,
      license: LedgerText,
      copyright: LedgerText.optional(),
      revision: LedgerText.optional(),
      files: z.array(LedgerText).optional(),
    })
    .optional(),
  evidence_ids: z.array(LedgerText),
  override: z.object({ reason: LedgerText }).optional(),
  decided_at: IsoDateSchema,
  /** Who the caller says made the call. Nothing verifies it: `rw_decide` takes it as given, so this is the agent's report. */
  decided_by: z.enum(['agent', 'user']),
  /**
   * Names of the gates (flags) that `decided_by: "user"` turned into warnings. Filled by the server, never by the caller;
   * loaded strictly (flag-shaped names, at most 10) so a hand-edited ledger cannot smuggle text into the report.
   */
  waived_gates: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(10).optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const LedgerEventSchema = z.discriminatedUnion('type', [
  z.object({ v: z.literal(1), type: z.literal('project.set'), at: IsoDateSchema, project: ProjectInfoSchema }),
  z.object({ v: z.literal(1), type: z.literal('component.upsert'), at: IsoDateSchema, component: ComponentSchema }),
  z.object({ v: z.literal(1), type: z.literal('evidence.add'), at: IsoDateSchema, evidence: EvidenceSchema }),
  z.object({ v: z.literal(1), type: z.literal('evaluation.add'), at: IsoDateSchema, evaluation: EvaluationSchema }),
  /** A later decision for the same component replaces the earlier one. */
  z.object({ v: z.literal(1), type: z.literal('decision.add'), at: IsoDateSchema, decision: DecisionSchema }),
]);
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

export const LedgerStateSchema = z.object({
  project: ProjectInfoSchema.optional(),
  components: z.array(ComponentSchema),
  evidence: z.array(EvidenceSchema),
  evaluations: z.array(EvaluationSchema),
  /** Latest decision per component. */
  decisions: z.array(DecisionSchema),
  /** Superseded decisions. */
  history: z.array(DecisionSchema),
});
export type LedgerState = z.infer<typeof LedgerStateSchema>;

// ---------------------------------------------------------------------------
// Infrastructure contracts
// ---------------------------------------------------------------------------

export interface HttpResult<T = unknown> {
  status: number;
  data: T | null;
  headers: Record<string, string>;
  provenance: Provenance;
  fetched_at: string;
  error?: 'rate_limited' | 'offline' | 'network' | 'timeout' | 'http';
}

export interface HttpRequestOptions {
  source: Source | 'depsdev' | 'librariesio';
  ttlClass: TtlClass;
  auth?: boolean;
  accept?: string;
  /** Candidate for upload to the remote cache. */
  shareable?: boolean;
}

export interface HttpClient {
  getJson<T = unknown>(url: string, opts: HttpRequestOptions): Promise<HttpResult<T>>;
}

export const CacheEntrySchema = z.object({
  key: z.string(),
  url_redacted: z.string(),
  source: z.string(),
  status: z.number().int(),
  etag: z.string().optional(),
  last_modified: z.string().optional(),
  body: z.string(),
  /** Epoch milliseconds. */
  fetched_at: z.number(),
  /** Epoch milliseconds. */
  expires_at: z.number(),
  provenance: ProvenanceSchema,
});
export type CacheEntry = z.infer<typeof CacheEntrySchema>;

/** All timestamps are epoch milliseconds. */
export const RateLimitStateSchema = z.object({
  resource: z.string(),
  limit: z.number(),
  remaining: z.number(),
  reset_at: z.number(),
  updated_at: z.number(),
});
export type RateLimitState = z.infer<typeof RateLimitStateSchema>;

export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  put(e: CacheEntry): void;
  /** Extends freshness after a 304 revalidation. `expires_at` is epoch ms. */
  touch(key: string, expires_at: number): void;
  /** Returns the number of removed entries. `olderThanMs` is an age relative to now. */
  purge(filter?: { source?: string; olderThanMs?: number }): number;
  stats(): { entries: number; bytes: number; by_source: Record<string, number> };
  getRateLimit(resource: string): RateLimitState | undefined;
  setRateLimit(s: RateLimitState): void;
  close(): void;
}

export interface RemoteCache {
  mode: 'off' | 'read' | 'readwrite';
  get(key: string): Promise<CacheEntry | undefined>;
  put(e: CacheEntry): Promise<void>;
  healthy(): Promise<boolean>;
}

export interface SourceAdapter {
  source: Source;
  search(q: {
    query: string;
    limit: number;
    ecosystem?: Ecosystem;
    language?: string;
    pushedWithinDays?: number;
    minStars?: number;
    nameHints?: string[];
  }): Promise<{ candidates: Candidate[]; meta: SourceMeta }>;
}

/** Detail lookup for evaluation (github, npm, pypi, depsdev, mcp-registry each implement one). */
export interface Enricher {
  /** Short identifier (`depsdev`, `github`, `npm`, ...); `rw_search` previews skip the rate-limited `github` one. */
  name?: string;
  supports(ref: CandidateRef): boolean;
  enrich(
    ref: CandidateRef,
    opts: { deep: boolean },
  ): Promise<{
    metrics: Evaluation['metrics'];
    license_spdx: string | null;
    license_source: LicenseVerdict['source'];
    repository_url?: string;
    provenance: Provenance;
    missing: string[];
    /** Hugging Face model card facts; only the `hf:` enricher sets it. */
    model_license?: ModelLicenseFacts;
    /** Candidate-level flags the enricher raises (e.g. `gated_model`). */
    flags?: string[];
    /** Name, description and topics, one sanitized line, for the "uses ML weights" heuristic. */
    descriptor?: string;
    /** Set by `rw_evaluate` (not by enrichers): the package and its repository declare different licenses. */
    license_conflict?: { package: string | null; repository: string | null };
  }>;
}

/** License facts of a Hugging Face model card, already sanitized and bounded. */
export interface ModelLicenseFacts {
  /** Lowercase Hub license ids from `cardData.license` or `license:` tags; empty when none is declared. */
  hf_license: string[];
  license_name?: string;
  license_link?: string;
  gated: boolean;
  /** `base_model:` tags; their licenses may apply too. */
  base_models: string[];
}

/**
 * Runtime configuration (PLAN §10.4), produced by `loadConfig` in `src/config.ts`.
 * Timestamps and sizes are plain numbers; secrets are included, so never log or
 * serialize a whole Config. The GitHub token is intentionally absent: it is
 * resolved only by `auth/github-token.ts`.
 */
export interface Config {
  /** `RECYCLEWHEEL_NO_GH_CLI`: true disables the `gh auth token` fallback. */
  noGhCli: boolean;
  /** Directory holding the local cache database. */
  cacheDir: string;
  /** `<cacheDir>/cache.db`. */
  cacheDbPath: string;
  cacheMaxMb: number;
  /** `RECYCLEWHEEL_OFFLINE`: network forbidden, cache only. */
  offline: boolean;
  /** Absolute ledger root default (`RECYCLEWHEEL_PROJECT_ROOT`, else cwd). */
  projectRoot: string;
  /** Enabled sources (default: all). */
  sources: Source[];
  remoteCacheUrl?: string;
  /** Effective mode; `off` whenever the URL is missing or invalid. */
  remoteCacheMode: RemoteCache['mode'];
  remoteCacheToken?: string;
  /**
   * `RECYCLEWHEEL_ALLOW_INSECURE_REMOTE`: allow a plain `http:` remote cache on a
   * non-loopback host (the Bearer token then travels unencrypted). Default false.
   */
  allowInsecureRemote: boolean;
  budget: { rounds: number; evals: number; web: number };
  librariesIoApiKey?: string;
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  serverWriteToken?: string;
  serverReadToken?: string;
  /** Human-readable notes about ignored or invalid env values. */
  warnings: string[];
}

export interface LedgerHandle {
  path: string;
  append(e: LedgerEvent): void;
  read(): LedgerState;
}

export interface AppContext {
  config: Config;
  http: HttpClient;
  store: CacheStore;
  remote: RemoteCache;
  adapters: Partial<Record<Source, SourceAdapter>>;
  enrichers: Enricher[];
  ledger: (projectRoot?: string) => LedgerHandle;
  now: () => Date;
}

export interface ToolModule {
  name: string;
  register(server: McpServer, ctx: AppContext): void;
}

export type StartCacheServer = (o: {
  host: string;
  port: number;
  dbPath: string;
  writeToken?: string;
  readToken?: string;
  maxBodyBytes?: number;
  maxTtlSec?: number;
}) => Promise<{ url: string; close(): Promise<void> }>;
