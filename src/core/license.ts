/**
 * License classification and compatibility verdicts (docs/PLAN.md §12 T12).
 *
 * Pure and deterministic: no I/O, no clock. The human-readable matrix lives in
 * `skills/recyclewheel/reference/license-matrix.md`; a unit test keeps that file
 * in sync with `LICENSE_MATRIX` and `CATEGORY_MEMBERS` below.
 *
 * This is a conservative triage aid, not legal advice. Anything this module
 * cannot parse or recognize is `unknown`, never `compatible`.
 */
import parse from 'spdx-expression-parse';
import type { Distribution, LicenseVerdict } from '../types.js';

export type LicenseCategory = LicenseVerdict['category'];
export type VerdictKind = LicenseVerdict['verdict'];

/** Matrix columns: `library` and `application` share one column. */
export type MatrixColumn = 'internal' | 'distributed' | 'saas';

/**
 * A matrix cell. `gpl_project` and `agpl_project` are resolved per candidate and
 * project license: compatible only when the project is a compatible GPL (or an
 * AGPL), otherwise incompatible.
 */
export type MatrixCell = VerdictKind | 'gpl_project' | 'agpl_project';

type SpdxNode = parse.Info;
type SpdxLeaf = parse.LicenseInfo;

// ---------------------------------------------------------------------------
// Classification tables
// ---------------------------------------------------------------------------

const PERMISSIVE_IDS = [
  'MIT',
  'MIT-0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'ISC',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'Zlib',
  'BSL-1.0',
  'Python-2.0',
  'BlueOak-1.0.0',
  'PSF-2.0',
] as const;

/** PLAN lists MPL-2.0 and EPL-2.0; the older MPL-1.1, EPL-1.0 and CDDL are the same file-level kind. */
const WEAK_COPYLEFT_IDS = ['MPL-2.0', 'EPL-2.0', 'MPL-1.1', 'EPL-1.0', 'CDDL-1.0', 'CDDL-1.1'] as const;

const NON_OSS_IDS = ['SSPL-1.0', 'BUSL-1.1', 'Elastic-2.0', 'Commons-Clause'] as const;
const NON_OSS_PREFIX = 'CC-BY-NC-';

/** SPDX GPL-family versions this module recognizes. Everything else is `unknown`. */
const GPL_FAMILY_VERSIONS = {
  GPL: ['2.0', '3.0'],
  LGPL: ['2.0', '2.1', '3.0'],
  AGPL: ['3.0'],
} as const;

/** Display names per category, as printed in license-matrix.md (`*` = any suffix: -only, -or-later, ...). */
export const CATEGORY_MEMBERS: Readonly<Record<Exclude<LicenseCategory, 'unknown'>, readonly string[]>> = {
  permissive: PERMISSIVE_IDS,
  weak_copyleft: ['LGPL-2.0*', 'LGPL-2.1*', 'LGPL-3.0*', ...WEAK_COPYLEFT_IDS],
  strong_copyleft: ['GPL-2.0*', 'GPL-3.0*'],
  network_copyleft: ['AGPL-3.0*'],
  non_oss: [...NON_OSS_IDS, `${NON_OSS_PREFIX}*`],
};

/**
 * The compatibility matrix (row = candidate category, column = distribution).
 * `library` and `application` use `distributed`.
 */
export const LICENSE_MATRIX: Readonly<Record<LicenseCategory, Readonly<Record<MatrixColumn, MatrixCell>>>> = {
  permissive: { internal: 'compatible', distributed: 'compatible', saas: 'compatible' },
  weak_copyleft: { internal: 'compatible', distributed: 'conditional', saas: 'conditional' },
  strong_copyleft: { internal: 'conditional', distributed: 'gpl_project', saas: 'conditional' },
  network_copyleft: { internal: 'conditional', distributed: 'agpl_project', saas: 'agpl_project' },
  non_oss: { internal: 'conditional', distributed: 'incompatible', saas: 'incompatible' },
  unknown: { internal: 'unknown', distributed: 'unknown', saas: 'unknown' },
};

/** Labels used for matrix cells in license-matrix.md. */
export const MATRIX_CELL_LABEL: Readonly<Record<MatrixCell, string>> = {
  compatible: 'compatible',
  conditional: 'conditional',
  incompatible: 'incompatible',
  unknown: 'unknown',
  gpl_project: 'compatible if project is a compatible GPL, else incompatible',
  agpl_project: 'compatible if project is AGPL, else incompatible',
};

export function matrixColumn(distribution: Distribution): MatrixColumn {
  switch (distribution) {
    case 'internal':
      return 'internal';
    case 'saas':
      return 'saas';
    case 'library':
    case 'application':
      return 'distributed';
  }
}

// ---------------------------------------------------------------------------
// Leaf-level facts
// ---------------------------------------------------------------------------

type GplFamily = 'gpl' | 'lgpl' | 'agpl';

interface GplTraits {
  family: GplFamily;
  major: 2 | 3;
  /** `+` suffix or `-or-later`. `GPL-2.0` and `GPL-2.0-only` are both "only". */
  orLater: boolean;
}

const GPL_ID_RE = /^(AGPL|LGPL|GPL)-(\d\.\d)(?:-(only|or-later))?(?:-.+)?$/;

function gplTraits(id: string, plus: boolean): GplTraits | undefined {
  const m = GPL_ID_RE.exec(id);
  if (!m) return undefined;
  const name = m[1] as keyof typeof GPL_FAMILY_VERSIONS;
  const version = m[2] as string;
  if (!(GPL_FAMILY_VERSIONS[name] as readonly string[]).includes(version)) return undefined;
  return {
    family: name.toLowerCase() as GplFamily,
    major: version.startsWith('3') ? 3 : 2,
    orLater: plus || m[3] === 'or-later',
  };
}

interface LeafInfo {
  id: string;
  plus: boolean;
  exception?: string;
  category: LicenseCategory;
  gpl?: GplTraits;
}

function categoryOfId(id: string, gpl: GplTraits | undefined): LicenseCategory {
  if ((PERMISSIVE_IDS as readonly string[]).includes(id)) return 'permissive';
  if ((WEAK_COPYLEFT_IDS as readonly string[]).includes(id)) return 'weak_copyleft';
  if ((NON_OSS_IDS as readonly string[]).includes(id) || id.startsWith(NON_OSS_PREFIX)) return 'non_oss';
  if (gpl) {
    switch (gpl.family) {
      case 'gpl':
        return 'strong_copyleft';
      case 'lgpl':
        return 'weak_copyleft';
      case 'agpl':
        return 'network_copyleft';
    }
  }
  return 'unknown';
}

function leafInfo(node: SpdxLeaf): LeafInfo {
  const plus = node.plus === true;
  const gpl = gplTraits(node.license, plus);
  const info: LeafInfo = { id: node.license, plus, category: categoryOfId(node.license, gpl) };
  if (node.exception !== undefined) info.exception = node.exception;
  if (gpl !== undefined) info.gpl = gpl;
  return info;
}

// ---------------------------------------------------------------------------
// Parsing and normalization
// ---------------------------------------------------------------------------

type ParsedExpression =
  | { kind: 'empty' }
  | { kind: 'invalid'; text: string }
  | { kind: 'ok'; node: SpdxNode; text: string; notes: string[] };

/** Lowercased id -> canonical id, for repairing `mit` or `apache-2.0` before a second parse. */
const CANONICAL_IDS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const add = (id: string): void => {
    map.set(id.toLowerCase(), id);
  };
  [...PERMISSIVE_IDS, ...WEAK_COPYLEFT_IDS, ...NON_OSS_IDS].forEach(add);
  for (const [family, versions] of Object.entries(GPL_FAMILY_VERSIONS)) {
    for (const v of versions) {
      const base = `${family}-${v}`;
      add(base);
      add(`${base}-only`);
      add(`${base}-or-later`);
    }
  }
  return map;
})();

function tryParse(text: string): SpdxNode | undefined {
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

function repairCase(text: string): string {
  return text.replace(/[^\s()]+/g, (token) => {
    const upper = token.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'WITH') return upper;
    const plus = token.endsWith('+');
    const base = plus ? token.slice(0, -1) : token;
    const hit = CANONICAL_IDS.get(base.toLowerCase());
    return hit === undefined ? token : `${hit}${plus ? '+' : ''}`;
  });
}

/** Serializes a parsed expression: canonical operator case, parentheses where AND/OR mix. */
function render(node: SpdxNode, parent?: 'and' | 'or'): string {
  if ('conjunction' in node) {
    const text = `${render(node.left, node.conjunction)} ${node.conjunction.toUpperCase()} ${render(node.right, node.conjunction)}`;
    return parent !== undefined && parent !== node.conjunction ? `(${text})` : text;
  }
  let text = node.license;
  if (node.plus === true) text += '+';
  if (node.exception !== undefined) text += ` WITH ${node.exception}`;
  return text;
}

function parseExpression(input: string | null | undefined): ParsedExpression {
  if (typeof input !== 'string') return { kind: 'empty' };
  const raw = input.trim();
  if (raw === '' || /^(NOASSERTION|NONE)$/i.test(raw)) return { kind: 'empty' };

  const node = tryParse(raw) ?? tryParse(repairCase(raw));
  if (node !== undefined) return { kind: 'ok', node, text: render(node), notes: [] };

  // "Commons Clause" is not an SPDX id or exception, but it is common in package metadata.
  if (/\bcommons[- ]clause\b/i.test(raw)) {
    return {
      kind: 'ok',
      node: { license: 'Commons-Clause' },
      text: raw,
      notes: [`"${raw}" is not a valid SPDX expression; treated as Commons-Clause because it mentions it.`],
    };
  }
  return { kind: 'invalid', text: raw };
}

/**
 * Parses an SPDX license expression and returns its canonical text (operators
 * upper-cased, known ids repaired to canonical case, `AND`/`OR` mixes
 * parenthesized). Returns `null` for empty, `NONE`, `NOASSERTION`, or text that
 * is not a valid SPDX expression.
 */
export function normalizeSpdx(spdx: string | null | undefined): string | null {
  const parsed = parseExpression(spdx);
  return parsed.kind === 'ok' ? parsed.text : null;
}

// ---------------------------------------------------------------------------
// Outcomes: verdict + category + obligations + notes for (part of) an expression
// ---------------------------------------------------------------------------

interface Outcome {
  category: LicenseCategory;
  verdict: VerdictKind;
  obligations: string[];
  notes: string[];
}

/** Higher = more restrictive. `unknown` ranks highest so a known alternative always wins an OR. */
const CATEGORY_RANK: Record<LicenseCategory, number> = {
  permissive: 0,
  weak_copyleft: 1,
  strong_copyleft: 2,
  network_copyleft: 3,
  non_oss: 4,
  unknown: 5,
};

/** Higher = worse. `unknown` is worse than `conditional` and better than `incompatible`. */
const VERDICT_BADNESS: Record<VerdictKind, number> = {
  compatible: 0,
  conditional: 1,
  unknown: 2,
  incompatible: 3,
};

function isBetter(a: Outcome, b: Outcome): boolean {
  const byVerdict = VERDICT_BADNESS[a.verdict] - VERDICT_BADNESS[b.verdict];
  if (byVerdict !== 0) return byVerdict < 0;
  return CATEGORY_RANK[a.category] < CATEGORY_RANK[b.category];
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function andOutcome(a: Outcome, b: Outcome): Outcome {
  // Every part applies: the worst one decides; ties go to the more restrictive category.
  const worst = isBetter(b, a) ? a : isBetter(a, b) ? b : a;
  return {
    category: worst.category,
    verdict: worst.verdict,
    obligations: unique([...a.obligations, ...b.obligations]),
    notes: unique([...a.notes, ...b.notes]),
  };
}

/** Folds an expression tree. OR keeps the most favorable alternative, AND the least favorable. */
function evalNode(node: SpdxNode, leaf: (n: SpdxLeaf) => Outcome): Outcome {
  if (!('conjunction' in node)) return leaf(node);
  const left = evalNode(node.left, leaf);
  const right = evalNode(node.right, leaf);
  if (node.conjunction === 'and') return andOutcome(left, right);
  const leftWins = !isBetter(right, left);
  const chosen = leftWins ? left : right;
  const chosenNode = leftWins ? node.left : node.right;
  return {
    ...chosen,
    notes: unique([...chosen.notes, `Dual license (OR): evaluated the most favorable alternative, ${render(chosenNode)}.`]),
  };
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

/**
 * Category of a license expression, independent of any project.
 * OR resolves to the most favorable alternative, AND to the most restrictive
 * part, WITH to the base license. Empty, `NOASSERTION` and unparseable input
 * are `unknown`.
 */
export function classify(spdx: string | null | undefined): LicenseCategory {
  const parsed = parseExpression(spdx);
  if (parsed.kind !== 'ok') return 'unknown';
  return evalNode(parsed.node, (n) => {
    const category = leafInfo(n).category;
    return {
      category,
      verdict: category === 'unknown' ? 'unknown' : 'compatible',
      obligations: [],
      notes: [],
    };
  }).category;
}

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------

export interface JudgeInput {
  /** Candidate license as an SPDX expression; null/empty/NOASSERTION/unparseable -> unknown. */
  candidate: string | null | undefined;
  /** Project license as an SPDX expression. Missing -> assumed permissive, with a note. */
  project?: string | null | undefined;
  /** Defaults to `application` (the `rw_decompose` default). */
  distribution?: Distribution;
  source: LicenseVerdict['source'];
}

const NOT_LEGAL_ADVICE = 'Not legal advice';
const REVIEW_LICENSE_TEXT = 'Obtain and review the actual LICENSE text before adopting';

const PUBLIC_DOMAIN_LIKE: readonly string[] = ['0BSD', 'Unlicense', 'CC0-1.0', 'MIT-0'];

function obligationsFor(leaf: LeafInfo): string[] {
  switch (leaf.category) {
    case 'permissive': {
      if (PUBLIC_DOMAIN_LIKE.includes(leaf.id)) {
        return ['No notice required (public-domain-like terms); keep the license text for traceability'];
      }
      const out = ['Retain copyright and license notice'];
      if (leaf.id === 'Apache-2.0') out.push('Include NOTICE file if present; state changes to modified files');
      if (leaf.id === 'BSD-3-Clause') out.push('Do not use contributor names to endorse derived products');
      return out;
    }
    case 'weak_copyleft': {
      const out = ['Retain copyright and license notice', 'Publish modifications to covered files under the same license'];
      if (leaf.gpl?.family === 'lgpl') out.push('Allow users to replace the library (dynamic linking or relinkable objects)');
      return out;
    }
    case 'strong_copyleft':
      return [
        'Retain copyright and license notice',
        'Provide corresponding source of the combined work when distributed',
        'License the combined work under GPL-compatible terms',
      ];
    case 'network_copyleft':
      return [
        'Retain copyright and license notice',
        'Provide corresponding source to users who interact with the program over a network (AGPL section 13)',
        'License the combined work under AGPL terms',
      ];
    case 'non_oss':
      return ['Review the license terms with legal counsel before any use'];
    case 'unknown':
      return [REVIEW_LICENSE_TEXT];
  }
}

/** Why a `conditional` cell is conditional, per (category, column). */
const CONDITION_NOTES: Partial<Record<LicenseCategory, Partial<Record<MatrixColumn, string>>>> = {
  weak_copyleft: {
    distributed: 'Conditional: use unmodified and link dynamically; modified covered files must be published.',
    saas: 'Conditional: use unmodified; modified covered files must be published if the software is ever distributed.',
  },
  strong_copyleft: {
    internal: 'Conditional: copyleft obligations apply if the software is ever distributed outside your organization.',
    saas:
      'Conditional: GPL has no network clause, so SaaS use alone does not require source disclosure, but any distribution of binaries or on-premises delivery does.',
  },
  network_copyleft: {
    internal:
      'Conditional: AGPL section 13 applies as soon as users interact with the program over a network, including internal users.',
  },
  non_oss: {
    internal: 'Conditional: source-available or non-commercial terms; legal review required even for internal use.',
  },
};

interface ProjectLeaf {
  id: string;
  gpl?: GplTraits;
}

function projectLeaf(node: SpdxLeaf): ProjectLeaf {
  const gpl = gplTraits(node.license, node.plus === true);
  return gpl === undefined ? { id: node.license } : { id: node.license, gpl };
}

/** Can a project under `proj` carry a GPL candidate described by `cand`? */
function gplProjectCompatible(cand: GplTraits, proj: GplTraits | undefined): boolean {
  if (proj === undefined || proj.family === 'lgpl') return false;
  const canV2 = proj.family === 'gpl' && proj.major === 2;
  const canV3 = proj.family === 'agpl' || proj.major === 3 || (proj.major === 2 && proj.orLater);
  if (cand.major === 2 && !cand.orLater) return canV2;
  if (cand.major === 2) return canV2 || canV3;
  return canV3;
}

function isGplV2Only(gpl: GplTraits | undefined): boolean {
  return gpl !== undefined && gpl.family === 'gpl' && gpl.major === 2 && !gpl.orLater;
}

function incompatibleGplNote(candidate: LeafInfo, project: ProjectLeaf | undefined): string {
  const proj = project?.gpl;
  if (proj !== undefined && proj.family !== 'lgpl') {
    return `${candidate.id} cannot be combined with project license ${project?.id}: GPL-2.0-only and GPL-3.0 (including AGPL-3.0) are mutually incompatible.`;
  }
  return `${candidate.id} requires the combined work to be licensed under compatible GPL terms; the project license is not one.`;
}

function leafOutcome(candidate: LeafInfo, column: MatrixColumn, project: ProjectLeaf | undefined): Outcome {
  const cell = LICENSE_MATRIX[candidate.category][column];
  const notes: string[] = [];
  let verdict: VerdictKind;

  switch (cell) {
    case 'gpl_project': {
      const ok = candidate.gpl !== undefined && gplProjectCompatible(candidate.gpl, project?.gpl);
      verdict = ok ? 'compatible' : 'incompatible';
      if (!ok) notes.push(incompatibleGplNote(candidate, project));
      break;
    }
    case 'agpl_project': {
      const ok = project?.gpl?.family === 'agpl';
      verdict = ok ? 'compatible' : 'incompatible';
      if (!ok) {
        notes.push(`${candidate.id} requires the project to be AGPL as well.`);
        if (project?.gpl?.family === 'gpl' && project.gpl.major === 3) {
          notes.push(
            'GPL-3.0 projects may combine with AGPL-3.0 code (GPL-3.0 section 13), but the AGPL network clause then applies to the combination; this tool reports incompatible conservatively, so review manually.',
          );
        }
      }
      break;
    }
    default:
      verdict = cell;
  }

  if (
    verdict === 'compatible' &&
    column === 'distributed' &&
    candidate.id === 'Apache-2.0' &&
    isGplV2Only(project?.gpl)
  ) {
    verdict = 'incompatible';
    notes.push('Apache-2.0 is incompatible with GPL-2.0-only; the project would need GPL-2.0-or-later or GPL-3.0.');
  }

  if (verdict === 'conditional') {
    const why = CONDITION_NOTES[candidate.category]?.[column];
    if (why !== undefined) notes.push(why);
  }
  if (candidate.category === 'unknown') {
    notes.push(`License "${candidate.id}" is not in the classification table; treated as unknown.`);
  }
  if (candidate.exception !== undefined) {
    notes.push(
      `WITH ${candidate.exception}: the exception is not applied; judged by the base license ${candidate.id}. Verify the exception terms manually.`,
    );
  }

  return { category: candidate.category, verdict, obligations: obligationsFor(candidate), notes };
}

/**
 * Judges a candidate license against the project license and distribution.
 * OR expressions take the most favorable alternative (candidate and project
 * alike), AND the least favorable. Never throws.
 */
export function judge(input: JudgeInput): LicenseVerdict {
  const distribution = input.distribution ?? 'application';
  const column = matrixColumn(distribution);
  const candidate = parseExpression(input.candidate);
  const project = parseExpression(input.project);

  const preface: string[] = [];
  let projectNode: SpdxNode | undefined;
  switch (project.kind) {
    case 'ok':
      projectNode = project.node;
      preface.push(...project.notes);
      break;
    case 'empty':
      preface.push('Project license not specified; assumed permissive (non-copyleft).');
      break;
    case 'invalid':
      preface.push(
        `Project license "${project.text}" is not a valid SPDX expression; assumed non-copyleft (proprietary or permissive).`,
      );
      break;
  }

  let outcome: Outcome;
  switch (candidate.kind) {
    case 'ok': {
      preface.push(...candidate.notes);
      outcome = evalNode(candidate.node, (cn) => {
        const leaf = leafInfo(cn);
        if (projectNode === undefined) return leafOutcome(leaf, column, undefined);
        return evalNode(projectNode, (pn) => leafOutcome(leaf, column, projectLeaf(pn)));
      });
      break;
    }
    case 'empty':
      outcome = {
        category: 'unknown',
        verdict: 'unknown',
        obligations: [REVIEW_LICENSE_TEXT],
        notes: ['No license information (missing, NONE, or NOASSERTION); treated as unknown.'],
      };
      break;
    case 'invalid':
      outcome = {
        category: 'unknown',
        verdict: 'unknown',
        obligations: [REVIEW_LICENSE_TEXT],
        notes: [`"${candidate.text}" is not a valid SPDX expression; treated as unknown.`],
      };
      break;
  }

  return {
    candidate_spdx: candidate.kind === 'empty' ? null : candidate.text,
    project_spdx: project.kind === 'empty' ? null : project.text,
    distribution,
    category: outcome.category,
    verdict: outcome.verdict,
    obligations: unique(outcome.obligations),
    notes: unique([...preface, ...outcome.notes, NOT_LEGAL_ADVICE]),
    source: input.source,
  };
}
