import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerPathError, ledgerPathProblem, openLedger } from '../../../src/core/ledger.js';
import type { LedgerEvent } from '../../../src/types.js';
import { cleanupTmpDirs, makeTmpDir } from '../../helpers/tmp.js';

afterEach(cleanupTmpDirs);

const event: LedgerEvent = {
  v: 1,
  type: 'component.upsert',
  at: '2026-10-01T00:00:00.000Z',
  component: { id: 'a', name: 'A', description: 'd', keywords: ['k'], status: 'pending' },
};

/** A directory junction works on Windows without privileges; elsewhere it is a plain directory symlink. */
function linkDir(target: string, link: string): void {
  symlinkSync(target, link, 'junction');
}

describe('ledger link and containment guard (N-1)', () => {
  it('passes for a missing or ordinary .recyclewheel and still appends and reads', () => {
    const root = makeTmpDir();
    expect(ledgerPathProblem(root)).toBeUndefined();
    expect(ledgerPathProblem(path.join(root, 'does-not-exist'))).toBeUndefined();
    const ledger = openLedger(root);
    expect(ledger.read().components).toEqual([]);
    ledger.append(event);
    expect(ledgerPathProblem(root)).toBeUndefined();
    expect(ledger.read().components.map((c) => c.id)).toEqual(['a']);
  });

  it('refuses to append through a .recyclewheel junction that points outside the root', () => {
    const root = makeTmpDir();
    const outside = makeTmpDir('rw-outside-');
    linkDir(outside, path.join(root, '.recyclewheel'));

    expect(ledgerPathProblem(root)).toMatch(/symbolic link or junction/);
    const ledger = openLedger(root);
    expect(() => ledger.append(event)).toThrow(LedgerPathError);
    expect(() => ledger.append(event)).toThrow(/symbolic link or junction/);
    expect(existsSync(path.join(outside, 'ledger.jsonl'))).toBe(false);
  });

  it('refuses to read through the junction too, without touching the target', () => {
    const root = makeTmpDir();
    const outside = makeTmpDir('rw-outside-');
    const line = JSON.stringify(event);
    writeFileSync(path.join(outside, 'ledger.jsonl'), `${line}\n`);
    linkDir(outside, path.join(root, '.recyclewheel'));

    const ledger = openLedger(root);
    expect(() => ledger.read()).toThrow(LedgerPathError);
    expect(() => ledger.readDetailed()).toThrow(/Refusing to use the ledger/);
    expect(readFileSync(path.join(outside, 'ledger.jsonl'), 'utf8')).toBe(`${line}\n`);
  });

  it('refuses a junction that stays inside the root (a link is a link)', () => {
    const root = makeTmpDir();
    mkdirSync(path.join(root, 'elsewhere'));
    linkDir(path.join(root, 'elsewhere'), path.join(root, '.recyclewheel'));
    expect(() => openLedger(root).append(event)).toThrow(LedgerPathError);
    expect(existsSync(path.join(root, 'elsewhere', 'ledger.jsonl'))).toBe(false);
  });

  it('refuses when .recyclewheel is a regular file', () => {
    const root = makeTmpDir();
    writeFileSync(path.join(root, '.recyclewheel'), 'x');
    expect(ledgerPathProblem(root)).toMatch(/not a directory/);
    expect(() => openLedger(root).read()).toThrow(LedgerPathError);
  });

  it('refuses a symbolic-link ledger.jsonl (conditional: file symlinks need a privilege on Windows)', () => {
    const root = makeTmpDir();
    const outside = path.join(makeTmpDir('rw-outside-'), 'target.jsonl');
    writeFileSync(outside, '');
    mkdirSync(path.join(root, '.recyclewheel'));
    try {
      symlinkSync(outside, path.join(root, '.recyclewheel', 'ledger.jsonl'), 'file');
    } catch {
      // No privilege to create file symlinks here; the directory cases above cover the same guard.
      return;
    }
    expect(ledgerPathProblem(root)).toMatch(/ledger\.jsonl is a symbolic link/);
    expect(() => openLedger(root).append(event)).toThrow(LedgerPathError);
    expect(() => openLedger(root).read()).toThrow(LedgerPathError);
    expect(readFileSync(outside, 'utf8')).toBe('');
  });
});
