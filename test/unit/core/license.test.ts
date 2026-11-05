import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_MEMBERS,
  LICENSE_MATRIX,
  MATRIX_CELL_LABEL,
  classify,
  judge,
  isCustomLicenseText,
  normalizeSpdx,
} from '../../../src/core/license.js';
import type { LicenseCategory } from '../../../src/core/license.js';
import { LicenseVerdictSchema } from '../../../src/types.js';
import type { Distribution, LicenseVerdict } from '../../../src/types.js';

type Verdict = LicenseVerdict['verdict'];

function verdictOf(candidate: string | null, project: string | null, distribution: Distribution): Verdict {
  return judge({ candidate, project, distribution, source: 'npm' }).verdict;
}

describe('classify: single licenses', () => {
  const table: Array<[string, LicenseCategory]> = [
    ['MIT', 'permissive'],
    ['MIT-0', 'permissive'],
    ['BSD-2-Clause', 'permissive'],
    ['BSD-3-Clause', 'permissive'],
    ['Apache-2.0', 'permissive'],
    ['ISC', 'permissive'],
    ['0BSD', 'permissive'],
    ['Unlicense', 'permissive'],
    ['CC0-1.0', 'permissive'],
    ['Zlib', 'permissive'],
    ['BSL-1.0', 'permissive'],
    ['Python-2.0', 'permissive'],
    ['BlueOak-1.0.0', 'permissive'],
    ['PSF-2.0', 'permissive'],
    ['LGPL-2.1', 'weak_copyleft'],
    ['LGPL-2.1-only', 'weak_copyleft'],
    ['LGPL-2.1-or-later', 'weak_copyleft'],
    ['LGPL-2.1+', 'weak_copyleft'],
    ['LGPL-3.0-only', 'weak_copyleft'],
    ['LGPL-3.0-or-later', 'weak_copyleft'],
    ['MPL-2.0', 'weak_copyleft'],
    ['EPL-2.0', 'weak_copyleft'],
    ['GPL-2.0', 'strong_copyleft'],
    ['GPL-2.0-only', 'strong_copyleft'],
    ['GPL-2.0+', 'strong_copyleft'],
    ['GPL-2.0-or-later', 'strong_copyleft'],
    ['GPL-3.0', 'strong_copyleft'],
    ['GPL-3.0-only', 'strong_copyleft'],
    ['GPL-3.0-or-later', 'strong_copyleft'],
    ['AGPL-3.0', 'network_copyleft'],
    ['AGPL-3.0-only', 'network_copyleft'],
    ['AGPL-3.0-or-later', 'network_copyleft'],
    ['SSPL-1.0', 'non_oss'],
    ['BUSL-1.1', 'non_oss'],
    ['Elastic-2.0', 'non_oss'],
    ['CC-BY-NC-4.0', 'non_oss'],
    ['CC-BY-NC-SA-4.0', 'non_oss'],
    ['CC-BY-NC-ND-3.0', 'non_oss'],
  ];

  it.each(table)('%s -> %s', (spdx, category) => {
    expect(classify(spdx)).toBe(category);
  });

  it('does not treat LGPL as GPL or AGPL as GPL', () => {
    expect(classify('LGPL-3.0-only')).not.toBe('strong_copyleft');
    expect(classify('AGPL-3.0-only')).not.toBe('strong_copyleft');
  });

  it('treats a valid but unlisted SPDX id as unknown, never permissive', () => {
    expect(classify('WTFPL')).toBe('unknown');
    expect(classify('GPL-1.0-only')).toBe('unknown');
  });

  it('treats Commons Clause mentions (not valid SPDX) as non_oss', () => {
    expect(classify('Commons-Clause')).toBe('non_oss');
    expect(classify('Apache-2.0 WITH Commons-Clause')).toBe('non_oss');
    expect(classify('Commons Clause')).toBe('non_oss');
  });
});

describe('classify: unknown inputs', () => {
  it.each([
    [null],
    [undefined],
    [''],
    ['   '],
    ['NOASSERTION'],
    ['noassertion'],
    ['NONE'],
    ['LicenseRef-custom'],
    ['SEE LICENSE IN LICENSE.txt'],
    ['GPLv2'],
    ['MIT OR'],
    ['Proprietary'],
  ])('%s -> unknown', (input) => {
    expect(classify(input)).toBe('unknown');
  });
});

describe('classify: expressions', () => {
  it('OR resolves to the most favorable side', () => {
    expect(classify('MIT OR GPL-3.0')).toBe('permissive');
    expect(classify('GPL-3.0-only OR MIT')).toBe('permissive');
    expect(classify('GPL-3.0-only OR LGPL-3.0-only')).toBe('weak_copyleft');
    expect(classify('AGPL-3.0-only OR SSPL-1.0')).toBe('network_copyleft');
  });

  it('AND resolves to the most restrictive side', () => {
    expect(classify('MIT AND GPL-3.0')).toBe('strong_copyleft');
    expect(classify('Apache-2.0 AND MPL-2.0')).toBe('weak_copyleft');
    expect(classify('GPL-3.0-only AND SSPL-1.0')).toBe('non_oss');
  });

  it('respects parentheses and AND-over-OR precedence', () => {
    expect(classify('(MIT OR GPL-3.0) AND Apache-2.0')).toBe('permissive');
    expect(classify('MIT AND (Apache-2.0 OR GPL-3.0)')).toBe('permissive');
    expect(classify('(MIT AND GPL-3.0) OR AGPL-3.0-only')).toBe('strong_copyleft');
    expect(classify('MIT OR GPL-3.0 AND AGPL-3.0-only')).toBe('permissive');
  });

  it('WITH classifies by the base license', () => {
    expect(classify('GPL-2.0-only WITH Classpath-exception-2.0')).toBe('strong_copyleft');
    expect(classify('Apache-2.0 WITH LLVM-exception')).toBe('permissive');
  });

  it('unknown parts: AND is unknown, OR prefers a known side', () => {
    expect(classify('MIT AND LicenseRef-custom')).toBe('unknown');
    expect(classify('MIT OR LicenseRef-custom')).toBe('permissive');
    expect(classify('LicenseRef-a OR LicenseRef-b')).toBe('unknown');
  });

  it('repairs identifier case and lower-case operators', () => {
    expect(classify('mit')).toBe('permissive');
    expect(classify('apache-2.0 or gpl-3.0')).toBe('permissive');
    expect(classify('gpl-3.0-or-later')).toBe('strong_copyleft');
  });
});

describe('normalizeSpdx', () => {
  it('canonicalizes operators, case and grouping', () => {
    expect(normalizeSpdx('  mit or apache-2.0 ')).toBe('MIT OR Apache-2.0');
    expect(normalizeSpdx('MIT AND (Apache-2.0 OR GPL-3.0)')).toBe('MIT AND (Apache-2.0 OR GPL-3.0)');
    expect(normalizeSpdx('(MIT OR Apache-2.0) AND BSD-3-Clause')).toBe('(MIT OR Apache-2.0) AND BSD-3-Clause');
    expect(normalizeSpdx('GPL-2.0+')).toBe('GPL-2.0+');
    expect(normalizeSpdx('gpl-2.0-only with Classpath-exception-2.0')).toBe(
      'GPL-2.0-only WITH Classpath-exception-2.0',
    );
  });

  it('returns null for empty, NOASSERTION and non-SPDX text', () => {
    expect(normalizeSpdx('')).toBeNull();
    expect(normalizeSpdx(null)).toBeNull();
    expect(normalizeSpdx(undefined)).toBeNull();
    expect(normalizeSpdx('NOASSERTION')).toBeNull();
    expect(normalizeSpdx('NONE')).toBeNull();
    expect(normalizeSpdx('SEE LICENSE IN LICENSE')).toBeNull();
    expect(normalizeSpdx('Proprietary EULA')).toBeNull();
  });
});

describe('judge: matrix cells (category x distribution)', () => {
  // [description, candidate, project, distribution, expected verdict]
  const table: Array<[string, string, string | null, Distribution, Verdict]> = [
    // permissive
    ['permissive/internal', 'MIT', 'MIT', 'internal', 'compatible'],
    ['permissive/library', 'MIT', 'MIT', 'library', 'compatible'],
    ['permissive/application', 'BSD-3-Clause', 'Apache-2.0', 'application', 'compatible'],
    ['permissive/saas', 'ISC', 'MIT', 'saas', 'compatible'],
    ['permissive into GPL-3.0 application', 'MIT', 'GPL-3.0-only', 'application', 'compatible'],
    ['Apache-2.0 into GPL-2.0-only application', 'Apache-2.0', 'GPL-2.0-only', 'application', 'incompatible'],
    ['Apache-2.0 into GPL-2.0 (deprecated id = only) library', 'Apache-2.0', 'GPL-2.0', 'library', 'incompatible'],
    ['Apache-2.0 into GPL-2.0-or-later application', 'Apache-2.0', 'GPL-2.0-or-later', 'application', 'compatible'],
    ['Apache-2.0 into GPL-2.0+ application', 'Apache-2.0', 'GPL-2.0+', 'application', 'compatible'],
    ['Apache-2.0 into GPL-3.0 application', 'Apache-2.0', 'GPL-3.0-only', 'application', 'compatible'],
    ['Apache-2.0 into GPL-2.0-only internal', 'Apache-2.0', 'GPL-2.0-only', 'internal', 'compatible'],
    ['Apache-2.0 into GPL-2.0-only saas', 'Apache-2.0', 'GPL-2.0-only', 'saas', 'compatible'],
    ['MIT into GPL-2.0-only application', 'MIT', 'GPL-2.0-only', 'application', 'compatible'],
    // weak copyleft
    ['weak/internal', 'MPL-2.0', 'MIT', 'internal', 'compatible'],
    ['weak/library', 'MPL-2.0', 'MIT', 'library', 'conditional'],
    ['weak/application', 'LGPL-3.0-or-later', 'Apache-2.0', 'application', 'conditional'],
    ['weak/saas', 'EPL-2.0', 'MIT', 'saas', 'conditional'],
    // strong copyleft
    ['strong/internal', 'GPL-3.0-only', 'MIT', 'internal', 'conditional'],
    ['strong/saas (no network clause)', 'GPL-3.0-only', 'MIT', 'saas', 'conditional'],
    ['strong/application, MIT project', 'GPL-3.0-only', 'MIT', 'application', 'incompatible'],
    ['strong/library, Apache project', 'GPL-2.0-or-later', 'Apache-2.0', 'library', 'incompatible'],
    ['strong/application, GPL-3.0 project', 'GPL-3.0-only', 'GPL-3.0-or-later', 'application', 'compatible'],
    ['strong/library, AGPL project', 'GPL-3.0-only', 'AGPL-3.0-only', 'library', 'compatible'],
    ['GPL-2.0-only dep, GPL-2.0-only project', 'GPL-2.0-only', 'GPL-2.0-only', 'application', 'compatible'],
    ['GPL-2.0-only dep, GPL-2.0-or-later project', 'GPL-2.0-only', 'GPL-2.0-or-later', 'application', 'compatible'],
    ['GPL-2.0-only dep, GPL-3.0 project', 'GPL-2.0-only', 'GPL-3.0-only', 'application', 'incompatible'],
    ['GPL-3.0 dep, GPL-2.0-only project', 'GPL-3.0-only', 'GPL-2.0-only', 'application', 'incompatible'],
    ['GPL-3.0 dep, GPL-2.0-or-later project', 'GPL-3.0-only', 'GPL-2.0-or-later', 'application', 'compatible'],
    ['GPL-2.0-or-later dep, GPL-3.0 project', 'GPL-2.0-or-later', 'GPL-3.0-only', 'application', 'compatible'],
    ['GPL-2.0-only dep, AGPL project', 'GPL-2.0-only', 'AGPL-3.0-only', 'application', 'incompatible'],
    ['strong dep, LGPL project', 'GPL-3.0-only', 'LGPL-3.0-only', 'library', 'incompatible'],
    // network copyleft
    ['network/internal', 'AGPL-3.0-only', 'MIT', 'internal', 'conditional'],
    ['network/application, MIT project', 'AGPL-3.0-only', 'MIT', 'application', 'incompatible'],
    ['network/library, AGPL project', 'AGPL-3.0-or-later', 'AGPL-3.0-only', 'library', 'compatible'],
    ['network/saas, MIT project', 'AGPL-3.0-only', 'MIT', 'saas', 'incompatible'],
    ['network/saas, AGPL project', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'saas', 'compatible'],
    ['network/saas, GPL-3.0 project (conservative)', 'AGPL-3.0-only', 'GPL-3.0-only', 'saas', 'incompatible'],
    // non_oss
    ['non_oss/internal', 'BUSL-1.1', 'MIT', 'internal', 'conditional'],
    ['non_oss/library', 'SSPL-1.0', 'MIT', 'library', 'incompatible'],
    ['non_oss/application', 'Elastic-2.0', 'MIT', 'application', 'incompatible'],
    ['non_oss/saas', 'CC-BY-NC-4.0', 'MIT', 'saas', 'incompatible'],
    ['non_oss into GPL project', 'BUSL-1.1', 'GPL-3.0-only', 'application', 'incompatible'],
    // unknown
    ['unknown/internal', 'LicenseRef-custom', 'MIT', 'internal', 'unknown'],
    ['unknown/library', 'LicenseRef-custom', 'MIT', 'library', 'unknown'],
    ['unknown/application', 'WTFPL', 'MIT', 'application', 'unknown'],
    ['unknown/saas', 'LicenseRef-custom', 'MIT', 'saas', 'unknown'],
  ];

  it.each(table)('%s', (_name, candidate, project, distribution, expected) => {
    expect(verdictOf(candidate, project, distribution)).toBe(expected);
  });

  it('has at least 25 table cases', () => {
    expect(table.length).toBeGreaterThanOrEqual(25);
  });

  it('agrees with LICENSE_MATRIX for every category x distribution when the project resolves the cell', () => {
    const representative: Record<LicenseCategory, { candidate: string; project: string | null }> = {
      permissive: { candidate: 'MIT', project: 'MIT' },
      weak_copyleft: { candidate: 'MPL-2.0', project: 'MIT' },
      strong_copyleft: { candidate: 'GPL-3.0-only', project: 'GPL-3.0-only' },
      network_copyleft: { candidate: 'AGPL-3.0-only', project: 'AGPL-3.0-only' },
      non_oss: { candidate: 'SSPL-1.0', project: 'MIT' },
      unknown: { candidate: 'LicenseRef-x', project: 'MIT' },
    };
    const columns: Array<[Distribution, 'internal' | 'distributed' | 'saas']> = [
      ['internal', 'internal'],
      ['library', 'distributed'],
      ['application', 'distributed'],
      ['saas', 'saas'],
    ];
    for (const [category, sample] of Object.entries(representative) as Array<
      [LicenseCategory, { candidate: string; project: string | null }]
    >) {
      for (const [distribution, column] of columns) {
        const cell = LICENSE_MATRIX[category][column];
        const expected: Verdict =
          cell === 'gpl_project' || cell === 'agpl_project' ? 'compatible' : cell;
        const verdict = judge({ ...sample, distribution, source: 'github' });
        expect(verdict.category, `${category}/${distribution}`).toBe(category);
        expect(verdict.verdict, `${category}/${distribution}`).toBe(expected);
      }
    }
  });
});

describe('judge: expressions', () => {
  it('MIT OR GPL-3.0 is permissive and compatible for a proprietary application', () => {
    const v = judge({ candidate: 'MIT OR GPL-3.0', project: 'Proprietary', distribution: 'application', source: 'npm' });
    expect(v.category).toBe('permissive');
    expect(v.verdict).toBe('compatible');
    expect(v.notes.join(' ')).toContain('most favorable alternative, MIT');
  });

  it('MIT AND GPL-3.0 is strong copyleft and incompatible for an MIT application', () => {
    const v = judge({ candidate: 'MIT AND GPL-3.0', project: 'MIT', distribution: 'application', source: 'npm' });
    expect(v.category).toBe('strong_copyleft');
    expect(v.verdict).toBe('incompatible');
  });

  it('MIT AND GPL-3.0 stays strong copyleft when the project is GPL-3.0 (compatible)', () => {
    const v = judge({ candidate: 'MIT AND GPL-3.0', project: 'GPL-3.0-only', distribution: 'application', source: 'npm' });
    expect(v.category).toBe('strong_copyleft');
    expect(v.verdict).toBe('compatible');
  });

  it('an OR picks the alternative that fits the project license', () => {
    const v = judge({
      candidate: 'Apache-2.0 OR GPL-2.0-only',
      project: 'GPL-2.0-only',
      distribution: 'application',
      source: 'npm',
    });
    expect(v.verdict).toBe('compatible');
    expect(v.category).toBe('strong_copyleft');
  });

  it('AND takes the worst verdict; unknown parts make the result unknown', () => {
    expect(verdictOf('MIT AND LicenseRef-x', 'MIT', 'application')).toBe('unknown');
    expect(verdictOf('MIT AND MPL-2.0', 'MIT', 'application')).toBe('conditional');
    expect(verdictOf('GPL-3.0-only AND LicenseRef-x', 'MIT', 'application')).toBe('incompatible');
  });

  it('a dual-licensed project can use the more favorable of its licenses', () => {
    expect(verdictOf('GPL-3.0-only', 'MIT OR GPL-3.0-only', 'application')).toBe('compatible');
    expect(verdictOf('GPL-3.0-only', 'MIT AND GPL-3.0-only', 'application')).toBe('incompatible');
  });

  it('WITH is judged by the base license and says so', () => {
    const v = judge({
      candidate: 'GPL-2.0-only WITH Classpath-exception-2.0',
      project: 'MIT',
      distribution: 'application',
      source: 'depsdev',
    });
    expect(v.category).toBe('strong_copyleft');
    expect(v.verdict).toBe('incompatible');
    expect(v.candidate_spdx).toBe('GPL-2.0-only WITH Classpath-exception-2.0');
    expect(v.notes.join(' ')).toContain('exception is not applied');
  });
});

describe('judge: unknown, NOASSERTION and non-SPDX candidates', () => {
  it.each([[null], [''], ['NOASSERTION'], ['NONE']])('%j -> unknown with null candidate_spdx', (candidate) => {
    const v = judge({ candidate, project: 'MIT', distribution: 'application', source: 'github' });
    expect(v.verdict).toBe('unknown');
    expect(v.category).toBe('unknown');
    expect(v.candidate_spdx).toBeNull();
    expect(v.obligations.length).toBeGreaterThan(0);
    expect(v.notes).toContain('Not legal advice');
  });

  it('keeps unparseable text visible in candidate_spdx', () => {
    const v = judge({ candidate: 'SEE LICENSE IN LICENSE.md', project: 'MIT', distribution: 'library', source: 'npm' });
    expect(v.verdict).toBe('unknown');
    expect(v.candidate_spdx).toBe('SEE LICENSE IN LICENSE.md');
    expect(v.notes.join(' ')).toContain('Custom license');
    const other = judge({ candidate: 'Some License 1.0', project: 'MIT', distribution: 'library', source: 'npm' });
    expect(other.notes.join(' ')).toContain('not a valid SPDX expression');
  });

  it('marks custom license texts (usually commercial) apart from a missing license', () => {
    expect(isCustomLicenseText('SEE LICENSE IN <license.txt>')).toBe(true);
    expect(isCustomLicenseText('UNLICENSED')).toBe(true);
    expect(isCustomLicenseText('LicenseRef-Commercial')).toBe(true);
    expect(isCustomLicenseText('MIT')).toBe(false);
    expect(isCustomLicenseText(null)).toBe(false);
  });

  it('never throws on odd input', () => {
    for (const candidate of ['(', ')', 'AND', 'MIT AND', '((MIT)', '\u0000', 'a'.repeat(5000)]) {
      expect(() => judge({ candidate, project: candidate, source: 'agent' })).not.toThrow();
    }
  });
});

describe('judge: project license handling', () => {
  it('assumes permissive with a warning note when the project license is missing', () => {
    const v = judge({ candidate: 'GPL-3.0-only', project: null, distribution: 'application', source: 'github' });
    expect(v.project_spdx).toBeNull();
    expect(v.verdict).toBe('incompatible');
    expect(v.notes.join(' ')).toContain('Project license not specified; assumed permissive');
  });

  it('omitting project behaves like null', () => {
    const v = judge({ candidate: 'MIT', distribution: 'library', source: 'npm' });
    expect(v.project_spdx).toBeNull();
    expect(v.verdict).toBe('compatible');
    expect(v.notes.join(' ')).toContain('assumed permissive');
  });

  it('treats an unparseable project license as non-copyleft and says so', () => {
    const v = judge({ candidate: 'GPL-3.0-only', project: 'Proprietary EULA', distribution: 'application', source: 'npm' });
    expect(v.project_spdx).toBe('Proprietary EULA');
    expect(v.verdict).toBe('incompatible');
    expect(v.notes.join(' ')).toContain('not a valid SPDX expression');
  });

  it('defaults distribution to application', () => {
    const v = judge({ candidate: 'GPL-3.0-only', project: 'MIT', source: 'npm' });
    expect(v.distribution).toBe('application');
    expect(v.verdict).toBe('incompatible');
  });

  it('GPL-2.0-only vs GPL-3.0 incompatibility is explained', () => {
    const v = judge({ candidate: 'GPL-3.0-only', project: 'GPL-2.0-only', distribution: 'application', source: 'npm' });
    expect(v.verdict).toBe('incompatible');
    expect(v.notes.join(' ')).toContain('mutually incompatible');
  });

  it('explains the Apache-2.0 vs GPL-2.0-only conflict', () => {
    const v = judge({ candidate: 'Apache-2.0', project: 'GPL-2.0-only', distribution: 'library', source: 'npm' });
    expect(v.verdict).toBe('incompatible');
    expect(v.category).toBe('permissive');
    expect(v.notes.join(' ')).toContain('Apache-2.0 is incompatible with GPL-2.0-only');
  });
});

describe('judge: output shape', () => {
  it('echoes normalized licenses, distribution and source', () => {
    const v = judge({ candidate: 'mit or apache-2.0', project: 'gpl-3.0-only', distribution: 'saas', source: 'remote_cache' });
    expect(v.candidate_spdx).toBe('MIT OR Apache-2.0');
    expect(v.project_spdx).toBe('GPL-3.0-only');
    expect(v.distribution).toBe('saas');
    expect(v.source).toBe('remote_cache');
  });

  it('always includes Not legal advice', () => {
    for (const candidate of ['MIT', 'GPL-3.0-only', 'SSPL-1.0', null]) {
      const v = judge({ candidate, project: 'MIT', distribution: 'application', source: 'npm' });
      expect(v.notes).toContain('Not legal advice');
    }
  });

  it('lists obligations by license', () => {
    const mit = judge({ candidate: 'MIT', project: 'MIT', source: 'npm' });
    expect(mit.obligations).toContain('Retain copyright and license notice');

    const apache = judge({ candidate: 'Apache-2.0', project: 'MIT', source: 'npm' });
    expect(apache.obligations).toContain('Retain copyright and license notice');
    expect(apache.obligations.join(' ')).toContain('NOTICE');

    const mpl = judge({ candidate: 'MPL-2.0', project: 'MIT', source: 'npm' });
    expect(mpl.obligations.join(' ')).toContain('Publish modifications to covered files');

    const both = judge({ candidate: 'Apache-2.0 AND MPL-2.0', project: 'MIT', source: 'npm' });
    expect(both.obligations.join(' ')).toContain('NOTICE');
    expect(both.obligations.join(' ')).toContain('Publish modifications');
  });

  it('is deterministic and produces a schema-valid shape', () => {
    const input = { candidate: 'MIT OR GPL-3.0', project: 'Apache-2.0', distribution: 'library', source: 'npm' } as const;
    const a = judge(input);
    const b = judge(input);
    expect(a).toEqual(b);
    expect(() => LicenseVerdictSchema.parse(a)).not.toThrow();
    expect(a.notes.length).toBe(new Set(a.notes).size);
    expect(a.obligations.length).toBe(new Set(a.obligations).size);
  });
});

describe('license-matrix.md matches the code', () => {
  const md = readFileSync(
    fileURLToPath(new URL('../../../skills/recyclewheel/reference/license-matrix.md', import.meta.url)),
    'utf8',
  );

  it('contains the matrix table rows generated from LICENSE_MATRIX', () => {
    for (const [category, cells] of Object.entries(LICENSE_MATRIX)) {
      const row = `| ${category} | ${MATRIX_CELL_LABEL[cells.internal]} | ${MATRIX_CELL_LABEL[cells.distributed]} | ${MATRIX_CELL_LABEL[cells.saas]} |`;
      expect(md, `row for ${category}`).toContain(row);
    }
  });

  it('lists every classified license under its category', () => {
    for (const [category, members] of Object.entries(CATEGORY_MEMBERS)) {
      const line = md.split('\n').find((l) => l.startsWith(`| ${category} |`) && l.includes('`'));
      expect(line, `classification row for ${category}`).toBeDefined();
      for (const member of members) {
        expect(line, `${member} under ${category}`).toContain(`\`${member}\``);
      }
    }
  });

  it('carries the not-legal-advice disclaimer', () => {
    expect(md).toContain('Not legal advice');
  });
});
