import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HF_SPDX_IDS, judgeModelLicense, worseVerdict } from '../../../src/core/model-license.js';
import { judge } from '../../../src/core/license.js';
import { LicenseVerdictSchema } from '../../../src/types.js';
import type { Distribution, ModelLicenseFacts } from '../../../src/types.js';

function facts(hf_license: string[], over: Partial<ModelLicenseFacts> = {}): ModelLicenseFacts {
  return { hf_license, gated: false, base_models: [], ...over };
}

function judgeIn(f: ModelLicenseFacts | undefined, distribution: Distribution = 'application') {
  return judgeModelLicense(f, { project: 'MIT', distribution, source: 'huggingface' });
}

describe('worseVerdict', () => {
  it('orders incompatible > unknown > conditional > compatible', () => {
    expect(worseVerdict('compatible', 'conditional')).toBe('conditional');
    expect(worseVerdict('conditional', 'unknown')).toBe('unknown');
    expect(worseVerdict('unknown', 'incompatible')).toBe('incompatible');
    expect(worseVerdict('incompatible', 'compatible')).toBe('incompatible');
    expect(worseVerdict('compatible', 'compatible')).toBe('compatible');
  });
});

describe('judgeModelLicense: mapped ids', () => {
  it.each(Object.keys(HF_SPDX_IDS).filter((id) => ['apache-2.0', 'mit', 'bsd-3-clause'].includes(id)))(
    '%s is compatible and not custom',
    (id) => {
      const r = judgeIn(facts([id]));
      expect(r.license.verdict).toBe('compatible');
      expect(r.custom).toBe(false);
      expect(r.license.candidate_spdx).toBe(HF_SPDX_IDS[id]);
    },
  );

  it('judges mapped ids with the code matrix for every distribution', () => {
    for (const d of ['library', 'application', 'saas', 'internal'] as const) {
      const code = judge({ candidate: 'GPL-3.0-only', project: 'MIT', distribution: d, source: 'huggingface' });
      expect(judgeIn(facts(['gpl-3.0']), d).license.verdict).toBe(code.verdict);
    }
    expect(judgeIn(facts(['gpl-3.0']), 'application').license.verdict).not.toBe('compatible');
  });

  it('always carries the separate-license and legal-advice notes and parses as a LicenseVerdict', () => {
    const r = judgeIn(facts(['mit']));
    expect(r.license.notes[0]).toMatch(/licensed separately from the code/);
    expect(r.license.notes[r.license.notes.length - 1]).toBe('Not legal advice');
    expect(LicenseVerdictSchema.safeParse(r.license).success).toBe(true);
  });
});

describe('judgeModelLicense: non-commercial', () => {
  it.each(['cc-by-nc-4.0', 'cc-by-nc-sa-4.0', 'cc-by-nc-nd-4.0', 'cc-by-nc-3.0', 'fair-noncommercial-research-license'])(
    '%s is incompatible for commercial distribution forms',
    (id) => {
      for (const d of ['application', 'saas', 'library'] as const) {
        const r = judgeIn(facts([id]), d);
        expect(r.license.verdict, `${id} ${d}`).toBe('incompatible');
        expect(r.custom).toBe(false);
      }
      expect(judgeIn(facts([id])).license.notes.join(' ')).toMatch(/Non-commercial/);
    },
  );
});

describe('judgeModelLicense: conditional families', () => {
  it.each(['openrail', 'openrail++', 'creativeml-openrail-m', 'bigscience-openrail-m', 'llama2', 'llama3.1', 'llama4', 'gemma', 'cc-by-sa-4.0', 'cc-by-nd-4.0'])(
    '%s is conditional',
    (id) => {
      const r = judgeIn(facts([id]));
      expect(r.license.verdict).toBe('conditional');
      expect(r.custom).toBe(false);
      expect(r.license.obligations.length).toBeGreaterThan(0);
    },
  );

  it('CC-BY is compatible with an attribution duty', () => {
    const r = judgeIn(facts(['cc-by-4.0']));
    expect(r.license.verdict).toBe('compatible');
    expect(r.license.obligations.join(' ')).toMatch(/credit/i);
  });

  it('names the Llama use policy', () => {
    expect(judgeIn(facts(['llama3.1'])).license.notes.join(' ')).toMatch(/acceptable use policy/);
  });
});

describe('judgeModelLicense: custom and unknown', () => {
  it('license: other is a custom license with verdict unknown', () => {
    const r = judgeIn(facts(['other']));
    expect(r.license.verdict).toBe('unknown');
    expect(r.custom).toBe(true);
    expect(r.license.obligations.join(' ')).toMatch(/review the actual LICENSE/);
  });

  it('an id outside the table is custom', () => {
    const r = judgeIn(facts(['some-new-license-1.0']));
    expect(r.license.verdict).toBe('unknown');
    expect(r.custom).toBe(true);
  });

  it('any license_name makes the whole card custom, even next to a mapped id', () => {
    const r = judgeIn(facts(['apache-2.0'], { license_name: 'vendor-license', license_link: 'LICENSE' }));
    expect(r.license.verdict).toBe('unknown');
    expect(r.custom).toBe(true);
    expect(r.license.candidate_spdx).toBe('vendor-license');
    expect(r.license.notes.join(' ')).toContain('"vendor-license" (LICENSE)');
  });

  it('a card without a license is unknown but not a custom license', () => {
    const r = judgeIn(facts([]));
    expect(r.license.verdict).toBe('unknown');
    expect(r.custom).toBe(false);
  });

  it('a model that could not be retrieved is unknown with an explanation', () => {
    const r = judgeIn(undefined);
    expect(r.license.verdict).toBe('unknown');
    expect(r.license.candidate_spdx).toBeNull();
    expect(r.license.notes.join(' ')).toMatch(/could not be retrieved/);
  });

  it('several ids combine like AND: the worst part decides', () => {
    expect(judgeIn(facts(['apache-2.0', 'cc-by-nc-4.0'])).license.verdict).toBe('incompatible');
    expect(judgeIn(facts(['mit', 'llama3'])).license.verdict).toBe('conditional');
    expect(judgeIn(facts(['mit', 'other'])).license.verdict).toBe('unknown');
  });
});

describe('judgeModelLicense: gating and base models', () => {
  it('notes gated access and base models without changing the verdict', () => {
    const r = judgeIn(facts(['apache-2.0'], { gated: true, base_models: ['Qwen/Qwen2.5-0.5B-Instruct'] }));
    expect(r.license.verdict).toBe('compatible');
    const notes = r.license.notes.join(' ');
    expect(notes).toMatch(/Gated model/);
    expect(notes).toContain('Qwen/Qwen2.5-0.5B-Instruct');
  });
});

describe('license-matrix.md section 8 matches the code', () => {
  const md = readFileSync(
    fileURLToPath(new URL('../../../skills/recyclewheel/reference/license-matrix.md', import.meta.url)),
    'utf8',
  );
  const section = md.split(/^## /m).find((p) => p.startsWith('8. '));
  if (section === undefined) throw new Error('license-matrix.md has no section 8');
  const rows = section
    .split('\n')
    .filter((l) => l.startsWith('| `') || l.startsWith('| 라이선스') || l.startsWith('| 표에'))
    .map((l) => l.split('|').map((c) => c.trim()))
    .filter((cells) => cells.length >= 4);

  const idsOf = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  const verdictOf = (id: string) => judgeIn(facts([id]));

  it('has a row for every documented verdict class', () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  it('every documented id gets the documented verdict', () => {
    let checked = 0;
    for (const cells of rows) {
      const verdict = cells[2]!;
      if (verdict.startsWith('unknown')) continue; // custom-license row: covered below
      for (const id of idsOf(cells[1]!)) {
        if (id.includes('*') || id === 'other') continue;
        const r = verdictOf(id);
        expect(r.custom, id).toBe(false);
        if (verdict.startsWith('compatible')) expect(r.license.verdict, id).toBe('compatible');
        else if (verdict.startsWith('conditional')) expect(r.license.verdict, id).toBe('conditional');
        else if (verdict.startsWith('incompatible')) expect(r.license.verdict, id).toBe('incompatible');
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('documents the cc-by-nc family and its internal exception', () => {
    expect(section).toContain('`cc-by-nc-*`');
    expect(judgeIn(facts(['cc-by-nc-4.0']), 'internal').license.verdict).toBe('conditional');
    expect(judgeIn(facts(['cc-by-nc-4.0']), 'application').license.verdict).toBe('incompatible');
  });

  it('lists every id the code maps to SPDX', () => {
    for (const id of Object.keys(HF_SPDX_IDS)) expect(section, id).toContain(`\`${id}\``);
  });

  it('documents the custom-license rule and the not-legal-advice notes', () => {
    expect(section).toContain('custom_model_license');
    expect(judgeIn(facts(['other'])).custom).toBe(true);
    expect(section).toContain('Not legal advice');
  });
});
