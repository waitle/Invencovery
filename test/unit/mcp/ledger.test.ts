import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ledgerTool } from '../../../src/mcp/tools/ledger.js';
import type { LedgerState } from '../../../src/types.js';
import { cleanupTmpDirs, makeTmpDir } from '../../helpers/tmp.js';
import { connect, makeCtx, seedLedger } from './_t20-helpers.js';
import type { Connected } from './_t20-helpers.js';

let conn: Connected | undefined;
afterEach(async () => {
  await conn?.close();
  conn = undefined;
  cleanupTmpDirs();
});

async function setup(seed = true) {
  const t = makeCtx();
  if (seed) seedLedger(t.root);
  conn = await connect(ledgerTool, t.ctx);
  return { t, call: conn.call };
}

describe('rw_ledger', () => {
  it('advertises schemas', async () => {
    const { call } = await setup();
    const { tools } = await conn!.client.listTools();
    expect(tools[0]?.name).toBe('rw_ledger');
    expect(tools[0]?.inputSchema).toBeDefined();
    expect(tools[0]?.outputSchema).toBeDefined();
    expect(call).toBeDefined();
  });

  it('get returns the Markdown Reuse Report by default, with a summary', async () => {
    const { call } = await setup();
    const r = await call('rw_ledger', { action: 'get' });
    expect(r.isError).toBe(false);
    expect(r.structured?.format).toBe('markdown');
    expect(r.structured?.truncated).toBe(false);
    expect(String(r.structured?.content)).toContain('| Component | Decision | Choice | License | Score | Evidence | Rationale |');
    expect(r.structured?.summary).toEqual({
      components: 2,
      decided: 1,
      by_decision: { adopt: 1, extend: 0, reference: 0, build: 0 },
      undecided: ['cmp_cli'],
    });
    expect(r.text).toContain('# Reuse Report');
  });

  it('supports json and notices formats and component scoping', async () => {
    const { call } = await setup();
    const json = await call('rw_ledger', { action: 'get', format: 'json', component_id: 'cmp_markdown' });
    const state = JSON.parse(String(json.structured?.content)) as LedgerState;
    expect(state.components.map((c) => c.id)).toEqual(['cmp_markdown']);
    const notices = await call('rw_ledger', { action: 'export', format: 'notices' });
    expect(String(notices.structured?.content)).toContain('## marked');
    expect(String(notices.structured?.content)).toContain('License: MIT');
  });

  it('rejects an unknown component_id and lists the known ones', async () => {
    const { call } = await setup();
    const r = await call('rw_ledger', { action: 'get', component_id: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('cmp_markdown');
  });

  it('works on an empty ledger', async () => {
    const { call } = await setup(false);
    const r = await call('rw_ledger', { action: 'get' });
    expect(r.isError).toBe(false);
    expect(r.structured?.summary).toMatchObject({ components: 0, decided: 0 });
  });

  it('truncates the response content at 50KB without touching the written file', async () => {
    const t = makeCtx();
    const big = 'x'.repeat(2000);
    const components = Array.from({ length: 60 }, (_, i) => ({
      id: `cmp_${i}`,
      name: `${big}-${i}`,
      description: 'd',
      keywords: ['k'],
      status: 'pending' as const,
    }));
    const state: LedgerState = { components, evidence: [], evaluations: [], decisions: [], history: [] };
    t.ctx.ledger = () => ({ path: join(t.root, 'x'), append: () => undefined, read: () => state });
    conn = await connect(ledgerTool, t.ctx);
    const r = await conn.call('rw_ledger', { action: 'export', write_to: 'docs/REUSE.md' });
    expect(r.isError).toBe(false);
    expect(r.structured?.truncated).toBe(true);
    expect(Buffer.byteLength(String(r.structured?.content))).toBeLessThanOrEqual(50 * 1024);
    expect(readFileSync(join(t.root, 'docs', 'REUSE.md'), 'utf8').length).toBeGreaterThan(50 * 1024);
  });

  describe('write_to', () => {
    it('writes inside the project root and can be repeated', async () => {
      const { t, call } = await setup();
      const r = await call('rw_ledger', { action: 'export', write_to: 'docs/REUSE.md' });
      expect(r.isError).toBe(false);
      expect(r.structured?.path).toBe(join(t.root, 'docs', 'REUSE.md'));
      expect(readFileSync(join(t.root, 'docs', 'REUSE.md'), 'utf8')).toContain('# Reuse Report');
      expect((await call('rw_ledger', { action: 'export', write_to: 'docs/REUSE.md' })).isError).toBe(false);
    });

    it.each(['../escape.md', '..\\escape.md', 'docs/../../escape.md'])('rejects %s (outside the root)', async (p) => {
      const { t, call } = await setup();
      const r = await call('rw_ledger', { action: 'export', write_to: p });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/outside the project root/);
      expect(existsSync(join(t.root, '..', 'escape.md'))).toBe(false);
    });

    it('rejects an absolute path outside the root', async () => {
      const { call } = await setup();
      const outside = join(makeTmpDir('rw-outside-'), 'x.md');
      const r = await call('rw_ledger', { action: 'export', write_to: outside });
      expect(r.isError).toBe(true);
      expect(existsSync(outside)).toBe(false);
    });

    it('rejects a symlinked directory that leaves the root', async () => {
      const { t, call } = await setup();
      const outside = makeTmpDir('rw-outside-');
      try {
        symlinkSync(outside, join(t.root, 'link'), 'junction');
      } catch {
        return; // platform without symlink support: nothing to test
      }
      const r = await call('rw_ledger', { action: 'export', write_to: 'link/x.md' });
      expect(r.isError).toBe(true);
      expect(existsSync(join(outside, 'x.md'))).toBe(false);
    });

    it('refuses to write into .recyclewheel/', async () => {
      const { call } = await setup();
      const r = await call('rw_ledger', { action: 'export', write_to: '.recyclewheel/ledger.jsonl' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('.recyclewheel');
    });

    it('never overwrites a hand-written THIRD_PARTY_NOTICES.md, but refreshes its own draft', async () => {
      const { t, call } = await setup();
      const file = join(t.root, 'THIRD_PARTY_NOTICES.md');
      writeFileSync(file, '# Third-party notices\n\nhand written\n');
      const r = await call('rw_ledger', { action: 'export', format: 'notices', write_to: 'THIRD_PARTY_NOTICES.md' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/without write_to/);
      expect(readFileSync(file, 'utf8')).toContain('hand written');

      const draft = await call('rw_ledger', { action: 'export', format: 'notices', write_to: 'NOTICES.draft.md' });
      expect(draft.isError).toBe(false);
      expect((await call('rw_ledger', { action: 'export', format: 'notices', write_to: 'NOTICES.draft.md' })).isError).toBe(false);
    });

    it('refuses to replace an arbitrary existing file or a directory', async () => {
      const { t, call } = await setup();
      writeFileSync(join(t.root, 'README.md'), 'keep me');
      mkdirSync(join(t.root, 'adir'));
      expect((await call('rw_ledger', { action: 'export', write_to: 'README.md' })).isError).toBe(true);
      expect((await call('rw_ledger', { action: 'export', write_to: 'adir' })).isError).toBe(true);
      expect(readFileSync(join(t.root, 'README.md'), 'utf8')).toBe('keep me');
    });

    it('is only valid with action export', async () => {
      const { call } = await setup();
      const r = await call('rw_ledger', { action: 'get', write_to: 'docs/REUSE.md' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("action: 'export'");
    });

    describe('extension allow-list (.md / .json only)', () => {
      it.each(['docs/REUSE.md', 'docs/REUSE.MD', 'docs/Reuse.Md', 'out.json', 'out.JSON'])('allows %s', async (p) => {
        const { t, call } = await setup();
        const r = await call('rw_ledger', { action: 'export', format: p.toLowerCase().endsWith('json') ? 'json' : 'markdown', write_to: p });
        expect(r.isError).toBe(false);
        expect(existsSync(join(t.root, p))).toBe(true);
      });

      it.each([
        'notes.txt',
        'script.js',
        'run.cmd',
        'evil.exe',
        'ledger.jsonl',
        'README',
        'docs/noext',
        '.gitignore',
        '.env',
        'x.md.txt',
        'x.md.',
        'x.md:stream',
        'x.markdown',
        'x.json5',
        'package.json.bak',
      ])('rejects %s', async (p) => {
        const { t, call } = await setup();
        const r = await call('rw_ledger', { action: 'export', write_to: p });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/\.md or \.json/);
        expect(existsSync(join(t.root, p))).toBe(false);
      });

      it('names the missing extension in the message', async () => {
        const { call } = await setup();
        expect((await call('rw_ledger', { action: 'export', write_to: 'noext' })).text).toContain('no extension');
        expect((await call('rw_ledger', { action: 'export', write_to: 'a.txt' })).text).toContain('`.txt`');
      });

      it('still reports .recyclewheel/ for ledger paths', async () => {
        const { call } = await setup();
        const r = await call('rw_ledger', { action: 'export', write_to: '.recyclewheel/anything.md' });
        expect(r.isError).toBe(true);
        expect(r.text).toContain('.recyclewheel');
      });

      it.runIf(process.platform === 'win32')('rejects Windows device names', async () => {
        const { call } = await setup();
        for (const p of ['con.md', 'NUL.json', 'docs/aux.md', 'COM1.md']) {
          expect((await call('rw_ledger', { action: 'export', write_to: p })).isError).toBe(true);
        }
      });
    });

    describe('Windows-style and absolute paths', () => {
      it.runIf(process.platform === 'win32')('rejects drive letters, UNC paths and backslash traversal', async () => {
        const { t, call } = await setup();
        const other = process.env.SystemRoot ?? 'C:\\Windows';
        for (const p of [
          `${other}\\recyclewheel-test.md`,
          'D:\\recyclewheel-test.md',
          '\\\\server\\share\\x.md',
          '\\\\?\\C:\\recyclewheel-test.md',
          '..\\..\\x.md',
          'docs\\..\\..\\x.md',
          '/x.md',
          '\\x.md',
        ]) {
          const r = await call('rw_ledger', { action: 'export', write_to: p });
          expect(r.isError, p).toBe(true);
        }
        expect(existsSync(join(t.root, '..', 'x.md'))).toBe(false);
      });

      it.runIf(process.platform === 'win32')('treats the root case-insensitively but still contains the target', async () => {
        const { t, call } = await setup();
        const upper = join(t.root.toUpperCase(), 'docs', 'CASE.md');
        const r = await call('rw_ledger', { action: 'export', write_to: upper });
        expect(r.isError).toBe(false);
        expect(existsSync(join(t.root, 'docs', 'CASE.md'))).toBe(true);
        const escape = await call('rw_ledger', { action: 'export', write_to: `${t.root.toUpperCase()}\\..\\escape.md` });
        expect(escape.isError).toBe(true);
      });

      it('accepts an absolute path inside the root', async () => {
        const { t, call } = await setup();
        const r = await call('rw_ledger', { action: 'export', write_to: join(t.root, 'docs', 'ABS.md') });
        expect(r.isError).toBe(false);
        expect(existsSync(join(t.root, 'docs', 'ABS.md'))).toBe(true);
      });

      it('rejects a dangling symlink or junction that points outside', async () => {
        const { t, call } = await setup();
        const outside = join(makeTmpDir('rw-outside-'), 'gone.md');
        try {
          symlinkSync(outside, join(t.root, 'dangling.md'), 'file');
        } catch {
          return; // creating file symlinks needs a privilege on Windows; the directory-junction test above covers the same code path
        }
        const r = await call('rw_ledger', { action: 'export', write_to: 'dangling.md' });
        expect(r.isError).toBe(true);
        expect(existsSync(outside)).toBe(false);
      });
    });

    describe('export marker (overwrite guard)', () => {
      it('writes the marker as the first line of markdown and notices exports', async () => {
        const { t, call } = await setup();
        await call('rw_ledger', { action: 'export', write_to: 'docs/REUSE.md' });
        await call('rw_ledger', { action: 'export', format: 'notices', write_to: 'NOTICES.draft.md' });
        expect(readFileSync(join(t.root, 'docs', 'REUSE.md'), 'utf8').split('\n')[0]).toBe('<!-- recyclewheel:export v1 -->');
        expect(readFileSync(join(t.root, 'NOTICES.draft.md'), 'utf8').split('\n')[0]).toBe('<!-- recyclewheel:export v1 -->');
      });

      it('writes "recyclewheel_export": 1 as the first key of json exports, and can refresh them', async () => {
        const { t, call } = await setup();
        const r = await call('rw_ledger', { action: 'export', format: 'json', write_to: 'out.json' });
        expect(r.isError).toBe(false);
        const text = readFileSync(join(t.root, 'out.json'), 'utf8');
        expect(Object.keys(JSON.parse(text) as object)[0]).toBe('recyclewheel_export');
        expect((JSON.parse(text) as { recyclewheel_export: number }).recyclewheel_export).toBe(1);
        expect(text).toMatch(/^\{\s*"recyclewheel_export": 1,/);
        expect((await call('rw_ledger', { action: 'export', format: 'json', write_to: 'out.json' })).isError).toBe(false);
      });

      it('refuses to overwrite a markdown file that has the old header but no marker', async () => {
        const { t, call } = await setup();
        const file = join(t.root, 'docs', 'REUSE.md');
        mkdirSync(join(t.root, 'docs'));
        writeFileSync(file, '# Reuse Report\n\nwritten by an older version\n');
        const r = await call('rw_ledger', { action: 'export', write_to: 'docs/REUSE.md' });
        expect(r.isError).toBe(true);
        expect(r.text).toContain('export marker');
        expect(r.text).toMatch(/different path|delete the existing file/);
        expect(readFileSync(file, 'utf8')).toContain('older version');
      });

      it('refuses a marker that is not on the first line, or a mismatching header', async () => {
        const { t, call } = await setup();
        writeFileSync(join(t.root, 'a.md'), '\n<!-- recyclewheel:export v1 -->\n# Reuse Report\n');
        writeFileSync(join(t.root, 'b.md'), 'intro\n<!-- recyclewheel:export v1 -->\n# Reuse Report\n');
        writeFileSync(join(t.root, 'c.md'), '<!-- recyclewheel:export v1 -->\n# Something else\n');
        writeFileSync(join(t.root, 'd.md'), '<!-- recyclewheel:export v1 -->\n# Third-Party Notices (draft)\n');
        for (const p of ['a.md', 'b.md', 'c.md', 'd.md']) {
          expect((await call('rw_ledger', { action: 'export', write_to: p })).isError, p).toBe(true);
        }
      });

      it('refuses json files without the marker, even if they look like ledger state', async () => {
        const { t, call } = await setup();
        writeFileSync(join(t.root, 'old.json'), '{\n  "components": [],\n  "decisions": []\n}\n');
        writeFileSync(join(t.root, 'late.json'), '{\n  "components": [],\n  "recyclewheel_export": 1\n}\n');
        writeFileSync(join(t.root, 'two.json'), '{\n  "recyclewheel_export": 2,\n  "components": []\n}\n');
        writeFileSync(join(t.root, 'package.json'), '{"name":"x","scripts":{},"components":1}');
        for (const p of ['old.json', 'late.json', 'two.json', 'package.json']) {
          const r = await call('rw_ledger', { action: 'export', format: 'json', write_to: p });
          expect(r.isError, p).toBe(true);
        }
        expect(readFileSync(join(t.root, 'package.json'), 'utf8')).toContain('"name":"x"');
      });

      it('does not let a markdown export overwrite a json export or vice versa', async () => {
        const { call } = await setup();
        expect((await call('rw_ledger', { action: 'export', format: 'json', write_to: 'x.json' })).isError).toBe(false);
        expect((await call('rw_ledger', { action: 'export', format: 'markdown', write_to: 'x.json' })).isError).toBe(true);
        expect((await call('rw_ledger', { action: 'export', format: 'markdown', write_to: 'y.md' })).isError).toBe(false);
        expect((await call('rw_ledger', { action: 'export', format: 'json', write_to: 'y.md' })).isError).toBe(true);
        expect((await call('rw_ledger', { action: 'export', format: 'notices', write_to: 'y.md' })).isError).toBe(true);
      });
    });
  });

  describe('project_root boundary (H-1)', () => {
    it('defaults to the server root and accepts a directory inside it', async () => {
      const { t, call } = await setup();
      mkdirSync(join(t.root, 'subproject'));
      expect((await call('rw_ledger', { action: 'get' })).isError).toBe(false);
      expect((await call('rw_ledger', { action: 'get', project_root: t.root })).isError).toBe(false);
      const sub = await call('rw_ledger', { action: 'export', project_root: 'subproject', write_to: 'docs/REUSE.md' });
      expect(sub.isError).toBe(false);
      expect(existsSync(join(t.root, 'subproject', 'docs', 'REUSE.md'))).toBe(true);
    });

    it('refuses to write files into an arbitrary directory via project_root + write_to', async () => {
      const { call } = await setup();
      const outside = makeTmpDir('rw-victim-');
      for (const args of [
        { project_root: outside, write_to: 'x.md' },
        { project_root: outside, write_to: 'docs/REUSE.md' },
        { project_root: '..', write_to: 'x.md' },
        { project_root: '../..', write_to: 'x.md' },
        { project_root: join(outside, 'deeper'), write_to: 'x.md' },
      ]) {
        const r = await call('rw_ledger', { action: 'export', ...args });
        expect(r.isError, JSON.stringify(args)).toBe(true);
        expect(r.text).toMatch(/outside the server's project root/);
      }
      expect(existsSync(join(outside, 'x.md'))).toBe(false);
      expect(existsSync(join(outside, 'docs'))).toBe(false);
    });

    it('refuses to read another directory too (get)', async () => {
      const { call } = await setup();
      const r = await call('rw_ledger', { action: 'get', project_root: makeTmpDir('rw-victim-') });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('RECYCLEWHEEL_PROJECT_ROOT');
    });

    it('rejects a project_root that escapes through a junction or symlink', async () => {
      const { t, call } = await setup();
      const outside = makeTmpDir('rw-victim-');
      try {
        symlinkSync(outside, join(t.root, 'portal'), 'junction');
      } catch {
        return;
      }
      const r = await call('rw_ledger', { action: 'export', project_root: 'portal', write_to: 'x.md' });
      expect(r.isError).toBe(true);
      expect(existsSync(join(outside, 'x.md'))).toBe(false);
    });
  });
});
