/**
 * Doctor and status hardening: project_root cannot be (or reach into) the ledger
 * directory (L-A / L-B), a linked ledger location is reported instead of followed
 * (N-1), and secrets never reach doctor or status output (L-G).
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRootError, collectStatus, formatDoctor, resolveProjectRoot, runDoctor } from '../../src/doctor.js';
import { createHarness } from './mcp/_harness.js';
import type { Harness } from './mcp/_harness.js';
import { cleanupTmpDirs, makeTmpDir } from '../helpers/tmp.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupTmpDirs();
});

const win = process.platform === 'win32';
const winOnly = win ? it : it.skip;

function rootWithLedgerDir() {
  const root = makeTmpDir('rw-root-');
  mkdirSync(join(root, '.recyclewheel'));
  mkdirSync(join(root, 'sub'));
  return { root, cfg: { projectRoot: root } };
}

describe('resolveProjectRoot and the ledger directory (L-A / L-B)', () => {
  it.each(['.recyclewheel', '.recyclewheel/sub', './.recyclewheel', 'sub/../.recyclewheel/x', '.RecycleWheel', '.recyclewheel/not/yet/created'])(
    'rejects %s',
    (arg) => {
      const { cfg } = rootWithLedgerDir();
      expect(() => resolveProjectRoot(cfg, arg)).toThrow(ProjectRootError);
      expect(() => resolveProjectRoot(cfg, arg)).toThrow(/\.recyclewheel/);
    },
  );

  it('rejects the absolute spelling of the ledger directory too', () => {
    const { root, cfg } = rootWithLedgerDir();
    expect(() => resolveProjectRoot(cfg, join(root, '.recyclewheel'))).toThrow(ProjectRootError);
    expect(() => resolveProjectRoot(cfg, join(root, '.recyclewheel', 'deeper'))).toThrow(ProjectRootError);
  });

  winOnly.each(['.recyclewheel::$INDEX_ALLOCATION', 'RECYCL~1', '.recyclewheel./x', 'sub:stream'])('rejects the Windows spelling %s', (arg) => {
    const { cfg } = rootWithLedgerDir();
    expect(() => resolveProjectRoot(cfg, arg)).toThrow(ProjectRootError);
  });

  it('rejects a junction that points at the ledger directory', () => {
    const { root, cfg } = rootWithLedgerDir();
    symlinkSync(join(root, '.recyclewheel'), join(root, 'alias'), 'junction');
    expect(() => resolveProjectRoot(cfg, 'alias')).toThrow(ProjectRootError);
    expect(() => resolveProjectRoot(cfg, 'alias/child')).toThrow(ProjectRootError);
  });

  it('still accepts ordinary sub-directories and names that merely start with the same letters', () => {
    const { root, cfg } = rootWithLedgerDir();
    mkdirSync(join(root, '.recyclewheel-notes'));
    expect(resolveProjectRoot(cfg, 'sub')).toBe(join(root, 'sub'));
    expect(resolveProjectRoot(cfg, 'recyclewheel')).toBe(join(root, 'recyclewheel'));
    expect(resolveProjectRoot(cfg, '.')).toBe(root);
  });
});

describe('collectStatus with a linked ledger location (N-1)', () => {
  it('reports ledger_exists false and a warning instead of following the junction', async () => {
    h = await createHarness();
    const outside = makeTmpDir('rw-outside-');
    writeFileSync(join(outside, 'ledger.jsonl'), '{}\n');
    symlinkSync(outside, join(h.root, '.recyclewheel'), 'junction');
    const report = await collectStatus(h.ctx, { projectRoot: h.root });
    expect(report.ledger_exists).toBe(false);
    expect(report.warnings.some((w) => /ledger location rejected/.test(w))).toBe(true);
  });

  it('is quiet for a normal ledger directory', async () => {
    h = await createHarness();
    mkdirSync(join(h.root, '.recyclewheel'));
    writeFileSync(join(h.root, '.recyclewheel', 'ledger.jsonl'), '');
    const report = await collectStatus(h.ctx, { projectRoot: h.root });
    expect(report.ledger_exists).toBe(true);
    expect(report.warnings.filter((w) => /ledger location/.test(w))).toEqual([]);
  });
});

describe('secret masking in doctor output (L-G)', () => {
  const SECRET = 'lio-secret-key-9876';

  it('masks a secret that ended up inside a config warning or a check message', async () => {
    const dir = makeTmpDir('rw-doctor-');
    const r = await runDoctor({
      env: {
        RECYCLEWHEEL_CACHE_DIR: join(dir, 'cache'),
        RECYCLEWHEEL_PROJECT_ROOT: dir,
        RECYCLEWHEEL_OFFLINE: '1',
        LIBRARIES_IO_API_KEY: SECRET,
        // A mistyped value that is the very secret: whatever the warning echoes must be masked.
        RECYCLEWHEEL_CACHE_MAX_MB: SECRET,
        RECYCLEWHEEL_BUDGET_ROUNDS: `${SECRET}-and-more`,
      },
      runGh: async () => {
        throw new Error(`gh failed with ${SECRET}`);
      },
    });
    const out = JSON.stringify(r) + formatDoctor(r);
    expect(out).not.toContain(SECRET);
    expect(r.checks.find((c) => c.id === 'config')?.level).toBe('warn');
  });

  it('masks secrets in the status warnings as well', async () => {
    const previous = process.env.LIBRARIES_IO_API_KEY;
    process.env.LIBRARIES_IO_API_KEY = SECRET;
    try {
      h = await createHarness({ env: { RECYCLEWHEEL_CACHE_MAX_MB: SECRET } });
      const report = await collectStatus(h.ctx, { projectRoot: h.root });
      expect(JSON.stringify(report)).not.toContain(SECRET);
    } finally {
      if (previous === undefined) delete process.env.LIBRARIES_IO_API_KEY;
      else process.env.LIBRARIES_IO_API_KEY = previous;
    }
  });
});

describe('doctor reports a linked ledger location (N-1)', () => {
  it('adds a ledger_path warning and still exits 0', async () => {
    const dir = makeTmpDir('rw-doctor-');
    const outside = makeTmpDir('rw-outside-');
    symlinkSync(outside, path.join(dir, '.recyclewheel'), 'junction');
    const r = await runDoctor({
      env: { RECYCLEWHEEL_CACHE_DIR: join(dir, 'cache'), RECYCLEWHEEL_PROJECT_ROOT: dir, RECYCLEWHEEL_OFFLINE: '1' },
      runGh: async () => {
        throw new Error('gh: command not found');
      },
    });
    expect(r.checks.find((c) => c.id === 'ledger_path')?.level).toBe('warn');
    expect(r.exitCode).toBe(0);
  });
});
