/**
 * Search budget (docs/PLAN.md §7.3, §10.3). Usage is derived from the ledger,
 * per component, so the budget survives server restarts:
 *   rounds = `search` evidence entries, evals = distinct evaluated refs,
 *   web    = `web` evidence entries.
 * Evidence recorded for a cross-cutting concern (`concern` set) is not part of
 * a component's budget; each concern has its own web allowance of `budget.web`
 * (`concernWebUsage`, warning only); `legal_privacy` gets it once per target market
 * (`concernWebLimit`), because every market has its own laws to look up.
 * Going past the limit only warns; going past `hard_limit` (2x) is refused
 * unless the caller supplies `force` together with a `force_reason`.
 */
import type { Concern, Config, LedgerState } from '../types.js';

export type BudgetResource = 'rounds' | 'evals' | 'web';
export type BudgetLimits = Config['budget'];
export type BudgetUsage = Record<BudgetResource, number>;

export const HARD_LIMIT_FACTOR = 2;

export interface BudgetCheck {
  resource: BudgetResource;
  /** False when `used + adding` would pass the hard limit and the call is not forced. */
  allowed: boolean;
  used: number;
  limit: number;
  hard_limit: number;
  /** Units left before the soft limit (never negative). */
  remaining: number;
  warning?: string;
  /** Agent-actionable sentence; set only when `allowed` is false. */
  error?: string;
}

export function hardLimit(limit: number): number {
  return limit * HARD_LIMIT_FACTOR;
}

export function usageFor(state: LedgerState, componentId: string): BudgetUsage {
  let rounds = 0;
  let web = 0;
  for (const ev of state.evidence) {
    if (ev.component_id !== componentId || ev.concern !== undefined) continue;
    if (ev.kind === 'search') rounds++;
    else if (ev.kind === 'web') web++;
  }
  const evals = new Set<string>();
  for (const e of state.evaluations) {
    if (e.component_id === componentId) evals.add(e.ref);
  }
  return { rounds, evals: evals.size, web };
}

/** Web evidence already recorded for one cross-cutting concern. */
export function concernWebUsage(state: LedgerState, concern: Concern): number {
  return state.evidence.filter((ev) => ev.kind === 'web' && ev.concern === concern).length;
}

/** Web queries allowed for one cross-cutting concern: `webBudget`, times the number of target markets (at least 1) for `legal_privacy`. */
export function concernWebLimit(state: Pick<LedgerState, 'project'>, concern: Concern, webBudget: number): number {
  return concern === 'legal_privacy' ? webBudget * Math.max(1, state.project?.markets?.length ?? 0) : webBudget;
}

export interface CheckBudgetOptions {
  /** Units this call would consume (default 1; for evals, the number of new refs). */
  adding?: number;
  force?: boolean;
  force_reason?: string;
}

const LABEL: Record<BudgetResource, string> = {
  rounds: 'search rounds',
  evals: 'evaluated candidates',
  web: 'web queries',
};

export function checkBudget(
  state: LedgerState,
  componentId: string,
  limits: BudgetLimits,
  resource: BudgetResource,
  opts: CheckBudgetOptions = {},
): BudgetCheck {
  const adding = opts.adding ?? 1;
  const used = usageFor(state, componentId)[resource];
  const limit = limits[resource];
  const hard = hardLimit(limit);
  const after = used + adding;
  const check: BudgetCheck = {
    resource,
    allowed: true,
    used,
    limit,
    hard_limit: hard,
    remaining: Math.max(0, limit - used),
  };
  const label = LABEL[resource];

  // Nothing new is consumed (re-evaluating refs that are already evaluated): this is the documented way out of an
  // exhausted budget, so it is neither blocked nor warned about, whatever has been used so far.
  if (adding === 0) return check;
  if (after > hard) {
    const reason = opts.force_reason?.trim() ?? '';
    if (opts.force === true && reason !== '') {
      check.warning = `hard limit exceeded (${used}/${limit} ${label} used, hard limit ${hard}); proceeding because force_reason was given: ${reason}`;
      return check;
    }
    check.allowed = false;
    check.error =
      opts.force === true
        ? `${label} for component "${componentId}" reached the hard limit (${used}/${limit}, hard ${hard}); force requires a non-empty force_reason.`
        : `${label} for component "${componentId}" reached the hard limit (${used}/${limit}, hard ${hard}). Decide with the evidence you have (rw_decide), or pass force=true with force_reason to continue.`;
    return check;
  }
  if (after > limit) {
    check.warning = `${label} budget exceeded for component "${componentId}" (${used}/${limit} used, hard limit ${hard}); stop searching and decide with the evidence you have.`;
  }
  return check;
}

/** Shape of `rw_search` output field `budget` (PLAN §7.3). */
export interface SearchBudgetReport {
  rounds_used: number;
  rounds_limit: number;
  hard_limit: number;
  warning?: string;
}

export function checkSearchBudget(
  state: LedgerState,
  componentId: string,
  limits: BudgetLimits,
  opts: Omit<CheckBudgetOptions, 'adding'> = {},
): { allowed: boolean; error?: string; budget: SearchBudgetReport } {
  const check = checkBudget(state, componentId, limits, 'rounds', opts);
  const budget: SearchBudgetReport = {
    rounds_used: check.used,
    rounds_limit: check.limit,
    hard_limit: check.hard_limit,
    ...(check.warning !== undefined ? { warning: check.warning } : {}),
  };
  return {
    allowed: check.allowed,
    ...(check.error !== undefined ? { error: check.error } : {}),
    budget,
  };
}

export function budgetSummary(
  state: LedgerState,
  componentId: string,
  limits: BudgetLimits,
): Record<BudgetResource, { used: number; limit: number; hard_limit: number }> {
  const usage = usageFor(state, componentId);
  const entry = (r: BudgetResource): { used: number; limit: number; hard_limit: number } => ({
    used: usage[r],
    limit: limits[r],
    hard_limit: hardLimit(limits[r]),
  });
  return { rounds: entry('rounds'), evals: entry('evals'), web: entry('web') };
}
