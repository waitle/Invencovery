import { describe, expect, it } from 'vitest';
import { hostWithinDomain, httpHost, saasEvidenceSource } from '../../../src/core/saas-evidence.js';
import { VendorDomainsSchema } from '../../../src/types.js';

const page = (id: string, ...urls: string[]) => ({ id, results: urls.map((url) => ({ url })) });

describe('httpHost', () => {
  it.each([
    ['https://deepgram.com/pricing', 'deepgram.com'],
    ['HTTP://API.DeepGram.COM:8443/x?y=1#z', 'api.deepgram.com'],
    ['https://deepgram.com./pricing', 'deepgram.com'],
    ['  https://deepgram.com/  ', 'deepgram.com'],
    ['https://user:pw@deepgram.com/', 'deepgram.com'],
  ])('%s -> %s', (url, host) => {
    expect(httpHost(url)).toBe(host);
  });

  it.each(['', 'not a url', 'deepgram.com/pricing', 'ftp://deepgram.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@deepgram.com'])(
    'rejects %j',
    (url) => {
      expect(httpHost(url)).toBeUndefined();
    },
  );
});

describe('hostWithinDomain', () => {
  it('accepts the domain itself and its subdomains', () => {
    expect(hostWithinDomain('deepgram.com', 'deepgram.com')).toBe(true);
    expect(hostWithinDomain('developers.deepgram.com', 'deepgram.com')).toBe(true);
    expect(hostWithinDomain('a.b.deepgram.com', 'deepgram.com')).toBe(true);
  });

  it('compares on label boundaries, not suffixes or prefixes', () => {
    expect(hostWithinDomain('evil-deepgram.com', 'deepgram.com')).toBe(false);
    expect(hostWithinDomain('deepgram.com.evil.io', 'deepgram.com')).toBe(false);
    expect(hostWithinDomain('notdeepgram.com', 'deepgram.com')).toBe(false);
    expect(hostWithinDomain('com', 'deepgram.com')).toBe(false);
  });

  it('ignores a trailing dot and case on the domain', () => {
    expect(hostWithinDomain('deepgram.com', 'DeepGram.com.')).toBe(true);
  });

  it('never matches an empty domain', () => {
    expect(hostWithinDomain('deepgram.com', '')).toBe(false);
  });
});

describe('saasEvidenceSource', () => {
  const domains = ['deepgram.com'];

  it('is first_party when a result URL is on a vendor domain', () => {
    expect(saasEvidenceSource([page('ev_1', 'https://deepgram.com/pricing')], 'ev_1', domains)).toBe('first_party');
    expect(saasEvidenceSource([page('ev_1', 'https://developers.deepgram.com/docs')], 'ev_1', domains)).toBe('first_party');
  });

  it('counts any result of the evidence, not just the first', () => {
    const ev = page('ev_1', 'https://livekit.io/deepgram', 'https://deepgram.com/pricing');
    expect(saasEvidenceSource([ev], 'ev_1', domains)).toBe('first_party');
  });

  it('is secondhand for a reseller, a lookalike host or a suffix trick', () => {
    for (const url of [
      'https://livekit.io/deepgram-pricing',
      'https://evil-deepgram.com/pricing',
      'https://deepgram.com.evil.io/pricing',
      'https://example.com/?next=https://deepgram.com',
    ]) {
      expect(saasEvidenceSource([page('ev_1', url)], 'ev_1', domains), url).toBe('secondhand');
    }
  });

  it('is secondhand when the evidence has no usable URL (non-http, unparsable, no results)', () => {
    expect(saasEvidenceSource([page('ev_1', 'ftp://deepgram.com/x', 'deepgram.com/pricing')], 'ev_1', domains)).toBe('secondhand');
    expect(saasEvidenceSource([page('ev_1')], 'ev_1', domains)).toBe('secondhand');
  });

  it('is secondhand when no vendor domain is known (older ledger)', () => {
    expect(saasEvidenceSource([page('ev_1', 'https://deepgram.com/pricing')], 'ev_1', undefined)).toBe('secondhand');
    expect(saasEvidenceSource([page('ev_1', 'https://deepgram.com/pricing')], 'ev_1', [])).toBe('secondhand');
  });

  it('is none without an id, or when the id is not in the ledger', () => {
    expect(saasEvidenceSource([page('ev_1', 'https://deepgram.com/')], undefined, domains)).toBe('none');
    expect(saasEvidenceSource([page('ev_1', 'https://deepgram.com/')], 'ev_9', domains)).toBe('none');
    expect(saasEvidenceSource([], 'ev_1', domains)).toBe('none');
  });
});

describe('VendorDomainsSchema', () => {
  const ok = (v: unknown) => VendorDomainsSchema.safeParse(v).success;

  it('accepts 1-5 lowercase hostnames with a dot', () => {
    expect(ok(['deepgram.com'])).toBe(true);
    expect(ok(['deepgram.com', 'api.deepgram.com', 'deepgram.co.uk', 'xn--vnx.example', 'a-b.example.io'])).toBe(true);
  });

  it('requires at least one and at most five', () => {
    expect(ok([])).toBe(false);
    expect(ok(undefined)).toBe(false);
    expect(ok(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com', 'a6.com'])).toBe(false);
  });

  it.each([
    'https://deepgram.com',
    'deepgram.com/pricing',
    'deepgram.com:443',
    '*.deepgram.com',
    'Deepgram.com',
    'localhost',
    'deepgram',
    '127.0.0.1',
    '1.2.3.4',
    'deepgram.com.',
    '.deepgram.com',
    '-a.com',
    'a b.com',
    'user@deepgram.com',
    'deepgram..com',
  ])('rejects %j', (value) => {
    expect(ok([value])).toBe(false);
  });

  it('says what to fix', () => {
    const r = VendorDomainsSchema.safeParse(['https://deepgram.com']);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('hostname');
  });
});
