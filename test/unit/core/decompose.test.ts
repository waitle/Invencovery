import { describe, expect, it } from 'vitest';
import {
  MAX_COMPONENTS,
  buildDecomposeEvents,
  buildSearchPlan,
  planComponent,
  pypiNameHints,
  queryMode,
  queryVariants,
  QUERY_BUDGETS,
  validateDecompose,
} from '../../../src/core/decompose.js';
import type { DecomposeComponentInput, DecomposeInput } from '../../../src/core/decompose.js';
import type { Component, Ecosystem, ProjectInfo, Source } from '../../../src/types.js';

function comp(over: Partial<Component> = {}): Component {
  return {
    id: 'c1',
    name: 'Markdown parser',
    description: 'Parses markdown',
    keywords: ['markdown', 'parser'],
    status: 'pending',
    ...over,
  };
}

function input(components: DecomposeComponentInput[], over: Partial<DecomposeInput> = {}): DecomposeInput {
  return {
    project: { name: 'Docs', summary: 'Markdown to PDF tool', ecosystems: ['npm'] },
    components,
    ...over,
  };
}

const simple: DecomposeComponentInput = {
  name: 'Markdown parser',
  description: 'Parses markdown',
  keywords: ['markdown', 'parser'],
};

describe('validateDecompose', () => {
  it('normalizes a valid decomposition and assigns slug ids', () => {
    const r = validateDecompose(
      input([simple, { name: 'PDF Renderer (headless)', description: 'd', keywords: [' pdf ', 'PDF', 'render'] }]),
    );
    expect(r.errors).toEqual([]);
    expect(r.project).toEqual({
      name: 'Docs',
      summary: 'Markdown to PDF tool',
      distribution: 'application',
      ecosystems: ['npm'],
    });
    expect(r.components.map((c) => c.id)).toEqual(['markdown-parser', 'pdf-renderer-headless']);
    expect(r.components[1]?.keywords).toEqual(['pdf', 'render']);
    expect(r.components.every((c) => c.status === 'pending')).toBe(true);
  });

  it('suffixes colliding slugs and honours explicit ids', () => {
    const r = validateDecompose(
      input([
        { ...simple, id: 'markdown-parser' },
        { ...simple },
        { ...simple },
      ]),
    );
    expect(r.errors).toEqual([]);
    expect(r.components.map((c) => c.id)).toEqual(['markdown-parser', 'markdown-parser-2', 'markdown-parser-3']);
  });

  it('upserts an existing component by slug and keeps its status', () => {
    const existing = [comp({ id: 'markdown-parser', status: 'searching' })];
    const r = validateDecompose(input([simple]), existing);
    expect(r.components).toHaveLength(1);
    expect(r.components[0]).toMatchObject({ id: 'markdown-parser', status: 'searching' });
  });

  it.each([
    ['no components', input([]), 'at least 1'],
    ['too many components', input(Array.from({ length: MAX_COMPONENTS + 1 }, (_, i) => ({ ...simple, name: `C${i}` }))), 'limit is 30'],
    ['empty keywords', input([{ ...simple, keywords: ['  '] }]), 'keywords needs at least 1'],
    ['too many keywords', input([{ ...simple, keywords: Array.from({ length: 9 }, (_, i) => `k${i}`) }]), 'limit is 8'],
    ['long description', input([{ ...simple, description: 'x'.repeat(501) }]), 'limit is 500'],
    ['long summary', input([simple], { project: { name: 'p', summary: 's'.repeat(1001) } }), 'limit is 1000'],
    ['empty name', input([{ ...simple, name: ' ' }]), 'name must not be empty'],
    ['bad explicit id', input([{ ...simple, id: 'has space' }]), 'must match'],
    ['duplicate explicit id', input([{ ...simple, id: 'a' }, { ...simple, name: 'Other', id: 'a' }]), 'duplicate id'],
    ['unknown parent', input([{ ...simple, parent_id: 'ghost' }]), 'does not match any component'],
    ['self parent', input([{ ...simple, id: 'a', parent_id: 'a' }]), 'must not reference itself'],
    [
      'parent cycle',
      input([
        { ...simple, id: 'a', parent_id: 'b' },
        { ...simple, name: 'B', id: 'b', parent_id: 'a' },
      ]),
      'cycle',
    ],
  ])('reports an error: %s', (_label, bad, fragment) => {
    const r = validateDecompose(bad);
    expect(r.errors.join('\n')).toContain(fragment);
    expect(r.components).toEqual([]);
  });

  it('accepts a parent from the batch or from existing components', () => {
    const r = validateDecompose(
      input([
        { ...simple, id: 'child', parent_id: 'root' },
        { ...simple, name: 'Child 2', id: 'child2', parent_id: 'old' },
        { ...simple, name: 'Root', id: 'root' },
      ]),
      [comp({ id: 'old' })],
    );
    expect(r.errors).toEqual([]);
  });

  it('warns about more than 10 components and a missing ecosystem', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...simple, name: `Part ${i}` }));
    const r = validateDecompose(input(many, { project: { name: 'p', summary: 's' } }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes('recommended 10'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('no ecosystem'))).toBe(true);
  });

  it('lists superseded components when replace is true', () => {
    const r = validateDecompose(input([simple], { replace: true }), [comp({ id: 'old-one' }), comp({ id: 'markdown-parser' })]);
    expect(r.superseded).toEqual(['old-one']);
    expect(r.warnings.some((w) => w.includes('old-one'))).toBe(true);
  });

  it('builds project.set and component.upsert events', () => {
    const r = validateDecompose(input([simple]));
    const events = buildDecomposeEvents(r.project!, r.components, new Date('2026-10-12T00:00:00Z'));
    expect(events.map((e) => e.type)).toEqual(['project.set', 'component.upsert']);
    expect(events[0]?.at).toBe('2026-10-12T00:00:00.000Z');
  });
});

describe('pypiNameHints', () => {
  it.each([
    [['markdown'], ['markdown']],
    [['markdown', 'pdf'], ['markdown-pdf', 'markdown', 'pdf']],
    [['Markdown To PDF', 'convert'], ['markdown-to-pdf-convert', 'markdown-to-pdf', 'convert']],
    [['a', 'b', 'c', 'd', 'e'], ['a-b', 'b-c', 'c-d', 'd-e', 'a']],
    [['pdf', 'pdf'], ['pdf-pdf', 'pdf']],
    [['***', 'pdf'], ['pdf']],
  ])('%j -> %j', (keywords, expected) => {
    expect(pypiNameHints(keywords)).toEqual(expected);
  });
});

describe('planComponent', () => {
  const plan = (c: Component, eco: Ecosystem[], enabled?: Source[]) =>
    planComponent(c, eco, enabled ? { enabledSources: enabled } : {});

  it('skips trivial components', () => {
    expect(plan(comp({ trivial: true }), ['npm'])).toEqual({
      component_id: 'c1',
      queries: [],
      skip_reason: 'trivial',
    });
  });

  it('npm project: github_repo without a language qualifier, plus npm', () => {
    expect(plan(comp(), ['npm'])).toEqual({
      component_id: 'c1',
      queries: [
        { source: 'github_repo', query: 'markdown parser archived:false fork:false' },
        { source: 'npm', query: 'markdown', alternatives: ['parser'] },
      ],
    });
  });

  it('pypi project: language qualifier, pypi name hints, no npm', () => {
    const r = plan(comp({ keywords: ['markdown', 'pdf', 'render'] }), ['pypi']);
    expect(r.queries).toEqual([
      { source: 'github_repo', query: 'markdown pdf render archived:false fork:false language:Python' },
      {
        source: 'pypi',
        query: 'markdown pdf render',
        params: { nameHints: ['markdown-pdf', 'pdf-render', 'markdown', 'pdf', 'render'] },
      },
    ]);
  });

  it('limits the github query to 4 words (the rest become an alternative) and gives npm one keyword per query, 5 at most', () => {
    const r = plan(comp({ keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }), ['npm']);
    expect(r.queries[0]?.query).toBe('a b c d archived:false fork:false');
    expect(r.queries[0]?.alternatives).toEqual(['e f archived:false fork:false']);
    expect(r.queries[1]?.query).toBe('a');
    expect(r.queries[1]?.alternatives).toEqual(['b', 'c', 'd', 'e']);
  });

  it.each([
    [['cargo'], ' language:Rust'],
    [['go'], ' language:Go'],
    [['maven'], ' language:Java'],
    [['nuget'], ' language:C#'],
    [['other'], ''],
    [['npm', 'pypi'], ''],
    [['pypi', 'go'], ''],
    [[], ''],
  ] as Array<[Ecosystem[], string]>)('github language qualifier for %j', (eco, suffix) => {
    expect(plan(comp(), eco).queries[0]?.query).toBe(`markdown parser archived:false fork:false${suffix}`);
  });

  it('prefers the component ecosystem over the project ecosystems', () => {
    const r = plan(comp({ ecosystem: 'pypi' }), ['npm', 'pypi']);
    expect(r.queries.map((q) => q.source)).toEqual(['github_repo', 'pypi']);
    expect(r.queries[0]?.query).toContain('language:Python');
  });

  it('plans both registries when the project has both ecosystems', () => {
    expect(plan(comp(), ['npm', 'pypi']).queries.map((q) => q.source)).toEqual(['github_repo', 'npm', 'pypi']);
  });

  it('adds mcp_registry for kind tool or an mcp keyword, never otherwise', () => {
    expect(plan(comp({ kind: 'tool' }), ['npm']).queries.map((q) => q.source)).toContain('mcp_registry');
    expect(plan(comp({ keywords: ['MCP', 'server'] }), ['npm']).queries.map((q) => q.source)).toContain('mcp_registry');
    expect(plan(comp({ keywords: ['mcp-server'] }), ['npm']).queries.map((q) => q.source)).toContain('mcp_registry');
    expect(plan(comp({ keywords: ['mcpx-like'] }), ['npm']).queries.map((q) => q.source)).not.toContain('mcp_registry');
    expect(plan(comp({ kind: 'library' }), ['npm']).queries.map((q) => q.source)).not.toContain('mcp_registry');
  });

  it('never plans github_code', () => {
    const r = plan(comp({ kind: 'tool', keywords: ['mcp'] }), ['npm', 'pypi']);
    expect(r.queries.map((q) => q.source)).not.toContain('github_code');
  });

  it('filters by enabled sources', () => {
    const r = plan(comp(), ['npm', 'pypi'], ['npm', 'github_repo']);
    expect(r.queries.map((q) => q.source)).toEqual(['github_repo', 'npm']);
  });

  it('is deterministic', () => {
    const c = comp({ keywords: ['x', 'y', 'z'] });
    expect(plan(c, ['npm', 'pypi'])).toEqual(plan(c, ['npm', 'pypi']));
  });
});

describe('buildSearchPlan', () => {
  it('plans every component in order', () => {
    const r = buildSearchPlan({ ecosystems: ['npm'] }, [comp({ id: 'a' }), comp({ id: 'b', trivial: true })]);
    expect(r.map((p) => [p.component_id, p.skip_reason])).toEqual([
      ['a', undefined],
      ['b', 'trivial'],
    ]);
  });
});

describe('validateDecompose: project fields kept from the ledger', () => {
  const existingProject: ProjectInfo = {
    name: 'Docs',
    summary: 'Old summary',
    license: 'Apache-2.0',
    distribution: 'saas',
    ecosystems: ['pypi', 'npm'],
    markets: ['KR'],
    markets_source: 'input',
  };
  const bare = (over: Partial<DecomposeInput['project']> = {}): DecomposeInput => ({
    project: { name: 'Docs', summary: 'New summary', ...over },
    components: [simple],
  });

  it('inherits every omitted optional field and reports which', () => {
    const r = validateDecompose(bare(), [], existingProject);
    expect(r.errors).toEqual([]);
    expect(r.project).toEqual({ ...existingProject, summary: 'New summary' });
    expect(r.inherited).toEqual(['ecosystems', 'license', 'distribution', 'markets']);
  });

  it('lets explicit values overwrite, including an explicit empty ecosystem list', () => {
    const r = validateDecompose(
      bare({ license: 'MIT', distribution: 'library', ecosystems: [], markets: ['US'] }),
      [],
      existingProject,
    );
    expect(r.project).toMatchObject({ license: 'MIT', distribution: 'library', ecosystems: [], markets: ['US'], markets_source: 'input' });
    expect(r.inherited).toEqual([]);
  });

  it('inherits field by field', () => {
    const r = validateDecompose(bare({ license: 'MIT' }), [], existingProject);
    expect(r.project).toMatchObject({ license: 'MIT', distribution: 'saas', ecosystems: ['pypi', 'npm'] });
    expect(r.inherited).toEqual(['ecosystems', 'distribution', 'markets']);
  });

  it('keeps inferred markets when this call infers nothing new, and infers again when it does', () => {
    const kept = validateDecompose(bare(), [], { ...existingProject, markets: ['JP'], markets_source: 'inferred' });
    expect(kept.inherited).toContain('markets');
    expect(kept.project).toMatchObject({ markets: ['JP'], markets_source: 'inferred' });
    const again = validateDecompose(bare({ summary: 'A tool for Korea' }), [], { ...existingProject, markets: ['JP'], markets_source: 'inferred' });
    expect(again.inherited).not.toContain('markets');
    expect(again.project).toMatchObject({ markets: ['KR'], markets_source: 'inferred' });
  });

  it('applies the distribution default only without an existing project', () => {
    const r = validateDecompose(bare());
    expect(r.project).toMatchObject({ distribution: 'application', ecosystems: [] });
    expect(r.project?.license).toBeUndefined();
    expect(r.inherited).toEqual([]);
  });

  it('behaves the same with replace: only the components are replaced', () => {
    const r = validateDecompose({ ...bare(), replace: true }, [comp({ id: 'old-one' })], existingProject);
    expect(r.project).toMatchObject({ license: 'Apache-2.0', distribution: 'saas', ecosystems: ['pypi', 'npm'] });
    expect(r.inherited).toEqual(['ecosystems', 'license', 'distribution', 'markets']);
  });
});

describe('validateDecompose: project fields kept from the ledger', () => {
  const existingProject: ProjectInfo = {
    name: 'Docs',
    summary: 'Old summary',
    license: 'Apache-2.0',
    distribution: 'saas',
    ecosystems: ['pypi', 'npm'],
    markets: ['KR'],
    markets_source: 'input',
  };
  const bare = (over: Partial<DecomposeInput['project']> = {}): DecomposeInput => ({
    project: { name: 'Docs', summary: 'New summary', ...over },
    components: [simple],
  });

  it('inherits every omitted optional field and reports which', () => {
    const r = validateDecompose(bare(), [], existingProject);
    expect(r.errors).toEqual([]);
    expect(r.project).toEqual({ ...existingProject, summary: 'New summary' });
    expect(r.inherited).toEqual(['ecosystems', 'license', 'distribution', 'markets']);
  });

  it('lets explicit values overwrite, including an explicit empty ecosystem list', () => {
    const r = validateDecompose(
      bare({ license: 'MIT', distribution: 'library', ecosystems: [], markets: ['US'] }),
      [],
      existingProject,
    );
    expect(r.project).toMatchObject({ license: 'MIT', distribution: 'library', ecosystems: [], markets: ['US'], markets_source: 'input' });
    expect(r.inherited).toEqual([]);
  });

  it('inherits field by field', () => {
    const r = validateDecompose(bare({ license: 'MIT' }), [], existingProject);
    expect(r.project).toMatchObject({ license: 'MIT', distribution: 'saas', ecosystems: ['pypi', 'npm'] });
    expect(r.inherited).toEqual(['ecosystems', 'distribution', 'markets']);
  });

  it('keeps inferred markets when this call infers nothing new, and infers again when it does', () => {
    const kept = validateDecompose(bare(), [], { ...existingProject, markets: ['JP'], markets_source: 'inferred' });
    expect(kept.inherited).toContain('markets');
    expect(kept.project).toMatchObject({ markets: ['JP'], markets_source: 'inferred' });
    const again = validateDecompose(bare({ summary: 'A tool for Korea' }), [], { ...existingProject, markets: ['JP'], markets_source: 'inferred' });
    expect(again.inherited).not.toContain('markets');
    expect(again.project).toMatchObject({ markets: ['KR'], markets_source: 'inferred' });
  });

  it('applies the distribution default only without an existing project', () => {
    const r = validateDecompose(bare());
    expect(r.project).toMatchObject({ distribution: 'application', ecosystems: [] });
    expect(r.project?.license).toBeUndefined();
    expect(r.inherited).toEqual([]);
  });

  it('behaves the same with replace: only the components are replaced', () => {
    const r = validateDecompose({ ...bare(), replace: true }, [comp({ id: 'old-one' })], existingProject);
    expect(r.project).toMatchObject({ license: 'Apache-2.0', distribution: 'saas', ecosystems: ['pypi', 'npm'] });
    expect(r.inherited).toEqual(['ecosystems', 'license', 'distribution', 'markets']);
  });
});

describe('queryVariants (short per-source queries)', () => {
  const RADIO = ['react native audio player', 'track player', 'background audio', 'lock screen controls', 'hls streaming'];

  it('packs whole keywords into the GitHub budget and offers the rest as alternatives', () => {
    expect(queryVariants(RADIO, QUERY_BUDGETS.github_repo)).toEqual([
      'react native audio player',
      'track player background audio',
      'lock screen controls',
    ]);
  });

  it('gives npm one keyword per query (its ranking degrades when phrases are concatenated), within 64 characters', () => {
    const variants = queryVariants(RADIO, QUERY_BUDGETS.npm);
    expect(variants).toEqual(RADIO);
    for (const v of variants) expect(v.length).toBeLessThanOrEqual(64);
    expect(queryVariants([...RADIO, 'six', 'seven'], QUERY_BUDGETS.npm)).toHaveLength(5);
    expect(queryVariants(['x'.repeat(80)], QUERY_BUDGETS.npm)).toEqual([]);
    expect(queryVariants(['react native audio player streaming background lock screen'], QUERY_BUDGETS.npm)).toEqual([
      'react native audio player streaming background',
    ]);
  });

  it('counts distinct words, so a repeated word does not spend the token budget twice', () => {
    expect(queryVariants(['audio player', 'audio streaming', 'audio'], QUERY_BUDGETS.github_repo)).toEqual([
      'audio player audio streaming audio',
    ]);
  });

  it('cuts a keyword that is a sentence down to the budget instead of dropping it', () => {
    expect(queryVariants(['convert markdown files into pdf documents quickly'], QUERY_BUDGETS.github_repo)).toEqual([
      'convert markdown files into',
    ]);
  });

  it('returns at most one primary and two alternatives, and nothing for empty keywords', () => {
    const many = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8'];
    expect(queryVariants(many, { maxTokens: 1, maxChars: 64 })).toEqual(['a1', 'b2', 'c3']);
    expect(queryVariants(many, { maxTokens: 1, maxChars: 64, maxVariants: 1 })).toEqual(['a1']);
    expect(queryVariants(['   ', ''], QUERY_BUDGETS.npm)).toEqual([]);
  });

  it('plans alternatives per source and a single pypi query', () => {
    const r = planComponent(comp({ keywords: RADIO }), ['npm', 'pypi']);
    const gh = r.queries.find((q) => q.source === 'github_repo')!;
    expect(gh.query).toBe('react native audio player archived:false fork:false');
    expect(gh.alternatives).toEqual([
      'track player background audio archived:false fork:false',
      'lock screen controls archived:false fork:false',
    ]);
    const npm = r.queries.find((q) => q.source === 'npm')!;
    expect(npm.query).toBe('react native audio player');
    expect(npm.alternatives).toEqual(['track player', 'background audio', 'lock screen controls', 'hls streaming']);
    const pypi = r.queries.find((q) => q.source === 'pypi')!;
    expect(pypi.alternatives).toBeUndefined();
    expect(pypi.query.length).toBeLessThanOrEqual(64);
  });

  it('has no GitHub alternatives when the keywords fit one query; npm still gets one query per keyword', () => {
    const r = planComponent(comp(), ['npm']);
    expect(r.queries.find((q) => q.source === 'github_repo')!.alternatives).toBeUndefined();
    expect(r.queries.find((q) => q.source === 'npm')).toEqual({ source: 'npm', query: 'markdown', alternatives: ['parser'] });
    expect(queryMode('npm')).toBe('eager');
    expect(queryMode('github_repo')).toBe('adaptive');
    expect(queryMode('github_code')).toBe('adaptive');
  });
});

describe('keyword quality warnings', () => {
  it('warns about keywords that are sentences, not for trivial components', () => {
    const long = 'play live hls mp3 aac streams in react native';
    const r = validateDecompose({
      project: { name: 'p', summary: 's', ecosystems: ['npm'], markets: ['US'] },
      components: [
        { name: 'Player', description: 'd', keywords: [long, 'audio'] },
        { name: 'Tiny', description: 'd', keywords: [long], trivial: true },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('`player`');
    expect(r.warnings[0]).toContain('more than 4 words');
  });
});
