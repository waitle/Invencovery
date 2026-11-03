import { describe, expect, it } from 'vitest';
import {
  blockedStateFor,
  blockedUntil,
  DEFAULT_BACKOFF_MS,
  isRateLimited,
  MAX_BACKOFF_MS,
  parseRetryAfterMs,
  rateLimitHeaders,
  rateLimitResource,
  readRateLimitState,
} from '../../../src/http/ratelimit.js';
import type { RateLimitState } from '../../../src/types.js';

const NOW = 1_800_000_000_000;

describe('rateLimitResource', () => {
  const cases: [string, boolean, string][] = [
    ['https://api.github.com/search/repositories?q=x', true, 'github:search'],
    ['https://api.github.com/search/code?q=x', true, 'github:code_search'],
    ['https://api.github.com/repos/o/r', true, 'github:core'],
    ['https://api.github.com/repos/o/r/releases/latest', true, 'github:core'],
    ['https://api.github.com/search/repositories?q=x', false, 'github:search:anon'],
    ['https://api.github.com/repos/o/r', false, 'github:core:anon'],
    ['https://libraries.io/api/search?q=x', false, 'librariesio'],
    ['https://registry.npmjs.org/-/v1/search?text=x', false, 'npm'],
    ['https://api.npmjs.org/downloads/point/last-week/x', false, 'npm'],
    ['https://pypi.org/pypi/x/json', false, 'pypi'],
    ['https://api.deps.dev/v3/systems/npm/packages/x', false, 'depsdev'],
    ['https://registry.modelcontextprotocol.io/v0.1/servers', false, 'mcp_registry'],
  ];
  it.each(cases)('%s (authenticated=%s) -> %s', (url, authed, expected) => {
    expect(rateLimitResource(new URL(url), authed)).toBe(expected);
  });

  it('prefers a well-formed x-ratelimit-resource response header for GitHub', () => {
    const u = new URL('https://api.github.com/repos/o/r');
    expect(rateLimitResource(u, true, { 'x-ratelimit-resource': 'graphql' })).toBe('github:graphql');
    expect(rateLimitResource(u, true, { 'x-ratelimit-resource': 'bad value!' })).toBe('github:core');
  });
});

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('120', NOW)).toBe(120_000);
    expect(parseRetryAfterMs(' 0 ', NOW)).toBe(0);
  });
  it('reads an HTTP date relative to now', () => {
    const at = new Date(NOW + 30_000).toUTCString();
    expect(parseRetryAfterMs(at, NOW)).toBe(30_000);
    expect(parseRetryAfterMs(new Date(NOW - 5_000).toUTCString(), NOW)).toBe(0);
  });
  it('returns undefined for absent or invalid values', () => {
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfterMs('', NOW)).toBeUndefined();
    expect(parseRetryAfterMs('soon', NOW)).toBeUndefined();
  });
});

describe('readRateLimitState', () => {
  it('converts the epoch-seconds reset header to milliseconds', () => {
    const resetSec = Math.floor(NOW / 1000) + 600;
    const s = readRateLimitState(
      { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': String(resetSec) },
      NOW,
      'github:core',
    );
    expect(s).toEqual({
      resource: 'github:core',
      limit: 60,
      remaining: 42,
      reset_at: resetSec * 1000,
      updated_at: NOW,
    });
  });

  it('reads a small reset value as seconds from now', () => {
    const s = readRateLimitState({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '30' }, NOW, 'r');
    expect(s?.reset_at).toBe(NOW + 30_000);
    expect(s?.limit).toBe(0);
  });

  it('accepts an epoch-milliseconds reset value', () => {
    const s = readRateLimitState({ 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String(NOW + 5_000) }, NOW, 'r');
    expect(s?.reset_at).toBe(NOW + 5_000);
  });

  it('caps absurd reset times', () => {
    const s = readRateLimitState(
      { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 10 * 365 * 86400) },
      NOW,
      'r',
    );
    expect(s?.reset_at).toBe(NOW + MAX_BACKOFF_MS);
  });

  it('returns undefined without remaining or reset', () => {
    expect(readRateLimitState({}, NOW, 'r')).toBeUndefined();
    expect(readRateLimitState({ 'x-ratelimit-remaining': '3' }, NOW, 'r')).toBeUndefined();
    expect(readRateLimitState({ 'x-ratelimit-remaining': 'abc', 'x-ratelimit-reset': '1' }, NOW, 'r')).toBeUndefined();
  });
});

describe('isRateLimited', () => {
  const cases: [number, Record<string, string>, boolean][] = [
    [429, {}, true],
    [403, { 'x-ratelimit-remaining': '0' }, true],
    [403, { 'retry-after': '60' }, true],
    [403, { 'x-ratelimit-remaining': '12' }, false],
    [403, {}, false],
    [200, { 'x-ratelimit-remaining': '0' }, false],
    [500, { 'retry-after': '5' }, false],
  ];
  it.each(cases)('status %i %j -> %s', (status, headers, expected) => {
    expect(isRateLimited(status, headers)).toBe(expected);
  });
});

describe('blockedStateFor', () => {
  it('uses the announced reset when remaining is 0', () => {
    const base: RateLimitState = { resource: 'r', limit: 60, remaining: 0, reset_at: NOW + 120_000, updated_at: NOW };
    const s = blockedStateFor(base, {}, NOW, 'r');
    expect(s).toMatchObject({ remaining: 0, reset_at: NOW + 120_000, limit: 60 });
  });

  it('uses retry-after, and the later of the two when both exist', () => {
    expect(blockedStateFor(undefined, { 'retry-after': '90' }, NOW, 'r').reset_at).toBe(NOW + 90_000);
    const base: RateLimitState = { resource: 'r', limit: 5, remaining: 0, reset_at: NOW + 10_000, updated_at: NOW };
    expect(blockedStateFor(base, { 'retry-after': '90' }, NOW, 'r').reset_at).toBe(NOW + 90_000);
  });

  it('ignores a reset that is still announced with remaining > 0 (secondary limit)', () => {
    const base: RateLimitState = { resource: 'r', limit: 5000, remaining: 4000, reset_at: NOW + 3_000_000, updated_at: NOW };
    const s = blockedStateFor(base, { 'retry-after': '30' }, NOW, 'r');
    expect(s.reset_at).toBe(NOW + 30_000);
    expect(s.remaining).toBe(0);
  });

  it('falls back to the default backoff and clamps long waits', () => {
    expect(blockedStateFor(undefined, {}, NOW, 'r').reset_at).toBe(NOW + DEFAULT_BACKOFF_MS);
    expect(blockedStateFor(undefined, { 'retry-after': String(10 * 365 * 86400) }, NOW, 'r').reset_at).toBe(
      NOW + MAX_BACKOFF_MS,
    );
  });
});

describe('blockedUntil', () => {
  const s = (remaining: number, resetAt: number): RateLimitState => ({
    resource: 'r',
    limit: 10,
    remaining,
    reset_at: resetAt,
    updated_at: NOW,
  });
  it('blocks only while remaining is 0 and reset is in the future', () => {
    expect(blockedUntil(undefined, NOW)).toBeUndefined();
    expect(blockedUntil(s(0, NOW + 1), NOW)).toBe(NOW + 1);
    expect(blockedUntil(s(0, NOW), NOW)).toBeUndefined();
    expect(blockedUntil(s(0, NOW - 1), NOW)).toBeUndefined();
    expect(blockedUntil(s(1, NOW + 1000), NOW)).toBeUndefined();
  });
});

describe('rateLimitHeaders', () => {
  it('emits epoch seconds and a retry-after in seconds', () => {
    const h = rateLimitHeaders(
      { resource: 'r', limit: 60, remaining: 0, reset_at: NOW + 90_500, updated_at: NOW },
      NOW,
    );
    expect(h).toEqual({
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.ceil((NOW + 90_500) / 1000)),
      'retry-after': '91',
    });
  });
});
