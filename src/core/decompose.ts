/**
 * Decomposition support (docs/PLAN.md §3, §7.2): validates the agent's
 * component list and derives deterministic per-source search queries. The
 * semantic work of splitting a project into components is the agent's.
 */
import { soundsLikeMl } from './ml-terms.js';
import { codeSpan } from './sanitize.js';
import type {
  Component,
  Distribution,
  Ecosystem,
  LedgerEvent,
  ProjectInfo,
  Source,
} from '../types.js';

export const MAX_COMPONENTS = 30;
export const MAX_KEYWORDS = 8;
export const MAX_SUMMARY_CHARS = 1000;
export const MAX_DESCRIPTION_CHARS = 500;
/** Longest component name and keyword. */
export const MAX_NAME_CHARS = 200;
export const MAX_MARKETS = 10;
/** PLAN §10.3: a task should stay within this many components. */
export const RECOMMENDED_COMPONENTS = 10;
const MAX_NAME_HINTS = 5;
const MAX_GITHUB_KEYWORDS = 4;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MARKET_PATTERN = /^[A-Z]{2}$/;

export interface DecomposeProjectInput {
  name: string;
  summary: string;
  license?: string;
  /** Default `application`. */
  distribution?: Distribution;
  /** Default `[]`. */
  ecosystems?: Ecosystem[];
  /** Target markets: ISO 3166-1 alpha-2 codes in capitals, or `EU`. When omitted they are inferred from the project text, if possible. */
  markets?: string[];
}

export interface DecomposeComponentInput {
  id?: string;
  name: string;
  description: string;
  keywords: string[];
  ecosystem?: Ecosystem;
  kind?: Component['kind'];
  parent_id?: string;
  trivial?: boolean;
}

export interface DecomposeInput {
  project: DecomposeProjectInput;
  components: DecomposeComponentInput[];
  /** true: the list replaces the component set; false (default): upsert. */
  replace?: boolean;
}

/** Target markets of a decomposition and where they come from (`none`: neither given nor inferable). */
export interface MarketsResolution {
  codes: string[];
  source: 'input' | 'inferred' | 'none';
}

/** Optional project fields that an omitted input inherits from the ledger's latest project. */
export type InheritedProjectField = 'license' | 'distribution' | 'ecosystems' | 'markets';

export interface DecomposeValidation {
  errors: string[];
  warnings: string[];
  markets: MarketsResolution;
  /** Project fields that were omitted in the input and kept from the existing project (only those the existing project has). */
  inherited: InheritedProjectField[];
  /** Normalized project info (set even when `errors` is non-empty, if the project itself is valid). */
  project?: ProjectInfo;
  /** Normalized components with ids assigned. Empty when `errors` is non-empty. */
  components: Component[];
  /**
   * Existing component ids absent from the input when `replace` is true. The
   * ledger has no component-removal event, so they stay in the ledger.
   */
  superseded: string[];
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug === '' ? 'component' : slug;
}

/**
 * Markets the project text points at: Hangul or the words Korea/한국 mean `KR`;
 * kana or the words Japan/일본 mean `JP`. A guess from the language of the text,
 * reported as `inferred` so the agent can confirm or correct it.
 */
export function inferMarkets(text: string): string[] {
  const markets: string[] = [];
  if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(text) || /\bkorea(?:n)?\b/i.test(text)) markets.push('KR');
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text) || /\bjapan(?:ese)?\b/i.test(text) || text.includes('일본')) markets.push('JP');
  return markets;
}

function cleanKeywords(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of raw) {
    const kw = k.trim();
    if (kw === '' || seen.has(kw.toLowerCase())) continue;
    seen.add(kw.toLowerCase());
    out.push(kw);
  }
  return out;
}

/**
 * Validates and normalizes a decomposition. Components without an explicit id
 * get a slug of their name; a slug equal to an existing component id upserts
 * that component (so repeating a decompose is idempotent), and a slug already
 * used in this batch gets a numeric suffix. Existing components keep their
 * status when upserted. An optional project field that is omitted (license,
 * distribution, ecosystems, markets) keeps the value of the existing project, so
 * a second call that only adds components does not reset them; a field that is
 * given replaces it, `replace` or not. Without `project.markets` the markets of
 * the existing project are kept when the agent gave them; otherwise they are
 * inferred from the project text (`inferMarkets`), and when that text yields
 * nothing the earlier markets (inferred ones included) are kept.
 */
export function validateDecompose(
  input: DecomposeInput,
  existing: readonly Component[] = [],
  existingProject?: ProjectInfo,
): DecomposeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = input.project.name.trim();
  const summary = input.project.summary.trim();
  if (name === '') errors.push('project.name must not be empty.');
  if (summary === '') errors.push('project.summary must not be empty.');
  if (summary.length > MAX_SUMMARY_CHARS) {
    errors.push(`project.summary is ${summary.length} chars; the limit is ${MAX_SUMMARY_CHARS}.`);
  }

  const inherited: InheritedProjectField[] = [];
  if (input.project.ecosystems === undefined && existingProject !== undefined && existingProject.ecosystems.length > 0) {
    inherited.push('ecosystems');
  }
  const ecosystems = [...new Set(input.project.ecosystems ?? existingProject?.ecosystems ?? [])];
  if (input.project.license === undefined && existingProject?.license !== undefined) inherited.push('license');
  const license = (input.project.license ?? existingProject?.license)?.trim();
  if (input.project.distribution === undefined && existingProject !== undefined) inherited.push('distribution');

  let markets: MarketsResolution = { codes: [], source: 'none' };
  if (input.project.markets !== undefined) {
    const codes = [...new Set(input.project.markets.map((m) => m.trim()))];
    const bad = codes.filter((m) => !MARKET_PATTERN.test(m));
    if (bad.length > 0) {
      errors.push(
        `project.markets: ${bad.map((m) => codeSpan(m, 32)).join(', ')} must be an ISO 3166-1 alpha-2 country code in capital letters (e.g. "KR", "US") or "EU".`,
      );
    }
    if (codes.length < 1 || codes.length > MAX_MARKETS) {
      errors.push(`project.markets needs 1-${MAX_MARKETS} distinct codes (got ${codes.length}).`);
    }
    markets = { codes, source: 'input' };
  } else if (existingProject?.markets !== undefined && existingProject.markets_source === 'input') {
    markets = { codes: existingProject.markets, source: 'input' };
    inherited.push('markets');
  } else {
    const text = [name, summary, ...input.components.flatMap((c) => [c.name, c.description])].join(' ');
    const inferred = inferMarkets(text);
    if (inferred.length > 0) {
      markets = { codes: inferred, source: 'inferred' };
    } else if (existingProject?.markets !== undefined) {
      // Nothing new is inferred from this call's text (a follow-up call that only adds components often has none):
      // the markets recorded earlier stay, inferred ones and values from older ledgers without a source included.
      markets = { codes: existingProject.markets, source: existingProject.markets_source ?? 'input' };
      inherited.push('markets');
    }
  }

  const project: ProjectInfo = {
    name,
    summary,
    distribution: input.project.distribution ?? existingProject?.distribution ?? 'application',
    ecosystems,
    ...(license ? { license } : {}),
    ...(markets.source !== 'none' ? { markets: markets.codes, markets_source: markets.source } : {}),
  };

  const items = input.components;
  if (items.length < 1) errors.push('components must contain at least 1 entry.');
  if (items.length > MAX_COMPONENTS) {
    errors.push(`components has ${items.length} entries; the limit is ${MAX_COMPONENTS}. Merge related components.`);
  }

  // Pass 1: explicit ids.
  const used = new Set<string>();
  items.forEach((c, i) => {
    if (c.id === undefined) return;
    const label = `components[${i}] (${codeSpan(c.name, 100)})`;
    if (!ID_PATTERN.test(c.id)) {
      errors.push(`${label}: id ${codeSpan(c.id, 64)} must match ${ID_PATTERN.source}.`);
    } else if (used.has(c.id)) {
      errors.push(`${label}: duplicate id ${codeSpan(c.id, 64)}.`);
    }
    used.add(c.id);
  });

  // Pass 2: assign ids to the rest, then normalize.
  const existingById = new Map(existing.map((c) => [c.id, c]));
  const normalized: Component[] = [];
  items.forEach((c, i) => {
    const label = `components[${i}] (${codeSpan(c.name, 100)})`;
    let id = c.id;
    if (id === undefined) {
      const base = slugify(c.name);
      id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
    }

    const cname = c.name.trim();
    const description = c.description.trim();
    const keywords = cleanKeywords(c.keywords);
    if (cname === '') errors.push(`${label}: name must not be empty.`);
    if (description === '') errors.push(`${label}: description must not be empty.`);
    if (description.length > MAX_DESCRIPTION_CHARS) {
      errors.push(`${label}: description is ${description.length} chars; the limit is ${MAX_DESCRIPTION_CHARS}.`);
    }
    if (keywords.length < 1) errors.push(`${label}: keywords needs at least 1 non-empty entry.`);
    if (keywords.length > MAX_KEYWORDS) {
      errors.push(`${label}: keywords has ${keywords.length} entries; the limit is ${MAX_KEYWORDS}.`);
    }

    const component: Component = {
      id,
      name: cname,
      description,
      keywords,
      status: existingById.get(id)?.status ?? 'pending',
    };
    if (c.ecosystem !== undefined) component.ecosystem = c.ecosystem;
    if (c.kind !== undefined) component.kind = c.kind;
    if (c.parent_id !== undefined) component.parent_id = c.parent_id;
    if (c.trivial !== undefined) component.trivial = c.trivial;
    normalized.push(component);
  });

  // Parent references and cycles.
  const parentOf = new Map<string, string | undefined>();
  if (input.replace !== true) for (const c of existing) parentOf.set(c.id, c.parent_id);
  for (const c of normalized) parentOf.set(c.id, c.parent_id);
  for (const c of normalized) {
    if (c.parent_id === undefined) continue;
    if (c.parent_id === c.id) {
      errors.push(`component ${codeSpan(c.id, 64)}: parent_id must not reference itself.`);
    } else if (!parentOf.has(c.parent_id)) {
      errors.push(`component ${codeSpan(c.id, 64)}: parent_id ${codeSpan(c.parent_id, 64)} does not match any component id.`);
    }
  }
  for (const c of normalized) {
    const seen = new Set<string>([c.id]);
    let cursor = parentOf.get(c.id);
    while (cursor !== undefined && cursor !== c.id) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
    if (cursor === c.id && c.parent_id !== c.id) {
      errors.push(`component ${codeSpan(c.id, 64)}: parent_id chain forms a cycle.`);
    }
  }

  const superseded: string[] = [];
  if (input.replace === true) {
    const keep = new Set(normalized.map((c) => c.id));
    for (const c of existing) if (!keep.has(c.id)) superseded.push(c.id);
    if (superseded.length > 0) {
      warnings.push(
        `replace=true: ${superseded.length} existing component(s) are not in the new list (${superseded.map((id) => codeSpan(id, 64)).join(', ')}); the ledger is append-only, so they remain recorded.`,
      );
    }
  }

  const total = new Set([...(input.replace === true ? [] : existing.map((c) => c.id)), ...normalized.map((c) => c.id)]).size;
  if (total > RECOMMENDED_COMPONENTS) {
    warnings.push(
      `${total} components exceed the recommended ${RECOMMENDED_COMPONENTS} per task; consider merging or marking small ones trivial.`,
    );
  }
  if (ecosystems.length === 0 && normalized.every((c) => c.ecosystem === undefined)) {
    warnings.push('no ecosystem given for the project or any component; only github_repo will be searched. Set project.ecosystems (e.g. ["npm"]).');
  }
  if (markets.source === 'none') {
    warnings.push('no target market given or inferable from the project text; legal and store rules differ per country. Set project.markets (e.g. ["KR"] or ["US", "EU"]).');
  }

  return {
    errors,
    warnings,
    markets,
    inherited,
    ...(name !== '' && summary !== '' ? { project } : {}),

    components: errors.length === 0 ? normalized : [],
    superseded,
  };
}

/** `project.set` followed by one `component.upsert` per component. */
export function buildDecomposeEvents(
  project: ProjectInfo,
  components: readonly Component[],
  now: Date,
): LedgerEvent[] {
  const at = now.toISOString();
  return [
    { v: 1, type: 'project.set', at, project },
    ...components.map((component): LedgerEvent => ({ v: 1, type: 'component.upsert', at, component })),
  ];
}

// ---------------------------------------------------------------------------
// Search plan
// ---------------------------------------------------------------------------

export interface PlannedQuery {
  source: Source;
  query: string;
  params?: { nameHints?: string[] };
}

export interface SearchPlanItem {
  component_id: string;
  queries: PlannedQuery[];
  skip_reason?: 'trivial';
}

export interface SearchPlanOptions {
  /** When given, queries for other sources are left out (e.g. `config.sources`). */
  enabledSources?: readonly Source[];
}

/** PLAN §8: ecosystem -> GitHub language qualifier. npm/other are language-agnostic (JS or TS). */
const GITHUB_LANGUAGE: Partial<Record<Ecosystem, string>> = {
  pypi: 'Python',
  cargo: 'Rust',
  go: 'Go',
  maven: 'Java',
  nuget: 'C#',
};

function githubLanguage(ecosystems: readonly Ecosystem[]): string | undefined {
  if (ecosystems.length === 0) return undefined;
  if (ecosystems.some((e) => GITHUB_LANGUAGE[e] === undefined)) return undefined;
  const languages = new Set(ecosystems.map((e) => GITHUB_LANGUAGE[e]));
  if (languages.size !== 1) return undefined;
  return [...languages][0];
}

function kebab(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Single keywords and adjacent 2-grams in kebab-case, deduplicated, at most 5 (2-grams first). */
export function pypiNameHints(keywords: readonly string[]): string[] {
  const words = keywords.map(kebab).filter((k) => k !== '');
  const hints: string[] = [];
  const push = (h: string): void => {
    if (h !== '' && !hints.includes(h)) hints.push(h);
  };
  for (let i = 0; i + 1 < words.length; i++) push(`${words[i]}-${words[i + 1]}`);
  for (const w of words) push(w);
  return hints.slice(0, MAX_NAME_HINTS);
}

function mentionsMcp(component: Component, ecosystems: readonly string[]): boolean {
  if (component.kind === 'tool') return true;
  if (ecosystems.includes('mcp')) return true;
  return component.keywords.some((k) => k.toLowerCase().split(/[^a-z0-9]+/).includes('mcp'));
}

/** Deterministic queries for one component (PLAN §7.2). `github_code` is never planned. */
export function planComponent(
  component: Component,
  projectEcosystems: readonly Ecosystem[],
  opts: SearchPlanOptions = {},
): SearchPlanItem {
  if (component.trivial === true) {
    return { component_id: component.id, queries: [], skip_reason: 'trivial' };
  }
  const ecosystems: readonly Ecosystem[] =
    component.ecosystem !== undefined ? [component.ecosystem] : projectEcosystems;
  const keywords = cleanKeywords(component.keywords);
  const queries: PlannedQuery[] = [];

  if (keywords.length > 0) {
    const language = githubLanguage(ecosystems);
    const github = [keywords.slice(0, MAX_GITHUB_KEYWORDS).join(' '), 'archived:false', 'fork:false'];
    if (language !== undefined) github.push(`language:${language}`);
    queries.push({ source: 'github_repo', query: github.join(' ') });

    if (ecosystems.includes('npm')) queries.push({ source: 'npm', query: keywords.join(' ') });
    if (ecosystems.includes('pypi')) {
      queries.push({
        source: 'pypi',
        query: keywords.join(' '),
        params: { nameHints: pypiNameHints(keywords) },
      });
    }
    if (mentionsMcp(component, projectEcosystems)) {
      queries.push({ source: 'mcp_registry', query: keywords.join(' ') });
    }
    // Pretrained weights are published on Hugging Face, not in a package registry.
    if (soundsLikeMl(`${component.name} ${component.description} ${keywords.join(' ')}`, 'any')) {
      queries.push({ source: 'hf_models', query: keywords.slice(0, MAX_GITHUB_KEYWORDS).join(' ') });
    }
  }

  const enabled = opts.enabledSources;
  return {
    component_id: component.id,
    queries: enabled ? queries.filter((q) => enabled.includes(q.source)) : queries,
  };
}

export function buildSearchPlan(
  project: Pick<ProjectInfo, 'ecosystems'>,
  components: readonly Component[],
  opts: SearchPlanOptions = {},
): SearchPlanItem[] {
  return components.map((c) => planComponent(c, project.ecosystems, opts));
}
