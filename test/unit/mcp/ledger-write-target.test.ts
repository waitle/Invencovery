/**
 * resolveWriteTarget (L-A..L-D): Windows spellings that reach the ledger directory,
 * agent configuration files, hidden entries and device names are refused; normal
 * documentation paths keep working.
 */
import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isWindowsDeviceName, resolveWriteTarget } from '../../../src/mcp/tools/ledger.js';
import { cleanupTmpDirs, makeTmpDir } from '../../helpers/tmp.js';

afterEach(cleanupTmpDirs);

const win = process.platform === 'win32';
const winOnly = win ? it : it.skip;

function rootWithLedgerDir(): string {
  const root = makeTmpDir();
  mkdirSync(path.join(root, '.recyclewheel'));
  return root;
}

describe('normal use keeps working', () => {
  it.each([
    ['docs/REUSE.md', 'markdown'],
    ['THIRD_PARTY_NOTICES.md', 'notices'],
    ['reports/x.md', 'markdown'],
    ['export.json', 'json'],
    ['docs/deep/er/REPORT.md', 'markdown'],
    ['README.md', 'markdown'],
  ] as const)('%s', (writeTo, format) => {
    const root = rootWithLedgerDir();
    const r = resolveWriteTarget(root, writeTo, format);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    if (r.ok) expect(r.target).toBe(path.resolve(root, writeTo));
  });
});

describe('agent instruction files and dot-segments (L-C)', () => {
  it.each([
    'CLAUDE.md',
    'claude.md',
    'Claude.MD',
    'AGENTS.md',
    'agents.md',
    'GEMINI.md',
    'docs/Gemini.md',
    'copilot-instructions.md',
    'docs/COPILOT-INSTRUCTIONS.md',
  ])('refuses %s with the allowed example in the message', (writeTo) => {
    const r = resolveWriteTarget(rootWithLedgerDir(), writeTo, 'markdown');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/agent instruction file/);
      expect(r.error).toContain('docs/REUSE.md');
    }
  });

  it.each([
    '.cursorrules',
    '.claude/x.md',
    '.github/x.md',
    '.git/x.md',
    '.vscode/x.md',
    'docs/.hidden.md',
    'docs/.md',
    '.md',
    '.json',
    'a/.b/c.md',
  ])('refuses the dot-segment path %s', (writeTo) => {
    const r = resolveWriteTarget(rootWithLedgerDir(), writeTo, writeTo.endsWith('.json') ? 'json' : 'markdown');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('docs/REUSE.md');
  });

  it('does not put README.md on the agent-file list', () => {
    const r = resolveWriteTarget(rootWithLedgerDir(), 'README.md', 'markdown');
    expect(r.ok).toBe(true);
  });
});

describe('the ledger directory by any spelling (L-A / L-B)', () => {
  it.each(['.recyclewheel/x.md', '.recyclewheel/ledger.jsonl', './.recyclewheel/x.md', 'docs/../.recyclewheel/x.md'])(
    'refuses %s',
    (writeTo) => {
      const r = resolveWriteTarget(rootWithLedgerDir(), writeTo, 'markdown');
      expect(r.ok).toBe(false);
    },
  );

  winOnly.each([
    ['8.3 short name', 'RECYCL~1/x.md'],
    ['upper case', '.RECYCLEWHEEL/x.md'],
    ['directory index stream', '.recyclewheel::$INDEX_ALLOCATION/z.md'],
    ['trailing dot', '.recyclewheel./x.md'],
    ['trailing space', '.recyclewheel /x.md'],
  ])('refuses the Windows spelling: %s', (_what, writeTo) => {
    const r = resolveWriteTarget(rootWithLedgerDir(), writeTo, 'markdown');
    expect(r.ok, writeTo).toBe(false);
  });

  it.each([
    ['alternate data stream', 'package.json:s.md'],
    ['stream with type', 'docs/REUSE.md::$DATA'],
    ['stream on a folder', 'docs:x/REUSE.md'],
    ['8.3 short name', 'PROGRA~1/x.md'],
    ['8.3 short name file', 'docs/LONGNA~1.md'],
    ['trailing dot', 'docs./x.md'],
    ['trailing space', 'docs /x.md'],
  ])('refuses the special segment: %s', (_what, writeTo) => {
    const r = resolveWriteTarget(rootWithLedgerDir(), writeTo, writeTo.endsWith('.json') ? 'json' : 'markdown');
    expect(r.ok, writeTo).toBe(false);
  });

  it('refuses a junction or symlink alias that points at .recyclewheel', () => {
    const root = rootWithLedgerDir();
    symlinkSync(path.join(root, '.recyclewheel'), path.join(root, 'alias'), 'junction');
    const r = resolveWriteTarget(root, 'alias/x.md', 'markdown');
    expect(r.ok).toBe(false);
  });

  it('refuses a junction that leaves the project root', () => {
    const root = rootWithLedgerDir();
    const outside = makeTmpDir('rw-outside-');
    symlinkSync(outside, path.join(root, 'out'), 'junction');
    expect(resolveWriteTarget(root, 'out/x.md', 'markdown').ok).toBe(false);
  });
});

describe('Windows device names (L-D)', () => {
  it.each(['nul', 'NUL', 'con', 'con.txt', 'nul.x', 'con.txt.md', 'nul.x.md', 'aux.md', 'prn.a.b.md', 'com1.md', 'LPT9.x', 'conin$', 'CONOUT$.md', 'com¹.md'])(
    'isWindowsDeviceName(%s) is true',
    (name) => {
      expect(isWindowsDeviceName(name)).toBe(true);
    },
  );

  it.each(['console.md', 'nulls.md', 'docs', 'xcon.md', 'com10.md', 'REUSE.md', 'a.nul.md', 'comm.md'])('isWindowsDeviceName(%s) is false', (name) => {
    expect(isWindowsDeviceName(name)).toBe(false);
  });

  winOnly.each(['nul.x.md', 'con.txt.md', 'docs/aux.md', 'CON.md', 'docs/prn.report.md'])('refuses %s as a write target on Windows', (writeTo) => {
    expect(resolveWriteTarget(rootWithLedgerDir(), writeTo, 'markdown').ok).toBe(false);
  });
});

describe('containment', () => {
  it.each(['../escape.md', 'docs/../../escape.md', '..\\escape.md', 'a/../..'])('refuses %s', (writeTo) => {
    expect(resolveWriteTarget(rootWithLedgerDir(), writeTo, 'markdown').ok).toBe(false);
  });

  it('refuses an empty path, a NUL byte and the root itself', () => {
    const root = rootWithLedgerDir();
    expect(resolveWriteTarget(root, '  ', 'markdown').ok).toBe(false);
    expect(resolveWriteTarget(root, 'a\0b.md', 'markdown').ok).toBe(false);
    expect(resolveWriteTarget(root, '.', 'markdown').ok).toBe(false);
  });

  it('refuses extensions other than .md and .json', () => {
    const root = rootWithLedgerDir();
    for (const p of ['x.txt', 'x.js', 'x.sh', 'x.yml', 'noext']) expect(resolveWriteTarget(root, p, 'markdown').ok, p).toBe(false);
  });
});

describe('agent configuration names and folders (second re-check M4)', () => {
  it.each([
    'SKILL.md',
    'skill.md',
    'docs/Skill.MD',
    'CLAUDE.local.md',
    'claude.LOCAL.md',
    'AGENT.md',
    'docs/agent.md',
    'QWEN.md',
    'qwen.md',
    'WARP.md',
    'docs/warp.md',
    '.windsurfrules',
    '.WINDSURFRULES',
  ])('refuses the file name %s and shows the allowed example', (writeTo) => {
    const r = resolveWriteTarget(rootWithLedgerDir(), writeTo, 'markdown');
    expect(r.ok, writeTo).toBe(false);
    if (!r.ok) expect(r.error).toContain('docs/REUSE.md');
  });

  it.each([
    'commands/x.md',
    'Commands/x.md',
    'agents/x.md',
    'Agents/x.md',
    'AGENTS/x.md',
    'skills/x.md',
    'hooks/x.md',
    'docs/commands/x.md',
    'docs/skills/deep/x.md',
    '.claude/commands/x.md',
  ])('refuses the folder in %s with a reason', (writeTo) => {
    const r = resolveWriteTarget(rootWithLedgerDir(), writeTo, 'markdown');
    expect(r.ok, writeTo).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('docs/REUSE.md');
      expect(r.error).toMatch(/hidden entry|folder named/);
    }
  });

  it.each(['commands.md', 'docs/agents.json', 'docs/skills-list.md', 'docs/hooked.md', 'agent-notes.md', 'docs/skill-overview.md', 'warp-notes.md'])(
    'still allows the look-alike %s',
    (writeTo) => {
      const r = resolveWriteTarget(rootWithLedgerDir(), writeTo, writeTo.endsWith('.json') ? 'json' : 'markdown');
      expect(r.ok, JSON.stringify(r)).toBe(true);
    },
  );

  it.each(['docs/REUSE.md', 'THIRD_PARTY_NOTICES.md', 'reports/x.md', 'export.json', 'docs/한글-보고서.md', 'docs/a-b_c.1.md'])(
    'normal path %s keeps working',
    (writeTo) => {
      const r = resolveWriteTarget(rootWithLedgerDir(), writeTo, writeTo.endsWith('.json') ? 'json' : 'markdown');
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    },
  );
});

describe('links inside the project root (second re-check M4)', () => {
  function rootWith(dirs: string[]): string {
    const root = rootWithLedgerDir();
    for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true });
    return root;
  }

  it.each(['.claude', 'commands', 'agents', 'skills', 'hooks', 'Commands'])('refuses docs/link when it is a junction to %s', (dir) => {
    const root = rootWith(['docs', dir]);
    symlinkSync(path.join(root, dir), path.join(root, 'docs', 'link'), 'junction');
    const r = resolveWriteTarget(root, 'docs/link/x.md', 'markdown');
    expect(r.ok, dir).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('through a link');
      expect(r.error).toContain('docs/REUSE.md');
    }
  });

  it('refuses docs/link when it is a junction to .recyclewheel', () => {
    const root = rootWith(['docs']);
    symlinkSync(path.join(root, '.recyclewheel'), path.join(root, 'docs', 'link'), 'junction');
    const r = resolveWriteTarget(root, 'docs/link/x.md', 'markdown');
    expect(r.ok).toBe(false);
  });

  it('refuses a link to a folder below an agent folder', () => {
    const root = rootWith(['docs', '.claude/deep']);
    symlinkSync(path.join(root, '.claude', 'deep'), path.join(root, 'docs', 'link'), 'junction');
    expect(resolveWriteTarget(root, 'docs/link/x.md', 'markdown').ok).toBe(false);
  });

  it('still allows a link to an ordinary folder inside the root', () => {
    const root = rootWith(['docs', 'reports']);
    symlinkSync(path.join(root, 'reports'), path.join(root, 'docs', 'link'), 'junction');
    const r = resolveWriteTarget(root, 'docs/link/x.md', 'markdown');
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});
