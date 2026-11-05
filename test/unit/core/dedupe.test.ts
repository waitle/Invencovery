import { describe, expect, it } from 'vitest';
import { dedupe, interleaveByRank, mergeSearchResults, normalizeRepoUrl } from '../../../src/core/dedupe.js';
import type { Candidate, Source } from '../../../src/types.js';

function cand(ref: string, source: Source, extra: Partial<Candidate> = {}): Candidate {
  return {
    ref,
    source,
    name: ref.slice(ref.indexOf(':') + 1),
    url: `https://example.test/${ref}`,
    description: null,
    matched_via: { query: 'q', rank: 1 },
    provenance: 'live',
    ...extra,
  };
}

describe('normalizeRepoUrl', () => {
  it.each([
    ['https://github.com/Owner/Repo', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['git+https://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['git://github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['git+ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['git@github.com:Owner/Repo.git', 'https://github.com/owner/repo'],
    ['http://www.GitHub.com/owner/repo/', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo/tree/main/packages/x', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo/blob/main/README.md#install', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo/issues?q=is%3Aopen', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo#readme', 'https://github.com/owner/repo'],
    ['https://user:secret@github.com/owner/repo.git', 'https://github.com/owner/repo'],
    ['git+https://github.com/owner/repo.git#semver:^1.0.0', 'https://github.com/owner/repo'],
    ['github:owner/repo', 'https://github.com/owner/repo'],
    ['owner/repo', 'https://github.com/owner/repo'],
    ['github.com/owner/repo', 'https://github.com/owner/repo'],
    ['  https://github.com/owner/repo  ', 'https://github.com/owner/repo'],
    ['https://gitlab.com/group/sub/proj/-/tree/main/src', 'https://gitlab.com/group/sub/proj'],
    ['git@gitlab.com:group/proj.git', 'https://gitlab.com/group/proj'],
    ['https://bitbucket.org/team/repo/src/master/', 'https://bitbucket.org/team/repo'],
    ['gitlab:group/proj', 'https://gitlab.com/group/proj'],
    ['https://git.example.org/team/proj.git', 'https://git.example.org/team/proj'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeRepoUrl(input)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    ['not a url'],
    ['https://github.com/owner'],
    ['https://github.com/'],
    ['ftp://github.com/owner/repo'],
    ['https://localhost/owner/repo'],
  ])('rejects %j', (input) => {
    expect(normalizeRepoUrl(input)).toBeUndefined();
  });

  it('rejects null and undefined', () => {
    expect(normalizeRepoUrl(null)).toBeUndefined();
    expect(normalizeRepoUrl(undefined)).toBeUndefined();
  });

  it('keeps a project literally named "src" on nested-group hosts', () => {
    expect(normalizeRepoUrl('https://gitlab.com/group/src')).toBe('https://gitlab.com/group/src');
  });
});

describe('dedupe', () => {
  it('merges an npm and a github candidate of the same repository (github is the representative)', () => {
    const npm = cand('npm:left-pad', 'npm', {
      repository_url: 'https://github.com/stevemao/left-pad',
      downloads_weekly: 1_000_000,
      ecosystem: 'npm',
      matched_via: { query: 'pad', rank: 2 },
    });
    const gh = cand('github:stevemao/left-pad', 'github_repo', {
      stars: 1200,
      forks: 90,
      license_spdx: 'MIT',
      last_activity: '2026-09-01T00:00:00Z',
      description: 'String left pad',
      matched_via: { query: 'pad', rank: 1 },
    });
    const out = dedupe([npm, gh]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      ref: 'github:stevemao/left-pad',
      source: 'github_repo',
      also_known_as: ['npm:left-pad'],
      stars: 1200,
      forks: 90,
      downloads_weekly: 1_000_000, // union of metrics
      ecosystem: 'npm',
      license_spdx: 'MIT',
      repository_url: 'https://github.com/stevemao/left-pad',
      description: 'String left pad',
    });
  });

  it('merges github, npm, pypi and mcp entries of one repository into one candidate', () => {
    const repo = 'https://github.com/acme/widget';
    const out = dedupe([
      cand('mcp:io.github.acme/widget', 'mcp_registry', { repository_url: repo }),
      cand('pypi:widget', 'pypi', { repository_url: 'git+https://github.com/Acme/Widget.git' }),
      cand('npm:widget', 'npm', { repository_url: `${repo}/tree/main` }),
      cand('github:acme/widget', 'github_repo'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.ref).toBe('github:acme/widget');
    expect(out[0]?.also_known_as).toEqual(['npm:widget', 'pypi:widget', 'mcp:io.github.acme/widget']);
  });

  it('uses npm as representative when no github candidate is present', () => {
    const out = dedupe([
      cand('mcp:io.github.acme/widget', 'mcp_registry', { repository_url: 'https://github.com/acme/widget' }),
      cand('npm:widget', 'npm', { repository_url: 'https://github.com/acme/widget' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.ref).toBe('npm:widget');
    expect(out[0]?.also_known_as).toEqual(['mcp:io.github.acme/widget']);
  });

  it('merges the same ref seen twice (repo search + code search), ignoring case', () => {
    const out = dedupe([
      cand('github:Acme/Widget', 'github_repo', { stars: 5 }),
      cand('github:acme/widget', 'github_code', { matched_via: { query: 'code', rank: 3 } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('github_repo');
    expect(out[0]?.also_known_as).toBeUndefined(); // same project, same ref: no alias noise
  });

  it('keeps different npm packages of one monorepo apart', () => {
    const repo = 'https://github.com/babel/babel';
    const out = dedupe([
      cand('github:babel/babel', 'github_repo'),
      cand('npm:@babel/core', 'npm', { repository_url: repo }),
      cand('npm:@babel/parser', 'npm', { repository_url: repo }),
    ]);
    expect(out.map((c) => c.ref)).toEqual(['github:babel/babel', 'npm:@babel/core', 'npm:@babel/parser']);
    expect(out.every((c) => c.also_known_as === undefined)).toBe(true);
  });

  it('keeps different mcp servers of one monorepo apart but still merges the unique scheme', () => {
    const repo = 'https://github.com/org/suite';
    const out = dedupe([
      cand('github:org/suite', 'github_repo'),
      cand('mcp:io.github.org/fs', 'mcp_registry', { repository_url: repo }),
      cand('mcp:io.github.org/git', 'mcp_registry', { repository_url: repo }),
      cand('pypi:suite', 'pypi', { repository_url: repo }),
    ]);
    expect(out.map((c) => c.ref)).toEqual(['github:org/suite', 'mcp:io.github.org/fs', 'mcp:io.github.org/git']);
    expect(out[0]?.also_known_as).toEqual(['pypi:suite']);
  });

  it('does not merge an ambiguous group when there is no github anchor', () => {
    const repo = 'https://github.com/org/suite';
    const out = dedupe([
      cand('npm:a', 'npm', { repository_url: repo }),
      cand('npm:b', 'npm', { repository_url: repo }),
      cand('mcp:io.github.org/suite', 'mcp_registry', { repository_url: repo }),
    ]);
    expect(out).toHaveLength(3);
  });

  it('merges on a declared alias even without a repository url', () => {
    const mcp = cand('mcp:io.github.acme/widget', 'mcp_registry', { also_known_as: ['npm:widget-mcp'] });
    const npm = cand('npm:widget-mcp', 'npm', { downloads_weekly: 42 });
    const out = dedupe([mcp, npm]);
    expect(out).toHaveLength(1);
    expect(out[0]?.ref).toBe('npm:widget-mcp');
    expect(out[0]?.also_known_as).toEqual(['mcp:io.github.acme/widget']);
  });

  it('declared aliases survive when the aliased candidate is absent', () => {
    const mcp = cand('mcp:io.github.acme/widget', 'mcp_registry', { also_known_as: ['npm:widget-mcp'] });
    const gh = cand('github:acme/widget', 'github_repo');
    const out = dedupe([mcp, gh]);
    expect(out).toHaveLength(2); // no repository evidence linking them
    expect(out[0]).toBe(mcp);
  });

  it('applies the alias merge inside a monorepo where repo urls alone are ambiguous', () => {
    const repo = 'https://github.com/org/suite';
    const out = dedupe([
      cand('npm:a', 'npm', { repository_url: repo }),
      cand('npm:b', 'npm', { repository_url: repo }),
      cand('mcp:io.github.org/a', 'mcp_registry', { repository_url: repo, also_known_as: ['npm:a'] }),
    ]);
    expect(out.map((c) => c.ref)).toEqual(['npm:a', 'npm:b']);
    expect(out[0]?.also_known_as).toEqual(['mcp:io.github.org/a']);
  });

  it('unions metrics: first defined value wins, license fills gaps, freshest activity, risk flags OR', () => {
    const out = dedupe([
      cand('github:o/r', 'github_repo', {
        stars: 10,
        license_spdx: null,
        last_activity: '2026-01-01T00:00:00Z',
        archived: false,
        description: null,
      }),
      cand('npm:r', 'npm', {
        repository_url: 'https://github.com/o/r',
        stars: 999,
        license_spdx: 'Apache-2.0',
        last_activity: '2026-06-01T00:00:00Z',
        deprecated: true,
        description: 'from npm',
        downloads_weekly: 7,
      }),
    ]);
    expect(out[0]).toMatchObject({
      stars: 10,
      license_spdx: 'Apache-2.0',
      last_activity: '2026-06-01T00:00:00Z',
      archived: false,
      deprecated: true,
      description: 'from npm',
      downloads_weekly: 7,
    });
  });

  it('keeps license_spdx null when every member reports none', () => {
    const out = dedupe([
      cand('github:o/r', 'github_repo', { license_spdx: null }),
      cand('npm:r', 'npm', { repository_url: 'https://github.com/o/r' }),
    ]);
    expect(out[0]?.license_spdx).toBeNull();
  });

  it('takes the best rank and the least trusted provenance of the group', () => {
    const out = dedupe([
      cand('github:o/r', 'github_repo', { matched_via: { query: 'gh', rank: 4 }, provenance: 'live' }),
      cand('npm:r', 'npm', {
        repository_url: 'https://github.com/o/r',
        matched_via: { query: 'npm', rank: 2 },
        provenance: 'remote_cache',
      }),
    ]);
    expect(out[0]?.matched_via).toEqual({ query: 'npm', rank: 2, hits: 2 });
    expect(out[0]?.provenance).toBe('remote_cache');
  });

  it('merges the members\' own also_known_as and never lists the representative itself', () => {
    const out = dedupe([
      cand('github:o/r', 'github_repo', { also_known_as: ['pypi:r-py'] }),
      cand('npm:r', 'npm', { repository_url: 'https://github.com/o/r', also_known_as: ['github:o/r', 'npm:r-alias'] }),
    ]);
    expect(out[0]?.also_known_as).toEqual(['npm:r', 'pypi:r-py', 'npm:r-alias']);
  });

  it('leaves candidates without any repository evidence alone and preserves order', () => {
    const a = cand('npm:a', 'npm');
    const b = cand('pypi:b', 'pypi');
    const c = cand('mcp:io.github.x/c', 'mcp_registry', { repository_url: 'not a url' });
    const out = dedupe([a, b, c]);
    expect(out).toEqual([a, b, c]);
    expect(out[0]).toBe(a);
  });

  it('positions a merged group at its earliest member', () => {
    const out = dedupe([
      cand('npm:solo', 'npm'),
      cand('npm:r', 'npm', { repository_url: 'https://github.com/o/r' }),
      cand('pypi:other', 'pypi'),
      cand('github:o/r', 'github_repo'),
    ]);
    expect(out.map((c) => c.ref)).toEqual(['npm:solo', 'github:o/r', 'pypi:other']);
  });

  it('does not mutate its input and is idempotent', () => {
    const input = [
      cand('npm:r', 'npm', { repository_url: 'https://github.com/o/r', downloads_weekly: 3 }),
      cand('github:o/r', 'github_repo', { stars: 1 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const once = dedupe(input);
    expect(input).toEqual(snapshot);
    expect(dedupe(once)).toEqual(once);
  });

  it('handles an empty list', () => {
    expect(dedupe([])).toEqual([]);
  });
});

describe('interleaveByRank', () => {
  const list = [
    cand('github:a/1', 'github_repo', { matched_via: { query: 'q', rank: 1 } }),
    cand('github:a/2', 'github_repo', { matched_via: { query: 'q', rank: 2 } }),
    cand('github:a/3', 'github_repo', { matched_via: { query: 'q', rank: 3 } }),
    cand('npm:n1', 'npm', { matched_via: { query: 'q', rank: 1 } }),
    cand('npm:n2', 'npm', { matched_via: { query: 'q', rank: 2 } }),
    cand('mcp:m1', 'mcp_registry', { matched_via: { query: 'q', rank: 1 } }),
  ];

  it('round-robins sources by rank, ties broken by first appearance of the source', () => {
    expect(interleaveByRank(list).map((c) => c.ref)).toEqual([
      'github:a/1',
      'npm:n1',
      'mcp:m1',
      'github:a/2',
      'npm:n2',
      'github:a/3',
    ]);
  });

  it('does not mutate the input array', () => {
    const copy = [...list];
    interleaveByRank(list);
    expect(list).toEqual(copy);
  });
});

describe('mergeSearchResults', () => {
  it('dedupes, interleaves and caps the total', () => {
    const github = [
      cand('github:o/r', 'github_repo', { matched_via: { query: 'q', rank: 1 } }),
      cand('github:o/x', 'github_repo', { matched_via: { query: 'q', rank: 2 } }),
    ];
    const npm = [
      cand('npm:r', 'npm', { repository_url: 'https://github.com/o/r', matched_via: { query: 'q', rank: 1 } }),
      cand('npm:y', 'npm', { matched_via: { query: 'q', rank: 2 } }),
    ];
    const merged = mergeSearchResults([github, npm]);
    expect(merged.map((c) => c.ref)).toEqual(['github:o/r', 'github:o/x', 'npm:y']);
    expect(merged[0]?.also_known_as).toEqual(['npm:r']);
    expect(mergeSearchResults([github, npm], 2).map((c) => c.ref)).toEqual(['github:o/r', 'github:o/x']);
    expect(mergeSearchResults([github, npm], 0)).toEqual([]);
  });

describe('dedupe preferEcosystem', () => {
  const gh = { ref: 'github:o/x', source: 'github_repo', name: 'o/x', url: 'u', description: 'repo', stars: 10, license_spdx: null, matched_via: { query: 'q', rank: 1 }, provenance: 'live' } as const;
  const npm = { ref: 'npm:x', source: 'npm', name: 'x', url: 'u', description: 'pkg', downloads_weekly: 5, license_spdx: 'MIT', repository_url: 'https://github.com/o/x', matched_via: { query: 'q', rank: 2 }, provenance: 'live' } as const;

  it('lets the registry package of the ecosystem lead, keeping the merged metrics and the published license', () => {
    const [m] = dedupe([gh, npm], { preferEcosystem: 'npm' });
    expect(m?.ref).toBe('npm:x');
    expect(m?.also_known_as).toEqual(['github:o/x']);
    expect(m?.stars).toBe(10);
    expect(m?.downloads_weekly).toBe(5);
    expect(m?.license_spdx).toBe('MIT');
    expect(m?.matched_via).toEqual({ query: 'q', rank: 1, hits: 2 });
  });

  it('keeps GitHub first without the option or for another ecosystem', () => {
    expect(dedupe([gh, npm])[0]?.ref).toBe('github:o/x');
    expect(dedupe([gh, npm], { preferEcosystem: 'pypi' })[0]?.ref).toBe('github:o/x');
  });
});

describe('dedupe license disagreement', () => {
  const base = { name: 'x', url: 'u', description: 'd', matched_via: { query: 'q', rank: 1 }, provenance: 'live' } as const;
  it('keeps every source license when the merged sources disagree', () => {
    const [m] = dedupe(
      [
        { ...base, ref: 'github:o/x', source: 'github_repo', license_spdx: null },
        { ...base, ref: 'npm:x', source: 'npm', license_spdx: 'Apache-2.0', repository_url: 'https://github.com/o/x' },
      ],
      { preferEcosystem: 'npm' },
    );
    expect(m?.license_spdx).toBe('Apache-2.0');
    expect(m?.license_by_ref).toEqual([
      { ref: 'npm:x', license: 'Apache-2.0' },
      { ref: 'github:o/x', license: null },
    ]);
  });
  it('sets nothing when the sources agree or one is silent', () => {
    const [m] = dedupe([
      { ...base, ref: 'github:o/x', source: 'github_repo', license_spdx: 'MIT' },
      { ...base, ref: 'npm:x', source: 'npm', license_spdx: 'mit', repository_url: 'https://github.com/o/x' },
    ]);
    expect(m?.license_by_ref).toBeUndefined();
    const [n] = dedupe([
      { ...base, ref: 'github:o/x', source: 'github_repo' },
      { ...base, ref: 'npm:x', source: 'npm', license_spdx: 'MIT', repository_url: 'https://github.com/o/x' },
    ]);
    expect(n?.license_by_ref).toBeUndefined();
  });
});

describe('dedupe with forks published under the original repository URL', () => {
  const base = { url: 'u', description: 'd', provenance: 'live' } as const;
  const repo = 'https://github.com/doublesymmetry/react-native-track-player';
  it('merges the package named like the repository even when forks make npm ambiguous', () => {
    const out = dedupe(
      [
        { ...base, ref: 'github:doublesymmetry/react-native-track-player', source: 'github_repo', name: 'r', license_spdx: null, matched_via: { query: 'q', rank: 1 } },
        { ...base, ref: 'npm:react-native-track-player', source: 'npm', name: 'react-native-track-player', license_spdx: 'Apache-2.0', repository_url: repo, matched_via: { query: 'q', rank: 1 } },
        { ...base, ref: 'npm:@roitium/react-native-track-player', source: 'npm', name: 'fork', license_spdx: 'Apache-2.0', repository_url: repo, matched_via: { query: 'q', rank: 2 } },
      ],
      { preferEcosystem: 'npm' },
    );
    expect(out.map((c) => c.ref)).toEqual(['npm:react-native-track-player', 'npm:@roitium/react-native-track-player']);
    expect(out[0]!.also_known_as).toEqual(['github:doublesymmetry/react-native-track-player']);
    expect(out[0]!.license_by_ref).toEqual([
      { ref: 'npm:react-native-track-player', license: 'Apache-2.0' },
      { ref: 'github:doublesymmetry/react-native-track-player', license: null },
    ]);
  });
  it('does not report a custom license file against GitHub NOASSERTION as a disagreement', () => {
    const [m] = dedupe([
      { ...base, ref: 'github:o/player', source: 'github_repo', name: 'r', license_spdx: null, matched_via: { query: 'q', rank: 1 } },
      { ...base, ref: 'npm:player', source: 'npm', name: 'player', license_spdx: 'SEE LICENSE IN <license.txt>', repository_url: 'https://github.com/o/player', matched_via: { query: 'q', rank: 1 } },
    ]);
    expect(m?.license_by_ref).toBeUndefined();
  });
});
});
