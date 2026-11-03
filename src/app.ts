/**
 * Composition root (docs/PLAN.md §5, §12 T20):
 * config -> cache store -> remote cache -> http client -> adapters -> AppContext.
 *
 * `createApp` is synchronous and cheap: the GitHub token is resolved lazily
 * (and at most once) the first time an authenticated request needs it. Nothing
 * here writes to stdout.
 */
import { createGithubTokenProvider, redactGithubToken } from './auth/github-token.js';
import type { GithubTokenSource, RunGh } from './auth/github-token.js';
import { createAdapters, createEnrichers } from './adapters/index.js';
import { createRemoteCache } from './cache/remote.js';
import { sanitize } from './cache/sanitize.js';
import { openCacheStore } from './cache/store.js';
import { loadConfig } from './config.js';
import { openLedger } from './core/ledger.js';
import { VERSION, installSqliteWarningFilter, resolveProjectRoot } from './doctor.js';
import { createHttpClient } from './http/client.js';
import type { AppContext, CacheStore, Config, RemoteCache } from './types.js';

/** `recyclewheel/<version> (+https://github.com/<owner>/recyclewheel)`; the owner is a placeholder (PLAN §17). */
export const USER_AGENT = `recyclewheel/${VERSION} (+https://github.com/recyclewheel/recyclewheel)`;

const REMOTE_TIMEOUT_MS = 1500;

/** `AppContext` plus the process-level pieces the entry points need. */
export interface App extends AppContext {
  /** Where the GitHub token came from (never the token itself). Resolves lazily, at most once. */
  githubAuthSource(): Promise<GithubTokenSource>;
  /** Closes the cache store. Safe to call more than once. */
  close(): void;
}

export interface CreateAppOptions {
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injected `fetch` for the HTTP client and the remote cache (tests). */
  fetch?: typeof globalThis.fetch;
  /** Injected `gh` runner (tests never spawn gh). */
  runGh?: RunGh;
  now?: () => Date;
  /** Use this store instead of opening `config.cacheDbPath` (tests). */
  store?: CacheStore;
  /** Use this remote cache instead of building one from the config (tests). */
  remote?: RemoteCache;
}

const OFF_REMOTE: RemoteCache = {
  mode: 'off',
  get: async () => undefined,
  put: async () => undefined,
  healthy: async () => false,
};

function openStore(config: Config): CacheStore {
  try {
    return openCacheStore(config.cacheDbPath, {
      maxBytes: config.cacheMaxMb * 1024 * 1024,
      // Offline mode must keep every entry it has; otherwise the 7-day stale window applies.
      ...(config.offline ? { staleRetentionMs: Number.POSITIVE_INFINITY } : {}),
    });
  } catch (err) {
    // The cache is best effort: an unwritable location must not stop the server.
    const reason = redactGithubToken(err instanceof Error ? err.message : String(err));
    config.warnings.push(
      `Could not open the cache database at ${config.cacheDbPath} (${reason}); using an in-memory cache.`,
    );
    return openCacheStore(':memory:', { maxBytes: config.cacheMaxMb * 1024 * 1024 });
  }
}

export function createApp(env: NodeJS.ProcessEnv = process.env, opts: CreateAppOptions = {}): App {
  const config = loadConfig(env, opts.cwd !== undefined ? { cwd: opts.cwd } : {});
  const now = opts.now ?? (() => new Date());

  installSqliteWarningFilter();
  const store = opts.store ?? openStore(config);

  const remote =
    opts.remote ??
    (config.remoteCacheMode !== 'off' && config.remoteCacheUrl !== undefined
      ? createRemoteCache({
          url: config.remoteCacheUrl,
          mode: config.remoteCacheMode,
          ...(config.remoteCacheToken !== undefined ? { token: config.remoteCacheToken } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          timeoutMs: REMOTE_TIMEOUT_MS,
          allowInsecure: config.allowInsecureRemote,
        })
      : OFF_REMOTE);

  const tokens = createGithubTokenProvider({
    env,
    noGhCli: config.noGhCli,
    ...(opts.runGh ? { runGh: opts.runGh } : {}),
  });

  const http = createHttpClient({
    store,
    remote,
    config,
    token: tokens.getToken,
    now,
    userAgent: USER_AGENT,
    sanitize,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  let closed = false;
  return {
    config,
    http,
    store,
    remote,
    adapters: createAdapters({ http, config, hasToken: tokens.hasToken, store, now }),
    enrichers: createEnrichers(http),
    ledger: (projectRoot?: string) => openLedger(resolveProjectRoot(config, projectRoot)),
    now,
    githubAuthSource: async () => (await tokens.resolve()).source,
    close(): void {
      if (closed) return;
      closed = true;
      try {
        store.close();
      } catch {
        // Shutting down; nothing useful to do with a close error.
      }
    },
  };
}
