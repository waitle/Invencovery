import { afterEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../../src/core/ledger.js';
import { DecomposeOutputSchema } from '../../../src/mcp/tools/decompose.js';
import { cleanupTmpDirs, makeTmpDir } from '../../helpers/tmp.js';
import { FIXED_NOW, PROJECT, candidate, component, createHarness, fakeAdapter } from './_harness.js';
import type { Harness } from './_harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupTmpDirs();
});

describe('rw_decompose', () => {
  it('records project and components and returns the deterministic search plan', async () => {
    h = await createHarness();
    const r = await h.call('rw_decompose', {
      project: { ...PROJECT, ecosystems: ['npm', 'pypi'] },
      components: [
        component('Markdown Parser', { keywords: ['markdown', 'parser', 'ast'] }),
        component('Tiny Helper', { trivial: true }),
        component('Fs Server', { kind: 'tool', keywords: ['filesystem', 'server'] }),
      ],
    });
    expect(r.isError).toBe(false);
    const out = DecomposeOutputSchema.parse(r.structured);

    expect(out.components).toEqual([
      { id: 'markdown-parser', name: 'Markdown Parser', status: 'pending' },
      { id: 'tiny-helper', name: 'Tiny Helper', status: 'pending' },
      { id: 'fs-server', name: 'Fs Server', status: 'pending' },
    ]);
    const plan = Object.fromEntries(out.search_plan.map((p) => [p.component_id, p]));
    expect(plan['tiny-helper']).toEqual({ component_id: 'tiny-helper', queries: [], skip_reason: 'trivial' });
    const md = plan['markdown-parser']!.queries;
    expect(md.map((q) => q.source)).toEqual(['github_repo', 'npm', 'pypi']);
    expect(md[0]!.query).toBe('markdown parser ast archived:false fork:false');
    expect(md[1]!.query).toBe('markdown');
    expect(md[1]!.alternatives).toEqual(['parser', 'ast']);
    expect(md[2]!.params?.nameHints).toContain('markdown-parser');
    expect(plan['fs-server']!.queries.map((q) => q.source)).toContain('mcp_registry');
    expect(out.budget).toEqual({ rounds_per_component: 3, evals_per_component: 5, web_per_component: 2 });
    expect(out.ledger_path).toBe(h.ctx.ledger().path);
    expect(r.text).toContain('Markdown Parser');

    const state = h.state();
    expect(state.project).toMatchObject({ name: 'demo', license: 'MIT', ecosystems: ['npm', 'pypi'] });
    expect(state.components.map((c) => c.id)).toEqual(['markdown-parser', 'tiny-helper', 'fs-server']);
    const events = h.ledgerText().trim().split('\n').map((l) => JSON.parse(l) as { type: string; at: string });
    expect(events.map((e) => e.type)).toEqual(['project.set', 'component.upsert', 'component.upsert', 'component.upsert']);
    expect(events.every((e) => e.at === FIXED_NOW.toISOString())).toBe(true);
  });

  it('search: true runs the first round for every non-trivial component and returns it per component', async () => {
    const gh = fakeAdapter('github_repo', (q) => ({
      candidates: [candidate(`github:o/${q.query.split(' ')[0]}`, 'github_repo', { matched_via: { query: q.query, rank: 1 } })],
    }));
    const npm = fakeAdapter('npm', (q) => ({
      candidates: [1, 2, 3, 4].map((i) => candidate(`npm:${q.query.split(' ')[0]}-${i}`, 'npm', { matched_via: { query: q.query, rank: i } })),
    }));
    h = await createHarness({ adapters: { github_repo: gh, npm } });
    const r = await h.call('rw_decompose', {
      project: { ...PROJECT },
      components: [
        component('Parser', { keywords: ['markdown', 'parser'] }),
        component('Tiny', { trivial: true }),
        component('Renderer', { keywords: ['pdf', 'render'] }),
      ],
      search: true,
    });
    expect(r.isError, r.text).toBe(false);
    const out = DecomposeOutputSchema.parse(r.structured);
    expect(out.searches?.map((s) => s.component_id)).toEqual(['parser', 'renderer']);
    for (const s of out.searches ?? []) {
      expect('error' in s).toBe(false);
      if ('error' in s) continue;
      expect(s.evidence_id).toMatch(/^ev_/);
      expect(s.candidates.length).toBeGreaterThan(0);
      expect(s.budget.rounds_used).toBe(0);
    }
    // The components searched are now `searching`; the trivial one stays pending.
    expect(out.components.map((c) => c.status)).toEqual(['searching', 'pending', 'searching']);
    const state = h.state();
    expect(state.evidence.filter((e) => e.kind === 'search').map((e) => e.component_id)).toEqual(['parser', 'renderer']);
    expect(gh.calls.map((c) => c.query)).toEqual(['markdown parser archived:false fork:false', 'pdf render archived:false fork:false']);
    expect(r.text).toContain('## First search round (2 component(s))');
    expect(r.text).toContain('npm:markdown-1');
    expect(r.text).toContain('npm:pdf-1');
    expect(r.text).toContain('rw_evaluate');
    expect(r.text).not.toContain('search: true');
  });

  it('without search the output has no searches and the next step mentions the option', async () => {
    h = await createHarness();
    const r = await h.call('rw_decompose', { project: { ...PROJECT }, components: [component('Parser')] });
    const out = DecomposeOutputSchema.parse(r.structured);
    expect(out.searches).toBeUndefined();
    expect(r.text).toContain('search: true');
    expect(h.state().evidence).toEqual([]);
  });

  it('limits the plan to enabled sources', async () => {
    h = await createHarness({ env: { RECYCLEWHEEL_SOURCES: 'github_repo' } });
    const r = await h.call('rw_decompose', { project: { ...PROJECT }, components: [component('Parser')] });
    const out = DecomposeOutputSchema.parse(r.structured);
    expect(out.search_plan[0]!.queries.map((q) => q.source)).toEqual(['github_repo']);
  });

  it('rejects an invalid decomposition without writing to the ledger', async () => {
    h = await createHarness();
    const r = await h.call('rw_decompose', {
      project: { ...PROJECT },
      components: [component('A', { id: 'dup' }), component('B', { id: 'dup' }), component('C', { parent_id: 'nope' })],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('rw_decompose');
    expect(r.text).toContain('duplicate id `dup`');
    expect(r.text).toContain('parent_id `nope`');
    expect(h.ledgerText()).toBe('');
  });

  it('rejects schema violations (zero components, too many keywords)', async () => {
    h = await createHarness();
    expect((await h.call('rw_decompose', { project: { ...PROJECT }, components: [] })).isError).toBe(true);
    const tooMany = component('X', { keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] });
    expect((await h.call('rw_decompose', { project: { ...PROJECT }, components: [tooMany] })).isError).toBe(true);
    expect(h.ledgerText()).toBe('');
  });

  it('is idempotent and keeps the status of decided components', async () => {
    h = await createHarness();
    const args = { project: { ...PROJECT }, components: [component('Parser')] };
    await h.call('rw_decompose', args);
    h.ctx.ledger().append({
      v: 1,
      type: 'decision.add',
      at: FIXED_NOW.toISOString(),
      decision: {
        id: 'dec_1',
        component_id: 'parser',
        decision: 'build',
        rationale: 'x'.repeat(20),
        build_reason: 'trivial',
        alternatives: [],
        evidence_ids: [],
        decided_at: FIXED_NOW.toISOString(),
        decided_by: 'agent',
      },
    });
    const r = await h.call('rw_decompose', args);
    const out = DecomposeOutputSchema.parse(r.structured);
    expect(out.components).toEqual([{ id: 'parser', name: 'Parser', status: 'decided' }]);
    expect(h.state().components).toHaveLength(1);
    expect(h.state().components[0]!.status).toBe('decided');
  });

  it('replace=true warns about superseded components but does not remove them', async () => {
    h = await createHarness();
    await h.call('rw_decompose', { project: { ...PROJECT }, components: [component('Old One'), component('Keep')] });
    const r = await h.call('rw_decompose', { project: { ...PROJECT }, components: [component('Keep')], replace: true });
    const out = DecomposeOutputSchema.parse(r.structured);
    expect(out.warnings?.join(' ')).toContain('old-one');
    expect(h.state().components.map((c) => c.id).sort()).toEqual(['keep', 'old-one']);
  });

  it('writes to project_root when given', async () => {
    h = await createHarness();
    const other = makeTmpDir('rw-other-');
    const r = await h.call('rw_decompose', { project: { ...PROJECT }, components: [component('Parser')], project_root: other });
    expect(r.isError).toBe(false);
    expect(h.state(other).components).toHaveLength(1);
    expect(h.state().components).toHaveLength(0);
  });

  describe('project fields kept on a re-call', () => {
    const FIRST = { ...PROJECT, license: 'Apache-2.0', distribution: 'saas', ecosystems: ['pypi', 'npm'], markets: ['KR'] };
    const bare = { name: 'demo', summary: 'A reworded summary.' };

    it('keeps license, distribution, ecosystems and markets the call omits, and says so', async () => {
      h = await createHarness();
      await h.call('rw_decompose', { project: FIRST, components: [component('Parser')] });
      const r = await h.call('rw_decompose', { project: bare, components: [component('Parser'), component('Lexer')] });
      expect(r.isError).toBe(false);
      const out = DecomposeOutputSchema.parse(r.structured);
      expect(out.inherited_project_fields).toEqual(['ecosystems', 'license', 'distribution', 'markets']);
      expect(r.text).toContain('Project fields kept from the ledger (omitted in this call): ecosystems, license, distribution, markets.');
      expect(h.state().project).toMatchObject({
        summary: 'A reworded summary.',
        license: 'Apache-2.0',
        distribution: 'saas',
        ecosystems: ['pypi', 'npm'],
        markets: ['KR'],
        markets_source: 'input',
      });
    });

    it('lets explicit values overwrite', async () => {
      h = await createHarness();
      await h.call('rw_decompose', { project: FIRST, components: [component('Parser')] });
      const r = await h.call('rw_decompose', {
        project: { ...bare, license: 'MIT', distribution: 'library', ecosystems: ['npm'], markets: ['US'] },
        components: [component('Parser')],
      });
      expect(DecomposeOutputSchema.parse(r.structured).inherited_project_fields).toBeUndefined();
      expect(r.text).not.toContain('Project fields kept');
      expect(h.state().project).toMatchObject({ license: 'MIT', distribution: 'library', ecosystems: ['npm'], markets: ['US'] });
    });

    it('keeps them with replace: true as well', async () => {
      h = await createHarness();
      await h.call('rw_decompose', { project: FIRST, components: [component('Parser')] });
      await h.call('rw_decompose', { project: bare, components: [component('Lexer')], replace: true });
      expect(h.state().project).toMatchObject({ license: 'Apache-2.0', distribution: 'saas', ecosystems: ['pypi', 'npm'] });
    });

    it('shows the kept license in REUSE.md', async () => {
      h = await createHarness();
      await h.call('rw_decompose', { project: FIRST, components: [component('Parser')] });
      await h.call('rw_decompose', { project: bare, components: [component('Parser')] });
      const md = renderMarkdown(h.state());
      expect(md).toContain('**License:** Apache-2.0');
      expect(md).toContain('**Distribution:** saas');
    });
  });
});
