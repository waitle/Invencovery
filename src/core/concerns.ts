/**
 * Cross-cutting concerns (docs/PLAN.md §3, §7.2): topics that package research
 * never reveals but that decide whether a project can ship: what it costs to
 * run, whether the store or platform allows it, privacy and legal duties,
 * operations and security. `rw_decompose` returns a checklist; the agent
 * investigates each concern on the web and records the result with
 * `rw_record_evidence(concern=...)`; `rw_status` and `rw_ledger` report which
 * concerns have evidence and which have none.
 *
 * Laws and store rules differ per country, so `legal_privacy` and
 * `distribution_policy` also get market-specific questions for the project's
 * target markets (`project.markets`), and `legal_privacy` coverage is tracked per
 * market. Evidence tagged with a market counts for `legal_privacy` when the project
 * has target markets, but not for `distribution_policy`, whose store rules are
 * worldwide: a country's rule alone leaves it unchecked.
 *
 * Pure and deterministic. The checklist text is ours (static), never derived
 * from the task text; only the relevance decision reads the task text.
 */
import { CONCERNS } from '../types.js';
import type { Concern, Distribution, Evidence, LedgerState, ProjectInfo } from '../types.js';

export interface ConcernSpec {
  concern: Concern;
  /** What to find out. Static text. */
  questions: string[];
  /** Web search starting points. Static text; the agent adds product names. */
  search_hints: string[];
  /** Latin terms match whole words, others as substrings; the task text is searched case-insensitively. */
  triggers: string[];
  /** Distributions for which the concern applies even without a keyword. */
  distributions: Distribution[];
}

export const CONCERN_SPECS: readonly ConcernSpec[] = [
  {
    concern: 'cost',
    questions: [
      'What do the paid services and APIs this project calls cost at the expected usage (free tier limits, per-request or per-seat pricing)?',
      'Which cost grows with usage (LLM tokens, storage, bandwidth, SMS, maps), and what is a realistic monthly figure?',
    ],
    search_hints: ['<service> pricing free tier limits', '<service> pricing per request overage'],
    triggers: [
      'api',
      'cloud',
      'hosting',
      'gpu',
      'llm',
      'saas',
      'subscription',
      'pricing',
      'storage',
      'bandwidth',
      'sms',
      'maps',
      'payment',
      'paid',
      '비용',
      '요금',
      '과금',
      '클라우드',
      '호스팅',
      '결제',
      '유료',
    ],
    distributions: ['saas'],
  },
  {
    concern: 'distribution_policy',
    questions: [
      'Which store, marketplace or platform will distribute this (app store, browser extension store, package registry, hosting provider), and what are its review rules and restricted features?',
      'Do those rules limit anything this project needs (background execution, permissions, payments, remote code, content)?',
      'If users can see or exchange user-generated or AI-generated content, what reporting, blocking and moderation requirements do the store rules impose (for example Apple App Review guideline 1.2 on user-generated content)?',
      'What disclosure and consent does the store require before personal data, including voice, is sent to a third-party AI service (for example App Store Review Guideline 5.1.2)?',
      'Which payment methods do the store rules require for subscriptions and digital goods (for example App Store Review Guideline 3.1.1, Google Play Billing)?',
    ],
    search_hints: [
      '<platform> review guidelines restricted',
      '<platform> developer policy requirements',
      '<platform> user-generated content reporting blocking requirements',
      '<platform> review guidelines 5.1.2 personal data third-party AI disclosure consent',
      '<platform> in-app purchase subscription billing requirements (App Store 3.1.1, Google Play Billing)',
    ],
    triggers: [
      'app store',
      'play store',
      'ios',
      'android',
      'mobile',
      'electron',
      'desktop',
      'extension',
      'marketplace',
      'plugin',
      'steam',
      'widget',
      '앱스토어',
      '플레이스토어',
      '모바일',
      '심사',
      '확장 프로그램',
      '확장프로그램',
      '데스크톱',
    ],
    distributions: ['application'],
  },
  {
    concern: 'legal_privacy',
    questions: [
      'Does the project handle personal data (accounts, location, voice, images, analytics) and which privacy law or consent duty applies (GDPR, CCPA, local law)?',
      'Do any data sources, models or services restrict the intended use through their terms (scraping, commercial use, retention, data sent to a vendor)?',
    ],
    search_hints: ['<data type> privacy consent requirements', '<service> terms of service commercial use data retention'],
    triggers: [
      'personal data',
      'pii',
      'privacy',
      'gdpr',
      'ccpa',
      'analytics',
      'tracking',
      'camera',
      'microphone',
      'location',
      'biometric',
      'health',
      'children',
      'login',
      'email',
      'recording',
      'voice',
      'audio',
      'face',
      'scraping',
      '개인정보',
      '동의',
      '약관',
      '저작권',
      '위치',
      '녹음',
      '마이크',
      '카메라',
      '얼굴',
      '로그인',
      '음성',
    ],
    distributions: ['saas'],
  },
  {
    concern: 'operations',
    questions: [
      'What has to run in production (servers, database, queues, schedulers) and who operates it (deploy, monitoring, backups, upgrades)?',
      'What limits apply (rate limits, quotas, cold starts, regions, uptime guarantees) and what happens when a dependency is down?',
    ],
    search_hints: ['<service> rate limits quotas', '<service> uptime SLA status incidents'],
    triggers: [
      'deploy',
      'server',
      'database',
      'queue',
      'cron',
      'scheduler',
      'monitoring',
      'uptime',
      'scaling',
      'backup',
      'migration',
      'realtime',
      'real-time',
      'websocket',
      'sync',
      'offline',
      'docker',
      'kubernetes',
      '배포',
      '운영',
      '서버',
      '모니터링',
      '백업',
      '동기화',
      '실시간',
    ],
    distributions: ['saas', 'internal'],
  },
  {
    concern: 'security',
    questions: [
      'How are users authenticated and authorized, and where are secrets and tokens kept?',
      'What untrusted input does the project accept (uploads, URLs, plugins, user-supplied code or prompts) and what is the known attack surface of the chosen dependencies?',
    ],
    search_hints: ['<library> security advisories vulnerabilities', '<service> security best practices authentication'],
    triggers: [
      'auth',
      'login',
      'password',
      'token',
      'oauth',
      'encryption',
      'secret',
      'api key',
      'upload',
      'payment',
      'admin',
      'permission',
      'sandbox',
      'execute',
      'plugin',
      '인증',
      '로그인',
      '암호',
      '권한',
      '업로드',
      '결제',
      '보안',
      '비밀',
    ],
    distributions: ['saas'],
  },
];

/** Investigation questions for one market, per concern. Questions to research, not legal conclusions. */
interface MarketQuestions {
  legal_privacy: string[];
  distribution_policy: string[];
}

/** Markets with their own questions; any other code gets the generic questions of `marketQuestions`. */
export const MARKET_QUESTIONS: Readonly<Record<string, MarketQuestions>> = {
  KR: {
    legal_privacy: [
      'Does the Korean AI Basic Act (AI 기본법) impose notice or labeling duties for AI-generated output or AI interaction, and does this product fall under them?',
      'Under the Personal Information Protection Act (개인정보 보호법), what consent and notice apply when personal data, including voice, is transferred abroad (for example to overseas vendor servers)?',
      'What consent or notice is required to record or transcribe calls or voice in Korea?',
    ],
    distribution_policy: [
      'Do Korean app market rules on in-app payment and billing limit how this product may be sold or billed?',
    ],
  },
  US: {
    legal_privacy: [
      'Which US state call-recording consent laws (one-party or all-party consent) apply to recording or transcribing calls?',
      'If children can use the product, do the US rules on online privacy of children (COPPA) apply?',
      'Do state privacy laws such as CCPA apply (notice, opt-out, data sale or sharing)?',
    ],
    distribution_policy: [
      'Do the store rules on external payment links and subscription billing in the US limit how this product may be sold?',
    ],
  },
  EU: {
    legal_privacy: [
      'What GDPR legal basis covers the processing, and does voice or other biometric data raise special-category duties?',
      'Do the EU AI Act transparency obligations (telling people they interact with AI, labeling synthetic content) apply to this product?',
    ],
    distribution_policy: [
      'Do EU rules on alternative app distribution and billing change how this product is distributed or sold?',
    ],
  },
  JP: {
    legal_privacy: [
      'Under the Act on the Protection of Personal Information (APPI), what consent and notice apply when personal data is transferred abroad, and which purposes must be disclosed?',
    ],
    distribution_policy: [
      'Do Japanese app store and billing rules limit how this product may be sold or billed?',
    ],
  },
};

function marketQuestions(code: string): MarketQuestions {
  return (
    MARKET_QUESTIONS[code] ?? {
      legal_privacy: [`What personal-data, AI and consumer-protection rules of ${code} apply to this product?`],
      distribution_policy: [`Do app store or marketplace rules that apply in ${code} limit the features or billing of this product?`],
    }
  );
}

export interface ConcernChecklistItem {
  concern: Concern;
  /** `likely`: the task text or distribution points at it. `consider`: no sign; check it, or record why it does not apply. */
  relevance: 'likely' | 'consider';
  /** Why `likely` (our own trigger terms or the distribution); empty for `consider`. */
  reason: string;
  questions: string[];
  search_hints: string[];
}

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
}

function hasTrigger(normalized: string, term: string): boolean {
  // Terms with letters outside ASCII (Korean) attach particles to the stem: match them as substrings.
  if (/[^\x00-\x7f]/.test(term)) return normalized.includes(term);
  return normalized.includes(` ${term.replace(/[^a-z0-9]+/g, ' ')} `);
}

/**
 * One item per concern, `likely` first. `text` is the project summary plus the
 * component names, descriptions and keywords.
 */
export function buildConcernsChecklist(
  text: string,
  distribution: Distribution,
  markets: readonly string[] = [],
): ConcernChecklistItem[] {
  const normalized = normalize(text);
  const items = CONCERN_SPECS.map((spec): ConcernChecklistItem => {
    const matched = spec.triggers.filter((t) => hasTrigger(normalized, t)).slice(0, 4);
    const byDistribution = spec.distributions.includes(distribution);
    const reasons: string[] = [];
    if (matched.length > 0) reasons.push(`task mentions ${matched.join(', ')}`);
    if (byDistribution) reasons.push(`distribution is ${distribution}`);
    // Market questions follow the generic ones, each prefixed with its market code.
    const marketConcern = spec.concern === 'legal_privacy' || spec.concern === 'distribution_policy' ? spec.concern : undefined;
    const perMarket =
      marketConcern === undefined
        ? []
        : markets.flatMap((code) => marketQuestions(code)[marketConcern].map((q) => `[${code}] ${q}`));
    return {
      concern: spec.concern,
      relevance: reasons.length > 0 ? 'likely' : 'consider',
      reason: reasons.join('; '),
      questions: [...spec.questions, ...perMarket],
      search_hints: spec.search_hints,
    };
  });
  return [...items.filter((i) => i.relevance === 'likely'), ...items.filter((i) => i.relevance === 'consider')];
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface MarketCoverage {
  code: string;
  checked: boolean;
  evidence_count: number;
}

export interface ConcernCoverage {
  concern: Concern;
  checked: boolean;
  /** Evidence ids tagged with this concern, oldest first. */
  evidence_ids: string[];
  /** `legal_privacy` only, when the project has target markets: evidence tagged with each market. */
  markets?: MarketCoverage[];
  /** `distribution_policy` only: not checked, because all its evidence is tagged with a market (store rules are worldwide, a market tag covers one country's rule). */
  market_only?: true;
}

/** What coverage needs of the ledger state. */
type CoverageState = Pick<LedgerState, 'evidence'> & { project?: Pick<ProjectInfo, 'markets'> | undefined };

/** Evidence that was recorded for a cross-cutting concern (not for a component's candidate search). */
export function concernEvidence(evidence: readonly Evidence[]): Evidence[] {
  return evidence.filter((e) => e.concern !== undefined);
}

export function concernCoverage(state: CoverageState): ConcernCoverage[] {
  const markets = state.project?.markets ?? [];
  return CONCERNS.map((concern) => {
    const own = state.evidence.filter((e) => e.concern === concern);
    const ids = own.map((e) => e.id);
    const general = own.filter((e) => e.market === undefined).length;
    // Laws differ per country: with target markets `legal_privacy` needs evidence tagged with every one of them
    // (a tag of a country that is not a target market counts for nothing).
    // Store rules mostly apply worldwide: `distribution_policy` needs evidence that is not tied to one market.
    let checked = ids.length > 0;
    if (concern === 'distribution_policy') checked = general > 0;
    else if (concern === 'legal_privacy' && markets.length > 0) checked = markets.every((code) => own.some((e) => e.market === code));
    const coverage: ConcernCoverage = { concern, checked, evidence_ids: ids };
    if (concern === 'distribution_policy' && !checked && ids.length > 0) coverage.market_only = true;
    if (concern === 'legal_privacy' && markets.length > 0) {
      coverage.markets = markets.map((code) => {
        const count = state.evidence.filter((e) => e.concern === concern && e.market === code).length;
        return { code, checked: count > 0, evidence_count: count };
      });
    }
    return coverage;
  });
}

/**
 * `cross-cutting concern not checked: <concern>` for every concern not checked
 * (see `concernCoverage`), once at least one decision exists, with
 * ` (only market-specific evidence)` when `distribution_policy` has only
 * market-tagged evidence; and
 * `cross-cutting concern not checked for market <code>: legal_privacy` for every
 * target market without legal_privacy evidence tagged with it. Warnings only: a
 * concern may genuinely not apply, but then the agent records that, with its reason.
 */
export function concernWarnings(state: CoverageState & Pick<LedgerState, 'decisions'>): string[] {
  if (state.decisions.length === 0) return [];
  const coverage = concernCoverage(state);
  return [
    ...coverage
      // With target markets the per-market warnings below say which market is missing; the general one would only repeat them.
      .filter((c) => !c.checked && c.markets === undefined)
      .map((c) => `cross-cutting concern not checked: ${c.concern}${c.market_only === true ? ' (only market-specific evidence)' : ''}`),
    ...coverage.flatMap((c) =>
      (c.markets ?? []).filter((m) => !m.checked).map((m) => `cross-cutting concern not checked for market ${m.code}: ${c.concern}`),
    ),
  ];
}
