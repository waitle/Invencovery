/**
 * Second re-check M1 at tool level: hostile third-party and caller text
 * (`<` followed by endless whitespace, `</` repeats, huge license strings) goes
 * through each tool's output path in bounded time and stays inert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../../../src/core/sanitize.js';
import { ledgerTool } from '../../../src/mcp/tools/ledger.js';
import { cleanupTmpDirs } from '../../helpers/tmp.js';
import { ALL_TOOLS, candidate, createHarness, fakeAdapter, fakeEnricher, seedComponents } from './_harness.js';
import type { Harness } from './_harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupTmpDirs();
});

const BIG = 200_000;
/** Generous for slow CI; a quadratic regex on this input takes many seconds. */
const BUDGET_MS = 1500;

const HOSTILE: Array<[string, string]> = [
  ['< and spaces', `<${' '.repeat(BIG)}`],
  ['</ repeated', '</'.repeat(BIG / 2)],
  ['< / repeated', '< / '.repeat(BIG / 4)],
  ['license list', `MIT ${'OR MIT '.repeat(BIG / 7)}`],
];

async function timedCall(t: Harness, name: string, args: Record<string, unknown>): Promise<{ ms: number; text: string; isError: boolean }> {
  const start = performance.now();
  const r = await t.call(name, args);
  return { ms: performance.now() - start, text: r.text, isError: r.isError };
}

function expectFenceIntact(text: string): void {
  const lines = text.split('\n');
  expect(lines.filter((l) => l === UNTRUSTED_OPEN).length).toBe(lines.filter((l) => l === UNTRUSTED_CLOSE).length);
  expect(text.length).toBeLessThan(400_000);
}

describe.each(HOSTILE)('hostile text: %s', (_name, hostile) => {
  it('rw_search: a huge license_spdx / name / description from an adapter', async () => {
    h = await createHarness({
      adapters: {
        npm: fakeAdapter('npm', () => ({
          candidates: [candidate('npm:zod', 'npm', { name: hostile, description: hostile, license_spdx: hostile })],
          meta: { status: 'ok', message: hostile },
        })),
      },
    });
    await seedComponents(h);
    const id = h.state().components[0]?.id as string;
    const r = await timedCall(h, 'rw_search', { component_id: id, sources: ['npm'] });
    expect(r.ms).toBeLessThan(BUDGET_MS);
    expect(r.isError, r.text.slice(0, 300)).toBe(false);
    expectFenceIntact(r.text);
  });

  it('rw_evaluate: a huge license from an enricher, and huge missing entries', async () => {
    h = await createHarness({
      enrichers: [fakeEnricher(['npm'], () => ({ license_spdx: hostile, license_source: 'npm', missing: [hostile, 'license'] }))],
    });
    await seedComponents(h);
    const id = h.state().components[0]?.id as string;
    const r = await timedCall(h, 'rw_evaluate', {
      component_id: id,
      candidates: [{ ref: 'npm:zod', fit: 3, fit_reason: 'because the fit reason is long enough' }],
    });
    expect(r.ms).toBeLessThan(BUDGET_MS);
    expect(r.isError, r.text.slice(0, 300)).toBe(false);
    expectFenceIntact(r.text);
  });

  it('rw_record_evidence: a huge summary, title and note', async () => {
    h = await createHarness();
    await seedComponents(h);
    const id = h.state().components[0]?.id as string;
    const r = await timedCall(h, 'rw_record_evidence', {
      component_id: id,
      kind: 'manual',
      results: [{ url: 'https://example.test/a', title: hostile.slice(0, 2000), note: hostile.slice(0, 200) }],
      summary: `${hostile} and more words`,
    });
    expect(r.ms).toBeLessThan(BUDGET_MS);
    expectFenceIntact(r.text);
  });

  it('rw_decompose: a huge name and keyword', async () => {
    h = await createHarness();
    const r = await timedCall(h, 'rw_decompose', {
      project: { name: 'demo', summary: 'A demo project used by the tests.', ecosystems: ['npm'] },
      components: [{ name: hostile.slice(0, 200), description: hostile.slice(0, 500), keywords: [hostile.slice(0, 100)] }],
    });
    expect(r.ms).toBeLessThan(BUDGET_MS);
    expectFenceIntact(r.text);
  });

  it('rw_ledger: every format renders a ledger holding hostile text in bounded time', async () => {
    h = await createHarness({ tools: [...ALL_TOOLS, ledgerTool] });
    await seedComponents(h, [{ name: 'Markdown', description: hostile.slice(0, 500), keywords: [hostile.slice(0, 100)] }]);
    const id = h.state().components[0]?.id as string;
    await h.call('rw_record_evidence', {
      component_id: id,
      kind: 'manual',
      results: [{ url: 'https://example.test/a', title: hostile.slice(0, 2000) }],
      summary: `${hostile} and more words`,
    });
    for (const format of ['markdown', 'notices', 'json']) {
      const r = await timedCall(h, 'rw_ledger', { action: 'get', format });
      expect(r.ms, format).toBeLessThan(BUDGET_MS);
      expect(r.isError, `${format}: ${r.text.slice(0, 300)}`).toBe(false);
      expectFenceIntact(r.text);
    }
  });
});
