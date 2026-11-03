/**
 * License judgement for model weights published on the Hugging Face Hub
 * (docs/PLAN.md §7.4 "Model weights"). Pure and deterministic, like `license.ts`.
 *
 * Code and weights are licensed separately: a repository can be Apache-2.0
 * while its weights carry a vendor license (`license: other`). The Hub model
 * card declares the weights license as an id (`apache-2.0`, `cc-by-nc-4.0`,
 * `llama3.1`, `other`, ...) plus, for `other`, a `license_name` and
 * `license_link`. This module maps those ids:
 *
 * - ids that are SPDX licenses the code matrix knows (Apache-2.0, MIT, ...,
 *   and the `CC-BY-NC-*` family) are judged by `judge()`, so the verdict per
 *   distribution form is the one in license-matrix.md;
 * - model-specific families (OpenRAIL, Llama, Gemma, CC-BY, CC-BY-SA, CC-BY-ND)
 *   have use or attribution conditions and are `conditional`;
 * - `other`, ids missing from the table and any card with a `license_name` are
 *   a custom model license: verdict `unknown`, the caller raises the flag
 *   `custom_model_license`.
 *
 * Anything unknown is `unknown`, never `compatible`. Not legal advice.
 * Human-readable twin: the "Model weights" part of
 * skills/recyclewheel/reference/license-matrix.md.
 */
import { LEDGER_TEXT_MAX } from '../types.js';
import type { Distribution, LicenseVerdict, ModelLicenseFacts } from '../types.js';
import { judge } from './license.js';

type VerdictKind = LicenseVerdict['verdict'];

/** Hub license id -> SPDX expression judged by the code matrix. */
export const HF_SPDX_IDS: Readonly<Record<string, string>> = {
  'apache-2.0': 'Apache-2.0',
  mit: 'MIT',
  'bsd-2-clause': 'BSD-2-Clause',
  'bsd-3-clause': 'BSD-3-Clause',
  isc: 'ISC',
  unlicense: 'Unlicense',
  'cc0-1.0': 'CC0-1.0',
  zlib: 'Zlib',
  'bsl-1.0': 'BSL-1.0',
  'mpl-2.0': 'MPL-2.0',
  'epl-1.0': 'EPL-1.0',
  'epl-2.0': 'EPL-2.0',
  'lgpl-2.1': 'LGPL-2.1-only',
  'lgpl-3.0': 'LGPL-3.0-only',
  'gpl-2.0': 'GPL-2.0-only',
  'gpl-3.0': 'GPL-3.0-only',
  'agpl-3.0': 'AGPL-3.0-only',
};

/**
 * `HF_SPDX_IDS[id]` for an id the table defines itself: `constructor`, `__proto__` and the like are card text,
 * not table keys, and must reach the custom-license path.
 */
export function hfSpdx(id: string): string | undefined {
  return Object.hasOwn(HF_SPDX_IDS, id) ? HF_SPDX_IDS[id] : undefined;
}

/** Most license ids of one card that are judged; a card with more is not a normal card. */
export const MAX_LICENSE_IDS = 5;

/** Non-commercial ids: `cc-by-nc-*` (also -sa, -nd) and the FAIR research license. Matrix category `non_oss`. */
const NC_RE = /^cc-by-nc(?:-[a-z]+)*(?:-\d\.\d)?$/;
const NC_EXTRA_IDS: readonly string[] = ['fair-noncommercial-research-license'];

interface ConditionalRule {
  /** Name shown in `candidate_spdx`, e.g. `llama3.1` (these are not SPDX ids). */
  label: string;
  category: LicenseVerdict['category'];
  obligations: string[];
  notes: string[];
}

const OPENRAIL: ConditionalRule = {
  label: 'OpenRAIL',
  category: 'non_oss',
  obligations: [
    'Pass the behavioral-use restrictions on to every downstream user (they are part of the license)',
    'Include a copy of the license when you redistribute the weights or derivatives',
  ],
  notes: [
    'OpenRAIL-family licenses permit commercial use but forbid listed uses (e.g. surveillance, disinformation, medical advice); check your use case against the use restrictions in the license text.',
  ],
};

const LLAMA: ConditionalRule = {
  label: 'Llama community license',
  category: 'non_oss',
  obligations: [
    'Accept the Llama community license and its acceptable use policy',
    'Show the required attribution ("Built with Llama") and keep the license with redistributed copies',
    'Naming rules for derived models apply (see the license text)',
  ],
  notes: [
    'The Llama community license is not an open-source license: it has an acceptable use policy and, for very large services (monthly active users above the license threshold), requires a separate license from the vendor.',
  ],
};

const GEMMA: ConditionalRule = {
  label: 'Gemma terms of use',
  category: 'non_oss',
  obligations: [
    'Accept the Gemma Terms of Use and the Prohibited Use Policy',
    'Pass the use restrictions on to downstream users and include the notice when you redistribute',
  ],
  notes: ['The Gemma terms are not an open-source license; the vendor can update the prohibited-use policy.'],
};

const CC_BY: ConditionalRule = {
  label: 'CC-BY',
  category: 'permissive',
  obligations: ['Give appropriate credit, link to the license and indicate changes'],
  notes: [],
};

const CC_BY_SA: ConditionalRule = {
  label: 'CC-BY-SA',
  category: 'weak_copyleft',
  obligations: [
    'Give appropriate credit and indicate changes',
    'Share adaptations (for example fine-tuned weights you distribute) under the same license',
  ],
  notes: ['Share-alike: adapted material that you distribute must carry the same license.'],
};

const CC_BY_ND: ConditionalRule = {
  label: 'CC-BY-ND',
  category: 'non_oss',
  obligations: ['Give appropriate credit and link to the license'],
  notes: ['No-derivatives: use the weights unmodified; fine-tuned, quantized or merged variants may not be shared.'],
};

/** Verdict and rule per Hub id for the families the code matrix does not cover. */
const CONDITIONAL_IDS: Readonly<Record<string, { verdict: VerdictKind; rule: ConditionalRule }>> = {
  openrail: { verdict: 'conditional', rule: OPENRAIL },
  'openrail++': { verdict: 'conditional', rule: OPENRAIL },
  'creativeml-openrail-m': { verdict: 'conditional', rule: OPENRAIL },
  'bigscience-openrail-m': { verdict: 'conditional', rule: OPENRAIL },
  'bigscience-bloom-rail-1.0': { verdict: 'conditional', rule: OPENRAIL },
  'bigcode-openrail-m': { verdict: 'conditional', rule: OPENRAIL },
  llama2: { verdict: 'conditional', rule: LLAMA },
  llama3: { verdict: 'conditional', rule: LLAMA },
  'llama3.1': { verdict: 'conditional', rule: LLAMA },
  'llama3.2': { verdict: 'conditional', rule: LLAMA },
  'llama3.3': { verdict: 'conditional', rule: LLAMA },
  llama4: { verdict: 'conditional', rule: LLAMA },
  gemma: { verdict: 'conditional', rule: GEMMA },
  'cc-by-2.0': { verdict: 'compatible', rule: CC_BY },
  'cc-by-2.5': { verdict: 'compatible', rule: CC_BY },
  'cc-by-3.0': { verdict: 'compatible', rule: CC_BY },
  'cc-by-4.0': { verdict: 'compatible', rule: CC_BY },
  'cc-by-sa-3.0': { verdict: 'conditional', rule: CC_BY_SA },
  'cc-by-sa-4.0': { verdict: 'conditional', rule: CC_BY_SA },
  'cc-by-nd-4.0': { verdict: 'conditional', rule: CC_BY_ND },
};

/** Ids that say "no usable license information", not a custom license. */
const NO_LICENSE_IDS: readonly string[] = ['unknown'];

const VERDICT_BADNESS: Record<VerdictKind, number> = { compatible: 0, conditional: 1, unknown: 2, incompatible: 3 };

const NOT_LEGAL_ADVICE = 'Not legal advice';
const WEIGHTS_SEPARATE =
  'Model weights are licensed separately from the code; this verdict covers the Hugging Face model card only.';
const REVIEW_LICENSE_TEXT = 'Obtain and review the actual LICENSE text before adopting';

/** Worse of two verdicts: incompatible > unknown > conditional > compatible. */
export function worseVerdict(a: VerdictKind, b: VerdictKind): VerdictKind {
  return VERDICT_BADNESS[b] > VERDICT_BADNESS[a] ? b : a;
}

export interface ModelLicenseContext {
  project?: string | null | undefined;
  distribution?: Distribution;
  source: LicenseVerdict['source'];
}

export interface ModelLicenseJudgement {
  license: LicenseVerdict;
  /** `other`, an id outside the table, or a card with `license_name`: the caller raises `custom_model_license`. */
  custom: boolean;
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

interface Part {
  verdict: VerdictKind;
  category: LicenseVerdict['category'];
  label: string;
  obligations: string[];
  notes: string[];
  custom: boolean;
}

function customPart(id: string, facts: ModelLicenseFacts): Part {
  const name = facts.license_name ?? id;
  const link = facts.license_link !== undefined ? ` (${facts.license_link})` : '';
  return {
    verdict: 'unknown',
    category: 'unknown',
    label: name,
    obligations: [REVIEW_LICENSE_TEXT],
    notes: [
      `Custom model license "${name}"${link} is not in the classification table; read the license text for commercial use, redistribution and field-of-use terms.`,
    ],
    custom: true,
  };
}

function partFor(id: string, facts: ModelLicenseFacts, ctx: ModelLicenseContext): Part {
  const spdx = hfSpdx(id);
  const nc = NC_RE.test(id) || NC_EXTRA_IDS.includes(id);
  if (spdx !== undefined || nc) {
    // The NC family is judged as CC-BY-NC-4.0 (category non_oss); the exact id stays in the label.
    const judged = judge({
      candidate: spdx ?? 'CC-BY-NC-4.0',
      project: ctx.project,
      distribution: ctx.distribution ?? 'application',
      source: ctx.source,
    });
    const notes = judged.notes.filter((n) => n !== NOT_LEGAL_ADVICE);
    if (nc) {
      notes.push(
        'Non-commercial terms: commercial use is not permitted, so this is incompatible with a distributed application or a SaaS and needs legal review even for internal use.',
      );
    }
    return {
      verdict: judged.verdict,
      category: judged.category,
      label: spdx ?? id.toUpperCase(),
      obligations: judged.obligations,
      notes,
      custom: false,
    };
  }
  const conditional = Object.hasOwn(CONDITIONAL_IDS, id) ? CONDITIONAL_IDS[id] : undefined;
  if (conditional !== undefined) {
    const { verdict, rule } = conditional;
    return {
      verdict,
      category: rule.category,
      label: id,
      obligations: rule.obligations,
      notes: rule.notes,
      custom: false,
    };
  }
  if (NO_LICENSE_IDS.includes(id)) {
    return {
      verdict: 'unknown',
      category: 'unknown',
      label: id,
      obligations: [REVIEW_LICENSE_TEXT],
      notes: ['The model card declares no license; without a license no usage rights are granted.'],
      custom: false,
    };
  }
  return customPart(id, facts);
}

/**
 * Judges a Hub model license. `facts === undefined` (model not retrieved) and
 * a card without any license id are `unknown`. Several ids are combined like
 * an AND: the worst part decides. A `license_name` makes the whole card a
 * custom license. Never throws.
 */
export function judgeModelLicense(facts: ModelLicenseFacts | undefined, ctx: ModelLicenseContext): ModelLicenseJudgement {
  const distribution = ctx.distribution ?? 'application';
  const base = (verdict: VerdictKind, parts: Part[], candidate: string | null, extraNotes: string[]): LicenseVerdict => ({
    candidate_spdx: candidate,
    project_spdx: null,
    distribution,
    category: parts.find((p) => p.verdict === verdict)?.category ?? parts[0]?.category ?? 'unknown',
    verdict,
    obligations: unique(parts.flatMap((p) => p.obligations)),
    notes: unique([WEIGHTS_SEPARATE, ...parts.flatMap((p) => p.notes), ...extraNotes, NOT_LEGAL_ADVICE]),
    source: ctx.source,
  });

  if (facts === undefined) {
    const part: Part = {
      verdict: 'unknown',
      category: 'unknown',
      label: '',
      obligations: [REVIEW_LICENSE_TEXT],
      notes: ['The model license could not be retrieved (model not found, Hugging Face unreachable, or offline); treated as unknown.'],
      custom: false,
    };
    return { license: base('unknown', [part], null, []), custom: false };
  }

  const extra: string[] = [];
  if (facts.gated) {
    extra.push('Gated model: downloading requires accepting its terms (or requesting access) on Hugging Face first.');
  }
  if (facts.base_models.length > 0) {
    extra.push(
      `Derived from base model(s) ${facts.base_models.slice(0, 3).join(', ')}; the base model license may add terms.`,
    );
  }

  const allIds = unique(facts.hf_license);
  const ids = allIds.slice(0, MAX_LICENSE_IDS);
  if (allIds.length > ids.length) {
    extra.push(`The card lists ${allIds.length} license ids; only the first ${MAX_LICENSE_IDS} were judged. Read the model card.`);
  }
  let parts: Part[];
  if (facts.license_name !== undefined) {
    parts = [customPart(ids[0] ?? 'other', facts)];
  } else if (ids.length === 0) {
    parts = [partFor('unknown', facts, ctx)];
  } else {
    parts = ids.map((id) => partFor(id, facts, ctx));
  }
  const verdict = parts.reduce<VerdictKind>((worst, p) => worseVerdict(worst, p.verdict), 'compatible');
  const custom = parts.some((p) => p.custom);
  // Bounded like any ledger text field, so a hostile card cannot make the evaluation unwritable.
  const candidate = (facts.license_name ?? unique(parts.map((p) => p.label)).join(' AND ')).slice(0, LEDGER_TEXT_MAX);
  return { license: base(verdict, parts, candidate === '' ? null : candidate, extra), custom };
}
