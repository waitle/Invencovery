import { homedir, tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import {
  createGithubTokenProvider,
  getGithubToken,
  redactGithubToken,
} from '../../../src/auth/github-token.js';
import type { RunGh } from '../../../src/auth/github-token.js';
import { loadConfig } from '../../../src/config.js';

const TOKEN = 'ghp_TESTTOKEN123';

function fakeGh(stdout: string): { run: RunGh; calls: { args: readonly string[]; timeoutMs: number }[] } {
  const calls: { args: readonly string[]; timeoutMs: number }[] = [];
  const run: RunGh = async (args, opts) => {
    calls.push({ args, timeoutMs: opts.timeoutMs });
    return stdout;
  };
  return { run, calls };
}

describe('getGithubToken priority', () => {
  it('prefers GITHUB_TOKEN over GH_TOKEN and never runs gh', async () => {
    const gh = fakeGh('gho_fromcli\n');
    const r = await getGithubToken({ env: { GITHUB_TOKEN: TOKEN, GH_TOKEN: 'ghp_other' }, runGh: gh.run });
    expect(r.source).toBe('env');
    expect(r.token).toBe(TOKEN);
    expect(gh.calls).toHaveLength(0);
  });

  it('falls back to GH_TOKEN when GITHUB_TOKEN is empty or whitespace', async () => {
    const gh = fakeGh('');
    for (const empty of ['', '   ', '\n']) {
      const r = await getGithubToken({ env: { GITHUB_TOKEN: empty, GH_TOKEN: ` ${TOKEN} ` }, runGh: gh.run });
      expect(r.source).toBe('env');
      expect(r.token).toBe(TOKEN);
    }
    expect(gh.calls).toHaveLength(0);
  });

  it('falls back to `gh auth token --hostname github.com` with a 3s timeout', async () => {
    const gh = fakeGh(`${TOKEN}\n`);
    const r = await getGithubToken({ env: {}, runGh: gh.run });
    expect(r.source).toBe('gh_cli');
    expect(r.token).toBe(TOKEN);
    expect(gh.calls).toEqual([{ args: ['auth', 'token', '--hostname', 'github.com'], timeoutMs: 3000 }]);
  });

  it('ignores env values that are not a header-safe single token', async () => {
    const gh = fakeGh('');
    for (const bad of ['two words', 'tok\nen', 'tok\u0000en', 'x'.repeat(600)]) {
      const r = await getGithubToken({ env: { GITHUB_TOKEN: bad }, runGh: gh.run });
      expect(r.source).toBe('none');
      expect(r.token).toBeUndefined();
    }
  });

  it('returns none when gh prints nothing, several lines, or fails', async () => {
    expect((await getGithubToken({ env: {}, runGh: fakeGh('\n').run })).source).toBe('none');
    expect((await getGithubToken({ env: {}, runGh: fakeGh('a\nb\n').run })).source).toBe('none');
    const failing: RunGh = async () => {
      throw new Error(`gh: not logged in (${TOKEN})`);
    };
    const r = await getGithubToken({ env: {}, runGh: failing });
    expect(r).toMatchObject({ source: 'none' });
    expect(r.token).toBeUndefined();
  });

  it('gives up when gh hangs past the timeout', async () => {
    const hanging: RunGh = () => new Promise<string>(() => undefined);
    const started = Date.now();
    const r = await getGithubToken({ env: {}, runGh: hanging, timeoutMs: 30 });
    expect(r.source).toBe('none');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('RECYCLEWHEEL_NO_GH_CLI', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' On '])('disables the gh fallback for %j', async (value) => {
    const gh = fakeGh(TOKEN);
    const r = await getGithubToken({ env: { RECYCLEWHEEL_NO_GH_CLI: value }, runGh: gh.run });
    expect(r.source).toBe('none');
    expect(gh.calls).toHaveLength(0);
  });

  it.each(['0', 'false', 'no', 'off', '', 'banana'])('keeps the gh fallback for %j', async (value) => {
    const gh = fakeGh(TOKEN);
    const r = await getGithubToken({ env: { RECYCLEWHEEL_NO_GH_CLI: value }, runGh: gh.run });
    expect(r.source).toBe('gh_cli');
    expect(gh.calls).toHaveLength(1);
  });

  it('agrees with loadConfig().noGhCli for every value', async () => {
    for (const value of ['1', 'true', 'yes', 'on', 'YES', '0', 'false', 'no', 'off', '', '  ', 'maybe']) {
      const env = { RECYCLEWHEEL_NO_GH_CLI: value };
      const gh = fakeGh(TOKEN);
      const r = await getGithubToken({ env, runGh: gh.run });
      expect(r.source === 'none').toBe(loadConfig(env).noGhCli);
    }
  });

  it('does not affect env tokens, and an explicit noGhCli option overrides the env', async () => {
    const withEnv = await getGithubToken({ env: { GH_TOKEN: TOKEN, RECYCLEWHEEL_NO_GH_CLI: '1' } });
    expect(withEnv.source).toBe('env');

    const gh = fakeGh(TOKEN);
    const forced = await getGithubToken({ env: {}, noGhCli: true, runGh: gh.run });
    expect(forced.source).toBe('none');
    const allowed = await getGithubToken({ env: { RECYCLEWHEEL_NO_GH_CLI: '1' }, noGhCli: false, runGh: gh.run });
    expect(allowed.source).toBe('gh_cli');
  });
});

describe('token confidentiality', () => {
  it('keeps the token out of JSON, spread and inspect output', async () => {
    const r = await getGithubToken({ env: { GITHUB_TOKEN: TOKEN } });
    expect(r.token).toBe(TOKEN);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify({ ...r })).not.toContain(TOKEN);
    expect(inspect(r, { showHidden: false })).not.toContain(TOKEN);
    expect(Object.keys(r)).toEqual(['source']);
  });

  it('redacts token lookalikes and the known token', () => {
    const text = `bad ${TOKEN} and gho_abcDEF123 and github_pat_11ABC_xyz987 and ghs_Zz9 end`;
    const out = redactGithubToken(text);
    expect(out).not.toMatch(/ghp_TESTTOKEN123|gho_abcDEF123|github_pat_11ABC_xyz987|ghs_Zz9/);
    expect(out).toContain('[REDACTED]');
    expect(redactGithubToken('custom-enterprise-secret-1', 'custom-enterprise-secret-1')).toBe('[REDACTED]');
    expect(redactGithubToken('nothing to hide')).toBe('nothing to hide');
  });
});

describe('createGithubTokenProvider', () => {
  it('runs gh at most once, including after a failure', async () => {
    const calls = vi.fn<RunGh>(async () => {
      throw new Error('gh not installed');
    });
    const p = createGithubTokenProvider({ env: {}, runGh: calls });
    expect(await p.hasToken()).toBe(false);
    expect(await p.getToken()).toBeUndefined();
    expect((await p.resolve()).source).toBe('none');
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('shares one resolution between concurrent callers', async () => {
    const calls = vi.fn<RunGh>(async () => `${TOKEN}\n`);
    const p = createGithubTokenProvider({ env: {}, runGh: calls });
    const [a, b, c] = await Promise.all([p.getToken(), p.hasToken(), p.resolve()]);
    expect(a).toBe(TOKEN);
    expect(b).toBe(true);
    expect(c.source).toBe('gh_cli');
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

describe('default gh runner', () => {
  it('spawns gh via execFile without a shell, with a timeout and fixed args', async () => {
    const exec = vi.mocked(execFile);
    exec.mockClear();
    exec.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      cb(null, 'gho_fromRealRunner\n', '');
      return {} as never;
    }) as unknown as typeof execFile);

    const r = await getGithubToken({ env: {} });
    expect(r.source).toBe('gh_cli');
    expect(r.token).toBe('gho_fromRealRunner');
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(file).toBe('gh');
    expect(args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(options.shell).toBeUndefined();
    expect(options.timeout).toBe(3000);
  });

  it('runs gh from a neutral directory with the current-directory executable search disabled', async () => {
    const exec = vi.mocked(execFile);
    exec.mockClear();
    exec.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      cb(null, 'gho_fromRealRunner\n', '');
      return {} as never;
    }) as unknown as typeof execFile);

    await getGithubToken({ env: {} });
    const options = exec.mock.calls[0]![2] as unknown as { cwd?: string; env: Record<string, string | undefined> };
    expect(options.cwd).toBe(homedir() || tmpdir());
    expect(options.cwd).not.toBe(process.cwd());
    expect(options.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
    expect(options.env.GH_PROMPT_DISABLED).toBe('1');
  });

  it('treats a spawn error as no token', async () => {
    const exec = vi.mocked(execFile);
    exec.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      cb(new Error('spawn gh ENOENT'), '', '');
      return {} as never;
    }) as unknown as typeof execFile);
    const r = await getGithubToken({ env: {} });
    expect(r.source).toBe('none');
  });
});
