/**
 * stdio smoke test (docs/PLAN.md §12 T30, §13.3): the bundled `dist/cli.js` runs as
 * a real child process and is driven through the SDK client over stdio.
 *
 * Determinism without a network: `RECYCLEWHEEL_OFFLINE=1`, a temporary cache
 * directory and a temporary project root. The HTTP responses the scenario needs
 * are written into the temporary cache database up front, keyed with the same
 * `cacheKey()` the server uses, so the adapters see cache hits (fresh entries are
 * served before the offline check). Everything else fails as `offline`.
 *
 * The tests in the main `describe` are ordered: each step uses the ledger state
 * produced by the previous one.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMcpRegistrySearchUrl } from '../../src/adapters/mcp-registry.js';
import { cacheKey } from '../../src/cache/key.js';
import { openCacheStore } from '../../src/cache/store.js';
import { cleanupTmpDirs, makeTmpDir } from '../helpers/tmp.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');
const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');

/** A fake token: it must never show up in any output, log, ledger or cache file. */
const FAKE_TOKEN = 'ghp_TESTTOKEN123';

const EXPECTED_TOOLS = [
  'rw_cache',
  'rw_decide',
  'rw_decompose',
  'rw_evaluate',
  'rw_ledger',
  'rw_record_evidence',
  'rw_search',
  'rw_status',
];

// ---------------------------------------------------------------------------
// Build (only when dist is missing or older than its inputs)
// ---------------------------------------------------------------------------

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

function ensureBuilt(): void {
  const inputsNewest = Math.max(
    newestMtime(path.join(REPO_ROOT, 'src')),
    statSync(path.join(REPO_ROOT, 'tsup.config.ts')).mtimeMs,
    statSync(path.join(REPO_ROOT, 'package.json')).mtimeMs,
  );
  if (existsSync(CLI) && statSync(CLI).mtimeMs >= inputsNewest) return;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const built = spawnSync(npm, ['run', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (built.status !== 0 || !existsSync(CLI)) {
    throw new Error(`npm run build failed (status ${String(built.status)}):\n${built.stdout}\n${built.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Cache seeding
// ---------------------------------------------------------------------------

const SEARCH_QUERY = 'markdown pdf pushed:>=2020-01-01';
const LIMIT = 5;
const GITHUB_SEARCH_URL = `https://api.github.com/search/repositories?q=${encodeURIComponent(SEARCH_QUERY)}&per_page=${LIMIT}`;
const NPM_SEARCH_URL = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(SEARCH_QUERY)}&size=${LIMIT}`;
const MCP_SEARCH_URL = buildMcpRegistrySearchUrl('v0.1', SEARCH_QUERY, LIMIT);
const NPM_LATEST_URL = 'https://registry.npmjs.org/markdown-pdf/latest';
const NPM_DOWNLOADS_URL = 'https://api.npmjs.org/downloads/point/last-week/markdown-pdf';
const GITHUB_REPO_URL = 'https://api.github.com/repos/alanshaw/markdown-pdf';
const HF_MODEL_URL = 'https://huggingface.co/api/models/livekit/turn-detector';

function fixtureText(...segments: string[]): string {
  return readFileSync(path.join(FIXTURES, ...segments), 'utf8');
}

function seedCache(cacheDir: string): void {
  const store = openCacheStore(path.join(cacheDir, 'cache.db'));
  const fetchedAt = Date.now();
  const put = (url: string, source: string, body: unknown): void => {
    store.put({
      key: cacheKey(url),
      url_redacted: url,
      source,
      status: 200,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      fetched_at: fetchedAt,
      expires_at: fetchedAt + 24 * 3_600_000,
      provenance: 'live',
    });
  };
  try {
    const githubFixture = JSON.parse(fixtureText('github', 'search-repositories.json')) as { body: unknown };
    put(GITHUB_SEARCH_URL, 'github_repo', githubFixture.body);
    put(NPM_SEARCH_URL, 'npm', fixtureText('npm', 'search.json'));
    put(MCP_SEARCH_URL, 'mcp_registry', fixtureText('mcp-registry', 'search-v0.1-filesystem-latest.json'));
    put(NPM_LATEST_URL, 'npm', {
      name: 'markdown-pdf',
      version: '11.0.0',
      description: 'Markdown to PDF converter',
      license: 'MIT',
      dependencies: { 'duplexer': '^0.1.1', 'extend': '^3.0.0', 'tmp': '0.0.33' },
      repository: { type: 'git', url: 'git+ssh://git@github.com/alanshaw/markdown-pdf.git' },
    });
    put(NPM_DOWNLOADS_URL, 'npm', { downloads: 45000, start: '2026-10-04', end: '2026-10-10', package: 'markdown-pdf' });
    put(GITHUB_REPO_URL, 'github_repo', {
      full_name: 'alanshaw/markdown-pdf',
      html_url: 'https://github.com/alanshaw/markdown-pdf',
      description: 'Node module that converts Markdown files to PDFs',
      stargazers_count: 1100,
      forks_count: 180,
      open_issues_count: 12,
      license: { spdx_id: 'MIT' },
      pushed_at: new Date(fetchedAt - 20 * 86_400_000).toISOString(),
      archived: false,
      private: false,
    });
    put(HF_MODEL_URL, 'hf_models', fixtureText('huggingface', 'model-turn-detector.json'));
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

interface ToolReply {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

function textOf(reply: ToolReply): string {
  return reply.content.map((c) => c.text ?? '').join('\n');
}

function serverEnv(cacheDir: string, projectRoot: string): Record<string, string> {
  return {
    RECYCLEWHEEL_CACHE_DIR: cacheDir,
    RECYCLEWHEEL_PROJECT_ROOT: projectRoot,
    RECYCLEWHEEL_OFFLINE: '1',
    RECYCLEWHEEL_NO_GH_CLI: '1',
    GITHUB_TOKEN: FAKE_TOKEN,
  };
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

describe('recyclewheel over stdio (dist/cli.js)', () => {
  let cacheDir = '';
  let projectRoot = '';
  let client: Client;
  let transport: StdioClientTransport;
  const transportErrors: string[] = [];
  const stderrChunks: string[] = [];
  /** Every tool reply, serialized, for the secret scan at the end. */
  const everyReply: string[] = [];

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
    const reply = (await client.callTool({ name, arguments: args })) as unknown as ToolReply;
    everyReply.push(JSON.stringify(reply));
    return reply;
  }

  function structured(reply: ToolReply): Record<string, any> {
    expect(reply.isError, textOf(reply)).not.toBe(true);
    expect(reply.structuredContent).toBeDefined();
    return reply.structuredContent as Record<string, any>;
  }

  function ledgerLines(): Array<Record<string, any>> {
    const file = path.join(projectRoot, '.recyclewheel', 'ledger.jsonl');
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, any>);
  }

  beforeAll(async () => {
    ensureBuilt();
    cacheDir = makeTmpDir('rw-smoke-cache-');
    projectRoot = makeTmpDir('rw-smoke-project-');
    seedCache(cacheDir);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp'],
      env: serverEnv(cacheDir, projectRoot),
      cwd: projectRoot,
      stderr: 'pipe',
    });
    transport.onerror = (err) => transportErrors.push(err.message);
    transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));
    client = new Client({ name: 'rw-smoke', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      cleanupTmpDirs();
    }
  });

  it('lists exactly the 8 tools, each with input and output schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
      expect(tool.description?.length ?? 0, `${tool.name} description`).toBeGreaterThan(20);
    }
  });

  it('serves the reuse_first_workflow prompt built from SKILL.md', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('reuse_first_workflow');

    const got = await client.getPrompt({ name: 'reuse_first_workflow', arguments: { task: 'a markdown to pdf CLI' } });
    const text = got.messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .join('\n');
    expect(text).toContain('Step 0.');
    expect(text).toContain('Step 9.');
    expect(text).toContain('Apply this workflow to: a markdown to pdf CLI');
    expect(text.startsWith('---')).toBe(false); // frontmatter is stripped
  });

  it('rw_status reports the temporary project and offline mode', async () => {
    const status = structured(await call('rw_status'));
    expect(status.offline).toBe(true);
    expect(status.github_auth).toBe('env');
    expect(status.ledger_exists).toBe(false);
    expect(path.resolve(status.project_root)).toBe(path.resolve(projectRoot));
    expect(path.resolve(status.ledger_path)).toBe(path.resolve(projectRoot, '.recyclewheel', 'ledger.jsonl'));
    expect(path.resolve(status.cache.path)).toBe(path.resolve(cacheDir, 'cache.db'));
    expect(status.cache.entries).toBe(7); // the seven seeded responses
    expect(status.cross_cutting.map((c: { concern: string }) => c.concern)).toEqual([
      'cost',
      'distribution_policy',
      'legal_privacy',
      'operations',
      'security',
    ]);
    expect(status.adapters.map((a: { source: string }) => a.source)).toContain('hf_models');
    expect(status.adapters.map((a: { source: string }) => a.source)).toContain('github_repo');
  });

  it('rw_decompose records the plan and skips the trivial component', async () => {
    const out = structured(
      await call('rw_decompose', {
        project: {
          name: 'md2pdf',
          summary: 'A command line tool that converts Markdown files to PDF documents.',
          license: 'MIT',
          distribution: 'application',
          ecosystems: ['npm'],
          markets: ['KR'],
        },
        components: [
          { id: 'md-pdf', name: 'Markdown to PDF', description: 'Render Markdown into PDF files', keywords: ['markdown', 'pdf', 'converter'], ecosystem: 'npm' },
          { id: 'pricing-rules', name: 'Pricing rules', description: 'Company specific pricing rule engine', keywords: ['pricing', 'rules', 'engine'], ecosystem: 'npm' },
          { id: 'slug', name: 'Slug helper', description: 'Lowercase and hyphenate a title', keywords: ['slug'], ecosystem: 'npm', trivial: true },
        ],
      }),
    );
    expect(out.components.map((c: { id: string }) => c.id)).toEqual(['md-pdf', 'pricing-rules', 'slug']);
    const plan = out.search_plan as Array<{ component_id: string; queries: Array<{ source: string }>; skip_reason?: string }>;
    const mdPlan = plan.find((p) => p.component_id === 'md-pdf');
    expect(mdPlan?.queries.map((q) => q.source)).toEqual(expect.arrayContaining(['github_repo', 'npm']));
    expect(plan.find((p) => p.component_id === 'slug')?.skip_reason).toBe('trivial');
    // cross-cutting concerns come back as a checklist next to the plan
    const checklist = out.concerns_checklist as Array<{ concern: string; relevance: string; questions: string[] }>;
    expect(checklist.map((c) => c.concern).sort()).toEqual(['cost', 'distribution_policy', 'legal_privacy', 'operations', 'security']);
    expect(checklist.every((c) => c.questions.length > 0)).toBe(true);
    // the target market adds its own questions and is reported back
    expect(out.markets).toEqual({ codes: ['KR'], source: 'input' });
    expect(checklist.find((c) => c.concern === 'legal_privacy')?.questions.some((q) => q.startsWith('[KR] '))).toBe(true);
    expect(path.resolve(out.ledger_path)).toBe(path.resolve(projectRoot, '.recyclewheel', 'ledger.jsonl'));
  });

  it('rw_search answers from the seeded cache without network', async () => {
    const out = structured(
      await call('rw_search', {
        component_id: 'md-pdf',
        query: SEARCH_QUERY,
        sources: ['github_repo', 'npm', 'mcp_registry'],
        limit_per_source: LIMIT,
      }),
    );
    expect(out.degraded).toBe(false);
    expect(out.evidence_id).toMatch(/^ev_/);
    const bySource = new Map<string, { status: string }>(out.per_source.map((m: { source: string; status: string }) => [m.source, m]));
    expect(bySource.get('github_repo')?.status).toBe('cached');
    expect(bySource.get('npm')?.status).toBe('cached');
    expect(bySource.get('mcp_registry')?.status).toMatch(/^(cached|ok|partial)$/);
    const refs = out.candidates.map((c: { ref: string }) => c.ref);
    expect(refs).toContain('npm:markdown-pdf');
    expect(refs).toContain('github:markdown-it/markdown-it');
    expect(out.budget.rounds_used).toBe(0);
  });

  it('rw_evaluate scores a candidate from cached metadata', async () => {
    const out = structured(
      await call('rw_evaluate', {
        component_id: 'md-pdf',
        candidates: [{ ref: 'npm:markdown-pdf', fit: 5, fit_reason: 'Converts Markdown to PDF exactly as required.' }],
      }),
    );
    expect(out.evidence_id).toMatch(/^ev_/);
    expect(out.evaluations).toHaveLength(1);
    const evaluation = out.evaluations[0];
    expect(evaluation.ref).toBe('npm:markdown-pdf');
    expect(evaluation.license.candidate_spdx).toBe('MIT');
    expect(evaluation.license.verdict).toBe('compatible');
    expect(evaluation.metrics.downloads_weekly).toBe(45000);
    expect(evaluation.metrics.stars).toBe(1100);
    expect(evaluation.total).toBeGreaterThan(0);
    expect(['adopt', 'extend', 'reference', 'build']).toContain(evaluation.hint);
  });

  it('rw_evaluate judges model weights from the cached model card', async () => {
    const out = structured(
      await call('rw_evaluate', {
        component_id: 'md-pdf',
        candidates: [{ ref: 'hf:livekit/turn-detector', fit: 3, fit_reason: 'Model weights used only to check the license path.' }],
      }),
    );
    const evaluation = out.evaluations[0];
    expect(evaluation.ref).toBe('hf:livekit/turn-detector');
    expect(evaluation.license.verdict).toBe('unknown');
    expect(evaluation.flags).toContain('custom_model_license');
    expect(evaluation.weights_license).toMatchObject({ ref: 'hf:livekit/turn-detector', verdict: 'unknown' });
    expect(evaluation.metrics.stars).toBe(169);
    expect(evaluation.hint).toBe('reference');

    const rejected = await call('rw_decide', {
      component_id: 'md-pdf',
      decision: 'adopt',
      ref: 'hf:livekit/turn-detector',
      rationale: 'Trying to adopt weights whose license is unknown must be rejected.',
    });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('model weights');
  });

  it('rw_evaluate gates a hosted service with unverified terms and rw_decide rejects adopt', async () => {
    const out = structured(
      await call('rw_evaluate', {
        component_id: 'md-pdf',
        candidates: [
          {
            ref: 'saas:acme/pdf-render',
            fit: 5,
            fit_reason: 'Hosted renderer that covers the whole requirement.',
            saas: {
              maturity: 'ga',
              vendor_domains: ['acme.test'],
              pricing: { checked: false },
              data_use: { policy: 'unknown' },
              lock_in: 'low',
              exit_path: 'Switch back to the local renderer.',
            },
          },
        ],
      }),
    );
    const evaluation = out.evaluations[0];
    expect(evaluation.profile).toBe('saas');
    expect(evaluation.flags).toContain('saas_terms_unverified');
    expect(evaluation.hint).toBe('reference');

    const rejected = await call('rw_decide', {
      component_id: 'md-pdf',
      decision: 'adopt',
      ref: 'saas:acme/pdf-render',
      rationale: 'Hosted renderer, but its pricing and data-use terms were never checked.',
    });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('saas_terms_unverified');
  });

  it('rw_evaluate tells the vendor page from a secondhand page and gates adopt on it', async () => {
    const recordPage = async (url: string) =>
      structured(
        await call('rw_record_evidence', {
          component_id: 'md-pdf',
          kind: 'web',
          summary: 'Read the pricing and data-use terms of the hosted renderer.',
          results: [{ url, ref: 'saas:acme/pdf-render' }],
        }),
      ).evidence_id as string;
    const terms = (evidenceId: string) => ({
      maturity: 'ga',
      vendor_domains: ['acme.test'],
      pricing: { checked: true, summary: 'Free tier', evidence_id: evidenceId },
      data_use: { policy: 'no_training', evidence_id: evidenceId },
      lock_in: 'low',
      exit_path: 'Switch back to the local renderer.',
    });
    const evaluate = async (evidenceId: string) =>
      structured(
        await call('rw_evaluate', {
          component_id: 'md-pdf',
          candidates: [
            { ref: 'saas:acme/pdf-render', fit: 5, fit_reason: 'Hosted renderer that covers the whole requirement.', saas: terms(evidenceId) },
          ],
        }),
      ).evaluations[0];

    const secondhand = await evaluate(await recordPage('https://reseller.example/acme-pricing'));
    expect(secondhand.saas.pricing.source).toBe('secondhand');
    expect(secondhand.saas.data_use.source).toBe('secondhand');
    expect(secondhand.flags).toContain('saas_terms_secondhand');
    expect(secondhand.hint).toBe('reference');
    const rejected = await call('rw_decide', {
      component_id: 'md-pdf',
      decision: 'adopt',
      ref: 'saas:acme/pdf-render',
      rationale: 'Hosted renderer whose terms were only read on a reseller page.',
    });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('saas_terms_secondhand');

    const firstParty = await evaluate(await recordPage('https://docs.acme.test/pricing'));
    expect(firstParty.saas.pricing.source).toBe('first_party');
    expect(firstParty.saas.data_use.source).toBe('first_party');
    expect(firstParty.flags).not.toContain('saas_terms_secondhand');
    expect(firstParty.flags).not.toContain('saas_evidence_missing');
    expect(firstParty.hint).toBe('adopt');
  });

  it('rw_evaluate takes a client and its hosted service in one call, with the vendor page as source_url', async () => {
    const out = structured(
      await call('rw_evaluate', {
        component_id: 'md-pdf',
        candidates: [
          { ref: 'npm:markdown-pdf', fit: 5, fit_reason: 'Client of the hosted renderer.', service_ref: 'saas:acme/render-api' },
          {
            ref: 'saas:acme/render-api',
            fit: 5,
            fit_reason: 'Hosted renderer behind the client.',
            saas: {
              vendor_domains: ['acme.test'],
              lock_in: 'low',
              exit_path: 'Switch back to the local renderer.',
              pricing: { source_url: 'https://acme.test/pricing', summary: 'Free tier' },
              data_use: { policy: 'no_training', source_url: 'https://acme.test/privacy' },
            },
          },
        ],
      }),
    );
    const byRef = Object.fromEntries(out.evaluations.map((e: { ref: string }) => [e.ref, e]));
    expect(byRef['saas:acme/render-api'].saas.pricing.source).toBe('first_party');
    expect(['adopt', 'extend']).toContain(byRef['saas:acme/render-api'].hint);
    expect(byRef['npm:markdown-pdf'].service_ref).toBe('saas:acme/render-api');
    expect(byRef['npm:markdown-pdf'].flags).not.toContain('service_terms_unverified');
    expect(out.recorded_evidence).toHaveLength(2);
  });

  it('rw_record_evidence stores project-wide concern evidence that rw_status counts', async () => {
    const recorded = structured(
      await call('rw_record_evidence', {
        concern: 'cost',
        kind: 'web',
        query: 'pdf rendering cost',
        summary: 'Local rendering is free; no paid API is called by this tool.',
        results: [],
      }),
    );
    expect(recorded.evidence_id).toMatch(/^ev_/);
    const status = structured(await call('rw_status'));
    expect(status.cross_cutting.find((c: { concern: string }) => c.concern === 'cost')).toEqual({
      concern: 'cost',
      checked: true,
      evidence_count: 1,
    });
    expect(ledgerLines().some((l) => l.type === 'evidence.add' && l.evidence?.concern === 'cost')).toBe(true);
  });

  it('tracks legal_privacy per target market and rejects a market without a concern', async () => {
    const bare = await call('rw_record_evidence', { component_id: 'md-pdf', kind: 'manual', summary: 'No concern given.', results: [], market: 'KR' });
    expect(bare.isError).toBe(true);
    expect(textOf(bare)).toContain('market');

    const before = structured(await call('rw_status'));
    const legal = (status: Record<string, any>) => status.cross_cutting.find((c: { concern: string }) => c.concern === 'legal_privacy');
    expect(legal(before).markets).toEqual([{ code: 'KR', checked: false, evidence_count: 0 }]);

    structured(
      await call('rw_record_evidence', {
        concern: 'legal_privacy',
        market: 'KR',
        kind: 'manual',
        summary: 'Checked the Korean personal information rules; no personal data is processed.',
        results: [],
      }),
    );
    const after = structured(await call('rw_status'));
    expect(legal(after).markets).toEqual([{ code: 'KR', checked: true, evidence_count: 1 }]);
    expect(ledgerLines().some((l) => l.type === 'evidence.add' && l.evidence?.concern === 'legal_privacy' && l.evidence?.market === 'KR')).toBe(true);
  });

  it('rejects a build decision that lacks the two-source search evidence', async () => {
    const reply = await call('rw_decide', {
      component_id: 'pricing-rules',
      decision: 'build',
      build_reason: 'core_differentiator',
      rationale: 'The pricing rule engine is the core value of this product.',
    });
    expect(reply.isError).toBe(true);
    const message = textOf(reply);
    expect(message).toContain('rejected');
    expect(message).toContain('>=2 distinct sources');
    expect(ledgerLines().some((l) => l.type === 'decision.add' && l.decision?.component_id === 'pricing-rules')).toBe(false);

    const missingReason = await call('rw_decide', {
      component_id: 'pricing-rules',
      decision: 'build',
      rationale: 'The pricing rule engine is the core value of this product.',
    });
    expect(missingReason.isError).toBe(true);
    expect(textOf(missingReason)).toContain('build_reason');
  });

  it('accepts build once two sources answered, and trivial without any search', async () => {
    const search = structured(
      await call('rw_search', {
        component_id: 'pricing-rules',
        query: SEARCH_QUERY,
        sources: ['github_repo', 'npm'],
        limit_per_source: LIMIT,
      }),
    );
    expect(search.degraded).toBe(false);

    const built = structured(
      await call('rw_decide', {
        component_id: 'pricing-rules',
        decision: 'build',
        build_reason: 'core_differentiator',
        rationale: 'The pricing rule engine is the core value of this product, so it is built in house.',
      }),
    );
    expect(built.decision_id).toMatch(/^dec_/);

    const trivial = structured(
      await call('rw_decide', {
        component_id: 'slug',
        decision: 'build',
        build_reason: 'trivial',
        rationale: 'A one line string helper does not justify a dependency.',
      }),
    );
    expect(trivial.decision_id).toMatch(/^dec_/);
  });

  it('degrades honestly for an uncached query while offline', async () => {
    const out = structured(
      await call('rw_search', { query: 'unseeded-query-for-offline-check', sources: ['npm', 'pypi'] }),
    );
    expect(out.degraded).toBe(true);
    expect(out.candidates).toEqual([]);
    expect(out.fallback_hint).toContain('rw_record_evidence');
    for (const meta of out.per_source as Array<{ status: string }>) {
      expect(['offline', 'skipped']).toContain(meta.status);
    }
  });

  it('rw_decide(adopt) is recorded and rw_ledger exports the report', async () => {
    const decided = structured(
      await call('rw_decide', {
        component_id: 'md-pdf',
        decision: 'adopt',
        ref: 'npm:markdown-pdf',
        version: '11.0.0',
        rationale: 'Maintained, MIT licensed and covers the whole Markdown to PDF requirement.',
      }),
    );
    expect(decided.decision_id).toMatch(/^dec_/);
    expect(path.resolve(decided.ledger_path)).toBe(path.resolve(projectRoot, '.recyclewheel', 'ledger.jsonl'));

    const report = structured(await call('rw_ledger', { action: 'export', format: 'markdown' }));
    expect(report.content).toContain('# Reuse Report');
    expect(report.content).toContain('npm:markdown-pdf');
    expect(report.content).toContain('## Cross-cutting checks');
    expect(report.content).toContain('cost: checked (1 evidence)');
    expect(report.warnings).toContain('cross-cutting concern not checked: security');
    expect(report.summary.components).toBe(3);
    expect(report.summary.decided).toBe(3);
    expect(report.summary.by_decision).toEqual({ adopt: 1, extend: 0, reference: 0, build: 2 });
    expect(report.summary.undecided).toEqual([]);

    const written = structured(await call('rw_ledger', { action: 'export', format: 'markdown', write_to: 'docs/REUSE.md' }));
    expect(path.resolve(written.path)).toBe(path.resolve(projectRoot, 'docs', 'REUSE.md'));
    expect(readFileSync(path.join(projectRoot, 'docs', 'REUSE.md'), 'utf8')).toContain('# Reuse Report');

    const escape = await call('rw_ledger', { action: 'export', format: 'markdown', write_to: '../escaped.md' });
    expect(escape.isError).toBe(true);
    expect(textOf(escape)).toContain('outside the project root');
    expect(existsSync(path.join(projectRoot, '..', 'escaped.md'))).toBe(false);
  });

  it('left a valid append-only ledger on disk', () => {
    const lines = ledgerLines();
    const types = new Set(lines.map((l) => l.type));
    for (const type of ['project.set', 'component.upsert', 'evidence.add', 'evaluation.add', 'decision.add']) {
      expect(types, type).toContain(type);
    }
    expect(lines.every((l) => l.v === 1 && typeof l.at === 'string')).toBe(true);

    const decisions = lines.filter((l) => l.type === 'decision.add').map((l) => l.decision);
    expect(decisions.map((d) => `${d.component_id}:${d.decision}`).sort()).toEqual([
      'md-pdf:adopt',
      'pricing-rules:build',
      'slug:build',
    ]);
    const adopt = decisions.find((d) => d.component_id === 'md-pdf');
    expect(adopt.ref).toBe('npm:markdown-pdf');
    expect(adopt.evidence_ids.length).toBeGreaterThanOrEqual(2); // search + evaluate evidence

    const searchEvidence = lines.filter((l) => l.type === 'evidence.add' && l.evidence.kind === 'search');
    expect(searchEvidence.length).toBeGreaterThanOrEqual(3);
  });

  it('kept stdout clean and leaked no secrets', async () => {
    // Any non-JSON line on stdout makes the SDK transport report a parse error.
    expect(transportErrors).toEqual([]);

    await client.close();
    const stderr = stderrChunks.join('');
    expect(stderr).not.toContain(FAKE_TOKEN);

    for (const reply of everyReply) expect(reply).not.toContain(FAKE_TOKEN);

    const files = [
      path.join(projectRoot, '.recyclewheel', 'ledger.jsonl'),
      path.join(projectRoot, 'docs', 'REUSE.md'),
      path.join(cacheDir, 'cache.db'),
    ];
    for (const file of files) {
      expect(readFileSync(file).includes(FAKE_TOKEN), file).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Raw protocol check: nothing but JSON-RPC frames on stdout
// ---------------------------------------------------------------------------

describe('recyclewheel stdout hygiene (raw child process)', () => {
  beforeAll(() => {
    ensureBuilt();
  }, 60_000);

  it('writes only JSON-RPC frames to stdout, diagnostics go to stderr, and exits 0 when stdin closes', async () => {
    const cacheDir = makeTmpDir('rw-smoke-raw-cache-');
    const projectRoot = makeTmpDir('rw-smoke-raw-project-');
    try {
      const child = spawn(process.execPath, [CLI, 'mcp'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...serverEnv(cacheDir, projectRoot),
          // An invalid value makes the server print a configuration warning (to stderr).
          RECYCLEWHEEL_CACHE_MAX_MB: 'not-a-number',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

      const send = (message: unknown): void => void child.stdin.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      send({ jsonrpc: '2.0', id: 3, method: 'prompts/list' });

      const deadline = Date.now() + 15_000;
      while (!(stdout.includes('"id":2') && stdout.includes('"id":3')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      child.stdin.end();
      const code = await Promise.race([
        exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000)),
      ]);
      if (code === 'timeout') child.kill();
      expect(code).toBe(0);

      const lines = stdout.split('\n').filter((l) => l.trim() !== '');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        const frame = JSON.parse(line) as { jsonrpc?: string };
        expect(frame.jsonrpc, line.slice(0, 120)).toBe('2.0');
      }
      const toolsFrame = lines.map((l) => JSON.parse(l) as { id?: number; result?: { tools?: Array<{ name: string }> } }).find((f) => f.id === 2);
      expect(toolsFrame?.result?.tools?.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);

      expect(stderr).toContain('RECYCLEWHEEL_CACHE_MAX_MB');
      expect(stderr).not.toContain(FAKE_TOKEN);
    } finally {
      cleanupTmpDirs();
    }
  }, 40_000);
});
