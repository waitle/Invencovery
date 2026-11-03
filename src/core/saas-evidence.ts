/**
 * Whose page a SaaS term was read from (docs/PLAN.md §7.4 "Hosted services").
 *
 * The agent cites an `evidence_id` for the pricing and the data-use policy of a
 * hosted service. This module judges, from the ledger alone, whether that
 * evidence contains a page on one of the vendor's own domains. It does not fetch
 * anything: the URLs are values the agent recorded, and `vendor_domains` is the
 * agent's own claim. Both are visible in the ledger and the report, so a wrong
 * or invented value can be audited, but a server-side check of the page itself
 * does not exist.
 *
 * Pure and deterministic.
 */
import type { Evidence, SaasEvidenceSource } from '../types.js';

/** Lowercase hostname of an http(s) URL without a trailing dot; `undefined` for anything else (other schemes, unparsable text). */
export function httpHost(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  return host === '' ? undefined : host;
}

/** True when `host` is `domain` or a subdomain of it (compared on label boundaries: `evil-deepgram.com` is not `deepgram.com`). */
export function hostWithinDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.+$/, '');
  return d !== '' && (host === d || host.endsWith(`.${d}`));
}

/**
 * `first_party` when a result URL of the evidence `evidenceId` is on one of
 * `vendorDomains`; `secondhand` when the evidence exists but none of its URLs is
 * (or no vendor domain is known); `none` when no id is cited or it is not in
 * `evidence`.
 */
export function saasEvidenceSource(
  evidence: readonly Pick<Evidence, 'id' | 'results'>[],
  evidenceId: string | undefined,
  vendorDomains: readonly string[] | undefined,
): SaasEvidenceSource {
  if (evidenceId === undefined) return 'none';
  const found = evidence.find((e) => e.id === evidenceId);
  if (found === undefined) return 'none';
  const domains = vendorDomains ?? [];
  for (const result of found.results ?? []) {
    // Only a page read over https counts as the vendor's own: an http page can be altered on the way.
    if (!/^https:\/\//i.test(result.url.trim())) continue;
    const host = httpHost(result.url);
    if (host !== undefined && domains.some((d) => hostWithinDomain(host, d))) return 'first_party';
  }
  return 'secondhand';
}
