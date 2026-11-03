import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_LINE_BYTES,
  buildDecision,
  decisionFor,
  distinctEvidenceSources,
  ledgerPath,
  openLedger,
  parseLedgerText,
  reduceEvents,
  renderMarkdown,
  renderNotices,
  serializeEvent,
  summarize,
  truncateContent,
  validateDecision,
} from '../../../src/core/ledger.js';
import type { DecisionInput } from '../../../src/core/ledger.js';
import type {
  Component,
  Decision,
  Evaluation,
  Evidence,
  LedgerEvent,
  LedgerState,
  ProjectInfo,
} from '../../../src/types.js';
import { cleanupTmpDirs, makeTmpDir } from '../../helpers/tmp.js';

afterEach(() => cleanupTmpDirs());

const AT = '2026-10-01T00:00:00.000Z';

const project: ProjectInfo = {
  name: 'Docs Tool',
  summary: 'Converts Markdown to PDF',
  license: 'MIT',
  distribution: 'application',
  ecosystems: ['npm'],
};

function component(id: string, over: Partial<Component> = {}): Component {
  return { id, name: `Comp ${id}`, description: 'd', keywords: ['k'], status: 'pending', ...over };
}

function evidence(id: string, componentId: string, over: Partial<Evidence> = {}): Evidence {
  return { id, component_id: componentId, kind: 'search', at: AT, result_refs: [], summary: 'summary text', ...over };
}

function evaluation(componentId: string, ref: string, over: Partial<Evaluation> = {}): Evaluation {
  return {
    ref,
    component_id: componentId,
    metrics: {},
    scores: { maintenance: 25, popularity: 10, community: 5, license: 20, dependencies: 10, fit: 16 },
    total: 86,
    license: {
      candidate_spdx: 'MIT',
      project_spdx: 'MIT',
      distribution: 'application',
      category: 'permissive',
      verdict: 'compatible',
      obligations: ['Retain copyright and license notice'],
      notes: ['Not legal advice'],
      source: 'github',
    },
    fit: { value: 4, reason: 'covers the use case' },
    flags: [],
    missing: [],
    hint: 'adopt',
    scoring_version: 1,
    provenance: 'live',
    ...over,
  };
}

function decision(id: string, componentId: string, over: Partial<Decision> = {}): Decision {
  return {
    id,
    component_id: componentId,
    decision: 'adopt',
    ref: 'github:o/r',
    rationale: 'Best fit with a compatible license.',
    alternatives: [],
    evidence_ids: [],
    decided_at: AT,
    decided_by: 'agent',
    ...over,
  };
}

function ev(type: 'component.upsert', component: Component): LedgerEvent;
function ev(type: 'evidence.add', evidence: Evidence): LedgerEvent;
function ev(type: 'evaluation.add', evaluation: Evaluation): LedgerEvent;
function ev(type: 'decision.add', decision: Decision): LedgerEvent;
function ev(type: string, payload: unknown): LedgerEvent {
  const key = type.split('.')[0] as string;
  return { v: 1, type, at: AT, [key]: payload } as unknown as LedgerEvent;
}

function stateOf(parts: {
  components?: Component[];
  evidence?: Evidence[];
  evaluations?: Evaluation[];
  decisions?: Decision[];
}): LedgerState {
  return {
    project,
    components: parts.components ?? [],
    evidence: parts.evidence ?? [],
    evaluations: parts.evaluations ?? [],
    decisions: parts.decisions ?? [],
    history: [],
  };
}

describe('openLedger: append and read', () => {
  it('round-trips every event type and creates the directory', () => {
    const root = makeTmpDir();
    const ledger = openLedger(root);
    expect(ledger.path).toBe(path.join(root, '.recyclewheel', 'ledger.jsonl'));
    expect(ledger.path).toBe(ledgerPath(root));

    const events: LedgerEvent[] = [
      { v: 1, type: 'project.set', at: AT, project },
      ev('component.upsert', component('pdf')),
      ev('evidence.add', evidence('ev_1', 'pdf', { sources: ['github_repo', 'npm'] })),
      ev('evaluation.add', evaluation('pdf', 'github:o/r')),
      ev('decision.add', decision('dec_1', 'pdf', { evidence_ids: ['ev_1'] })),
    ];
    for (const e of events) ledger.append(e);

    const state = ledger.read();
    expect(state.project).toEqual(project);
    expect(state.components).toHaveLength(1);
    expect(state.evidence.map((e) => e.id)).toEqual(['ev_1']);
    expect(state.evaluations.map((e) => e.ref)).toEqual(['github:o/r']);
    expect(state.decisions.map((d) => d.id)).toEqual(['dec_1']);
    expect(state.history).toEqual([]);

    const lines = readFileSync(ledger.path, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('reads a missing ledger as an empty state', () => {
    const root = makeTmpDir();
    const detailed = openLedger(root).readDetailed();
    expect(detailed.state).toEqual({ components: [], evidence: [], evaluations: [], decisions: [], history: [] });
    expect(detailed.warnings).toEqual([]);
  });

  it('rejects an invalid event without touching the file', () => {
    const root = makeTmpDir();
    const ledger = openLedger(root);
    const bad = { v: 1, type: 'evidence.add', at: 'not a date', evidence: evidence('ev_1', 'c') } as LedgerEvent;
    expect(() => ledger.append(bad)).toThrow();
    expect(() => statSync(ledger.path)).toThrow();
  });
});

describe('tolerant parsing', () => {
  it('skips corrupt lines with a warning and keeps the valid ones', () => {
    const root = makeTmpDir();
    const ledger = openLedger(root);
    ledger.append(ev('component.upsert', component('a')));
    appendFileSync(ledger.path, '{"v":1,"type":"component.upsert","at":\n', 'utf8'); // truncated JSON
    appendFileSync(ledger.path, 'garbage\n\n', 'utf8');
    appendFileSync(ledger.path, `${JSON.stringify({ v: 1, type: 'future.event', at: AT })}\n`, 'utf8');
    appendFileSync(ledger.path, `${JSON.stringify({ v: 2, type: 'component.upsert', at: AT })}\n`, 'utf8');
    ledger.append(ev('component.upsert', component('b')));

    const { state, warnings } = ledger.readDetailed();
    expect(state.components.map((c) => c.id)).toEqual(['a', 'b']);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('line 2');
    expect(warnings[0]).toContain('not valid JSON');
    expect(warnings[2]).toContain('line 5');
  });

  it('handles CRLF line endings and a UTF-8 BOM', () => {
    const line = JSON.stringify(ev('component.upsert', component('a')));
    const { events, warnings } = parseLedgerText(`﻿${line}\r\n${line.replace('"a"', '"b"')}\r\n`);
    expect(warnings).toEqual([]);
    expect(events).toHaveLength(2);
  });

  it('starts a fresh line when the previous write was torn (no trailing newline)', () => {
    const root = makeTmpDir();
    const ledger = openLedger(root);
    ledger.append(ev('component.upsert', component('a')));
    appendFileSync(ledger.path, '{"v":1,"type":"compo', 'utf8');
    ledger.append(ev('component.upsert', component('b')));

    const { state, warnings } = ledger.readDetailed();
    expect(state.components.map((c) => c.id)).toEqual(['a', 'b']);
    expect(warnings).toHaveLength(1);
  });
});

describe('line size limit', () => {
  it('shrinks oversized evidence below 64KB and keeps it readable', () => {
    const root = makeTmpDir();
    const ledger = openLedger(root);
    const results = Array.from({ length: 400 }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: 'T'.repeat(300),
      note: 'N'.repeat(300),
    }));
    ledger.append(ev('evidence.add', evidence('ev_big', 'c', { kind: 'web', results })));

    const raw = readFileSync(ledger.path, 'utf8');
    expect(Buffer.byteLength(raw.trimEnd(), 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const stored = ledger.read().evidence[0];
    expect(stored?.id).toBe('ev_big');
    expect((stored?.results ?? []).length).toBeGreaterThan(0);
    expect((stored?.results ?? []).length).toBeLessThan(400);
  });

  it('caps oversized free text', () => {
    const line = serializeEvent(ev('decision.add', decision('dec_1', 'c', { rationale: 'x'.repeat(100_000) })));
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const parsed = JSON.parse(line) as { decision: Decision };
    expect(parsed.decision.rationale.length).toBeLessThan(100_000);
  });

  it('throws when an event cannot be shrunk', () => {
    const alternatives = Array.from({ length: 3000 }, (_, i) => ({ ref: `npm:pkg-${i}`, why_not: 'w'.repeat(100) }));
    expect(() => serializeEvent(ev('decision.add', decision('dec_1', 'c', { alternatives })))).toThrow(/exceeds/);
  });
});

describe('reduceEvents', () => {
  it('upserts components by id in place, keeping the latest definition', () => {
    const state = reduceEvents([
      ev('component.upsert', component('a', { name: 'First' })),
      ev('component.upsert', component('b')),
      ev('component.upsert', component('a', { name: 'Renamed' })),
    ]);
    expect(state.components.map((c) => [c.id, c.name])).toEqual([
      ['a', 'Renamed'],
      ['b', 'Comp b'],
    ]);
  });

  it('keeps the newest decision per component and moves older ones to history', () => {
    const state = reduceEvents([
      ev('component.upsert', component('a')),
      ev('decision.add', decision('dec_1', 'a', { decision: 'build', ref: undefined, build_reason: 'trivial' })),
      ev('decision.add', decision('dec_2', 'a', { decision: 'adopt' })),
      ev('decision.add', decision('dec_3', 'b')),
    ]);
    expect(state.decisions.map((d) => d.id)).toEqual(['dec_2', 'dec_3']);
    expect(state.history.map((d) => d.id)).toEqual(['dec_1']);
  });

  it('ignores a repeated decision id (duplicated line after a merge)', () => {
    const d = decision('dec_1', 'a');
    const state = reduceEvents([ev('decision.add', d), ev('decision.add', d)]);
    expect(state.decisions).toHaveLength(1);
    expect(state.history).toEqual([]);
  });

  it('replaces an evaluation of the same component and ref, keeps others', () => {
    const state = reduceEvents([
      ev('evaluation.add', evaluation('a', 'npm:x', { total: 40 })),
      ev('evaluation.add', evaluation('a', 'npm:y', { total: 50 })),
      ev('evaluation.add', evaluation('a', 'npm:x', { total: 80 })),
      ev('evaluation.add', evaluation('b', 'npm:x', { total: 10 })),
    ]);
    expect(state.evaluations.map((e) => [e.component_id, e.ref, e.total])).toEqual([
      ['a', 'npm:x', 80],
      ['a', 'npm:y', 50],
      ['b', 'npm:x', 10],
    ]);
  });

  it('derives component status from evidence and decisions', () => {
    const state = reduceEvents([
      ev('component.upsert', component('idle')),
      ev('component.upsert', component('searched')),
      ev('component.upsert', component('done')),
      ev('evidence.add', evidence('ev_1', 'searched')),
      ev('evidence.add', evidence('ev_2', 'done')),
      ev('decision.add', decision('dec_1', 'done')),
    ]);
    const status = Object.fromEntries(state.components.map((c) => [c.id, c.status]));
    expect(status).toEqual({ idle: 'pending', searched: 'searching', done: 'decided' });
  });
});

describe('concurrent appends from two processes', () => {
  it('loses no lines when two processes append 100 events each', async () => {
    const root = makeTmpDir();
    const work = makeTmpDir('rw-child-');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const ledgerModule = pathToFileURL(path.resolve(here, '../../../src/core/ledger.ts')).href;

    writeFileSync(
      path.join(work, 'hooks.mjs'),
      [
        'export async function resolve(specifier, context, next) {',
        '  try { return await next(specifier, context); }',
        '  catch (err) {',
        "    if (specifier.endsWith('.js') && (specifier.startsWith('.') || specifier.startsWith('file:'))) {",
        "      return next(specifier.slice(0, -3) + '.ts', context);",
        '    }',
        '    throw err;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(work, 'register.mjs'),
      "import { register } from 'node:module';\nregister(new URL('./hooks.mjs', import.meta.url));\n",
    );
    writeFileSync(
      path.join(work, 'child.mjs'),
      [
        `import { openLedger } from ${JSON.stringify(ledgerModule)};`,
        'const [root, tag, count] = process.argv.slice(2);',
        'const ledger = openLedger(root);',
        'for (let i = 0; i < Number(count); i++) {',
        '  ledger.append({',
        "    v: 1, type: 'evidence.add', at: new Date().toISOString(),",
        '    evidence: {',
        '      id: `ev_${tag}_${i}`, component_id: tag,',
        "      kind: 'manual', at: new Date().toISOString(), result_refs: [],",
        "      summary: 'payload '.repeat(300),",
        '    },',
        '  });',
        '}',
        '',
      ].join('\n'),
    );

    const run = (tag: string): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--experimental-strip-types',
            '--no-warnings',
            '--import',
            pathToFileURL(path.join(work, 'register.mjs')).href,
            path.join(work, 'child.mjs'),
            root,
            tag,
            '100',
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr }));
      });

    const results = await Promise.all([run('p1'), run('p2')]);
    for (const r of results) expect(r, r.stderr).toMatchObject({ code: 0 });

    const { state, warnings } = openLedger(root).readDetailed();
    expect(warnings).toEqual([]);
    expect(state.evidence).toHaveLength(200);
    expect(state.evidence.filter((e) => e.component_id === 'p1')).toHaveLength(100);
    expect(state.evidence.filter((e) => e.component_id === 'p2')).toHaveLength(100);
  }, 60_000);
});

describe('distinctEvidenceSources', () => {
  it('unions search sources and counts web / code_search once each', () => {
    const found = distinctEvidenceSources([
      evidence('1', 'c', { kind: 'search', sources: ['github_repo', 'npm'] }),
      evidence('2', 'c', { kind: 'search', sources: ['npm', 'pypi'] }),
      evidence('3', 'c', { kind: 'web' }),
      evidence('4', 'c', { kind: 'web' }),
      evidence('5', 'c', { kind: 'code_search' }),
      evidence('6', 'c', { kind: 'manual' }),
      evidence('7', 'c', { kind: 'evaluate' }),
    ]);
    expect(found.sort()).toEqual(['code_search', 'github_repo', 'npm', 'pypi', 'web']);
  });
});

describe('validateDecision', () => {
  const base = (over: Partial<DecisionInput>): DecisionInput => ({
    component_id: 'c1',
    decision: 'build',
    rationale: 'A sufficiently long rationale text.',
    ...over,
  });
  const twoSources = [
    evidence('ev_a', 'c1', { kind: 'search', sources: ['github_repo', 'npm'] }),
  ];
  const state = (over: Parameters<typeof stateOf>[0] = {}): LedgerState =>
    stateOf({ components: [component('c1')], ...over });

  it('rejects an unknown component, even with an override', () => {
    const r = validateDecision(stateOf({}), base({ override: { reason: 'x'.repeat(25) } }));
    expect(r.errors.join(' ')).toContain('unknown component_id');
  });

  it('rejects a malformed ref', () => {
    const r = validateDecision(state(), base({ decision: 'reference', ref: 'nope' }));
    expect(r.errors.join(' ')).toContain('not a valid candidate ref');
  });

  describe('adopt / extend', () => {
    it('requires ref', () => {
      const r = validateDecision(state(), base({ decision: 'adopt' }));
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain('requires ref');
    });

    it('requires an evaluation of that ref for that component', () => {
      const s = state({ evaluations: [evaluation('other', 'github:o/r')] });
      const r = validateDecision(s, base({ decision: 'adopt', ref: 'github:o/r' }));
      expect(r.errors[0]).toContain('rw_evaluate');
    });

    it('accepts a compatible license', () => {
      const s = state({ evaluations: [evaluation('c1', 'github:o/r')] });
      const r = validateDecision(s, base({ decision: 'adopt', ref: 'github:o/r' }));
      expect(r).toEqual({ errors: [], warnings: [], waived_gates: [] });
    });

    it.each(['incompatible', 'unknown'] as const)('rejects a %s license verdict', (verdict) => {
      const e = evaluation('c1', 'github:o/r');
      e.license.verdict = verdict;
      const r = validateDecision(state({ evaluations: [e] }), base({ decision: 'extend', ref: 'github:o/r' }));
      expect(r.errors[0]).toContain(verdict);
    });

    it('warns on a conditional license', () => {
      const e = evaluation('c1', 'npm:lib');
      e.license.verdict = 'conditional';
      e.license.obligations = ['Publish modifications to covered files'];
      const r = validateDecision(state({ evaluations: [e] }), base({ decision: 'adopt', ref: 'npm:lib' }));
      expect(r.errors).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain('Publish modifications');
    });

    describe('license_from_remote_cache', () => {
      const remote = () => state({ evaluations: [evaluation('c1', 'npm:lib', { flags: ['license_from_remote_cache'] })] });

      it.each(['adopt', 'extend'] as const)('is an error for %s unless the user decided', (kind) => {
        for (const decided_by of [undefined, 'agent' as const]) {
          const r = validateDecision(remote(), base({ decision: kind, ref: 'npm:lib', attribution: { source_url: 'https://x.test', license: 'MIT' }, ...(decided_by ? { decided_by } : {}) }));
          expect(r.errors).toHaveLength(1);
          expect(r.errors[0]).toContain('remote cache');
          expect(r.errors[0]).toContain('rw_evaluate');
          expect(r.errors[0]).toContain('decided_by "user"');
        }
      });

      it('is only a warning when decided_by is user', () => {
        const r = validateDecision(remote(), base({ decision: 'adopt', ref: 'npm:lib', decided_by: 'user' }));
        expect(r.errors).toEqual([]);
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]).toContain('remote cache');
      });

      it('keeps the normal override rule (a long enough reason demotes it to a warning)', () => {
        const r = validateDecision(
          remote(),
          base({ decision: 'adopt', ref: 'npm:lib', override: { reason: 'The user reviewed the LICENSE text by hand.' } }),
        );
        expect(r.errors).toEqual([]);
        expect(r.warnings.some((w) => w.startsWith('override applied:') && w.includes('remote cache'))).toBe(true);
        const short = validateDecision(remote(), base({ decision: 'adopt', ref: 'npm:lib', override: { reason: 'ok' } }));
        expect(short.errors.join(' ')).toContain('override.reason');
      });

      it('does not affect reference or build decisions', () => {
        const r = validateDecision(remote(), base({ decision: 'reference', ref: 'npm:lib' }));
        expect(r.errors).toEqual([]);
      });
    });

    it('recommends attribution for extend', () => {
      const s = state({ evaluations: [evaluation('c1', 'github:o/r')] });
      const without = validateDecision(s, base({ decision: 'extend', ref: 'github:o/r' }));
      expect(without.errors).toEqual([]);
      expect(without.warnings.join(' ')).toContain('attribution');
      const withAttr = validateDecision(
        s,
        base({ decision: 'extend', ref: 'github:o/r', attribution: { source_url: 'https://github.com/o/r', license: 'MIT' } }),
      );
      expect(withAttr.warnings).toEqual([]);
    });
  });

  describe('reference', () => {
    it('requires ref but allows web refs', () => {
      expect(validateDecision(state(), base({ decision: 'reference' })).errors[0]).toContain('requires ref');
      const ok = validateDecision(state(), base({ decision: 'reference', ref: 'web:https://example.com/post' }));
      expect(ok.errors).toEqual([]);
      expect(ok.warnings.join(' ')).toContain('attribution');
    });

    it('requires source_url and license when files are copied', () => {
      const r = validateDecision(
        state(),
        base({
          decision: 'reference',
          ref: 'github:o/r',
          attribution: { source_url: '', license: 'MIT', files: ['src/a.ts'] },
        }),
      );
      expect(r.errors[0]).toContain('source_url');
    });

    it('accepts a full attribution', () => {
      const r = validateDecision(
        state(),
        base({
          decision: 'reference',
          ref: 'github:o/r',
          attribution: { source_url: 'https://github.com/o/r', license: 'MIT', files: ['src/a.ts'] },
        }),
      );
      expect(r).toEqual({ errors: [], warnings: [], waived_gates: [] });
    });

    it('warns when files are copied from an incompatible license', () => {
      const e = evaluation('c1', 'github:o/r');
      e.license.verdict = 'incompatible';
      const r = validateDecision(
        state({ evaluations: [e] }),
        base({
          decision: 'reference',
          ref: 'github:o/r',
          attribution: { source_url: 'https://github.com/o/r', license: 'GPL-3.0', files: ['a.ts'] },
        }),
      );
      expect(r.errors).toEqual([]);
      expect(r.warnings.join(' ')).toContain('incompatible');
    });
  });

  describe('build', () => {
    it('requires build_reason', () => {
      const r = validateDecision(state({ evidence: twoSources }), base({}));
      expect(r.errors[0]).toContain('build_reason');
    });

    it('accepts trivial without any evidence', () => {
      const r = validateDecision(state(), base({ build_reason: 'trivial' }));
      expect(r).toEqual({ errors: [], warnings: [], waived_gates: [] });
    });

    it.each(['no_candidate', 'license_incompatible', 'unmaintained_or_risky', 'too_heavy', 'core_differentiator', 'integration_glue'] as const)(
      'requires two distinct sources for %s',
      (build_reason) => {
        const none = validateDecision(state(), base({ build_reason }));
        expect(none.errors[0]).toContain('>=2 distinct sources');
        const ok = validateDecision(state({ evidence: twoSources }), base({ build_reason }));
        expect(ok.errors).toEqual([]);
      },
    );

    it('rejects a single source, even across several evidence entries', () => {
      const s = state({
        evidence: [
          evidence('ev_1', 'c1', { sources: ['npm'] }),
          evidence('ev_2', 'c1', { sources: ['npm'] }),
          evidence('ev_3', 'c1', { kind: 'manual' }),
        ],
      });
      const r = validateDecision(s, base({ build_reason: 'no_candidate' }));
      expect(r.errors[0]).toContain('found 1: npm');
    });

    it('counts search + web, and web + code_search, as two sources', () => {
      const searchAndWeb = state({
        evidence: [evidence('ev_1', 'c1', { sources: ['npm'] }), evidence('ev_2', 'c1', { kind: 'web' })],
      });
      expect(validateDecision(searchAndWeb, base({ build_reason: 'no_candidate' })).errors).toEqual([]);
      const webAndCode = state({
        evidence: [evidence('ev_1', 'c1', { kind: 'web' }), evidence('ev_2', 'c1', { kind: 'code_search' })],
      });
      expect(validateDecision(webAndCode, base({ build_reason: 'no_candidate' })).errors).toEqual([]);
    });

    it('ignores evidence of other components', () => {
      const s = state({
        components: [component('c1'), component('c2')],
        evidence: [evidence('ev_1', 'c2', { sources: ['npm', 'github_repo'] })],
      });
      expect(validateDecision(s, base({ build_reason: 'no_candidate' })).errors).toHaveLength(1);
    });

    it('warns when a compatible adopt-grade candidate exists', () => {
      const s = state({ evidence: twoSources, evaluations: [evaluation('c1', 'github:o/r')] });
      const r = validateDecision(s, base({ build_reason: 'core_differentiator' }));
      expect(r.errors).toEqual([]);
      expect(r.warnings[0]).toContain('github:o/r');
    });
  });

  describe('evidence_ids and override', () => {
    it('rejects unknown evidence ids', () => {
      const r = validateDecision(state(), base({ build_reason: 'trivial', evidence_ids: ['ev_missing'] }));
      expect(r.errors[0]).toContain('ev_missing');
    });

    it('demotes violations to warnings when an override reason is given', () => {
      const r = validateDecision(
        state(),
        base({ build_reason: 'no_candidate', override: { reason: 'The user explicitly asked to build this.' } }),
      );
      expect(r.errors).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain('override applied');
      expect(r.warnings[0]).toContain('>=2 distinct sources');
    });

    it('rejects a too-short override reason and keeps the violations', () => {
      const r = validateDecision(state(), base({ build_reason: 'no_candidate', override: { reason: 'because' } }));
      expect(r.errors.length).toBeGreaterThanOrEqual(2);
      expect(r.errors.some((m) => m.startsWith('override.reason'))).toBe(true);
    });
  });
});

describe('buildDecision', () => {
  it('fills defaults and cites all component evidence', () => {
    const s = stateOf({
      components: [component('c1')],
      evidence: [evidence('ev_1', 'c1'), evidence('ev_2', 'c2'), evidence('ev_3', 'c1')],
    });
    const d = buildDecision(
      s,
      { component_id: 'c1', decision: 'build', rationale: 'r'.repeat(20), build_reason: 'trivial' },
      new Date('2026-10-12T01:02:03.000Z'),
    );
    expect(d.id).toMatch(/^dec_[0-9a-f]{12}$/);
    expect(d.evidence_ids).toEqual(['ev_1', 'ev_3']);
    expect(d.alternatives).toEqual([]);
    expect(d.decided_by).toBe('agent');
    expect(d.decided_at).toBe('2026-10-12T01:02:03.000Z');
    expect(d.build_reason).toBe('trivial');
    expect(d).not.toHaveProperty('ref');
  });

  it('drops build_reason for non-build decisions and honours explicit fields', () => {
    const d = buildDecision(
      stateOf({}),
      {
        component_id: 'c1',
        decision: 'adopt',
        ref: 'npm:x',
        version: '1.0.0',
        rationale: 'r'.repeat(20),
        build_reason: 'trivial',
        evidence_ids: ['ev_9'],
        decided_by: 'user',
      },
      new Date(0),
    );
    expect(d).not.toHaveProperty('build_reason');
    expect(d).toMatchObject({ ref: 'npm:x', version: '1.0.0', evidence_ids: ['ev_9'], decided_by: 'user' });
  });
});

describe('summarize and truncateContent', () => {
  it('counts decisions per kind and lists undecided components', () => {
    const state = reduceEvents([
      ev('component.upsert', component('a')),
      ev('component.upsert', component('b')),
      ev('component.upsert', component('c')),
      ev('decision.add', decision('dec_1', 'a', { decision: 'adopt' })),
      ev('decision.add', decision('dec_2', 'b', { decision: 'build', ref: undefined, build_reason: 'trivial' })),
    ]);
    expect(summarize(state)).toEqual({
      components: 3,
      decided: 2,
      by_decision: { adopt: 1, extend: 0, reference: 0, build: 1 },
      undecided: ['c'],
    });
    expect(decisionFor(state, 'a')?.id).toBe('dec_1');
  });

  it('truncates at a character boundary', () => {
    expect(truncateContent('abc', 10)).toEqual({ content: 'abc', truncated: false });
    const cut = truncateContent('가나다', 7); // 3 bytes per char
    expect(cut).toEqual({ content: '가나', truncated: true });
  });
});

describe('rendering', () => {
  const state = reduceEvents([
    { v: 1, type: 'project.set', at: AT, project },
    ev('component.upsert', component('pdf', { name: 'PDF renderer' })),
    ev('component.upsert', component('cli', { name: 'CLI shell' })),
    ev('component.upsert', component('rules', { name: 'Pricing | rules' })),
    ev('component.upsert', component('todo', { name: 'Telemetry' })),
    ev('evidence.add', evidence('ev_1', 'pdf', { sources: ['github_repo', 'npm'] })),
    ev('evidence.add', evidence('ev_2', 'pdf', { kind: 'web' })),
    ev('evaluation.add', evaluation('pdf', 'npm:md-to-pdf', { total: 82 })),
    ev(
      'decision.add',
      decision('dec_1', 'pdf', {
        decision: 'adopt',
        ref: 'npm:md-to-pdf',
        version: '5.2.4',
        rationale: 'Mature and permissive.',
        evidence_ids: ['ev_1', 'ev_2'],
        alternatives: [{ ref: 'github:o/old-pdf', why_not: 'Unmaintained since 2021' }],
        attribution: { source_url: 'https://github.com/simonhaenisch/md-to-pdf', license: 'MIT', copyright: 'Copyright (c) Simon Haenisch' },
      }),
    ),
    ev(
      'decision.add',
      decision('dec_2', 'cli', {
        decision: 'reference',
        ref: 'github:o/cli-ref',
        rationale: 'Used as a design reference.',
        attribution: { source_url: 'https://github.com/o/cli-ref', license: 'Apache-2.0', files: ['src/args.ts'] },
      }),
    ),
    ev(
      'decision.add',
      decision('dec_3', 'rules', {
        decision: 'build',
        ref: undefined,
        build_reason: 'core_differentiator',
        rationale: 'Company-specific\nrule engine.',
        override: { reason: 'Owner confirmed this is the differentiator.' },
      }),
    ),
  ]);

  it('renders the Reuse Report', () => {
    expect(renderMarkdown(state)).toBe(
      [
        '<!-- recyclewheel:export v1 -->',
        '# Reuse Report',
        '',
        '**Project:** Docs Tool — Converts Markdown to PDF',
        '**License:** MIT · **Distribution:** application · **Ecosystems:** npm',
        '',
        '## Decisions',
        '',
        '| Component | Decision | Choice | License | Score | Evidence | Rationale |',
        '|---|---|---|---|---|---|---|',
        '| PDF renderer | adopt | `npm:md-to-pdf` @5.2.4 | MIT (compatible) | 82/100 | 2: search×1, web×1 | Mature and permissive. |',
        "| CLI shell | reference | `github:o/cli-ref` | Apache-2.0 | — | 0 | Used as a design reference. |",
        '| Pricing \\| rules | build | — (core_differentiator) | — | — | 0 | Company-specific rule engine. |',
        '',
        '## Undecided components',
        '',
        '- `todo` Telemetry (pending)',
        '',
        '## Alternatives considered',
        '',
        '### PDF renderer',
        '',
        '- `github:o/old-pdf` — Unmaintained since 2021',
        '',
        '## Cross-cutting checks',
        '',
        '- cost: **not checked**',
        '- distribution_policy: **not checked**',
        '- legal_privacy: **not checked**',
        '- operations: **not checked**',
        '- security: **not checked**',
        '',
        '## Overrides',
        '',
        '- Pricing \\| rules (build): Owner confirmed this is the differentiator.',
        '',
      ].join('\n'),
    );
  });

  it('can be scoped to one component', () => {
    const md = renderMarkdown(state, { componentId: 'cli' });
    expect(md).toContain('CLI shell');
    expect(md).not.toContain('PDF renderer');
    expect(md).toContain('_None._');
  });

  it('reports an empty ledger', () => {
    const md = renderMarkdown(reduceEvents([]));
    expect(md).toContain('_No decisions recorded yet._');
  });

  it('renders THIRD_PARTY_NOTICES for adopt/extend/reference-with-attribution only', () => {
    expect(renderNotices(state)).toBe(
      [
        '<!-- recyclewheel:export v1 -->',
        '# Third-Party Notices (draft)',
        '',
        'Generated from the recyclewheel ledger. Verify each license text and copyright line before distribution. Not legal advice.',
        '',
        '## md-to-pdf',
        '',
        '- Component: PDF renderer',
        '- Decision: adopt',
        '- Version: 5.2.4',
        '- License: MIT',
        '- Copyright: Copyright \\(c\\) Simon Haenisch',
        '- URL: https://github.com/simonhaenisch/md-to-pdf',
        '',
        '## o/cli-ref',
        '',
        '- Component: CLI shell',
        '- Decision: reference',
        '- License: Apache-2.0',
        '- URL: https://github.com/o/cli-ref',
        '- Files: src/args.ts',
        '',
      ].join('\n'),
    );
  });

  it('derives license and URL from the evaluation when no attribution is recorded', () => {
    const s = reduceEvents([
      ev('component.upsert', component('a', { name: 'A' })),
      ev('evaluation.add', evaluation('a', 'pypi:some-lib')),
      ev('decision.add', decision('dec_1', 'a', { ref: 'pypi:some-lib' })),
    ]);
    const notices = renderNotices(s);
    expect(notices).toContain('- License: MIT');
    expect(notices).toContain('- URL: https://pypi.org/project/some-lib/');
  });

  it('says so when nothing needs a notice', () => {
    expect(renderNotices(reduceEvents([]))).toContain('_No third-party components recorded._');
  });
});

describe('mkdir safety', () => {
  it('appends to an existing .recyclewheel directory', () => {
    const root = makeTmpDir();
    mkdirSync(path.join(root, '.recyclewheel'));
    const ledger = openLedger(root);
    ledger.append(ev('component.upsert', component('a')));
    expect(ledger.read().components).toHaveLength(1);
  });
});
