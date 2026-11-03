/**
 * Hosted services behind a client library (docs/PLAN.md §7.4 "Hosted services").
 *
 * An SDK or plugin for a hosted service is open source, but using it means
 * accepting the service's terms: the real decision is the service. This module
 * holds the pure parts of that rule:
 *
 * - `serviceTermsGaps`: whether the latest evaluation of a service (`saas:` ref)
 *   has its terms read on the vendor's own pages;
 * - `serviceClientSignals`: a heuristic for "this package looks like a client
 *   of a hosted service" (a warning only, like `core/ml-terms.ts`);
 * - `upstreamProviderSignals`: a heuristic for "this package is an LLM gateway,
 *   proxy or router": it routes to model providers that are a decision of their
 *   own (a warning only);
 * - `serviceUsageGaps` / `serviceWarnings`: decided adopt/extend candidates whose
 *   service or upstream provider was not evaluated, and decided services whose
 *   data-use policy the vendor does not state, for the report and the warnings
 *   of rw_ledger and rw_status.
 *
 * Pure and deterministic.
 */
import { softLine } from './sanitize.js';
import type { DecisionKind, Evaluation, LedgerState } from '../types.js';

/** Flags that keep a hosted service at `reference` until its terms are read on the vendor's own pages. */
export const SAAS_TERMS_GATE_FLAGS: readonly string[] = ['saas_terms_unverified', 'saas_evidence_missing', 'saas_terms_secondhand'];

/**
 * Why the terms of a service are not confirmed: `['not evaluated']` without an
 * evaluation, otherwise the gate flags it carries; empty when they are confirmed.
 */
export function serviceTermsGaps(service: Pick<Evaluation, 'flags'> | undefined): string[] {
  if (service === undefined) return ['not evaluated'];
  return service.flags.filter((f) => SAAS_TERMS_GATE_FLAGS.includes(f));
}

// ---------------------------------------------------------------------------
// Heuristic: does this package look like a client of a hosted service?
// ---------------------------------------------------------------------------

/** Token sequences of vendors that only exist as a hosted service. Matched in the package name, not in free text. */
const VENDOR_TOKENS: ReadonlyArray<readonly string[]> = [
  ['openai'],
  ['anthropic'],
  ['elevenlabs'],
  ['deepgram'],
  ['cartesia'],
  ['assemblyai'],
  ['revenuecat'],
  ['firebase'],
  ['twilio'],
  ['stripe'],
  ['sendgrid'],
  ['algolia'],
  ['pinecone'],
  ['google', 'cloud'],
];

/** Descriptions that call the package a client of someone's API. Gaps are bounded so the patterns stay linear. */
const CLIENT_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'official … sdk/client', re: /\bofficial\b[^.\n]{0,60}?\b(?:sdk|client)\b/ },
  { label: 'api client for', re: /\bapi clients? for\b/ },
  { label: 'sdk/client library/plugin for … api/service', re: /\b(?:sdk|client library|plugin)s? for\b[^.\n]{0,80}?\b(?:api|apis|service|cloud|platform|saas)\b/ },
  { label: 'wrapper for … api', re: /\bwrapper (?:for|around)\b[^.\n]{0,60}?\bapi\b/ },
];

const MAX_DESCRIPTOR_CHARS = 2000;

function hasSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  for (let i = 0; i + sequence.length <= tokens.length; i++) {
    if (sequence.every((t, j) => tokens[i + j] === t)) return true;
  }
  return false;
}

/**
 * Signals that a github/npm/pypi/mcp package is a client or plugin of a hosted
 * service: a vendor token in the package name (`id`: `openai`, `RevenueCat/purchases-android`,
 * `livekit-plugins-elevenlabs`) or a strong client pattern in the description.
 * Vendor words in a description do not count (a package that merely mentions
 * OpenAI is not its client). Empty when nothing points that way; a hint for a
 * warning, never a verdict.
 */
export function serviceClientSignals(id: string, descriptor: string): string[] {
  const signals: string[] = [];
  const tokens = id.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== '');
  for (const vendor of VENDOR_TOKENS) {
    if (hasSequence(tokens, vendor)) signals.push(`name mentions ${vendor.join('-')}`);
  }
  const text = descriptor.slice(0, MAX_DESCRIPTOR_CHARS).toLowerCase().replace(/\s+/g, ' ');
  for (const { label, re } of CLIENT_PATTERNS) {
    if (re.test(text)) signals.push(`description: ${label}`);
  }
  return signals;
}

/** Package-name tokens of LLM gateways, which only route to someone else's models. Matched in the package name, not in free text. */
const GATEWAY_TOKENS: ReadonlyArray<string> = ['litellm', 'openrouter', 'portkey'];

/** Descriptions that call the package a gateway, proxy or router for model providers. Gaps are bounded so the patterns stay linear. */
const GATEWAY_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'llm/ai/model gateway, proxy or router', re: /\b(?:llm|ai|model)s? (?:gateway|proxy|router)\b/ },
  { label: 'openai-compatible gateway or proxy', re: /\bopenai[- ]compatible (?:gateway|proxy)\b/ },
  { label: 'many llms or providers', re: /\b(?:100\+|multiple|many|any|various) (?:llms?|llm providers|ai providers|model providers|llm apis)\b/ },
  { label: 'unified api for llms', re: /\bunified (?:api|interface) (?:for|to|across)\b[^.\n]{0,40}?\b(?:llms?|models|providers)\b/ },
];

/**
 * Signals that a github/npm/pypi/mcp package is an LLM gateway, proxy or router:
 * a gateway token in the package name (`github:BerriAI/litellm`, `pypi:litellm`,
 * `openrouter`) or a gateway pattern in the description. A gateway only forwards
 * to model providers (a hosted service or self-hosted weights), so those are the
 * real decision. Other words in a description (a tool that merely lists LiteLLM
 * among its integrations) do not count. Empty when nothing points that way; a
 * hint for a warning, never a verdict.
 */
export function upstreamProviderSignals(id: string, descriptor: string): string[] {
  const signals: string[] = [];
  const tokens = id.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== '');
  for (const token of GATEWAY_TOKENS) {
    if (tokens.includes(token)) signals.push(`name mentions ${token}`);
  }
  const text = descriptor.slice(0, MAX_DESCRIPTOR_CHARS).toLowerCase().replace(/\s+/g, ' ');
  for (const { label, re } of GATEWAY_PATTERNS) {
    if (re.test(text)) signals.push(`description: ${label}`);
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Decided candidates whose service is not confirmed
// ---------------------------------------------------------------------------

export interface ServiceGap {
  component_id: string;
  /**
   * `service_terms`: linked to a service without confirmed terms; `client_suspected`: looks like a
   * service client but is neither linked nor exempt; `upstream_provider`: looks like an LLM gateway
   * with neither a provider (`service_ref`) nor a self-hosted model (`weights_ref`).
   */
  kind: 'service_terms' | 'client_suspected' | 'upstream_provider';
  decision: Extract<DecisionKind, 'adopt' | 'extend'>;
  ref: string;
  /** The service the candidate was linked to; absent when the candidate only looks like a service client. */
  service_ref?: string;
  /** One plain sentence; escape it before it goes into Markdown. */
  reason: string;
}

/**
 * Decided adopt/extend candidates used through a client of a hosted service that
 * has no confirmed terms: linked to a service (`service_ref`) whose latest
 * evaluation in the component is missing or carries a terms gate flag, or flagged
 * `service_client_suspected` without a link or an exemption, or flagged
 * `upstream_provider_unverified` (an LLM gateway: `no_service_reason` does not
 * clear it, only a provider or a model does). Judged on the current state, so
 * evaluating the service later clears the entry.
 */
export function serviceUsageGaps(state: Pick<LedgerState, 'decisions' | 'evaluations'>): ServiceGap[] {
  const gaps: ServiceGap[] = [];
  for (const d of state.decisions) {
    if ((d.decision !== 'adopt' && d.decision !== 'extend') || d.ref === undefined) continue;
    const ev = state.evaluations.find((e) => e.component_id === d.component_id && e.ref === d.ref);
    if (ev === undefined) continue;
    const serviceRef = ev.service_ref;
    if (serviceRef !== undefined) {
      const service = state.evaluations.find((e) => e.component_id === d.component_id && e.ref === serviceRef);
      const problems = serviceTermsGaps(service);
      if (problems.length === 0) continue;
      gaps.push({
        component_id: d.component_id,
        decision: d.decision,
        ref: d.ref,
        service_ref: serviceRef,
        kind: 'service_terms',
        reason: `the terms of ${serviceRef} are not confirmed (${problems.join(', ')})`,
      });
    } else if (ev.flags.includes('upstream_provider_unverified')) {
      gaps.push({
        component_id: d.component_id,
        decision: d.decision,
        ref: d.ref,
        kind: 'upstream_provider',
        reason:
          'it looks like an LLM gateway (upstream_provider_unverified) and the model provider behind it was not evaluated: neither service_ref (a saas: provider) nor weights_ref (a self-hosted model) is linked, and no_service_reason does not clear this',
      });
    } else if (ev.flags.includes('service_client_suspected')) {
      gaps.push({
        component_id: d.component_id,
        decision: d.decision,
        ref: d.ref,
        kind: 'client_suspected',
        reason: 'it looks like a client of a hosted service (service_client_suspected) and has neither service_ref nor no_service_reason',
      });
    }
  }
  return gaps;
}

/** Decided adopt/extend services whose vendor pages were read but do not say whether they train on submitted data. */
function dataUseNotStated(state: Pick<LedgerState, 'decisions' | 'evaluations'>): Array<{ component_id: string; ref: string }> {
  const found: Array<{ component_id: string; ref: string }> = [];
  for (const d of state.decisions) {
    if ((d.decision !== 'adopt' && d.decision !== 'extend') || d.ref === undefined) continue;
    const ev = state.evaluations.find((e) => e.component_id === d.component_id && e.ref === d.ref);
    if (ev?.flags.includes('saas_data_use_not_stated')) found.push({ component_id: d.component_id, ref: d.ref });
  }
  return found;
}

/**
 * One warning line per gap, for rw_ledger and rw_status (empty when no decision has a gap):
 * services and providers that were not evaluated, and services whose vendor does not state its data use.
 */
export function serviceWarnings(state: Pick<LedgerState, 'decisions' | 'evaluations'>): string[] {
  const gaps = serviceUsageGaps(state).map((g) =>
    softLine(
      g.kind === 'upstream_provider'
        ? `LLM gateway used without an evaluated provider: component ${g.component_id} decided ${g.decision} ${g.ref}; ${g.reason}. Evaluate the model provider with rw_evaluate (saas: ref, vendor pages as source_url) and link the gateway with service_ref, or link a self-hosted model with weights_ref.`
        : `service used through a client but not evaluated: component ${g.component_id} decided ${g.decision} ${g.ref}; ${g.reason}. Evaluate the service with rw_evaluate (saas: ref, vendor pages as source_url) and link the client with service_ref.`,
      500,
    ),
  );
  const notStated = dataUseNotStated(state).map((s) =>
    softLine(
      `vendor does not state its data use: component ${s.component_id} decided ${s.ref} (saas_data_use_not_stated); check the vendor's DPA or ask the vendor whether submitted data is used for training.`,
      500,
    ),
  );
  return [...gaps, ...notStated];
}
