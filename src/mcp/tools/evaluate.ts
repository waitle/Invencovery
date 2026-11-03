/**
 * `rw_evaluate` (docs/PLAN.md section 7.4): enriches each candidate through the
 * Enricher chain, judges its license, scores it (`core/score`, scoring_version
 * 1) and records the evaluations plus one `evaluate` evidence entry.
 *
 * Enricher chain per ref: every enricher whose `supports(ref)` is true runs,
 * multi-scheme API enrichers (deps.dev) before per-source ones, so GitHub's
 * rate limit is spent last. `npm:`, `pypi:` and `mcp:` enrichers only return a
 * `repository_url`; when that points at GitHub, the chain runs once more for
 * the `github:` ref so stars, scorecard and push activity are filled in.
 *
 * Two more kinds of candidate are evaluated here (docs/PLAN.md §7.4):
 * - `hf:` models and `weights_ref` (the weights behind a code candidate): the
 *   Hugging Face model card license is judged by `core/model-license`; the
 *   final verdict of a code candidate is the worse of code and weights.
 * - `saas:` hosted services: no repository metrics exist, so the agent passes
 *   the terms in `saas` and `core/score.scoreSaas` scores them. Only the vendor
 *   domains, lock-in and exit path are required, so one call registers a service
 *   whose terms are not read yet (its hint stays at `reference`); a vendor page
 *   the agent read can be given inline as `source_url`, which the server records
 *   as evidence (kind `manual`, so it counts neither as a web query nor as a
 *   search source).
 *
 * A code candidate that is the client or plugin of a hosted service carries
 * `service_ref`: the decision is then really about the service, so the hint is
 * capped at `reference` until that service's terms are confirmed
 * (`core/service-terms`). Services are evaluated before the code candidates of
 * the same call.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { redactUrl } from '../../cache/key.js';
import { checkBudget } from '../../core/budget.js';
import { normalizeRepoUrl } from '../../core/dedupe.js';
import { evaluationFor, findComponent, serializeEvent } from '../../core/ledger.js';

import { judge } from '../../core/license.js';
import { mlTermsIn } from '../../core/ml-terms.js';
import { hfSpdx, judgeModelLicense, worseVerdict } from '../../core/model-license.js';
import { saasEvidenceSource } from '../../core/saas-evidence.js';
import { clampInput, codeSpan, cut, oneLine, softLine, stripControlChars, stripUnsafe, wrapUntrusted } from '../../core/sanitize.js';
import { SCORING_VERSION, pickRecommendation, score, scoreSaas } from '../../core/score.js';
import { SAAS_TERMS_GATE_FLAGS, serviceClientSignals, serviceTermsGaps, upstreamProviderSignals } from '../../core/service-terms.js';
import {
  CandidateRefSchema,
  DistributionSchema,
  EvaluationMetricsSchema,
  EvaluationSchema,
  FitValueSchema,
  SaasEvidenceSourceSchema,
  SaasTermsInputSchema,
  formatRef,
  newId,
  parseRef,
} from '../../types.js';
import type {
  AppContext,
  Component,
  Distribution,
  Enricher,
  Evaluation,
  Evidence,
  LedgerEvent,
  LicenseVerdict,
  ModelLicenseFacts,
  Provenance,
  RefScheme,
  SaasEvidenceSource,
  SaasTerms,
  SaasTermsInput,
  ToolModule,
  WeightsLicense,
} from '../../types.js';
import { safeErrorMessage } from './search.js';

export const TOOL_NAME = 'rw_evaluate';

const MAX_TABLE_ROWS = 15;
const MAX_SUMMARY_CHARS = 500;
const MAX_PAGE_NOTE_CHARS = 300;

type EnrichOutput = Awaited<ReturnType<Enricher['enrich']>>;
type Metrics = Evaluation['metrics'];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Schemes whose SDK can be evaluated as a package for a `saas:` candidate. */
const SDK_SCHEMES: readonly RefScheme[] = ['github', 'npm', 'pypi', 'mcp'];

/** Schemes whose name or description is checked for "probably loads model weights". */
const CODE_SCHEMES: readonly RefScheme[] = ['github', 'npm', 'pypi', 'mcp'];

const CandidateInputSchema = z
  .object({
    ref: CandidateRefSchema.describe(
      'Candidate ref as returned by rw_search, e.g. "github:owner/repo", "npm:name", "pypi:name", "mcp:server", "hf:owner/model" (model weights), "saas:vendor/product" (hosted service; needs the saas block), "web:https://...".',
    ),
    fit: z
      .number()
      .int()
      .min(0)
      .max(5)
      .describe('Your judgment of how well it meets the component requirements: 5 exact, 4 config-level gaps, 3 needs wrapping, 2 design reference only, 1 marginal, 0 unrelated.'),
    fit_reason: z.string().min(10).max(2000).describe('Why that fit value (at least 10 characters).'),
    weights_ref: CandidateRefSchema.optional().describe(
      'Only for code candidates that load pretrained model weights: the "hf:owner/model" ref of the weights. Weights are licensed separately from the code; the final license verdict is the worse of the two.',
    ),
    weights_exempt_reason: z
      .string()
      .min(10, 'weights_exempt_reason must be at least 10 characters: say why this candidate needs no weights check (for example "LLM API gateway: forwards HTTP calls to remote providers, loads no model", or "bundles the VAD model in the wheel under the same MIT LICENSE").')
      .max(300, 'weights_exempt_reason must be at most 300 characters.')
      .optional()
      .describe(
        'Only for github/npm/pypi/mcp candidates that sound like ML but need no separate weights license: they load no weights (for example an LLM API gateway or a client for a remote API), or the weights are bundled in the package under the same LICENSE as the code (say so). 10-300 characters. Clears the model_weights_unverified warning; the license verdict is unchanged. Exclusive with weights_ref.',
      ),
    service_ref: CandidateRefSchema.optional().describe(
      "Only for github/npm/pypi/mcp candidates: the \"saas:vendor/product\" ref of the hosted service this package is a client, SDK or plugin of. Using the package means accepting that service's terms, so the service is the real decision: evaluate it in the same call (services are processed first) or earlier in the same component. Until the service has its terms confirmed on the vendor's own pages the hint is capped at \"reference\", and rw_decide refuses adopt/extend. Exclusive with no_service_reason.",
    ),
    no_service_reason: z
      .string()
      .min(10, 'no_service_reason must be at least 10 characters: say why this package needs no hosted service (for example "self-hostable: runs fully offline, no API key").')
      .max(300, 'no_service_reason must be at most 300 characters.')
      .optional()
      .describe(
        'Only for github/npm/pypi/mcp candidates that look like a client of a hosted service (flag service_client_suspected) but are not: why, 10-300 characters (for example "self-hostable, works without an API key"). Clears that warning, but not upstream_provider_unverified (an LLM gateway needs service_ref or weights_ref). Exclusive with service_ref.',
      ),
    saas: SaasTermsInputSchema.optional().describe(
      "Required for \"saas:\" refs, forbidden otherwise. Required inside: vendor_domains (the vendor's OWN lowercase hostnames, e.g. [\"deepgram.com\"]), lock_in, exit_path. Optional: maturity (default unknown), pricing (default {checked:false}), data_use (default {policy:\"unknown\"}; policy is no_training, opt_out, trains, not_stated = you read the vendor's data page and it does not say whether it trains on data, or unknown = not read yet), sdk_ref. A service whose terms you have not read yet can be registered with just the required fields; its hint is then capped at \"reference\". Give the vendor page you read as `source_url` (an http(s) URL) inside pricing / data_use and the server records it as evidence itself; pricing.source_url implies checked:true. Or quote an `evidence_id` from rw_record_evidence (not both). The server judges each term as first_party (a page on vendor_domains), secondhand (another site) or none; only first_party earns full points, and anything else caps the hint at \"reference\". Do not pass `source`.",
    ),
  })
  .superRefine((c, ctx) => {
    const scheme = parseRef(c.ref)?.scheme;
    if (scheme === 'saas' && c.saas === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['saas'],
        message: 'a "saas:" ref requires the "saas" block (at least vendor_domains, lock_in, exit_path; pricing and data_use may be omitted until you have read the vendor pages).',
      });
    }
    for (const item of ['pricing', 'data_use'] as const) {
      const term = c.saas?.[item];
      if (term?.source_url === undefined) continue;
      if (term.evidence_id !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['saas', item, 'source_url'],
          message: `saas.${item}: source_url and evidence_id are exclusive: give source_url for a vendor page you just read (the server records it), evidence_id for evidence you recorded with rw_record_evidence.`,
        });
      }
      if (item === 'data_use' && c.saas?.data_use?.policy === 'unknown') {
        ctx.addIssue({
          code: 'custom',
          path: ['saas', 'data_use', 'policy'],
          message: 'saas.data_use: policy "unknown" (not read yet) contradicts source_url (a data-use page you read); give the policy the page states (no_training, opt_out, trains or not_stated), or drop source_url.',
        });
      }
      if (item === 'pricing' && c.saas?.pricing?.checked === false) {
        ctx.addIssue({
          code: 'custom',
          path: ['saas', 'pricing', 'checked'],
          message: 'saas.pricing: checked:false contradicts source_url (a pricing page you read); drop checked, or drop source_url.',
        });
      }
    }
    if (scheme !== 'saas' && c.saas !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['saas'], message: 'the "saas" block is only for "saas:" refs.' });
    }
    if (c.saas?.sdk_ref !== undefined) {
      const sdk = parseRef(c.saas.sdk_ref)?.scheme;
      if (sdk === undefined || !SDK_SCHEMES.includes(sdk)) {
        ctx.addIssue({ code: 'custom', path: ['saas', 'sdk_ref'], message: 'saas.sdk_ref must be a github:, npm:, pypi: or mcp: ref.' });
      }
    }
    if (c.weights_exempt_reason !== undefined) {
      if (c.weights_ref !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['weights_exempt_reason'],
          message: 'weights_exempt_reason and weights_ref are exclusive: give weights_ref when the candidate loads a model, weights_exempt_reason when it loads none or bundles them under the code license.',
        });
      }
      if (scheme === undefined || !CODE_SCHEMES.includes(scheme)) {
        ctx.addIssue({
          code: 'custom',
          path: ['weights_exempt_reason'],
          message: 'weights_exempt_reason is only for github:, npm:, pypi: and mcp: candidates.',
        });
      }
    }
    for (const field of ['service_ref', 'no_service_reason'] as const) {
      if (c[field] !== undefined && (scheme === undefined || !CODE_SCHEMES.includes(scheme))) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} is only for github:, npm:, pypi: and mcp: candidates.` });
      }
    }
    if (c.service_ref !== undefined) {
      if (parseRef(c.service_ref)?.scheme !== 'saas') {
        ctx.addIssue({ code: 'custom', path: ['service_ref'], message: 'service_ref must be a "saas:vendor/product" ref (the hosted service this package is a client of).' });
      }
      if (c.no_service_reason !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['no_service_reason'],
          message: 'no_service_reason and service_ref are exclusive: give service_ref when the package is a client of a hosted service, no_service_reason when it needs none.',
        });
      }
    }

    if (c.weights_ref !== undefined) {
      if (parseRef(c.weights_ref)?.scheme !== 'hf') {
        ctx.addIssue({ code: 'custom', path: ['weights_ref'], message: 'weights_ref must be an "hf:owner/model" ref.' });
      }
      if (scheme === 'hf' || scheme === 'saas') {
        ctx.addIssue({
          code: 'custom',
          path: ['weights_ref'],
          message: 'weights_ref is for code candidates; an "hf:" candidate is the weights itself.',
        });
      }
    }
  });

export const evaluateInputShape = {
  component_id: z.string().min(1).describe('Component the candidates are evaluated for (from rw_decompose).'),
  candidates: z
    .array(CandidateInputSchema)
    .min(1)
    .max(5)
    .describe('1-5 candidates to evaluate.'),
  project_license: z
    .string()
    .max(2000)
    .optional()
    .describe('SPDX expression of the project license. Default: the license recorded by rw_decompose.'),
  distribution: DistributionSchema.optional().describe(
    'library | application | saas | internal. Default: the distribution recorded by rw_decompose.',
  ),
  deep: z
    .boolean()
    .optional()
    .describe('Default false. true also fetches the latest release and the contributor count from GitHub (more API calls).'),
  force: z.boolean().optional().describe('Continue past the hard evaluation budget; requires force_reason.'),
  force_reason: z.string().optional().describe('Why more evaluations are justified.'),
  project_root: z
    .string()
    .optional()
    .describe('Project directory that holds .recyclewheel/ledger.jsonl. Default: RECYCLEWHEEL_PROJECT_ROOT or the working directory.'),
};
export const EvaluateInputSchema = z.object(evaluateInputShape);
export type EvaluateToolInput = z.infer<typeof EvaluateInputSchema>;

export const EvaluateOutputSchema = z.object({
  evidence_id: z.string(),
  evaluations: z.array(EvaluationSchema),
  recommendation: z.object({
    hint: EvaluationSchema.shape.hint,
    ref: z.string().optional(),
    reason: z.string(),
  }),
  /** Vendor pages given as `source_url` that were recorded as evidence (kind `manual`: not a web query, not a search source). */
  recorded_evidence: z
    .array(
      z.object({
        ref: z.string(),
        item: z.enum(['pricing', 'data_use']),
        evidence_id: z.string(),
        url: z.string(),
        /** Whose page the server judged it to be: `first_party` when the URL is on one of the vendor domains. */
        source: SaasEvidenceSourceSchema,
      }),
    )
    .optional(),
  /** Non-fatal notes: budget warnings and enrichment failures. */
  warnings: z.array(z.string()).optional(),
});
export type EvaluateOutput = z.infer<typeof EvaluateOutputSchema>;

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/** Freshest first; the weakest provenance describes the evaluation as a whole. */
const PROVENANCE_ORDER: readonly Provenance[] = ['live', 'local_cache', 'remote_cache', 'stale_cache'];

function weakestProvenance(list: readonly Provenance[]): Provenance {
  let worst: Provenance = 'live';
  for (const p of list) if (PROVENANCE_ORDER.indexOf(p) > PROVENANCE_ORDER.indexOf(worst)) worst = p;
  return worst;
}

const PROBE_REFS = ['github:a/b', 'npm:a', 'pypi:a', 'mcp:a'] as const;

/**
 * Stable order: enrichers covering several ref schemes (deps.dev) first, then
 * the per-source ones in the order given. Independent of how `ctx.enrichers`
 * was assembled.
 */
function orderEnrichers(enrichers: readonly Enricher[]): Enricher[] {
  const breadth = (e: Enricher): number => PROBE_REFS.filter((ref) => e.supports(ref)).length;
  return enrichers
    .map((enricher, index) => ({ enricher, index, breadth: breadth(enricher) }))
    .sort((a, b) => b.breadth - a.breadth || a.index - b.index)
    .map((x) => x.enricher);
}

async function runChain(
  enrichers: readonly Enricher[],
  ref: string,
  deep: boolean,
  errors: string[],
): Promise<EnrichOutput[]> {
  const applicable = enrichers.filter((e) => {
    try {
      return e.supports(ref);
    } catch {
      return false;
    }
  });
  const settled = await Promise.all(
    applicable.map(async (e): Promise<EnrichOutput | undefined> => {
      try {
        return await e.enrich(ref, { deep });
      } catch (err) {
        errors.push(`${ref}: ${safeErrorMessage(err)}`);
        return undefined;
      }
    }),
  );
  return settled.filter((r): r is EnrichOutput => r !== undefined);
}

/** `https://github.com/o/r` (any spelling) -> `github:o/r`; other hosts -> undefined. */
function githubRefFromRepositoryUrl(url: string | undefined): string | undefined {
  const normalized = normalizeRepoUrl(url);
  const m = normalized ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(normalized) : null;
  if (!m) return undefined;
  try {
    return formatRef('github', `${m[1]}/${m[2]}`);
  } catch {
    return undefined;
  }
}

const REGISTRY_SCHEMES: readonly RefScheme[] = ['npm', 'pypi', 'mcp'];

async function enrichRef(
  enrichers: readonly Enricher[],
  ref: string,
  deep: boolean,
  errors: string[],
): Promise<EnrichOutput[]> {
  const scheme = parseRef(ref)?.scheme;
  if (scheme === undefined || scheme === 'web') return [];
  const results = await runChain(enrichers, ref, deep, errors);
  if (REGISTRY_SCHEMES.includes(scheme)) {
    const repoRef = githubRefFromRepositoryUrl(results.find((r) => r.repository_url !== undefined)?.repository_url);
    if (repoRef !== undefined) results.push(...(await runChain(enrichers, repoRef, deep, errors)));
  }
  return results;
}

interface Merged {
  metrics: Metrics;
  license_spdx: string | null;
  license_source: LicenseVerdict['source'];
  repository_url: string | undefined;
  provenance: Provenance;
  missing: string[];
  model_license: ModelLicenseFacts | undefined;
  flags: string[];
  /** Name, description and topics of every enricher, for the "uses ML weights" heuristic. */
  descriptor: string;
}

const BOOLEAN_RISK_METRICS: ReadonlySet<string> = new Set(['archived', 'deprecated']);

/**
 * Combines chain results. Earlier results win per metric (package-level data
 * before repository-level), except `archived`/`deprecated`, where any `true`
 * wins. `missing` is the union minus whatever another enricher supplied.
 */
function mergeEnrichment(results: readonly EnrichOutput[]): Merged {
  const shape = EvaluationMetricsSchema.shape as Record<string, z.ZodType>;
  const collected: Record<string, unknown> = {};
  for (const r of results) {
    for (const [key, value] of Object.entries(r.metrics)) {
      if (value === undefined || shape[key] === undefined || !shape[key].safeParse(value).success) continue;
      if (BOOLEAN_RISK_METRICS.has(key)) collected[key] = collected[key] === true ? true : value;
      else if (collected[key] === undefined) collected[key] = value;
    }
  }
  const metrics = collected as Metrics;

  const licensed = results.find((r) => typeof r.license_spdx === 'string' && r.license_spdx.trim() !== '');
  // A real SPDX expression is short; cut hostile registry data before it reaches the verdict and the ledger.
  const license_spdx = licensed?.license_spdx != null ? cut(licensed.license_spdx.trim(), 200) : null;
  const source = licensed ?? results[0];
  const license_source: LicenseVerdict['source'] =
    source === undefined ? 'agent' : source.provenance === 'remote_cache' ? 'remote_cache' : source.license_source;

  const repository_url = results.find((r) => r.repository_url !== undefined)?.repository_url;
  const missing = [...new Set(results.flatMap((r) => r.missing))].filter(
    (name) =>
      !(name in collected) &&
      !(name === 'license' && license_spdx !== null) &&
      !(name === 'repository_url' && repository_url !== undefined),
  ).map((name) => cut(name, 200)); // metric names are short; a long one is hostile data and must not break the output schema
  return {
    metrics,
    license_spdx,
    license_source,
    repository_url,
    provenance: weakestProvenance(results.map((r) => r.provenance)),
    missing,
    model_license: results.find((r) => r.model_license !== undefined)?.model_license,
    flags: [...new Set(results.flatMap((r) => r.flags ?? []))],
    descriptor: results.flatMap((r) => (r.descriptor !== undefined ? [r.descriptor] : [])).join(' '),
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

type CandidateInput = z.infer<typeof CandidateInputSchema>;

interface EvaluationOptions {
  deep: boolean;
  projectLicense: string | undefined;
  distribution: Distribution;
  /** The terms of each `saas:` candidate of this call, with vendor pages already turned into evidence ids. */
  saasTerms: ReadonlyMap<string, SaasTerms>;
  /** Latest evaluation of a service in this component: from this call first, then from the ledger. */
  serviceOf: (ref: string) => Evaluation | undefined;
}

interface VendorPage {
  ref: string;
  item: 'pricing' | 'data_use';
  evidence: Evidence;
  /** The identical page evidence was already in the ledger (an earlier call): it is cited again, not written again. */
  reused: boolean;
}

const ITEM_LABEL = { pricing: 'pricing', data_use: 'data-use policy' } as const;

/**
 * The terms of a `saas:` input with their defaults filled in (maturity unknown,
 * pricing not checked, data use unknown) and every `source_url` turned into an
 * evidence entry of kind `manual`: it records a vendor page that was read, not a
 * search, so it counts neither as a web query nor as a source for the build rule.
 * The URL is normalised by `URL`, free text is stripped of control characters.
 * The entries are returned, not written: the caller appends them with the evaluation.
 */
function resolveSaasTerms(
  component: Component,
  ref: string,
  saas: SaasTermsInput,
  at: string,
  existing: readonly Evidence[],
): { terms: SaasTerms; pages: VendorPage[] } {
  const pages: VendorPage[] = [];
  const record = (item: VendorPage['item'], sourceUrl: string, detail: string | undefined): string => {
    const note = detail !== undefined ? cut(stripUnsafe(clampInput(detail, MAX_PAGE_NOTE_CHARS)), MAX_PAGE_NOTE_CHARS) : '';
    const text = `Vendor page (${saas.vendor_domains.join(', ')}) for the ${ITEM_LABEL[item]} of ${ref}, read by the agent and recorded by ${TOOL_NAME} from source_url${note !== '' ? `: ${note}` : '.'}`;
    const evidence: Evidence = {
      id: newId('ev'),
      component_id: component.id,
      kind: 'manual',
      at,
      tool: TOOL_NAME,
      result_refs: [ref],
      results: [{ url: redactUrl(new URL(sourceUrl).href), ...(note !== '' ? { note } : {}) }],
      summary: cut(text, MAX_SUMMARY_CHARS),
    };
    // Calling again with the same page must not pile up copies: the same component, ref, URL and text is the same evidence.
    const same = existing.find(
      (e) =>
        e.kind === 'manual' &&
        e.tool === TOOL_NAME &&
        e.component_id === evidence.component_id &&
        e.result_refs.length === 1 &&
        e.result_refs[0] === ref &&
        e.results?.length === 1 &&
        e.results[0]?.url === evidence.results?.[0]?.url &&
        e.results[0]?.note === evidence.results?.[0]?.note &&
        e.summary === evidence.summary,
    );
    if (same !== undefined) {
      pages.push({ ref, item, evidence: same, reused: true });
      return same.id;
    }
    pages.push({ ref, item, evidence, reused: false });
    return evidence.id;
  };
  const p = saas.pricing;
  const d = saas.data_use;
  const pricingId = p?.source_url !== undefined ? record('pricing', p.source_url, p.summary) : p?.evidence_id;
  const dataUseId =
    d?.source_url !== undefined
      ? record('data_use', d.source_url, `policy ${d.policy}${d.retention !== undefined ? `, retention ${d.retention}` : ''}`)
      : d?.evidence_id;
  const terms: SaasTerms = {
    maturity: saas.maturity ?? 'unknown',
    lock_in: saas.lock_in,
    exit_path: saas.exit_path,
    ...(saas.sdk_ref !== undefined ? { sdk_ref: saas.sdk_ref } : {}),
    vendor_domains: saas.vendor_domains,
    pricing: {
      checked: p?.checked ?? (p?.source_url !== undefined || p?.evidence_id !== undefined),
      ...(p?.summary !== undefined ? { summary: p.summary } : {}),
      ...(pricingId !== undefined ? { evidence_id: pricingId } : {}),
    },
    data_use: {
      policy: d?.policy ?? 'unknown',
      ...(d?.retention !== undefined ? { retention: d.retention } : {}),
      ...(dataUseId !== undefined ? { evidence_id: dataUseId } : {}),
    },
  };
  return { terms, pages };
}

/** SPDX expression of a model card that declares exactly one mapped license; `null` otherwise. */
function weightsSpdx(facts: ModelLicenseFacts | undefined): string | null {
  if (facts === undefined || facts.license_name !== undefined || facts.hf_license.length !== 1) return null;
  return hfSpdx(facts.hf_license[0]!) ?? null;
}

/** The card's own license name, or the Hub license id(s) when they are not an SPDX license (`llama3.1`), so the report names the license. */
function weightsLicenseName(facts: ModelLicenseFacts | undefined): string | undefined {
  if (facts === undefined) return undefined;
  if (facts.license_name !== undefined) return facts.license_name;
  return weightsSpdx(facts) === null && facts.hf_license.length > 0 ? facts.hf_license.join(' AND ') : undefined;
}

function weightsLicenseOf(
  ref: string,
  license: LicenseVerdict,
  codeVerdict: LicenseVerdict['verdict'],
  facts: ModelLicenseFacts | undefined,
): WeightsLicense {
  return {
    ref,
    verdict: license.verdict,
    code_verdict: codeVerdict,
    spdx: weightsSpdx(facts),
    ...(weightsLicenseName(facts) !== undefined ? { license_name: weightsLicenseName(facts) } : {}),
    ...(facts?.license_link !== undefined ? { license_link: facts.license_link } : {}),
    source: license.source,
  };
}

/** The verdict of code and weights together: the worse of the two, with the obligations and notes of both. */
function combineLicense(code: LicenseVerdict, weights: LicenseVerdict): LicenseVerdict {
  const verdict = worseVerdict(code.verdict, weights.verdict);
  return {
    ...code,
    category: code.verdict === verdict ? code.category : weights.category,
    verdict,
    obligations: [...new Set([...code.obligations, ...weights.obligations])],
    notes: [...new Set([...code.notes, ...weights.notes])],
    source: code.source === 'remote_cache' || weights.source === 'remote_cache' ? 'remote_cache' : code.source,
  };
}

/** Evaluation of a hosted service: there are no repository metrics, the verified terms are the input. */
async function evaluateSaas(
  ctx: AppContext,
  enrichers: readonly Enricher[],
  component: Component,
  candidate: CandidateInput,
  saas: SaasTerms,
  evidence: readonly Evidence[],
  opts: EvaluationOptions,
  errors: string[],
): Promise<Evaluation> {
  const fit = FitValueSchema.parse(candidate.fit);
  const chainErrors: string[] = [];
  const flags: string[] = [];
  let sdk: Evaluation['saas_sdk'];
  let provenance: Provenance = 'live';

  if (saas.sdk_ref !== undefined) {
    const results = await enrichRef(enrichers, saas.sdk_ref, opts.deep, chainErrors);
    const merged = mergeEnrichment(results);
    const sdkLicense = judge({
      candidate: merged.license_spdx,
      project: opts.projectLicense,
      distribution: opts.distribution,
      source: merged.license_source,
    });
    // Only the maintenance axis of the SDK is used; the fit argument does not affect it.
    const maintenance = score({ metrics: merged.metrics, license: sdkLicense, fit: 0, now: ctx.now() }).scores.maintenance;
    sdk = { ref: saas.sdk_ref, verdict: sdkLicense.verdict, spdx: merged.license_spdx, maintenance };
    provenance = merged.provenance;
    if (sdkLicense.verdict === 'incompatible' || sdkLicense.verdict === 'unknown') flags.push(`sdk_license_${sdkLicense.verdict}`);
    if (results.length === 0) flags.push('no_enrichment');
  }
  errors.push(...chainErrors);
  if (chainErrors.length > 0) flags.push('enrichment_error');

  // Whose page each cited evidence is, judged from the ledger: a result URL on a vendor domain makes it first-party.
  const sources = {
    pricing: saasEvidenceSource(evidence, saas.pricing.evidence_id, saas.vendor_domains),
    data_use: saasEvidenceSource(evidence, saas.data_use.evidence_id, saas.vendor_domains),
  };
  const recorded: SaasTerms = {
    ...saas,
    pricing: { ...saas.pricing, source: sources.pricing },
    data_use: { ...saas.data_use, source: sources.data_use },
  };
  const scored = scoreSaas({
    saas: recorded,
    sources,
    fit,
    ...(sdk !== undefined ? { sdk: { verdict: sdk.verdict, maintenance: sdk.maintenance } } : {}),
  });

  const obligations = [
    'Accept the vendor terms of service and acceptable use policy',
    'Keep API keys out of the repository and budget for usage-based pricing',
  ];
  if (saas.data_use.policy === 'trains') {
    obligations.push('The vendor may train on submitted data: do not send confidential or personal data without an opt-out');
  }
  const license: LicenseVerdict = {
    candidate_spdx: 'Vendor terms of service',
    project_spdx: null,
    distribution: opts.distribution,
    category: 'non_oss',
    verdict: 'conditional',
    obligations,
    notes: ['Hosted service: governed by the vendor terms of service, not an open-source license.', 'Not legal advice'],
    source: 'agent',
  };

  return {
    ref: candidate.ref,
    component_id: component.id,
    profile: 'saas',
    metrics: {},
    scores: scored.scores,
    total: scored.total,
    license,
    saas: recorded,
    ...(sdk !== undefined ? { saas_sdk: sdk } : {}),
    fit: { value: fit, reason: candidate.fit_reason },
    flags: [...new Set([...scored.flags, ...flags])],
    missing: scored.missing,
    hint: scored.hint,
    scoring_version: SCORING_VERSION,
    provenance,
  };
}

async function evaluateCandidate(
  ctx: AppContext,
  enrichers: readonly Enricher[],
  component: Component,
  candidate: CandidateInput,
  evidence: readonly Evidence[],
  opts: EvaluationOptions,
  errors: string[],
  notes: string[],
): Promise<Evaluation> {
  const parsed = parseRef(candidate.ref);
  const saasTerms = opts.saasTerms.get(candidate.ref);
  if (parsed?.scheme === 'saas' && saasTerms !== undefined) {
    return evaluateSaas(ctx, enrichers, component, candidate, saasTerms, evidence, opts, errors);
  }
  const scheme = parsed?.scheme;
  const isWeb = scheme === 'web';
  const chainErrors: string[] = [];
  const results = isWeb ? [] : await enrichRef(enrichers, candidate.ref, opts.deep, chainErrors);
  const merged = mergeEnrichment(results);
  const extraFlags: string[] = [...merged.flags];

  let license: LicenseVerdict;
  let weights: WeightsLicense | undefined;
  if (scheme === 'hf') {
    // The candidate is the weights: the model card license replaces the code license judgement.
    const judged = judgeModelLicense(merged.model_license, {
      project: opts.projectLicense,
      distribution: opts.distribution,
      source: merged.license_source,
    });
    license = judged.license;
    if (judged.custom) extraFlags.push('custom_model_license');
    weights = weightsLicenseOf(candidate.ref, license, license.verdict, merged.model_license);
  } else {
    license = judge({
      candidate: merged.license_spdx,
      project: opts.projectLicense,
      distribution: opts.distribution,
      source: merged.license_source,
    });
    if (candidate.weights_ref !== undefined) {
      const weightsResults = await enrichRef(enrichers, candidate.weights_ref, opts.deep, chainErrors);
      const weightsMerged = mergeEnrichment(weightsResults);
      const judged = judgeModelLicense(weightsMerged.model_license, {
        project: opts.projectLicense,
        distribution: opts.distribution,
        source: weightsMerged.license_source,
      });
      weights = weightsLicenseOf(candidate.weights_ref, judged.license, license.verdict, weightsMerged.model_license);
      license = combineLicense(license, judged.license);
      if (judged.custom) extraFlags.push('custom_model_license');
      extraFlags.push(...weightsMerged.flags);
      if (weightsMerged.model_license === undefined) {
        notes.push(`${candidate.weights_ref}: the model card could not be retrieved; the weights license is treated as unknown.`);
      }
    } else if (scheme !== undefined && CODE_SCHEMES.includes(scheme) && candidate.weights_exempt_reason === undefined) {
      // Heuristic only: a name or description that sounds like ML. The hint is not changed.
      // Remote-API words (llm, gpt) do not count: a gateway or client for a hosted model loads no weights.
      const terms = [
        ...new Set([...mlTermsIn(parsed?.id ?? '', 'any', 'weights'), ...mlTermsIn(merged.descriptor, 'strong', 'weights')]),
      ];
      if (terms.length > 0) {
        extraFlags.push('model_weights_unverified');
        notes.push(
          `${candidate.ref}: may load pretrained model weights (matched: ${terms.slice(0, 5).join(', ')}). Weights carry their own license; re-run rw_evaluate with weights_ref="hf:<owner>/<model>" for the model it loads, or with weights_exempt_reason="<why it loads no weights, or bundles them under the code license>" if it needs no separate weights license.`,
        );
      }
    }
  }
  errors.push(...chainErrors);

  const fit = FitValueSchema.parse(candidate.fit);
  const clientOfService = scheme !== undefined && CODE_SCHEMES.includes(scheme);
  let capToReference = false;
  if (clientOfService && candidate.service_ref !== undefined) {
    // The package is a client of a hosted service: using it accepts that service's terms, so its hint cannot beat the service's.
    const gaps = serviceTermsGaps(opts.serviceOf(candidate.service_ref));
    if (gaps.length > 0) {
      extraFlags.push('service_terms_unverified');
      capToReference = true;
      notes.push(
        `${candidate.ref}: is a client of the hosted service ${candidate.service_ref}, whose terms are not confirmed (${gaps.join(', ')}); its hint is capped at "reference". Evaluate ${candidate.service_ref} with the vendor's pricing and data-use pages as saas.pricing.source_url and saas.data_use.source_url (in this call or later; ${candidate.ref} needs no re-evaluation), or choose "reference".`,
      );
    }
  } else if (clientOfService && candidate.no_service_reason === undefined) {
    // Heuristic only: the name or description of a hosted-service client. The hint is not changed.
    const signals = serviceClientSignals(parsed?.id ?? '', merged.descriptor);
    if (signals.length > 0) {
      extraFlags.push('service_client_suspected');
      notes.push(
        `${candidate.ref}: looks like a client or plugin of a hosted service (${signals.slice(0, 3).join('; ')}); using it means accepting that service's terms. If it is, evaluate the service as a "saas:vendor/product" candidate in this call and pass service_ref on this candidate; if it works without a hosted service (self-hosted, no API key), pass no_service_reason="<why>".`,
      );
    }
  }
  if (clientOfService && candidate.service_ref === undefined && candidate.weights_ref === undefined) {
    // Heuristic only: an LLM gateway, proxy or router forwards to model providers that are a decision of their own.
    // no_service_reason does not clear this: the provider (service_ref) or the self-hosted model (weights_ref) does. The hint is not changed.
    const gateway = upstreamProviderSignals(parsed?.id ?? '', merged.descriptor);
    if (gateway.length > 0) {
      extraFlags.push('upstream_provider_unverified');
      notes.push(
        `${candidate.ref}: looks like an LLM gateway, proxy or router (${gateway.slice(0, 3).join('; ')}); the model provider behind it is a separate decision. Evaluate the provider as a "saas:vendor/product" candidate and pass service_ref on this candidate, or pass weights_ref="hf:<owner>/<model>" if you host the model yourself. no_service_reason does not clear this.`,
      );
    }
  }
  const scored = score({
    metrics: merged.metrics,
    license,
    fit,
    now: ctx.now(),
    ...(merged.metrics.scorecard_maintained !== undefined
      ? { scorecardMaintained: merged.metrics.scorecard_maintained }
      : {}),
  });

  const flags = [...scored.flags, ...extraFlags];
  if (isWeb) flags.push('web_only');
  else if (results.length === 0) flags.push('no_enrichment');
  if (chainErrors.length > 0) flags.push('enrichment_error');

  return {
    ref: candidate.ref,
    component_id: component.id,
    metrics: merged.metrics,
    scores: scored.scores,
    total: scored.total,
    license,
    ...(weights !== undefined ? { weights_license: weights } : {}),
    ...(candidate.weights_exempt_reason !== undefined ? { weights_exempt_reason: candidate.weights_exempt_reason } : {}),
    ...(candidate.service_ref !== undefined ? { service_ref: candidate.service_ref } : {}),
    ...(candidate.no_service_reason !== undefined ? { no_service_reason: candidate.no_service_reason } : {}),
    fit: { value: fit, reason: candidate.fit_reason },
    flags: [...new Set(flags)],
    missing: [...new Set([...merged.missing, ...scored.missing])],
    hint: capToReference && (scored.hint === 'adopt' || scored.hint === 'extend') ? 'reference' : scored.hint,
    scoring_version: SCORING_VERSION,
    provenance: merged.provenance,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** One table cell inside the untrusted fence: input cut first, one line, at most `max` characters, `\` and `|` escaped. */
function cell(text: string, max = 300): string {
  const flat = cut(stripControlChars(clampInput(text, max)).replace(/\r?\n/g, ' ').trim(), max);
  return flat.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

const ENRICHMENT_ERROR_PREFIX = 'enrichment error: ';

function summaryText(component: Component, output: EvaluateOutput): string {
  // Everything derived from the ledger or from third parties is escaped or fenced; nothing is interpolated raw.
  const lines: string[] = [`## rw_evaluate: ${oneLine(component.name, 100)} (${codeSpan(component.id, 64)})`, ''];
  lines.push(`Evidence ${codeSpan(output.evidence_id)} recorded.`, '');
  // Refs and license strings come from third parties: fence the table.
  const shown = output.evaluations.slice(0, MAX_TABLE_ROWS);
  const table: string[] = [
    '| Candidate | Total | Fit | License | Maint. | Pop. | Comm. | Deps | Hint | Flags |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  const saasTable: string[] = [
    '| Service | Total | Fit | Terms | Maturity | Terms pts | Lock-in | SDK | Hint | Vendor domains / term sources | Flags |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const e of shown) {
    const lic = `${e.license.candidate_spdx ?? 'none'} (${e.license.verdict})`;
    const flags = cell(e.flags.join(', ') || '-');
    if ('maturity' in e.scores) {
      const origin = `${e.saas?.vendor_domains?.join(', ') ?? 'no vendor domain'}: pricing ${e.saas?.pricing.source ?? 'n/a'}, data use ${e.saas?.data_use.source ?? 'n/a'}`;
      saasTable.push(
        `| \`${cell(e.ref, 1100)}\` | ${e.total} | ${e.fit.value} | ${cell(lic)} | ${e.scores.maturity} | ${e.scores.terms} | ${e.scores.lock_in} | ${e.scores.sdk} | ${e.hint} | ${cell(origin)} | ${flags} |`,
      );
    } else {
      table.push(
        `| \`${cell(e.ref, 1100)}\` | ${e.total} | ${e.fit.value} | ${cell(lic)} | ${e.scores.maintenance} | ${e.scores.popularity} | ${e.scores.community} | ${e.scores.dependencies} | ${e.hint} | ${flags} |`,
      );
    }
  }
  if (table.length > 2) lines.push(...wrapUntrusted(table));
  if (saasTable.length > 2) lines.push(...(table.length > 2 ? [''] : []), ...wrapUntrusted(saasTable));
  // The weights verdict that was applied to the final license, so it is visible without opening the structured result.
  const weightsLines: string[] = [];
  for (const e of shown) {
    const w = e.weights_license;
    if (w !== undefined && w.ref !== e.ref) {
      weightsLines.push(
        `- \`${cell(e.ref, 1100)}\` code: ${w.code_verdict}, weights: ${cell(w.ref)} → ${w.verdict}(${cell(w.spdx ?? w.license_name ?? 'no license declared')})`,
      );
    }
    if (e.weights_exempt_reason !== undefined) {
      weightsLines.push(`- \`${cell(e.ref, 1100)}\` weights exempt: ${cell(e.weights_exempt_reason)}`);
    }
  }
  if (weightsLines.length > 0) lines.push('', 'Model weights:', ...wrapUntrusted(weightsLines));
  if (output.recorded_evidence !== undefined && output.recorded_evidence.length > 0) {
    lines.push(
      '',
      'Vendor pages recorded from source_url (evidence kind manual: not a web query, not a search source):',
      ...wrapUntrusted(
        output.recorded_evidence.map((r) => `- \`${cell(r.ref, 1100)}\` ${r.item}: ${cell(r.evidence_id)} (${r.source}) ${cell(r.url, 500)}`),
      ),
    );
  }
  const r = output.recommendation;
  lines.push('', `Recommendation: **${r.hint}**${r.ref ? ` ${codeSpan(r.ref)}` : ''}. ${softLine(r.reason)}`);
  const gaps = output.evaluations.filter((e) => e.missing.length > 0);
  if (gaps.length > 0) {
    lines.push('', 'Missing metrics:');
    for (const e of gaps.slice(0, MAX_TABLE_ROWS)) lines.push(`- ${codeSpan(e.ref)}: ${softLine(e.missing.join(', '), 300)}`);
  }
  const verify = output.evaluations.filter((e) =>
    e.flags.some((f) => f === 'license_from_remote_cache' || f === 'license_unknown' || f === 'no_license' || f === 'custom_model_license'),
  );
  if (verify.length > 0) {
    lines.push(
      '',
      `Verify the LICENSE text before adopting: ${verify.map((e) => codeSpan(e.ref)).join(', ')} (license unknown or from the remote cache).`,
    );
  }
  const termsGaps = output.evaluations.filter((e) => e.flags.some((f) => SAAS_TERMS_GATE_FLAGS.includes(f)));
  if (termsGaps.length > 0) {
    lines.push(
      '',
      `Service terms not backed by the vendor's own page: ${termsGaps.map((e) => codeSpan(e.ref)).join(', ')} (${[...new Set(termsGaps.flatMap((e) => e.flags.filter((f) => SAAS_TERMS_GATE_FLAGS.includes(f))))].join(', ')}). Read the vendor's pricing and data-use pages, then call rw_evaluate again with their URLs as saas.pricing.source_url and saas.data_use.source_url (a page on the vendor_domains), or an evidence_id from rw_record_evidence; adopt and extend stay blocked until then. Otherwise choose "reference".`,
    );
  }
  const clientGaps = output.evaluations.filter((e) => e.flags.includes('service_terms_unverified'));
  if (clientGaps.length > 0) {
    lines.push(
      '',
      `Clients of a hosted service whose terms are not confirmed: ${clientGaps.map((e) => `${codeSpan(e.ref)} (service ${codeSpan(e.service_ref ?? '')})`).join(', ')}. Their hint is capped at reference, and adopt and extend stay blocked until the service is evaluated with its vendor pages as source_url (the client needs no re-evaluation).`,
    );
  }
  const gatewayGaps = output.evaluations.filter((e) => e.flags.includes('upstream_provider_unverified'));
  if (gatewayGaps.length > 0) {
    lines.push(
      '',
      `LLM gateways without a linked provider: ${gatewayGaps.map((e) => codeSpan(e.ref)).join(', ')} (upstream_provider_unverified). Evaluate the model provider as a saas: candidate and link it with service_ref, or link a self-hosted model with weights_ref; no_service_reason does not clear this. Adopted without one, they are listed as "Services used through a client but not evaluated".`,
    );
  }
  const notStated = output.evaluations.filter((e) => e.flags.includes('saas_data_use_not_stated'));
  if (notStated.length > 0) {
    lines.push(
      '',
      `Vendor does not state its data use: ${notStated.map((e) => codeSpan(e.ref)).join(', ')} (saas_data_use_not_stated). Check the vendor's DPA or ask the vendor before sending personal or confidential data.`,
    );
  }
  if (output.warnings && output.warnings.length > 0) {
    // The service-client and gateway notes are already said by the paragraphs above (the structured warnings keep them): not twice.
    const said = [
      ...clientGaps.map((e) => `${e.ref}: is a client of the hosted service `),
      ...gatewayGaps.map((e) => `${e.ref}: looks like an LLM gateway`),
    ];
    // Enrichment errors can quote upstream response text: fence those, not our own budget warning.
    const ours = output.warnings.filter((w) => !w.startsWith(ENRICHMENT_ERROR_PREFIX) && !said.some((s) => w.startsWith(s)));
    const upstream = output.warnings.filter((w) => w.startsWith(ENRICHMENT_ERROR_PREFIX));
    if (ours.length + upstream.length > 0) lines.push('', 'Warnings:');
    for (const w of ours) lines.push(`- ${softLine(w)}`);
    if (upstream.length > 0) lines.push(...wrapUntrusted(upstream.map((w) => `- ${cell(w, 600)}`)));
  }
  lines.push('', 'Next: call rw_decide for this component (adopt/extend need an evaluated ref with a compatible license).');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleEvaluate(ctx: AppContext, input: EvaluateToolInput): Promise<CallToolResult> {
  try {
    const ledger = ctx.ledger(input.project_root);
    const state = ledger.read();

    const component = findComponent(state, input.component_id);
    if (component === undefined) {
      const known = state.components.slice(0, 10).map((c) => c.id);
      return errorResult(
        `${TOOL_NAME}: unknown component_id ${codeSpan(input.component_id, 64)}. ${
          known.length > 0 ? `Known ids: ${known.map((id) => codeSpan(id, 64)).join(', ')}.` : 'The ledger has no components yet.'
        } Call rw_decompose first, or fix the id.`,
      );
    }

    const refs = input.candidates.map((c) => c.ref);
    const duplicates = refs.filter((ref, i) => refs.indexOf(ref) !== i);
    if (duplicates.length > 0) {
      return errorResult(`${TOOL_NAME}: duplicate candidate ref(s): ${[...new Set(duplicates)].map((r) => codeSpan(r)).join(', ')}. List each ref once.`);
    }

    const evaluated = new Set(
      state.evaluations.filter((e) => e.component_id === component.id).map((e) => e.ref),
    );
    const at = ctx.now().toISOString();
    const budget = checkBudget(state, component.id, ctx.config.budget, 'evals', {
      adding: refs.filter((ref) => !evaluated.has(ref)).length,
      ...(input.force !== undefined ? { force: input.force } : {}),
      ...(input.force_reason !== undefined ? { force_reason: input.force_reason } : {}),
    });
    if (!budget.allowed) return errorResult(`${TOOL_NAME}: ${budget.error ?? 'evaluation budget exhausted.'}`);

    const projectLicense = input.project_license ?? state.project?.license;
    const distribution = input.distribution ?? state.project?.distribution ?? 'application';
    const enrichers = orderEnrichers(ctx.enrichers);
    const errors: string[] = [];
    const notes: string[] = [];

    // Vendor pages given inline become evidence ids before anything is scored; nothing is written until the whole call has succeeded.
    const vendorPages: VendorPage[] = [];
    const saasTerms = new Map<string, SaasTerms>();
    for (const c of input.candidates) {
      if (c.saas === undefined) continue;
      const resolved = resolveSaasTerms(component, c.ref, c.saas, at, state.evidence);
      saasTerms.set(c.ref, resolved.terms);
      vendorPages.push(...resolved.pages);
    }
    const evidenceList = [...state.evidence, ...vendorPages.filter((p) => !p.reused).map((p) => p.evidence)];

    // Services first: a client candidate (`service_ref`) is judged on the service evaluated in the same call.
    let serviceEvaluations: Evaluation[] = [];
    const opts: EvaluationOptions = {
      deep: input.deep ?? false,
      projectLicense,
      distribution,
      saasTerms,
      serviceOf: (ref) => serviceEvaluations.find((e) => e.ref === ref) ?? evaluationFor(state, component.id, ref),
    };
    const run = (c: CandidateInput): Promise<Evaluation> =>
      evaluateCandidate(ctx, enrichers, component, c, evidenceList, opts, errors, notes);
    const isService = (c: CandidateInput): boolean => parseRef(c.ref)?.scheme === 'saas';
    serviceEvaluations = await Promise.all(input.candidates.filter(isService).map(run));
    const clientEvaluations = await Promise.all(input.candidates.filter((c) => !isService(c)).map(run));
    const evaluations = [...serviceEvaluations, ...clientEvaluations];
    evaluations.sort((a, b) => b.total - a.total || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

    const provenance = [...new Set(evaluations.map((e) => e.provenance))];
    const summary = `Evaluated ${evaluations.length} candidate(s) (deep=${String(input.deep ?? false)}): ${evaluations
      .map((e) => `${e.ref} ${e.total}/100 ${e.hint}`)
      .join('; ')}`.slice(0, MAX_SUMMARY_CHARS);
    const evidence: Evidence = {
      id: newId('ev'),
      component_id: component.id,
      kind: 'evaluate',
      at,
      tool: TOOL_NAME,
      result_refs: evaluations.map((e) => e.ref),
      summary,
      provenance,
    };
    // Every event is serialised and validated before the first one is written: a call that fails writes nothing.
    const events: LedgerEvent[] = [
      ...vendorPages.filter((p) => !p.reused).map((p): LedgerEvent => ({ v: 1, type: 'evidence.add', at, evidence: p.evidence })),
      ...evaluations.map((evaluation): LedgerEvent => ({ v: 1, type: 'evaluation.add', at, evaluation })),
      { v: 1, type: 'evidence.add', at, evidence },
    ];
    for (const event of events) serializeEvent(event);
    for (const event of events) ledger.append(event);

    const warnings = [
      ...(budget.warning !== undefined ? [budget.warning] : []),
      ...notes,
      ...errors.map((e) => `${ENRICHMENT_ERROR_PREFIX}${e}`),
    ];
    const output: EvaluateOutput = {
      evidence_id: evidence.id,
      evaluations,
      recommendation: pickRecommendation(evaluations),
      ...(vendorPages.length > 0
        ? {
            recorded_evidence: vendorPages.map((p) => {
              const terms = evaluations.find((e) => e.ref === p.ref)?.saas;
              const source = p.item === 'pricing' ? terms?.pricing.source : terms?.data_use.source;
              return { ref: p.ref, item: p.item, evidence_id: p.evidence.id, url: p.evidence.results?.[0]?.url ?? '', source: source ?? 'none' };
            }),
          }
        : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return {
      content: [{ type: 'text', text: summaryText(component, output) }],
      structuredContent: output,
    };
  } catch (err) {
    return errorResult(`${TOOL_NAME} failed: ${safeErrorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerEvaluateTool(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Evaluate candidates',
      description:
        'Step 4 of the reuse-first workflow. For 1-5 candidates of a component, fetch maintenance, popularity, community and dependency metrics, judge the license against the project, score each candidate 0-100 together with your fit rating, and get a recommendation (adopt | extend | reference | build). Records the evaluations and returns evidence_id (this tool writes to .recyclewheel/ledger.jsonl and is not read-only). rw_decide requires an evaluation here before adopt or extend.',
      inputSchema: evaluateInputShape,
      outputSchema: EvaluateOutputSchema.shape,
      // Appends evaluations and evidence to the ledger, so not read-only.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => handleEvaluate(ctx, args as EvaluateToolInput),
  );
}

export const evaluateTool: ToolModule = { name: TOOL_NAME, register: registerEvaluateTool };
