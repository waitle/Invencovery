/**
 * Shared harness for the work-tool tests (rw_decompose, rw_search, rw_evaluate,
 * rw_record_evidence, rw_decide). Builds a fake AppContext (fake adapters and
 * enrichers, a real ledger in a temp directory), registers the tools on a real
 * McpServer and talks to it through an in-memory MCP client, so every test
 * exercises input validation and output validation exactly as a client would.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from '../../../src/config.js';
import { openLedger } from '../../../src/core/ledger.js';
import { decideTool } from '../../../src/mcp/tools/decide.js';
import { decomposeTool } from '../../../src/mcp/tools/decompose.js';
import { evaluateTool } from '../../../src/mcp/tools/evaluate.js';
import { evidenceTool } from '../../../src/mcp/tools/evidence.js';
import { searchTool } from '../../../src/mcp/tools/search.js';
import type {
  AppContext,
  CacheStore,
  Candidate,
  Enricher,
  LedgerState,
  RemoteCache,
  Source,
  SourceAdapter,
  SourceMeta,
  ToolModule,
} from '../../../src/types.js';
import { FakeHttpClient } from '../../helpers/fake-http.js';
import { makeTmpDir } from '../../helpers/tmp.js';

export const FIXED_NOW = new Date('2026-10-12T00:00:00.000Z');

export const ALL_TOOLS: ToolModule[] = [decomposeTool, searchTool, evaluateTool, evidenceTool, decideTool];

export interface CallOutcome {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | undefined;
}

export interface Harness {
  ctx: AppContext;
  root: string;
  client: Client;
  /** Calls a tool through the MCP client. Never throws for tool-level errors. */
  call(name: string, args: Record<string, unknown>): Promise<CallOutcome>;
  /** Current ledger state of `root` (or another project directory). */
  state(projectRoot?: string): LedgerState;
  /** Raw ledger file text ('' when the ledger does not exist). */
  ledgerText(projectRoot?: string): string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  adapters?: Partial<Record<Source, SourceAdapter>>;
  enrichers?: Enricher[];
  /** Extra environment for `loadConfig` (RECYCLEWHEEL_SOURCES, RECYCLEWHEEL_BUDGET_ROUNDS, ...). */
  env?: Record<string, string>;
  now?: () => Date;
  tools?: ToolModule[];
}

const noopStore: CacheStore = {
  get: () => undefined,
  put: () => undefined,
  touch: () => undefined,
  purge: () => 0,
  stats: () => ({ entries: 0, bytes: 0, by_source: {} }),
  getRateLimit: () => undefined,
  setRateLimit: () => undefined,
  close: () => undefined,
};

const offRemote: RemoteCache = {
  mode: 'off',
  get: async () => undefined,
  put: async () => undefined,
  healthy: async () => false,
};

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = makeTmpDir('rw-tools-');
  const config = loadConfig(
    {
      RECYCLEWHEEL_PROJECT_ROOT: root,
      RECYCLEWHEEL_CACHE_DIR: join(root, '.cache'),
      RECYCLEWHEEL_NO_GH_CLI: '1',
      ...opts.env,
    },
    { cwd: root },
  );
  const now = opts.now ?? (() => FIXED_NOW);
  const ctx: AppContext = {
    config,
    http: new FakeHttpClient({}, now),
    store: noopStore,
    remote: offRemote,
    adapters: opts.adapters ?? {},
    enrichers: opts.enrichers ?? [],
    ledger: (projectRoot) => openLedger(projectRoot ?? root),
    now,
  };

  const server = new McpServer({ name: 'recyclewheel-test', version: '0.0.0' });
  for (const tool of opts.tools ?? ALL_TOOLS) tool.register(server, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    ctx,
    root,
    client,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : ''))
        .join('\n');
      return {
        isError: result.isError === true,
        text,
        structured: result.structuredContent as Record<string, unknown> | undefined,
      };
    },
    state: (projectRoot) => openLedger(projectRoot ?? root).read(),
    ledgerText(projectRoot) {
      try {
        return readFileSync(openLedger(projectRoot ?? root).path, 'utf8');
      } catch {
        return '';
      }
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

export function candidate(ref: string, source: Source, extra: Partial<Candidate> = {}): Candidate {
  const id = ref.slice(ref.indexOf(':') + 1);
  return {
    ref,
    source,
    name: id,
    url: `https://example.test/${id}`,
    description: `${id} description`,
    matched_via: { query: 'q', rank: 1 },
    provenance: 'live',
    ...extra,
  };
}

export type SearchQuery = Parameters<SourceAdapter['search']>[0];

/** Adapter returning canned candidates. `calls` records every query it received. */
export function fakeAdapter(
  source: Source,
  respond: (q: SearchQuery) => { candidates: Candidate[]; meta?: Partial<SourceMeta> } | Promise<{ candidates: Candidate[]; meta?: Partial<SourceMeta> }>,
): SourceAdapter & { calls: SearchQuery[] } {
  const calls: SearchQuery[] = [];
  return {
    source,
    calls,
    async search(q) {
      calls.push(q);
      const r = await respond(q);
      return {
        candidates: r.candidates,
        meta: { source, status: 'ok', count: r.candidates.length, query: q.query, ...r.meta },
      };
    },
  };
}

export function failingAdapter(
  source: Source,
  status: SourceMeta['status'],
  message = `${source} unavailable`,
): SourceAdapter & { calls: SearchQuery[] } {
  return fakeAdapter(source, () => ({ candidates: [], meta: { status, message } }));
}

type EnrichOutput = Awaited<ReturnType<Enricher['enrich']>>;

/** Enricher built from a scheme list; `enrich` receives the ref and the deep flag. */
export function fakeEnricher(
  schemes: readonly string[],
  enrich: (ref: string, opts: { deep: boolean }) => Partial<EnrichOutput> | Promise<Partial<EnrichOutput>>,
): Enricher & { calls: { ref: string; deep: boolean }[] } {
  const calls: { ref: string; deep: boolean }[] = [];
  return {
    calls,
    supports: (ref) => schemes.includes(ref.slice(0, ref.indexOf(':'))),
    async enrich(ref, opts) {
      calls.push({ ref, deep: opts.deep });
      const r = await enrich(ref, opts);
      return {
        metrics: {},
        license_spdx: null,
        license_source: 'github',
        provenance: 'live',
        missing: [],
        ...r,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Common inputs
// ---------------------------------------------------------------------------

export const PROJECT = {
  name: 'demo',
  summary: 'A demo project used by the tool tests.',
  license: 'MIT',
  distribution: 'application',
  ecosystems: ['npm'],
} as const;

export function component(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, description: `${name} component`, keywords: [name.toLowerCase(), 'library'], ...extra };
}

/** Decomposes `components` and returns their ids (slug of the name). */
export async function seedComponents(
  h: Harness,
  components: Record<string, unknown>[] = [component('Markdown')],
  project: Record<string, unknown> = { ...PROJECT },
): Promise<void> {
  const r = await h.call('rw_decompose', { project, components });
  if (r.isError) throw new Error(`seed failed: ${r.text}`);
}
