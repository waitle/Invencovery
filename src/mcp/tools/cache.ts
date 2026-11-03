/**
 * `rw_cache` (docs/PLAN.md §7.8): inspect and purge the LOCAL cache. The remote
 * cache is never modified, and `lookup` reports metadata only, never the body.
 */
import { z } from 'zod';
import { cacheKey } from '../../cache/key.js';
import { collectRateLimits } from '../../doctor.js';
import { RateLimitStateSchema } from '../../types.js';
import type { CacheEntry, ToolModule } from '../../types.js';
import { errorMessage, errorResult, formatBytes, mdCell, okResult } from '../result.js';

export const CACHE_TOOL_NAME = 'rw_cache';

const DAY_MS = 24 * 60 * 60 * 1000;
const REMOTE_HEALTH_TIMEOUT_MS = 1500;

const InputShape = {
  action: z
    .enum(['stats', 'lookup', 'purge'])
    .describe("'stats' = size, per-source counts, rate limits; 'lookup' = metadata for one URL; 'purge' = delete local entries."),
  url: z.string().optional().describe("lookup only: the upstream URL whose cache entry to inspect (e.g. 'https://registry.npmjs.org/zod/latest')."),
  source: z.string().optional().describe("purge only: only entries of this source, e.g. 'github_repo', 'npm', 'pypi', 'depsdev'."),
  older_than_days: z.number().int().min(0).optional().describe('purge only: only entries fetched more than this many days ago (whole days, 0 or more).'),
  confirm: z
    .boolean()
    .optional()
    .describe('purge only: must be true to delete. Without it, purge only reports how many entries would be deleted.'),
};

const OutputShape = {
  action: z.enum(['stats', 'lookup', 'purge']),
  entries: z.number().optional(),
  bytes: z.number().optional(),
  by_source: z.record(z.string(), z.number()).optional(),
  rate_limits: z.array(RateLimitStateSchema).optional(),
  remote: z
    .object({
      mode: z.enum(['off', 'read', 'readwrite']),
      host: z.string().optional(),
      healthy: z.boolean().optional(),
    })
    .optional(),
  key: z.string().optional(),
  hit: z.boolean().optional(),
  provenance: z.enum(['live', 'local_cache', 'remote_cache', 'stale_cache']).optional(),
  fetched_at: z.string().optional(),
  expires_at: z.string().optional(),
  status: z.number().optional(),
  fresh: z.boolean().optional(),
  removed: z.number().optional(),
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const cacheTool: ToolModule = {
  name: CACHE_TOOL_NAME,
  register(server, ctx) {
    server.registerTool(
      CACHE_TOOL_NAME,
      {
        title: 'recyclewheel cache',
        description:
          "Inspect or purge the local HTTP cache. stats: entry count, bytes, per-source counts, known rate limits, remote cache state. lookup: whether a URL is cached and how fresh (metadata only, no body). purge: delete local entries, optionally by source or age; requires confirm: true (without it nothing is deleted and the affected count is previewed). The remote cache is never touched.",
        inputSchema: InputShape,
        outputSchema: OutputShape,
        // purge deletes (re-fetchable) cache entries, so the tool is marked destructive.
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          switch (args.action) {
            case 'stats': {
              const s = ctx.store.stats();
              const remote: { mode: 'off' | 'read' | 'readwrite'; host?: string; healthy?: boolean } = {
                mode: ctx.remote.mode,
              };
              if (ctx.remote.mode !== 'off') {
                if (ctx.config.remoteCacheUrl !== undefined) {
                  try {
                    remote.host = new URL(ctx.config.remoteCacheUrl).host;
                  } catch {
                    // Invalid URLs are already reported by the config warnings.
                  }
                }
                remote.healthy = await withTimeout(
                  ctx.remote.healthy().catch(() => false),
                  REMOTE_HEALTH_TIMEOUT_MS,
                  false,
                );
              }
              const rate_limits = collectRateLimits(ctx.store);
              const lines = [
                `**Local cache** \`${ctx.config.cacheDbPath}\``,
                `- entries: ${s.entries} (${formatBytes(s.bytes)})`,
                `- remote cache: ${remote.mode}${remote.host ? ` at ${remote.host}` : ''}${
                  remote.healthy === undefined ? '' : remote.healthy ? ', healthy' : ', not reachable'
                }`,
              ];
              const sources = Object.entries(s.by_source).sort(([a], [b]) => a.localeCompare(b));
              if (sources.length > 0) {
                lines.push('', '| source | entries |', '|---|---|');
                for (const [name, count] of sources) lines.push(`| ${mdCell(name)} | ${count} |`);
              }
              if (rate_limits.length > 0) {
                lines.push('', '| rate limit | remaining | resets at |', '|---|---|---|');
                for (const r of rate_limits) {
                  lines.push(`| ${mdCell(r.resource)} | ${r.remaining}/${r.limit} | ${iso(r.reset_at)} |`);
                }
              }
              return okResult(lines.join('\n'), {
                action: 'stats',
                entries: s.entries,
                bytes: s.bytes,
                by_source: s.by_source,
                rate_limits,
                remote,
              });
            }

            case 'lookup': {
              if (args.url === undefined || args.url.trim() === '') {
                return errorResult("rw_cache lookup needs 'url': the upstream URL to look up, e.g. https://registry.npmjs.org/zod/latest.");
              }
              let key: string;
              try {
                key = cacheKey(args.url.trim());
              } catch {
                return errorResult("rw_cache lookup: 'url' is not a valid absolute URL (expected e.g. https://api.github.com/repos/owner/repo).");
              }
              const entry: CacheEntry | undefined = ctx.store.get(key);
              if (entry === undefined) {
                return okResult(`No local cache entry for \`${key.slice(0, 12)}…\`.`, { action: 'lookup', key, hit: false });
              }
              const fresh = entry.expires_at > ctx.now().getTime();
              const structured: Record<string, unknown> = {
                action: 'lookup',
                key,
                hit: true,
                provenance: entry.provenance,
                fetched_at: iso(entry.fetched_at),
                expires_at: iso(entry.expires_at),
                status: entry.status,
                fresh,
              };
              return okResult(
                `Cached (${fresh ? 'fresh' : 'stale'}): status ${entry.status}, fetched ${iso(entry.fetched_at)}, expires ${iso(entry.expires_at)}, provenance ${entry.provenance}.`,
                structured,
              );
            }

            case 'purge': {
              const filter: { source?: string; olderThanMs?: number } = {};
              if (args.source !== undefined && args.source.trim() !== '') filter.source = args.source.trim();
              if (args.older_than_days !== undefined) filter.olderThanMs = args.older_than_days * DAY_MS;
              const scope =
                filter.source === undefined && filter.olderThanMs === undefined
                  ? 'all local entries'
                  : [
                      filter.source !== undefined ? `source ${filter.source}` : undefined,
                      args.older_than_days !== undefined ? `older than ${args.older_than_days} day(s)` : undefined,
                    ]
                      .filter(Boolean)
                      .join(', ');
              if (args.confirm !== true) {
                const s = ctx.store.stats();
                const candidates = filter.source !== undefined ? (s.by_source[filter.source] ?? 0) : s.entries;
                const bound = filter.olderThanMs !== undefined ? 'up to ' : '';
                return errorResult(
                  `rw_cache purge was not run: it deletes local cache entries (${scope}) and needs confirm: true. Preview: ${bound}${candidates} of ${s.entries} entr${s.entries === 1 ? 'y' : 'ies'} (${formatBytes(s.bytes)} cached in total) would be deleted. Cached data is re-fetched on demand, but costs API rate limit. Call again with confirm: true to proceed.`,
                );
              }
              const removed = ctx.store.purge(filter);
              return okResult(`Purged ${removed} local cache entr${removed === 1 ? 'y' : 'ies'} (${scope}).`, {
                action: 'purge',
                removed,
              });
            }
          }
        } catch (err) {
          return errorResult(`rw_cache failed: ${errorMessage(err)}`);
        }
      },
    );
  },
};
