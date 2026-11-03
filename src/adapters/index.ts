/**
 * Adapter and enricher wiring (docs/PLAN.md §8, §12 T20).
 *
 * Builds the `AppContext.adapters` map and the `AppContext.enrichers` chain from
 * one `HttpClient`. `config.sources` decides which search sources exist;
 * libraries.io is not a source of its own, it only extends the pypi adapter and
 * only when `LIBRARIES_IO_API_KEY` is set.
 */
import type {
  CacheStore,
  Config,
  Enricher,
  HttpClient,
  Source,
  SourceAdapter,
} from '../types.js';
import { createDepsDevEnricher } from './depsdev.js';
import { createGithubCodeAdapter, createGithubEnricher, createGithubRepoAdapter } from './github.js';
import { createHuggingfaceAdapter, createHuggingfaceEnricher } from './huggingface.js';
import { createLibrariesIoAdapter } from './librariesio.js';
import { createMcpRegistryAdapter, createMcpRegistryEnricher } from './mcp-registry.js';
import { createNpmAdapter, createNpmEnricher } from './npm.js';
import { createPypiAdapter, createPypiEnricher } from './pypi.js';

export interface AdapterDeps {
  http: HttpClient;
  config: Pick<Config, 'sources' | 'librariesIoApiKey'>;
  /** Whether authenticated GitHub calls will carry a token (never the token itself). */
  hasToken: () => boolean | Promise<boolean>;
  store: Pick<CacheStore, 'getRateLimit'>;
  now?: () => Date;
}

export function createAdapters(deps: AdapterDeps): Partial<Record<Source, SourceAdapter>> {
  const { http, config } = deps;
  const github = {
    http,
    hasToken: deps.hasToken,
    ...(deps.now ? { now: deps.now } : {}),
    getRateLimit: (resource: string) => deps.store.getRateLimit(resource),
  };

  const factories: Record<Source, () => SourceAdapter> = {
    github_repo: () => createGithubRepoAdapter(github),
    github_code: () => createGithubCodeAdapter(github),
    npm: () => createNpmAdapter({ http }),
    pypi: () => {
      const librariesIo =
        config.librariesIoApiKey !== undefined
          ? createLibrariesIoAdapter({ http, apiKey: config.librariesIoApiKey })
          : undefined;
      return createPypiAdapter({ http, ...(librariesIo ? { librariesIo } : {}) });
    },
    mcp_registry: () => createMcpRegistryAdapter({ http }),
    hf_models: () => createHuggingfaceAdapter({ http }),
  };

  const adapters: Partial<Record<Source, SourceAdapter>> = {};
  for (const source of config.sources) adapters[source] = factories[source]();
  return adapters;
}

/**
 * Enrichment chain order (PLAN §7.4): deps.dev first so a `github:` ref is
 * answered without spending GitHub rate limit, then github, npm, pypi and the
 * MCP registry and Hugging Face.
 */
export function createEnrichers(http: HttpClient): Enricher[] {
  return [
    createDepsDevEnricher({ http }),
    createGithubEnricher({ http }),
    createNpmEnricher({ http }),
    createPypiEnricher({ http }),
    createMcpRegistryEnricher({ http }),
    createHuggingfaceEnricher({ http }),
  ];
}
