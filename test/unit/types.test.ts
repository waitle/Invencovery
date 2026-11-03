import { describe, expect, it } from 'vitest';
import {
  CandidateSchema,
  CandidateRefSchema,
  DecisionSchema,
  EvaluationSchema,
  LedgerEventSchema,
  SourceSchema,
  formatRef,
  newId,
  parseRef,
} from '../../src/types.js';
import type { Candidate, Evaluation, LedgerEvent, RefScheme } from '../../src/types.js';

const candidate: Candidate = {
  ref: 'github:owner/repo',
  source: 'github_repo',
  name: 'owner/repo',
  url: 'https://github.com/owner/repo',
  description: 'A library',
  stars: 120,
  license_spdx: 'MIT',
  last_activity: '2026-09-01T00:00:00Z',
  repository_url: 'https://github.com/owner/repo',
  matched_via: { query: 'markdown pdf', rank: 0 },
  provenance: 'live',
};

const evaluation: Evaluation = {
  ref: 'npm:@a/b',
  component_id: 'cmp_pdf',
  metrics: { stars: 10, scorecard: 6.5, last_commit_at: '2026-08-01T00:00:00Z' },
  scores: { maintenance: 25, popularity: 8, community: 4, license: 20, dependencies: 10, fit: 16 },
  total: 83,
  license: {
    candidate_spdx: 'MIT',
    project_spdx: null,
    distribution: 'application',
    category: 'permissive',
    verdict: 'compatible',
    obligations: ['Retain copyright and license notice'],
    notes: ['Not legal advice'],
    source: 'npm',
  },
  fit: { value: 4, reason: 'covers the core requirement' },
  flags: [],
  missing: [],
  hint: 'adopt',
  scoring_version: 1,
  provenance: 'live',
};

describe('parseRef / formatRef', () => {
  it('round-trips a scoped npm ref', () => {
    const parsed = parseRef('npm:@a/b');
    expect(parsed).toEqual({ scheme: 'npm', id: '@a/b' });
    expect(formatRef(parsed!.scheme, parsed!.id)).toBe('npm:@a/b');
  });

  it.each([
    ['github:owner/repo', 'github', 'owner/repo'],
    ['npm:left-pad', 'npm', 'left-pad'],
    ['pypi:requests', 'pypi', 'requests'],
    ['mcp:io.github.x/y', 'mcp', 'io.github.x/y'],
    ['hf:livekit/turn-detector', 'hf', 'livekit/turn-detector'],
    ['hf:Qwen/Qwen2.5-0.5B-Instruct', 'hf', 'Qwen/Qwen2.5-0.5B-Instruct'],
    ['saas:openai/api', 'saas', 'openai/api'],
    ['web:https://example.com/a:b?q=1', 'web', 'https://example.com/a:b?q=1'],
  ] as const)('round-trips %s', (ref, scheme, id) => {
    expect(parseRef(ref)).toEqual({ scheme, id });
    expect(formatRef(scheme, id)).toBe(ref);
  });

  it('normalizes pypi names per PEP 503', () => {
    expect(formatRef('pypi', 'Foo_Bar.baz--qux')).toBe('pypi:foo-bar-baz-qux');
  });

  it.each([
    '',
    'npm',
    ':id',
    'npm:',
    'gem:rails',
    'github:owner',
    'github:a/b/c',
    'npm:@scope',
    'npm:@a/b/c',
    'web:ftp://example.com',
    'web:example.com',
    'pypi:has space',
  ])('parseRef rejects %j without throwing', (ref) => {
    expect(parseRef(ref)).toBeUndefined();
  });

  it.each([
    'github:../user',
    'github:./user',
    'github:owner/..',
    'github:owner/.',
    'github:%2e%2e/user',
    'github:owner/%2e%2e',
    'github:ow%ner/repo',
    'github:-owner/repo',
    'github:owner/re?po',
    'github:owner/re#po',
    'github:owner\\repo',
    `github:${'a'.repeat(40)}/repo`,
    `github:owner/${'r'.repeat(101)}`,
    'npm:..',
    'npm:.',
    'npm:@scope/..',
    'npm:@../name',
    'npm:%2e%2e',
    'npm:a%2fb',
    'npm:a?b',
    'npm:a#b',
    'pypi:..',
    'pypi:a/b',
    'pypi:-x',
    'pypi:a%2fb',
    'mcp:..',
    'mcp:io.github.x/..',
    'mcp:a%2fb',
    'hf:owner',
    'hf:../model',
    'hf:owner/..',
    'hf:owner/%2e%2e',
    'hf:a/b/c',
    'hf:own er/model',
    'hf:owner/mo?del',
    'saas:vendor',
    'saas:../product',
    'saas:vendor/..',
    'saas:vendor/a#b',
    'saas:a/b/c',
  ])('parseRef and formatRef reject path-manipulating ref %j', (ref) => {
    expect(parseRef(ref)).toBeUndefined();
    const sep = ref.indexOf(':');
    expect(() => formatRef(ref.slice(0, sep) as RefScheme, ref.slice(sep + 1))).toThrow(TypeError);
  });

  it.each([
    'github:owner/repo.js',
    'github:owner/.github',
    'github:owner/repo..name',
    'github:a/b',
    'github:Mixed-Owner/Pdf_Kit-2.0',
    `github:${'a'.repeat(39)}/repo`,
    'npm:@scope/name',
    'npm:left.pad',
    'npm:@babel/core',
    'pypi:Flask',
    'pypi:a.b_c-d',
    'mcp:io.github.x/y',
    'mcp:io.github.x/y.z',
  ])('still accepts legitimate ref %j', (ref) => {
    expect(parseRef(ref)).toBeDefined();
  });

  it('formatRef throws on malformed ids and unknown schemes', () => {
    expect(() => formatRef('github', 'owner')).toThrow(TypeError);
    expect(() => formatRef('npm', '')).toThrow(TypeError);
    expect(() => formatRef('gem' as RefScheme, 'rails')).toThrow(TypeError);
  });

  it('CandidateRefSchema accepts valid refs only', () => {
    expect(CandidateRefSchema.safeParse('pypi:requests').success).toBe(true);
    expect(CandidateRefSchema.safeParse('requests').success).toBe(false);
  });
});

describe('newId', () => {
  it('builds <prefix>_<12 hex chars>', () => {
    expect(newId('ev')).toMatch(/^ev_[0-9a-f]{12}$/);
    expect(newId('eval')).toMatch(/^eval_[0-9a-f]{12}$/);
    expect(newId('dec')).toMatch(/^dec_[0-9a-f]{12}$/);
  });

  it('does not repeat', () => {
    expect(new Set(Array.from({ length: 50 }, () => newId('ev'))).size).toBe(50);
  });
});

describe('schemas', () => {
  it('accepts a well-formed Candidate', () => {
    expect(CandidateSchema.safeParse(candidate).success).toBe(true);
  });

  it('accepts null description and null license', () => {
    expect(CandidateSchema.safeParse({ ...candidate, description: null, license_spdx: null }).success).toBe(true);
  });

  it('rejects descriptions over 200 chars', () => {
    expect(CandidateSchema.safeParse({ ...candidate, description: 'x'.repeat(201) }).success).toBe(false);
    expect(CandidateSchema.safeParse({ ...candidate, description: 'x'.repeat(200) }).success).toBe(true);
  });

  it('rejects an unknown source and a bad ref', () => {
    expect(SourceSchema.safeParse('gitlab').success).toBe(false);
    expect(CandidateSchema.safeParse({ ...candidate, ref: 'owner/repo' }).success).toBe(false);
  });

  it('accepts a well-formed Evaluation and enforces fit 0-5 and scoring_version 1', () => {
    expect(EvaluationSchema.safeParse(evaluation).success).toBe(true);
    expect(EvaluationSchema.safeParse({ ...evaluation, fit: { value: 6, reason: 'x' } }).success).toBe(false);
    expect(EvaluationSchema.safeParse({ ...evaluation, scoring_version: 2 }).success).toBe(false);
    expect(EvaluationSchema.safeParse({ ...evaluation, total: 100.5 }).success).toBe(false);
  });

  it('parses every ledger event type', () => {
    const at = '2026-10-12T00:00:00.000Z';
    const decision = DecisionSchema.parse({
      id: 'dec_1',
      component_id: 'cmp_pdf',
      decision: 'build',
      rationale: 'nothing fits the requirement',
      build_reason: 'no_candidate',
      alternatives: [],
      evidence_ids: ['ev_1'],
      decided_at: at,
      decided_by: 'agent',
    });
    const events: LedgerEvent[] = [
      {
        v: 1,
        type: 'project.set',
        at,
        project: { name: 'p', summary: 's', distribution: 'application', ecosystems: ['npm'] },
      },
      {
        v: 1,
        type: 'component.upsert',
        at,
        component: { id: 'cmp_pdf', name: 'pdf', description: 'd', keywords: ['pdf'], status: 'pending' },
      },
      {
        v: 1,
        type: 'evidence.add',
        at,
        evidence: {
          id: 'ev_1',
          component_id: 'cmp_pdf',
          kind: 'search',
          at,
          result_refs: ['github:owner/repo'],
          summary: 'searched',
        },
      },
      { v: 1, type: 'evaluation.add', at, evaluation },
      { v: 1, type: 'decision.add', at, decision },
    ];
    for (const e of events) {
      expect(LedgerEventSchema.parse(e)).toEqual(e);
    }
  });

  it('rejects unknown event types, versions, and invalid dates', () => {
    const at = '2026-10-12T00:00:00.000Z';
    const project = { name: 'p', summary: 's', distribution: 'application', ecosystems: [] };
    expect(LedgerEventSchema.safeParse({ v: 1, type: 'project.delete', at }).success).toBe(false);
    expect(LedgerEventSchema.safeParse({ v: 2, type: 'project.set', at, project }).success).toBe(false);
    expect(LedgerEventSchema.safeParse({ v: 1, type: 'project.set', at: 'not-a-date', project }).success).toBe(false);
  });
});
