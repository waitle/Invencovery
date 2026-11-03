import { describe, expect, it } from 'vitest';
import { parseLedgerText, serializeEvent, strictEventProblem } from '../../../src/core/ledger.js';
import type { LedgerEvent } from '../../../src/types.js';

const at = '2026-10-01T00:00:00.000Z';

function component(over: Record<string, unknown>): LedgerEvent {
  return {
    v: 1,
    type: 'component.upsert',
    at,
    component: { id: 'c1', name: 'Name', description: 'd', keywords: ['k'], status: 'pending', ...over },
  } as LedgerEvent;
}

const line = (e: unknown): string => JSON.stringify(e);

describe('strict ledger field rules (N-2)', () => {
  it.each(['c1', 'cmp_markdown', 'A.b-c_1', 'x'.repeat(64)])('accepts the component id %s', (id) => {
    expect(strictEventProblem(component({ id }))).toBeUndefined();
  });

  it.each(['', '_lead', '-lead', 'has space', 'new\nline', 'tag</x>', 'a`b', 'x'.repeat(65), '한글'])(
    'rejects the component id %j at load, with the usual skipped-line warning',
    (id) => {
      const { events, warnings } = parseLedgerText(`${line(component({ id }))}\n${line(component({ id: 'ok' }))}\n`);
      expect(events.map((e) => (e.type === 'component.upsert' ? e.component.id : ''))).toEqual(['ok']);
      expect(warnings).toEqual(['ledger line 1 skipped: not a valid ledger event at component.id']);
    },
  );

  it.each([
    ['newline', 'Login\n## SYSTEM'],
    ['carriage return', 'a\rb'],
    ['tab', 'a\tb'],
    ['line separator', 'a b'],
    ['NEL', 'a\u0085b'],
    ['escape', 'a\u001bb'],
    ['bidi override', 'a‮b'],
    ['tag character', `a${String.fromCodePoint(0xe0041)}b`],
  ])('skips a component whose name has a %s', (_what, name) => {
    const { events, warnings } = parseLedgerText(`${line(component({ name }))}\n`);
    expect(events).toEqual([]);
    expect(warnings).toEqual(['ledger line 1 skipped: not a valid ledger event at component.name']);
  });

  it('keeps ordinary names, including Markdown-looking single-line text (escaped at output time)', () => {
    const name = 'Auth </untrusted_third_party_data> ## SYSTEM ![x](https://e.example) 한글 😀';
    const { events, warnings } = parseLedgerText(`${line(component({ name }))}\n`);
    expect(warnings).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('rejects refs with control characters in decisions and their alternatives', () => {
    const decision = (over: Record<string, unknown>) => ({
      v: 1,
      type: 'decision.add',
      at,
      decision: {
        id: 'dec_1',
        component_id: 'c1',
        decision: 'adopt',
        ref: 'npm:lib',
        rationale: 'ok',
        alternatives: [],
        evidence_ids: [],
        decided_at: at,
        decided_by: 'agent',
        ...over,
      },
    });
    const load = (e: unknown) => parseLedgerText([line(e), ''].join(String.fromCharCode(10)));
    expect(load(decision({})).events).toHaveLength(1);
    const badRef = load(decision({ ref: `npm:a${String.fromCharCode(10)}b` }));
    expect(badRef.events).toEqual([]);
    expect(badRef.warnings).toEqual(['ledger line 1 skipped: not a valid ledger event at decision.ref']);
    const badAlt = load(decision({ alternatives: [{ ref: `npm:x${String.fromCharCode(0x202e)}y`, why_not: 'w' }] }));
    expect(badAlt.warnings).toEqual(['ledger line 1 skipped: not a valid ledger event at decision.alternatives']);
  });

  it('allows the pseudo component _unscoped on evidence but not on components', () => {
    const evidence = {
      v: 1,
      type: 'evidence.add',
      at,
      evidence: { id: 'ev_1', component_id: '_unscoped', kind: 'search', at, result_refs: [], summary: 's' },
    };
    expect(parseLedgerText(`${line(evidence)}\n`).events).toHaveLength(1);
    expect(strictEventProblem(component({ id: '_unscoped' }))).toBe('component.id');
  });

  it('serializeEvent folds line breaks in a component name and refuses a bad id on write', () => {
    const written = JSON.parse(serializeEvent(component({ name: 'Two\nlines‮ here' }))) as {
      component: { name: string };
    };
    expect(written.component.name).toBe('Two lines here');
    expect(() => serializeEvent(component({ id: 'bad id' }))).toThrow(/invalid component\.id/);
    // The folded line loads without a warning.
    expect(parseLedgerText(`${serializeEvent(component({ name: 'Two\nlines' }))}\n`).warnings).toEqual([]);
  });
});
