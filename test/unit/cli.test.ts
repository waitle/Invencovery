import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeLogger, runCli } from '../../src/cli.js';
import type { CliIo } from '../../src/cli.js';
import { VERSION } from '../../src/doctor.js';
import { cleanupTmpDirs, makeTmpDir } from '../helpers/tmp.js';
import { seedLedger } from './mcp/_t20-helpers.js';

afterEach(cleanupTmpDirs);

function io(extra: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[]; dir: string } {
  const dir = makeTmpDir('rw-cli-');
  const out: string[] = [];
  const err: string[] = [];
  return {
    dir,
    out,
    err,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    env: { RECYCLEWHEEL_CACHE_DIR: join(dir, 'cache'), RECYCLEWHEEL_PROJECT_ROOT: dir, RECYCLEWHEEL_OFFLINE: '1' },
    cwd: dir,
    runGh: async () => {
      throw new Error('no gh');
    },
    ...extra,
  };
}

describe('runCli', () => {
  it('prints the version and help, exiting 0', async () => {
    const a = io();
    expect(await runCli(['--version'], a)).toBe(0);
    expect(a.out.join('')).toBe(`${VERSION}\n`);
    const b = io();
    expect(await runCli(['--help'], b)).toBe(0);
    expect(b.out.join('')).toContain('recyclewheel doctor');
    const c = io();
    expect(await runCli(['doctor', '--help'], c)).toBe(0);
  });

  it('exits 2 with usage for unknown commands, options, and malformed input', async () => {
    for (const argv of [['bogus'], ['doctor', '--nope'], ['ledger'], ['ledger', 'export', '--format', 'pdf'], ['mcp', 'extra'], ['cache-server', '--port', 'abc'], ['cache-server', '--port', '70000']]) {
      const a = io();
      expect(await runCli(argv, a), argv.join(' ')).toBe(2);
      expect(a.err.join('')).toContain('Usage:');
      expect(a.out).toEqual([]);
    }
  });

  it('doctor exits 0 offline and can print JSON', async () => {
    const a = io();
    expect(await runCli(['doctor'], a)).toBe(0);
    expect(a.out.join('')).toContain('[ ok ] node');
    const b = io();
    expect(await runCli(['doctor', '--json', '--no-network'], b)).toBe(0);
    const parsed = JSON.parse(b.out.join('')) as { version: string; exitCode: number; checks: unknown[] };
    expect(parsed).toMatchObject({ version: VERSION, exitCode: 0 });
    expect(parsed.checks.length).toBeGreaterThan(3);
  });

  describe('ledger export', () => {
    it('prints the Reuse Report to stdout by default', async () => {
      const a = io();
      seedLedger(a.dir);
      expect(await runCli(['ledger', 'export'], a)).toBe(0);
      expect(a.out.join('')).toContain('# Reuse Report');
    });

    it('writes with --out inside the root and honours --format and --component', async () => {
      const a = io();
      seedLedger(a.dir);
      expect(await runCli(['ledger', 'export', '--format', 'markdown', '--out', 'docs/REUSE.md'], a)).toBe(0);
      expect(readFileSync(join(a.dir, 'docs', 'REUSE.md'), 'utf8')).toContain('| Markdown |');
      const b = io({ cwd: a.dir, env: a.env });
      expect(await runCli(['ledger', 'export', '--format', 'json', '--component', 'cmp_cli'], b)).toBe(0);
      expect((JSON.parse(b.out.join('')) as { components: { id: string }[] }).components.map((c) => c.id)).toEqual(['cmp_cli']);
    });

    it('refuses paths outside the root and unknown components with exit 1', async () => {
      const a = io();
      seedLedger(a.dir);
      expect(await runCli(['ledger', 'export', '--out', '../evil.md'], a)).toBe(1);
      expect(existsSync(join(a.dir, '..', 'evil.md'))).toBe(false);
      expect(a.err.join('')).toContain('outside the project root');
      const b = io({ cwd: a.dir, env: a.env });
      expect(await runCli(['ledger', 'export', '--component', 'zzz'], b)).toBe(1);
    });

    it('--root selects another project', async () => {
      const a = io();
      const other = makeTmpDir('rw-other-');
      seedLedger(other);
      expect(await runCli(['ledger', 'export', '--root', other], a)).toBe(0);
      expect(a.out.join('')).toContain('Markdown');
    });
  });
});

describe('usage and error output secret masking', () => {
  const SECRET = 'server-write-secret-42';

  it.each([
    [['bogus-command-server-write-secret-42']],
    [['doctor', '--server-write-secret-42']],
    [['cache-server', '--port', 'server-write-secret-42']],
    [['cache-server', '--trusted-hops', 'server-write-secret-42']],
    [['ledger', 'export', '--format', 'server-write-secret-42']],
    [['mcp', 'server-write-secret-42']],
  ])('masks a configured secret that was typed into %j', async (argv) => {
    const a = io({ env: { ...io().env, RECYCLEWHEEL_SERVER_WRITE_TOKEN: SECRET } });
    expect(await runCli(argv, a)).toBe(2);
    const text = a.err.join('');
    expect(text).toContain('Usage:');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('***');
  });

  it('masks GitHub-shaped tokens in usage errors even when they are not configured', async () => {
    const a = io();
    expect(await runCli(['ledger', 'export', '--format', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'], a)).toBe(2);
    expect(a.err.join('')).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });
});

describe('stderr logger secret masking', () => {
  it('masks the values of configured secrets (not only GitHub-shaped tokens)', () => {
    const secrets = {
      GITHUB_TOKEN: 'ghp_ABCDEFGH12345678',
      LIBRARIES_IO_API_KEY: 'libkey-0123456789',
      RECYCLEWHEEL_REMOTE_CACHE_TOKEN: 'remote-token-xyz',
      RECYCLEWHEEL_SERVER_WRITE_TOKEN: 'server-write-secret',
    };
    const a = io({ env: { ...io().env, ...secrets } });
    const log = makeLogger(a, 'debug');
    log.error(`boom libkey-0123456789 and remote-token-xyz and server-write-secret and ${secrets.GITHUB_TOKEN}`);
    log.warn('plain message');
    const text = a.err.join('');
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    expect(text).toContain('boom *** and *** and *** and');
    expect(text).toContain('[recyclewheel] plain message\n');
  });

  it('respects the log level and leaves text alone when no secret is configured', () => {
    const a = io();
    const log = makeLogger(a, 'error');
    log.warn('hidden');
    log.error('shown');
    expect(a.err.join('')).toBe('[recyclewheel] shown\n');
  });
});

describe('cache-server --trusted-hops', () => {
  it.each(['0', '-1', 'abc', '1.5', '99', ''])('rejects %j with usage exit 2', async (value) => {
    const a = io();
    expect(await runCli(['cache-server', '--port', '0', '--trusted-hops', value], a)).toBe(2);
    expect(a.err.join('')).toContain('--trusted-hops');
    expect(a.out).toEqual([]);
  });

  it('is documented in --help', async () => {
    const a = io();
    expect(await runCli(['--help'], a)).toBe(0);
    expect(a.out.join('')).toContain('--trusted-hops <n>');
  });
});
