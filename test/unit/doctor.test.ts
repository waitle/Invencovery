import { mkdirSync, symlinkSync } from 'node:fs';
import path, { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProjectRootError,
  formatDoctor,
  installSqliteWarningFilter,
  isPathInside,
  resolveProjectRoot,
  runDoctor,
} from '../../src/doctor.js';
import { cleanupTmpDirs, makeTmpDir } from '../helpers/tmp.js';

afterEach(cleanupTmpDirs);

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = makeTmpDir('rw-doctor-');
  return { RECYCLEWHEEL_CACHE_DIR: join(dir, 'cache'), RECYCLEWHEEL_PROJECT_ROOT: dir, ...extra };
}

const okFetch = (urls: string[] = []): typeof globalThis.fetch =>
  (async (input: unknown) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ resources: { core: { remaining: 59, limit: 60 }, search: { remaining: 10, limit: 10 } } }), { status: 200 });
  }) as typeof globalThis.fetch;

const ghMissing = async () => {
  throw new Error('gh: command not found');
};

const level = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id)?.level;

describe('runDoctor', () => {
  it('passes on a healthy setup, probing the network once per service', async () => {
    const urls: string[] = [];
    const r = await runDoctor({ env: env(), fetch: okFetch(urls), runGh: async (a) => (a[0] === '--version' ? 'gh version 2.50.0\n' : 'gho_ghtoken123456\n') });
    expect(r.exitCode).toBe(0);
    expect(level(r, 'node')).toBe('ok');
    expect(level(r, 'sqlite')).toBe('ok');
    expect(level(r, 'cache_dir')).toBe('ok');
    expect(level(r, 'gh')).toBe('ok');
    expect(r.checks.find((c) => c.id === 'github_token')?.message).toMatch(/gh auth token/);
    expect(urls).toHaveLength(6);
    expect(r.checks.find((c) => c.id === 'net_github')?.message).toContain('core 59/60');
  });

  it('warns but exits 0 without a token, without gh, and with an unreachable network', async () => {
    const r = await runDoctor({
      env: env(),
      runGh: ghMissing,
      fetch: (async () => {
        throw new Error('offline');
      }) as typeof globalThis.fetch,
    });
    expect(r.exitCode).toBe(0);
    expect(level(r, 'github_token')).toBe('warn');
    expect(level(r, 'gh')).toBe('info');
    expect(level(r, 'net_npm')).toBe('warn');
  });

  it('fails (exit 1) only for a Node version below 22.13', async () => {
    const r = await runDoctor({ env: env({ RECYCLEWHEEL_OFFLINE: '1' }), runGh: ghMissing, nodeVersion: '22.12.0' });
    expect(level(r, 'node')).toBe('fail');
    expect(r.exitCode).toBe(1);
    expect((await runDoctor({ env: env({ RECYCLEWHEEL_OFFLINE: '1' }), runGh: ghMissing, nodeVersion: '22.13.0' })).exitCode).toBe(0);
  });

  it('skips the network in offline mode and with network: false', async () => {
    const urls: string[] = [];
    const a = await runDoctor({ env: env({ RECYCLEWHEEL_OFFLINE: '1' }), fetch: okFetch(urls), runGh: ghMissing });
    const b = await runDoctor({ env: env(), fetch: okFetch(urls), runGh: ghMissing, network: false });
    expect(urls).toHaveLength(0);
    expect(level(a, 'network')).toBe('info');
    expect(level(b, 'network')).toBe('info');
  });

  it('never prints secret values', async () => {
    const r = await runDoctor({
      env: env({
        GITHUB_TOKEN: 'ghp_TESTTOKEN123',
        RECYCLEWHEEL_REMOTE_CACHE_URL: 'https://u:urlsecret@cache.example.com/x',
        RECYCLEWHEEL_REMOTE_CACHE_MODE: 'read',
        RECYCLEWHEEL_REMOTE_CACHE_TOKEN: 'remote-secret-token',
        LIBRARIES_IO_API_KEY: 'lio-secret-key',
      }),
      fetch: okFetch(),
      runGh: ghMissing,
    });
    const out = JSON.stringify(r) + formatDoctor(r);
    for (const s of ['ghp_TESTTOKEN123', 'urlsecret', 'remote-secret-token', 'lio-secret-key']) expect(out).not.toContain(s);
    expect(out).toContain('cache.example.com');
    expect(level(r, 'github_token')).toBe('ok');
  });

  it('reports configuration warnings and formats a summary', async () => {
    const r = await runDoctor({ env: env({ RECYCLEWHEEL_CACHE_MAX_MB: 'abc', RECYCLEWHEEL_OFFLINE: '1' }), runGh: ghMissing });
    expect(level(r, 'config')).toBe('warn');
    expect(formatDoctor(r)).toMatch(/0 failed, 2 warning\(s\)\. Ready\./);
  });
});

describe('helpers', () => {
  it('resolveProjectRoot prefers the argument, resolved against the configured root', () => {
    const cfg = { projectRoot: process.platform === 'win32' ? 'C:\\proj' : '/proj' };
    expect(resolveProjectRoot(cfg)).toBe(cfg.projectRoot);
    expect(resolveProjectRoot(cfg, '  ')).toBe(cfg.projectRoot);
    expect(resolveProjectRoot(cfg, 'sub')).toBe(join(cfg.projectRoot, 'sub'));
  });

  describe('resolveProjectRoot boundary (H-1)', () => {
    const rootOf = () => {
      const root = makeTmpDir('rw-root-');
      mkdirSync(join(root, 'sub', 'deeper'), { recursive: true });
      return { root, cfg: { projectRoot: root } };
    };

    it('accepts the root itself and anything below it, existing or not', () => {
      const { root, cfg } = rootOf();
      expect(resolveProjectRoot(cfg, '.')).toBe(root);
      expect(resolveProjectRoot(cfg, root)).toBe(root);
      expect(resolveProjectRoot(cfg, 'sub/deeper')).toBe(join(root, 'sub', 'deeper'));
      expect(resolveProjectRoot(cfg, 'sub/not/yet/created')).toBe(join(root, 'sub', 'not', 'yet', 'created'));
      expect(resolveProjectRoot(cfg, join(root, 'sub'))).toBe(join(root, 'sub'));
      expect(resolveProjectRoot(cfg, 'sub/../sub')).toBe(join(root, 'sub'));
    });

    it.each(['..', '../x', '../../x', 'sub/../..', 'sub/../../elsewhere', '..\\x', 'sub\\..\\..\\x'])('rejects %s', (arg) => {
      const { cfg } = rootOf();
      if (process.platform !== 'win32' && arg.includes('\\')) {
        // On POSIX a backslash is an ordinary file-name character, so the path stays inside the root.
        expect(() => resolveProjectRoot(cfg, arg)).not.toThrow();
        return;
      }
      expect(() => resolveProjectRoot(cfg, arg)).toThrow(ProjectRootError);
    });

    it('rejects an absolute path outside the root and a sibling that merely shares the prefix', () => {
      const { root, cfg } = rootOf();
      const outside = makeTmpDir('rw-outside-');
      expect(() => resolveProjectRoot(cfg, outside)).toThrow(/outside the server's project root/);
      mkdirSync(`${root}-sibling`, { recursive: true });
      expect(() => resolveProjectRoot(cfg, `${root}-sibling`)).toThrow(ProjectRootError);
      expect(() => resolveProjectRoot(cfg, 'a\0b')).toThrow(ProjectRootError);
    });

    it('the error says what to do instead', () => {
      const { cfg } = rootOf();
      try {
        resolveProjectRoot(cfg, '../x');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectRootError);
        expect((err as Error).message).toContain('Omit project_root');
        expect((err as Error).message).toContain('RECYCLEWHEEL_PROJECT_ROOT');
      }
    });

    it('rejects a symlink or junction that leaves the root, including through a not-yet-created child', () => {
      const { root, cfg } = rootOf();
      const outside = makeTmpDir('rw-outside-');
      try {
        symlinkSync(outside, join(root, 'escape'), 'junction');
      } catch {
        // No symlink privilege on this machine: the pure-path cases above and below still cover the boundary logic.
        return;
      }
      expect(() => resolveProjectRoot(cfg, 'escape')).toThrow(ProjectRootError);
      expect(() => resolveProjectRoot(cfg, 'escape/new/child')).toThrow(ProjectRootError);
    });

    it('accepts a symlink or junction that stays inside the root', () => {
      const { root, cfg } = rootOf();
      try {
        symlinkSync(join(root, 'sub'), join(root, 'alias'), 'junction');
      } catch {
        return;
      }
      expect(resolveProjectRoot(cfg, 'alias')).toBe(join(root, 'alias'));
    });

    it.runIf(process.platform === 'win32')('keeps the boundary for drive letters, UNC paths and case on Windows', () => {
      const { root, cfg } = rootOf();
      expect(() => resolveProjectRoot(cfg, 'C:\\Windows\\System32')).toThrow(ProjectRootError);
      expect(() => resolveProjectRoot(cfg, 'D:\\')).toThrow(ProjectRootError);
      expect(() => resolveProjectRoot(cfg, '\\\\server\\share\\x')).toThrow(ProjectRootError);
      expect(() => resolveProjectRoot(cfg, '\\\\?\\C:\\Windows')).toThrow(ProjectRootError);
      expect(() => resolveProjectRoot(cfg, '\\\\.\\C:\\Windows')).toThrow(ProjectRootError);
      // Windows paths are case-insensitive: a differently-cased spelling of the root is still the root.
      expect(resolveProjectRoot(cfg, root.toUpperCase())).toBe(root.toUpperCase());
      expect(resolveProjectRoot(cfg, root.toLowerCase())).toBe(root.toLowerCase());
      expect(() => resolveProjectRoot(cfg, `${root.toUpperCase()}\\..\\x`)).toThrow(ProjectRootError);
    });
  });

  describe('isPathInside', () => {
    it('windows semantics: drive letters, UNC, case, dot-dot', () => {
      const inside = (r: string, t: string) => isPathInside(r, t, path.win32);
      expect(inside('C:\\proj', 'C:\\proj')).toBe(true);
      expect(inside('C:\\proj', 'C:\\proj\\sub\\x.md')).toBe(true);
      expect(inside('C:\\proj', 'c:\\PROJ\\Sub')).toBe(true);
      expect(inside('C:\\proj', 'C:\\proj2')).toBe(false);
      expect(inside('C:\\proj', 'C:\\proj\\..\\x')).toBe(false);
      expect(inside('C:\\proj', 'C:\\proj\\..')).toBe(false);
      expect(inside('C:\\proj', 'D:\\proj')).toBe(false);
      expect(inside('C:\\proj', '\\\\server\\share\\proj')).toBe(false);
      expect(inside('C:\\proj', '\\\\?\\C:\\proj\\x')).toBe(false);
      expect(inside('\\\\server\\share\\proj', '\\\\server\\share\\proj\\a')).toBe(true);
      expect(inside('\\\\server\\share\\proj', '\\\\other\\share\\proj\\a')).toBe(false);
      expect(inside('C:\\proj', 'C:\\proj\\..foo\\x')).toBe(true); // a name that merely starts with ".."
    });

    it('posix semantics', () => {
      const inside = (r: string, t: string) => isPathInside(r, t, path.posix);
      expect(inside('/proj', '/proj')).toBe(true);
      expect(inside('/proj', '/proj/a/b')).toBe(true);
      expect(inside('/proj', '/proj-other')).toBe(false);
      expect(inside('/proj', '/proj/../etc')).toBe(false);
      expect(inside('/proj', '/etc/passwd')).toBe(false);
      expect(inside('/proj', '/proj/..hidden')).toBe(true);
    });
  });

  it('installSqliteWarningFilter drops only the SQLite experimental warning', async () => {
    installSqliteWarningFilter();
    installSqliteWarningFilter();
    const seen: string[] = [];
    const listener = (w: Error) => seen.push(w.message);
    process.on('warning', listener);
    try {
      process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
      process.emitWarning('Something else is experimental', 'ExperimentalWarning');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('warning', listener);
    }
    expect(seen).toEqual(['Something else is experimental']);
  });
});
