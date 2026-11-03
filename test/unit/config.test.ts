import { describe, expect, it } from 'vitest';
import { collectSecrets, loadConfig, maskSecrets } from '../../src/config.js';
import { SourceSchema } from '../../src/types.js';

const linux = { platform: 'linux' as const, homedir: '/home/u', cwd: '/work/proj' };
const windows = { platform: 'win32' as const, homedir: 'C:\\Users\\u', cwd: 'C:\\work\\proj' };

describe('loadConfig defaults', () => {
  const c = loadConfig({}, linux);

  it('uses the documented defaults', () => {
    expect(c.noGhCli).toBe(false);
    expect(c.cacheMaxMb).toBe(200);
    expect(c.offline).toBe(false);
    expect(c.remoteCacheMode).toBe('off');
    expect(c.remoteCacheUrl).toBeUndefined();
    expect(c.budget).toEqual({ rounds: 3, evals: 5, web: 2 });
    expect(c.logLevel).toBe('warn');
    expect(c.sources).toEqual([...SourceSchema.options]);
    expect(c.projectRoot).toBe('/work/proj');
    expect(c.warnings).toEqual([]);
  });

  it('has no secrets set', () => {
    expect(c.remoteCacheToken).toBeUndefined();
    expect(c.librariesIoApiKey).toBeUndefined();
    expect(c.serverWriteToken).toBeUndefined();
    expect(c.serverReadToken).toBeUndefined();
  });

  it('picks the XDG cache dir on non-Windows', () => {
    expect(c.cacheDir).toBe('/home/u/.cache/recyclewheel');
    expect(c.cacheDbPath).toBe('/home/u/.cache/recyclewheel/cache.db');
    const xdg = loadConfig({ XDG_CACHE_HOME: '/var/xdg' }, linux);
    expect(xdg.cacheDbPath).toBe('/var/xdg/recyclewheel/cache.db');
  });

  it('picks %LOCALAPPDATA% on Windows', () => {
    const w = loadConfig({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, windows);
    expect(w.cacheDbPath).toBe('C:\\Users\\u\\AppData\\Local\\recyclewheel\\cache.db');
    const noLocal = loadConfig({}, windows);
    expect(noLocal.cacheDir).toBe('C:\\Users\\u\\AppData\\Local\\recyclewheel');
  });
});

describe('loadConfig overrides', () => {
  it('reads every documented variable', () => {
    const c = loadConfig(
      {
        RECYCLEWHEEL_NO_GH_CLI: '1',
        RECYCLEWHEEL_CACHE_DIR: '/tmp/rw',
        RECYCLEWHEEL_CACHE_MAX_MB: '50',
        RECYCLEWHEEL_OFFLINE: '1',
        RECYCLEWHEEL_PROJECT_ROOT: '/srv/app',
        RECYCLEWHEEL_SOURCES: 'npm, github_repo',
        RECYCLEWHEEL_REMOTE_CACHE_URL: 'https://cache.example.com/',
        RECYCLEWHEEL_REMOTE_CACHE_MODE: 'readwrite',
        RECYCLEWHEEL_REMOTE_CACHE_TOKEN: 'tok-remote',
        RECYCLEWHEEL_BUDGET_ROUNDS: '4',
        RECYCLEWHEEL_BUDGET_EVALS: '6',
        RECYCLEWHEEL_BUDGET_WEB: '1',
        LIBRARIES_IO_API_KEY: 'lib-key',
        RECYCLEWHEEL_LOG_LEVEL: 'DEBUG',
        RECYCLEWHEEL_SERVER_WRITE_TOKEN: 'w',
        RECYCLEWHEEL_SERVER_READ_TOKEN: 'r',
      },
      linux,
    );
    expect(c).toEqual({
      noGhCli: true,
      cacheDir: '/tmp/rw',
      cacheDbPath: '/tmp/rw/cache.db',
      cacheMaxMb: 50,
      offline: true,
      projectRoot: '/srv/app',
      sources: ['npm', 'github_repo'],
      remoteCacheUrl: 'https://cache.example.com',
      remoteCacheMode: 'readwrite',
      remoteCacheToken: 'tok-remote',
      allowInsecureRemote: false,
      budget: { rounds: 4, evals: 6, web: 1 },
      librariesIoApiKey: 'lib-key',
      logLevel: 'debug',
      serverWriteToken: 'w',
      serverReadToken: 'r',
      warnings: [],
    });
  });

  it('resolves relative paths against cwd', () => {
    const c = loadConfig({ RECYCLEWHEEL_PROJECT_ROOT: 'sub', RECYCLEWHEEL_CACHE_DIR: '.cache' }, linux);
    expect(c.projectRoot).toBe('/work/proj/sub');
    expect(c.cacheDir).toBe('/work/proj/.cache');
  });

  it('treats empty and whitespace values as unset', () => {
    const c = loadConfig(
      {
        RECYCLEWHEEL_REMOTE_CACHE_TOKEN: '',
        LIBRARIES_IO_API_KEY: '   ',
        RECYCLEWHEEL_OFFLINE: '',
        RECYCLEWHEEL_REMOTE_CACHE_MODE: '',
        RECYCLEWHEEL_SOURCES: '',
      },
      linux,
    );
    expect(c.remoteCacheToken).toBeUndefined();
    expect(c.librariesIoApiKey).toBeUndefined();
    expect(c.offline).toBe(false);
    expect(c.remoteCacheMode).toBe('off');
    expect(c.sources).toEqual([...SourceSchema.options]);
    expect(c.warnings).toEqual([]);
  });

  it('accepts 0 and false as explicit off', () => {
    const c = loadConfig({ RECYCLEWHEEL_OFFLINE: '0', RECYCLEWHEEL_NO_GH_CLI: 'false' }, linux);
    expect(c.offline).toBe(false);
    expect(c.noGhCli).toBe(false);
    expect(c.warnings).toEqual([]);
  });
});

describe('loadConfig: remote cache transport security', () => {
  const remote = (url: string, extra: Record<string, string> = {}) =>
    loadConfig(
      { RECYCLEWHEEL_REMOTE_CACHE_URL: url, RECYCLEWHEEL_REMOTE_CACHE_MODE: 'readwrite', ...extra },
      linux,
    );

  it.each(['https://cache.example.com', 'http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080/p'])(
    'accepts %s',
    (url) => {
      const c = remote(url);
      expect(c.remoteCacheMode).toBe('readwrite');
      expect(c.remoteCacheUrl).toBeDefined();
      expect(c.warnings).toEqual([]);
      expect(c.allowInsecureRemote).toBe(false);
    },
  );

  it('refuses plain http on a non-loopback host and warns without leaking the token', () => {
    const c = remote('http://cache.example.com', { RECYCLEWHEEL_REMOTE_CACHE_TOKEN: 'tok-remote-secret' });
    expect(c.remoteCacheMode).toBe('off');
    expect(c.remoteCacheUrl).toBeUndefined();
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).toContain('RECYCLEWHEEL_ALLOW_INSECURE_REMOTE');
    expect(c.warnings.join('\n')).not.toContain('tok-remote-secret');
  });

  it('accepts plain http on a non-loopback host only with RECYCLEWHEEL_ALLOW_INSECURE_REMOTE=1', () => {
    const c = remote('http://cache.example.com', { RECYCLEWHEEL_ALLOW_INSECURE_REMOTE: '1' });
    expect(c.remoteCacheMode).toBe('readwrite');
    expect(c.remoteCacheUrl).toBe('http://cache.example.com');
    expect(c.allowInsecureRemote).toBe(true);
    expect(c.warnings).toEqual([]);
  });

  it('treats a non-boolean opt-in as unset', () => {
    const c = remote('http://cache.example.com', { RECYCLEWHEEL_ALLOW_INSECURE_REMOTE: 'maybe' });
    expect(c.remoteCacheMode).toBe('off');
    expect(c.allowInsecureRemote).toBe(false);
    expect(c.warnings).toHaveLength(2);
  });
});

describe('collectSecrets / maskSecrets', () => {
  it('collects only non-empty secret values of length >= 8', () => {
    const secrets = collectSecrets({
      GITHUB_TOKEN: 'ghp_aaaaaaaa',
      GH_TOKEN: 'short',
      LIBRARIES_IO_API_KEY: '  lib-key-12345  ',
      RECYCLEWHEEL_REMOTE_CACHE_TOKEN: '',
      RECYCLEWHEEL_SERVER_WRITE_TOKEN: 'server-write-1',
      RECYCLEWHEEL_SERVER_READ_TOKEN: 'ghp_aaaaaaaa',
      RECYCLEWHEEL_CACHE_DIR: '/not/a/secret/value',
      PATH: '/usr/bin:/bin',
    });
    expect([...secrets].sort()).toEqual(['ghp_aaaaaaaa', 'lib-key-12345', 'server-write-1'].sort());
  });

  it('returns an empty list when nothing is set', () => {
    expect(collectSecrets({})).toEqual([]);
  });

  it('masks every occurrence, longest value first', () => {
    const out = maskSecrets('a tok-12345678 b tok-12345678-long c tok-12345678', ['tok-12345678', 'tok-12345678-long']);
    expect(out).toBe('a *** b *** c ***');
  });

  it('leaves text without secrets unchanged and ignores empty secrets', () => {
    expect(maskSecrets('nothing here', ['', 'zzzzzzzz'])).toBe('nothing here');
  });
});

describe('loadConfig invalid values', () => {
  it('maps an unknown remote cache mode to off with a warning', () => {
    const c = loadConfig(
      { RECYCLEWHEEL_REMOTE_CACHE_MODE: 'foo', RECYCLEWHEEL_REMOTE_CACHE_URL: 'https://c.example.com' },
      linux,
    );
    expect(c.remoteCacheMode).toBe('off');
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).toContain('RECYCLEWHEEL_REMOTE_CACHE_MODE');
  });

  it('disables the remote cache when mode is set without a URL', () => {
    const c = loadConfig({ RECYCLEWHEEL_REMOTE_CACHE_MODE: 'read' }, linux);
    expect(c.remoteCacheMode).toBe('off');
    expect(c.warnings.join('\n')).toContain('RECYCLEWHEEL_REMOTE_CACHE_URL');
  });

  it('disables the remote cache when the URL is not http(s)', () => {
    const c = loadConfig(
      { RECYCLEWHEEL_REMOTE_CACHE_URL: 'ftp://x', RECYCLEWHEEL_REMOTE_CACHE_MODE: 'read' },
      linux,
    );
    expect(c.remoteCacheMode).toBe('off');
    expect(c.remoteCacheUrl).toBeUndefined();
    expect(c.warnings).toHaveLength(1);
  });

  it('keeps the URL but mode off when only the URL is given', () => {
    const c = loadConfig({ RECYCLEWHEEL_REMOTE_CACHE_URL: 'https://c.example.com' }, linux);
    expect(c.remoteCacheUrl).toBe('https://c.example.com');
    expect(c.remoteCacheMode).toBe('off');
    expect(c.warnings).toEqual([]);
  });

  it.each(['abc', '0', '-3', '1.5'])('falls back to the default for bad integer %j', (bad) => {
    const c = loadConfig({ RECYCLEWHEEL_CACHE_MAX_MB: bad, RECYCLEWHEEL_BUDGET_ROUNDS: bad }, linux);
    expect(c.cacheMaxMb).toBe(200);
    expect(c.budget.rounds).toBe(3);
    expect(c.warnings).toHaveLength(2);
  });

  it('ignores unknown sources and keeps the valid ones', () => {
    const c = loadConfig({ RECYCLEWHEEL_SOURCES: 'npm,gitlab,npm' }, linux);
    expect(c.sources).toEqual(['npm']);
    expect(c.warnings).toHaveLength(1);
  });

  it('hf_models is a valid source name and enabled by default', () => {
    expect(loadConfig({}, linux).sources).toContain('hf_models');
    const c = loadConfig({ RECYCLEWHEEL_SOURCES: 'hf_models,npm' }, linux);
    expect(c.sources).toEqual(['hf_models', 'npm']);
    expect(c.warnings).toEqual([]);
  });

  it('enables all sources when none are valid', () => {
    const c = loadConfig({ RECYCLEWHEEL_SOURCES: 'gitlab' }, linux);
    expect(c.sources).toEqual([...SourceSchema.options]);
    expect(c.warnings).toHaveLength(2);
  });

  it('warns on an unknown log level and a non-boolean flag', () => {
    const c = loadConfig({ RECYCLEWHEEL_LOG_LEVEL: 'loud', RECYCLEWHEEL_OFFLINE: 'maybe' }, linux);
    expect(c.logLevel).toBe('warn');
    expect(c.offline).toBe(false);
    expect(c.warnings).toHaveLength(2);
  });

  it('does not echo rejected raw values in warnings (a misplaced secret must not leak)', () => {
    const leak = 'ghp_MISPLACEDSECRET99';
    const c = loadConfig(
      {
        RECYCLEWHEEL_OFFLINE: leak,
        RECYCLEWHEEL_NO_GH_CLI: leak,
        RECYCLEWHEEL_ALLOW_INSECURE_REMOTE: leak,
        RECYCLEWHEEL_CACHE_MAX_MB: leak,
        RECYCLEWHEEL_LOG_LEVEL: leak,
        RECYCLEWHEEL_SOURCES: `npm,${leak}`,
      },
      linux,
    );
    expect(c.warnings.length).toBeGreaterThanOrEqual(5);
    const text = c.warnings.join('\n');
    expect(text).not.toContain(leak);
    expect(text).toContain('RECYCLEWHEEL_OFFLINE');
    expect(text).toContain('unrecognized');
  });

  it('never puts secret values into warnings', () => {
    const c = loadConfig(
      {
        RECYCLEWHEEL_REMOTE_CACHE_TOKEN: 'ghp_TESTTOKEN123',
        LIBRARIES_IO_API_KEY: 'ghp_TESTTOKEN123',
        RECYCLEWHEEL_REMOTE_CACHE_MODE: 'bogus',
      },
      linux,
    );
    expect(c.warnings.join('\n')).not.toContain('ghp_TESTTOKEN123');
  });
});
