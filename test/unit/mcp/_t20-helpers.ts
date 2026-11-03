/** Fake AppContext + in-memory MCP client for the T20 tool tests (rw_status, rw_ledger, rw_cache). */
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openCacheStore } from '../../../src/cache/store.js';
import { loadConfig } from '../../../src/config.js';
import { openLedger } from '../../../src/core/ledger.js';
import type { StatusContext } from '../../../src/doctor.js';
import type { CacheStore, LedgerEvent, RemoteCache, SourceAdapter, ToolModule } from '../../../src/types.js';
import { FakeHttpClient } from '../../helpers/fake-http.js';
import { makeTmpDir } from '../../helpers/tmp.js';

export const NOW = new Date('2026-10-12T00:00:00.000Z');

export const offRemote: RemoteCache = {
  mode: 'off',
  get: async () => undefined,
  put: async () => undefined,
  healthy: async () => false,
};

export interface T20Ctx {
  ctx: StatusContext;
  root: string;
  store: CacheStore;
}

export function makeCtx(
  opts: {
    env?: Record<string, string>;
    remote?: RemoteCache;
    githubAuth?: 'env' | 'gh_cli' | 'none';
    adapters?: StatusContext['adapters'];
  } = {},
): T20Ctx {
  const root = makeTmpDir('rw-t20-');
  const config = loadConfig(
    { RECYCLEWHEEL_PROJECT_ROOT: root, RECYCLEWHEEL_CACHE_DIR: join(root, '.cache'), RECYCLEWHEEL_NO_GH_CLI: '1', ...opts.env },
    { cwd: root },
  );
  const store = openCacheStore(':memory:');
  const stub = (source: SourceAdapter['source']): SourceAdapter => ({
    source,
    search: async () => ({ candidates: [], meta: { source, status: 'ok', count: 0 } }),
  });
  const ctx: StatusContext = {
    config,
    http: new FakeHttpClient({}, () => NOW),
    store,
    remote: opts.remote ?? offRemote,
    adapters: opts.adapters ?? {
      github_repo: stub('github_repo'),
      github_code: stub('github_code'),
      npm: stub('npm'),
      pypi: stub('pypi'),
      mcp_registry: stub('mcp_registry'),
    },
    enrichers: [],
    ledger: (r) => openLedger(r ?? root),
    now: () => NOW,
    githubAuthSource: async () => opts.githubAuth ?? 'none',
  };
  return { ctx, root, store };
}

export interface Connected {
  client: Client;
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string; structured: Record<string, unknown> | undefined }>;
  close(): Promise<void>;
}

export async function connect(tool: ToolModule, ctx: StatusContext): Promise<Connected> {
  const server = new McpServer({ name: 't20', version: '0.0.0' });
  tool.register(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const content = Array.isArray(r.content) ? r.content : [];
      const text = content
        .map((c) => (typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
        .join('\n');
      return { isError: r.isError === true, text, structured: r.structuredContent as Record<string, unknown> | undefined };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Two components: `cmp_markdown` decided (adopt) with evidence, `cmp_cli` undecided. */
export function seedLedger(root: string): void {
  const at = NOW.toISOString();
  const ledger = openLedger(root);
  const events: LedgerEvent[] = [
    { v: 1, type: 'project.set', at, project: { name: 'demo', summary: 'demo project', license: 'MIT', distribution: 'application', ecosystems: ['npm'] } },
    { v: 1, type: 'component.upsert', at, component: { id: 'cmp_markdown', name: 'Markdown', description: 'render md', keywords: ['markdown'], status: 'pending' } },
    { v: 1, type: 'component.upsert', at, component: { id: 'cmp_cli', name: 'CLI', description: 'argument parsing', keywords: ['cli'], status: 'pending' } },
    { v: 1, type: 'evidence.add', at, evidence: { id: 'ev_1', component_id: 'cmp_markdown', kind: 'search', at, query: 'markdown', sources: ['npm'], result_refs: ['npm:marked'], summary: 'searched npm' } },
    {
      v: 1,
      type: 'decision.add',
      at,
      decision: {
        id: 'dec_1',
        component_id: 'cmp_markdown',
        decision: 'adopt',
        ref: 'npm:marked',
        version: '12.0.0',
        rationale: 'Mature markdown renderer that fits the need.',
        alternatives: [],
        attribution: { source_url: 'https://github.com/markedjs/marked', license: 'MIT', copyright: 'Marked contributors' },
        evidence_ids: ['ev_1'],
        decided_at: at,
        decided_by: 'agent',
      },
    },
  ];
  for (const e of events) ledger.append(e);
}
