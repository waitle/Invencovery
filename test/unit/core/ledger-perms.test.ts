import { constants as fsConstants, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerEvent } from '../../../src/types.js';
import { cleanupTmpDirs, makeTmpDir } from '../../helpers/tmp.js';

// Spy on the real fs calls (call-through) to prove the owner-only modes are requested on every platform;
// Windows ignores them, so the on-disk mode is only asserted on POSIX.
const calls = vi.hoisted(() => ({ mkdir: [] as unknown[][], open: [] as unknown[][] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: ((...args: Parameters<typeof actual.mkdirSync>) => {
      calls.mkdir.push(args);
      return actual.mkdirSync(...args);
    }) as typeof actual.mkdirSync,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      calls.open.push(args);
      return actual.openSync(...args);
    }) as typeof actual.openSync,
  };
});

const { openLedger } = await import('../../../src/core/ledger.js');

afterEach(() => {
  cleanupTmpDirs();
  calls.mkdir.length = 0;
  calls.open.length = 0;
});

const event: LedgerEvent = {
  v: 1,
  type: 'component.upsert',
  at: '2026-10-01T00:00:00.000Z',
  component: { id: 'a', name: 'A', description: 'd', keywords: ['k'], status: 'pending' },
};

describe('ledger file permissions', () => {
  it('creates the .recyclewheel directory with mode 0o700 and the ledger file with 0o600', () => {
    const root = makeTmpDir();
    openLedger(root).append(event);

    const dirDir = path.join(root, '.recyclewheel');
    const mk = calls.mkdir.find((a) => a[0] === dirDir);
    expect(mk?.[1]).toEqual({ recursive: true, mode: 0o700 });
    // The append handle is opened append-only and owner-only, with O_NOFOLLOW where the platform has it (N-1, M3).
    const ap = calls.open.find((a) => a[0] === path.join(dirDir, 'ledger.jsonl') && ((a[1] as number) & fsConstants.O_APPEND) !== 0);
    expect(ap?.[2]).toBe(0o600);
    expect((ap?.[1] as number) & fsConstants.O_CREAT).toBe(fsConstants.O_CREAT);
    if (typeof fsConstants.O_NOFOLLOW === 'number') expect((ap?.[1] as number) & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);

    if (process.platform !== 'win32') {
      expect(statSync(dirDir).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(dirDir, 'ledger.jsonl')).mode & 0o777).toBe(0o600);
    }
  });

  it('still appends to an existing ledger', () => {
    const root = makeTmpDir();
    const ledger = openLedger(root);
    ledger.append(event);
    ledger.append({ ...event, component: { ...event.component, id: 'b' } } as LedgerEvent);
    expect(ledger.read().components.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
