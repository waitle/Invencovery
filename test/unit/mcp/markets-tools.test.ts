/** Target markets across the tools: rw_decompose, rw_record_evidence, rw_decide, rw_status, rw_ledger. */
import { afterEach, describe, expect, it } from 'vitest';
import { StatusReportSchema } from '../../../src/doctor.js';
import { DecomposeOutputSchema } from '../../../src/mcp/tools/decompose.js';
import { EvidenceOutputSchema } from '../../../src/mcp/tools/evidence.js';
import { ledgerTool } from '../../../src/mcp/tools/ledger.js';
import { statusTool } from '../../../src/mcp/tools/status.js';
import { cleanupTmpDirs } from '../../helpers/tmp.js';
import { ALL_TOOLS, PROJECT, component, createHarness } from './_harness.js';
import type { Harness } from './_harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupTmpDirs();
});

const decompose = (project: Record<string, unknown> = {}, components = [component('Markdown')]) =>
  h!.call('rw_decompose', { project: { ...PROJECT, ...project }, components });

const legalEvidence = (market: string | undefined, over: Record<string, unknown> = {}) =>
  h!.call('rw_record_evidence', {
    concern: 'legal_privacy',
    kind: 'web',
    summary: 'Read the privacy rules of the market.',
    results: [],
    ...(market !== undefined ? { market } : {}),
    ...over,
  });

describe('rw_decompose: markets', () => {
  it('stores the given markets, reports them and adds market questions to the checklist', async () => {
    h = await createHarness();
    const r = await decompose({ markets: ['KR', 'US'] });
    expect(r.isError).toBe(false);
    const out = DecomposeOutputSchema.parse(r.structured);
    expect(out.markets).toEqual({ codes: ['KR', 'US'], source: 'input' });
    expect(h.state().project).toMatchObject({ markets: ['KR', 'US'], markets_source: 'input' });
    const legal = out.concerns_checklist.find((c) => c.concern === 'legal_privacy')!;
    expect(legal.questions.some((q) => q.startsWith('[KR] '))).toBe(true);
    expect(legal.questions.some((q) => q.startsWith('[US] '))).toBe(true);
    expect(r.text).toContain('Target markets');
    expect(r.text).toContain('`KR`');
    expect(out.warnings ?? []).not.toContain(expect.stringContaining('no target market'));
  });

  it('infers KR from Hangul in the project text and says to confirm it', async () => {
    h = await createHarness();
    const r = await decompose({ summary: '통화 녹음을 요약하는 서비스' }, [component('Notes', { description: '요약 노트' })]);
    expect(r.isError).toBe(false);
    const out = DecomposeOutputSchema.parse(r.structured);
    expect(out.markets).toEqual({ codes: ['KR'], source: 'inferred' });
    expect(h.state().project).toMatchObject({ markets: ['KR'], markets_source: 'inferred' });
    expect(r.text).toContain('inferred');
    expect(r.text).toContain('confirm');
  });

  it('warns when no market is given or inferable', async () => {
    h = await createHarness();
    const r = await decompose();
    const out = DecomposeOutputSchema.parse(r.structured);
    expect(out.markets).toEqual({ codes: [], source: 'none' });
    expect(out.warnings!.join(' ')).toContain('no target market given or inferable');
    expect(h.state().project?.markets).toBeUndefined();
  });

  it.each([['kr'], ['KOR'], ['Korea'], ['K'], ['']])('rejects the market %j', async (bad) => {
    h = await createHarness();
    const r = await decompose({ markets: [bad] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('alpha-2');
    expect(h.state().project).toBeUndefined();
  });

  it('rejects an empty list and more than ten markets', async () => {
    h = await createHarness();
    expect((await decompose({ markets: [] })).isError).toBe(true);
    const eleven = ['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK'];
    expect((await decompose({ markets: eleven })).isError).toBe(true);
  });

  it('keeps the markets of the first call when a later call gives none', async () => {
    h = await createHarness();
    await decompose({ markets: ['US'] });
    const again = await decompose();
    expect(DecomposeOutputSchema.parse(again.structured).markets).toEqual({ codes: ['US'], source: 'input' });
    expect(h.state().project).toMatchObject({ markets: ['US'], markets_source: 'input' });
  });
});

describe('rw_record_evidence: market', () => {
  it('records a market with a concern and echoes it', async () => {
    h = await createHarness();
    await decompose({ markets: ['KR'] });
    const r = await legalEvidence('KR');
    expect(r.isError).toBe(false);
    EvidenceOutputSchema.parse(r.structured);
    expect(r.text).toContain('market');
    expect(r.text).toContain('KR');
    expect(h.state().evidence[0]).toMatchObject({ concern: 'legal_privacy', market: 'KR' });
  });

  it('rejects a market without a concern, naming the fix', async () => {
    h = await createHarness();
    await decompose({ markets: ['KR'] });
    const r = await h.call('rw_record_evidence', { component_id: 'markdown', kind: 'web', summary: 'Looked at a page.', results: [], market: 'KR' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('market is only allowed together with `concern`');
    expect(h.state().evidence).toHaveLength(0);
  });

  it.each([['kr'], ['KOR'], ['Korea']])('rejects the malformed market %j', async (bad) => {
    h = await createHarness();
    await decompose({ markets: ['KR'] });
    const r = await legalEvidence(bad);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('alpha-2');
  });

  it('gives legal_privacy one web allowance per target market', async () => {
    h = await createHarness({ env: { RECYCLEWHEEL_BUDGET_WEB: '1' } });
    await decompose({ markets: ['KR', 'US'] });
    const warnings: Array<string[] | undefined> = [];
    for (const market of ['KR', 'US', 'KR']) {
      warnings.push(EvidenceOutputSchema.parse((await legalEvidence(market)).structured).warnings);
    }
    expect(warnings[0]).toBeUndefined();
    expect(warnings[1]).toBeUndefined();
    expect(warnings[2]?.[0]).toContain('exceeded (2/2 used)'); // two markets, one allowance each
  });

  it('keeps the plain allowance for the other concerns', async () => {
    h = await createHarness({ env: { RECYCLEWHEEL_BUDGET_WEB: '1' } });
    await decompose({ markets: ['KR', 'US'] });
    const security = () => h!.call('rw_record_evidence', { concern: 'security', kind: 'web', summary: 'Read the advisories.', results: [] });
    expect(EvidenceOutputSchema.parse((await security()).structured).warnings).toBeUndefined();
    expect(EvidenceOutputSchema.parse((await security()).structured).warnings?.[0]).toContain('exceeded (1/1 used)');
  });
});

describe('per-market coverage in rw_status, rw_ledger and rw_decide', () => {
  const tools = () => ({ tools: [...ALL_TOOLS, ledgerTool, statusTool] });

  it('rw_status lists legal_privacy per market', async () => {
    h = await createHarness(tools());
    await decompose({ markets: ['KR', 'US'] });
    await legalEvidence('KR');
    const r = await h.call('rw_status', {});
    expect(r.isError).toBe(false);
    const report = StatusReportSchema.parse(r.structured);
    const legal = report.cross_cutting.find((c) => c.concern === 'legal_privacy')!;
    expect(legal.markets).toEqual([
      { code: 'KR', checked: true, evidence_count: 1 },
      { code: 'US', checked: false, evidence_count: 0 },
    ]);
    expect(report.cross_cutting.filter((c) => c.markets !== undefined)).toHaveLength(1);
    expect(r.text).toContain('KR');
    expect(r.text).toContain('US');
  });

  it('rw_status has no market rows when the project has no markets', async () => {
    h = await createHarness(tools());
    await decompose();
    const report = StatusReportSchema.parse((await h.call('rw_status', {})).structured);
    expect(report.cross_cutting.every((c) => c.markets === undefined)).toBe(true);
  });

  it('rw_ledger export reports the market that has no legal_privacy evidence', async () => {
    h = await createHarness(tools());
    await decompose({ markets: ['KR', 'US'] });
    await legalEvidence('KR');
    const r = await h.call('rw_ledger', { action: 'export', format: 'markdown' });
    expect(r.isError).toBe(false);
    const structured = r.structured as { content: string; cross_cutting?: Array<{ concern: string; markets?: unknown[] }> };
    expect(structured.content).toContain('**Markets:** KR, US (input)');
    expect(structured.content).toContain('US **not checked**');
    expect(structured.cross_cutting?.find((c) => c.concern === 'legal_privacy')?.markets).toHaveLength(2);
  });

  it('rw_decide warns for each market without legal_privacy evidence', async () => {
    h = await createHarness({ ...tools(), adapters: {} });
    await decompose({ markets: ['KR', 'US'] }, [component('Markdown', { trivial: true })]);
    await legalEvidence('KR');
    const r = await h.call('rw_decide', {
      component_id: 'markdown',
      decision: 'build',
      rationale: 'Trivial helper, nothing worth a dependency.',
      build_reason: 'trivial',
    });
    expect(r.isError, r.text).toBe(false);
    const warnings = (r.structured as { warnings?: string[] }).warnings ?? [];
    expect(warnings).toContain('cross-cutting concern not checked for market US: legal_privacy');
    expect(warnings).not.toContain('cross-cutting concern not checked for market KR: legal_privacy');
  });
});

describe('distribution_policy with only market-specific evidence', () => {
  const tools = () => ({ tools: [...ALL_TOOLS, ledgerTool, statusTool] });
  const storeEvidence = (market: string | undefined) =>
    h!.call('rw_record_evidence', {
      concern: 'distribution_policy',
      kind: 'web',
      summary: 'Read the store rules.',
      results: [],
      ...(market !== undefined ? { market } : {}),
    });

  it('stays not checked in rw_status, rw_ledger and rw_decide until a general evidence exists', async () => {
    h = await createHarness({ ...tools(), adapters: {} });
    await decompose({ markets: ['KR'] }, [component('Markdown', { trivial: true })]);
    await storeEvidence('KR');
    const decide = () =>
      h!.call('rw_decide', {
        component_id: 'markdown',
        decision: 'build',
        rationale: 'Trivial helper, nothing worth a dependency.',
        build_reason: 'trivial',
      });
    const r = await decide();
    expect(r.isError, r.text).toBe(false);
    const decideWarnings = (r.structured as { warnings?: string[] }).warnings ?? [];
    expect(decideWarnings).toContain('cross-cutting concern not checked: distribution_policy (only market-specific evidence)');

    const status = await h.call('rw_status', {});
    const report = StatusReportSchema.parse(status.structured);
    expect(report.cross_cutting.find((c) => c.concern === 'distribution_policy')).toMatchObject({ checked: false, evidence_count: 1, market_only: true });
    expect(report.warnings).toContain('cross-cutting concern not checked: distribution_policy (only market-specific evidence)');
    expect(status.text).toContain('distribution_policy not checked (only market-specific evidence)');

    const ledger = await h.call('rw_ledger', { action: 'export', format: 'markdown' });
    const structured = ledger.structured as { content: string; warnings?: string[]; cross_cutting?: Array<{ concern: string; market_only?: boolean }> };
    expect(structured.content).toContain('distribution_policy: **not checked** (only market-specific evidence: 1)');
    expect(structured.warnings).toContain('cross-cutting concern not checked: distribution_policy (only market-specific evidence)');
    expect(structured.cross_cutting?.find((c) => c.concern === 'distribution_policy')?.market_only).toBe(true);

    await storeEvidence(undefined);
    const after = StatusReportSchema.parse((await h.call('rw_status', {})).structured);
    expect(after.cross_cutting.find((c) => c.concern === 'distribution_policy')).toMatchObject({ checked: true, evidence_count: 2 });
    expect(after.cross_cutting.find((c) => c.concern === 'distribution_policy')?.market_only).toBeUndefined();
    expect(after.warnings.some((w) => w.includes('distribution_policy'))).toBe(false);
  });

  it('legal_privacy with markets needs a market-tagged evidence in every output', async () => {
    h = await createHarness({ ...tools(), adapters: {} });
    await decompose({ markets: ['KR'] }, [component('Markdown', { trivial: true })]);
    await legalEvidence(undefined);
    const report = StatusReportSchema.parse((await h.call('rw_status', {})).structured);
    expect(report.cross_cutting.find((c) => c.concern === 'legal_privacy')).toMatchObject({ checked: false, evidence_count: 1 });
    await legalEvidence('KR');
    const after = StatusReportSchema.parse((await h.call('rw_status', {})).structured);
    expect(after.cross_cutting.find((c) => c.concern === 'legal_privacy')).toMatchObject({ checked: true, evidence_count: 2 });
  });
});
