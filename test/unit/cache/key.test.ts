import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_HOSTS,
  cacheKey,
  isAllowedHost,
  normalizeUrl,
  parseAllowedUrl,
  redactUrl,
  SECRET_PARAMS,
} from '../../../src/cache/key.js';

describe('normalizeUrl', () => {
  it('lowercases scheme and host, drops default port and fragment', () => {
    expect(normalizeUrl('HTTPS://API.GitHub.com:443/repos/a/b#readme')).toBe(
      'https://api.github.com/repos/a/b',
    );
    expect(normalizeUrl('http://Example.com:80/x')).toBe('http://example.com/x');
  });

  it('keeps a non-default port', () => {
    expect(normalizeUrl('https://api.github.com:8443/x')).toBe('https://api.github.com:8443/x');
  });

  it('sorts query parameters by name then value', () => {
    expect(normalizeUrl('https://pypi.org/s?b=2&a=2&a=1')).toBe('https://pypi.org/s?a=1&a=2&b=2');
    expect(normalizeUrl('https://pypi.org/s?q=x&per_page=5')).toBe(normalizeUrl('https://pypi.org/s?per_page=5&q=x'));
  });

  it('treats equivalent query encodings as the same', () => {
    expect(normalizeUrl('https://api.github.com/search/repositories?q=a%20b')).toBe(
      normalizeUrl('https://api.github.com/search/repositories?q=a+b'),
    );
  });

  it('uppercases percent-escapes in the path', () => {
    expect(normalizeUrl('https://registry.npmjs.org/@scope%2fname/latest')).toBe(
      'https://registry.npmjs.org/@scope%2Fname/latest',
    );
  });

  it('removes every secret parameter, case-insensitively', () => {
    for (const name of [...SECRET_PARAMS, 'API_KEY', 'Access_Token']) {
      expect(normalizeUrl(`https://libraries.io/api/search?q=x&${name}=SECRET`)).toBe(
        'https://libraries.io/api/search?q=x',
      );
    }
  });

  it('removes userinfo', () => {
    expect(normalizeUrl('https://user:pw@api.github.com/x')).toBe('https://api.github.com/x');
  });

  it('drops the query entirely when only secrets were present', () => {
    expect(normalizeUrl('https://libraries.io/api/x?api_key=abc')).toBe('https://libraries.io/api/x');
  });

  it('keeps non-secret parameters that merely contain a secret name', () => {
    expect(normalizeUrl('https://pypi.org/s?keyword=a&tokens=b')).toBe('https://pypi.org/s?keyword=a&tokens=b');
  });

  it('throws on input that is not an absolute URL', () => {
    expect(() => normalizeUrl('not a url')).toThrow();
  });
});

describe('cacheKey', () => {
  it('is sha256hex("rw1|" + normalizeUrl(url))', () => {
    const url = 'https://api.github.com/repos/o/r';
    const expected = createHash('sha256').update('rw1|https://api.github.com/repos/o/r').digest('hex');
    expect(cacheKey(url)).toBe(expected);
    expect(cacheKey(url)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is identical with and without a secret parameter', () => {
    const plain = cacheKey('https://libraries.io/api/search?q=pdf&platforms=PyPI');
    expect(cacheKey('https://libraries.io/api/search?q=pdf&platforms=PyPI&api_key=ghp_TESTTOKEN123')).toBe(plain);
    expect(cacheKey('https://libraries.io/api/search?api_key=other&platforms=PyPI&q=pdf')).toBe(plain);
  });

  it('differs when a non-secret parameter or the path differs', () => {
    const base = cacheKey('https://api.github.com/search/repositories?q=pdf');
    expect(cacheKey('https://api.github.com/search/repositories?q=pdf2')).not.toBe(base);
    expect(cacheKey('https://api.github.com/search/code?q=pdf')).not.toBe(base);
  });

  it('does not contain the secret value', () => {
    expect(cacheKey('https://libraries.io/x?api_key=ghp_TESTTOKEN123')).not.toContain('ghp_');
  });
});

describe('redactUrl', () => {
  it('replaces secret values with REDACTED and keeps the rest', () => {
    const out = redactUrl('https://libraries.io/api/search?q=pdf&api_key=ghp_TESTTOKEN123&platforms=PyPI');
    expect(out).toBe('https://libraries.io/api/search?q=pdf&api_key=REDACTED&platforms=PyPI');
    expect(out).not.toContain('ghp_TESTTOKEN123');
  });

  it('redacts repeated and mixed-case parameters', () => {
    const out = redactUrl('https://x.test/a?TOKEN=one&token=two&key=three&ok=1');
    expect(out).not.toMatch(/one|two|three/);
    expect(out).toContain('ok=1');
  });

  it('removes userinfo and fragment', () => {
    const out = redactUrl('https://user:hunter2@api.github.com/x?a=1#frag');
    expect(out).toBe('https://api.github.com/x?a=1');
  });

  it('leaves a URL without secrets untouched', () => {
    const url = 'https://api.github.com/search/repositories?q=a%20b&per_page=5';
    expect(redactUrl(url)).toBe(url);
  });

  it('never throws and still redacts when the URL does not parse', () => {
    const out = redactUrl('/relative/path?api_key=ghp_TESTTOKEN123&x=1');
    expect(out).toBe('/relative/path?api_key=REDACTED&x=1');
  });
});

describe('allowlist', () => {
  it('lists the PLAN §9.1 hosts', () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual(
      [
        'api.github.com',
        'registry.npmjs.org',
        'api.npmjs.org',
        'pypi.org',
        'api.deps.dev',
        'registry.modelcontextprotocol.io',
        'libraries.io',
        'huggingface.co',
      ].sort(),
    );
  });

  it('isAllowedHost matches exactly, case-insensitively', () => {
    expect(isAllowedHost('API.GitHub.com')).toBe(true);
    expect(isAllowedHost('github.com')).toBe(false);
    expect(isAllowedHost('evil.api.github.com')).toBe(false);
    expect(isAllowedHost('api.github.com.evil.com')).toBe(false);
  });

  it('parseAllowedUrl accepts https allowlisted hosts only', () => {
    expect(parseAllowedUrl('https://pypi.org/pypi/x/json')?.hostname).toBe('pypi.org');
    expect(parseAllowedUrl('http://pypi.org/pypi/x/json')).toBeUndefined();
    expect(parseAllowedUrl('https://pypi.org:8443/pypi/x/json')).toBeUndefined();
    expect(parseAllowedUrl('https://u:p@pypi.org/pypi/x/json')).toBeUndefined();
    expect(parseAllowedUrl('https://example.com/')).toBeUndefined();
    expect(parseAllowedUrl('https://127.0.0.1/')).toBeUndefined();
    expect(parseAllowedUrl('ftp://pypi.org/')).toBeUndefined();
    expect(parseAllowedUrl('garbage')).toBeUndefined();
  });
});
