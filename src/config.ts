/**
 * Environment parsing (docs/PLAN.md §10.4). Pure: reads only the `env` it is
 * given. Invalid values never throw; they fall back to the default and add a
 * human-readable entry to `Config.warnings`.
 */
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import { SourceSchema } from './types.js';
import type { Config, Source } from './types.js';

export type { Config } from './types.js';

export interface LoadConfigOptions {
  /** Defaults to `process.platform`. Selects the default cache directory. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. */
  homedir?: string;
  /** Defaults to `process.cwd()`. */
  cwd?: string;
}

const DEFAULTS = {
  cacheMaxMb: 200,
  budget: { rounds: 3, evals: 5, web: 2 },
  logLevel: 'warn',
} as const;

const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
const REMOTE_MODES = ['off', 'read', 'readwrite'] as const;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/** Empty or whitespace-only values count as unset (plugin env expansion yields ""). */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseBool(raw: string | undefined, name: string, warnings: string[]): boolean {
  if (raw === undefined) return false;
  const v = raw.toLowerCase();
  if (TRUE_VALUES.has(v)) return true;
  if (!FALSE_VALUES.has(v)) {
    // The value is never echoed: a wrong variable may hold a secret.
    warnings.push(`${name} has an unrecognized value (use 1 or 0); treating as unset.`);
  }
  return false;
}

function parsePositiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  warnings: string[],
): number {
  if (raw === undefined) return fallback;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  warnings.push(`${name} has an unrecognized value (must be a positive integer); using ${fallback}.`);
  return fallback;
}

function parseEnum<T extends string>(
  raw: string | undefined,
  name: string,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
): T {
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  const hit = allowed.find((a) => a === v);
  if (hit !== undefined) return hit;
  warnings.push(`${name} has an unrecognized value (expected ${allowed.join('|')}); using ${fallback}.`);
  return fallback;
}

function parseSources(raw: string | undefined, warnings: string[]): Source[] {
  const all = [...SourceSchema.options];
  if (raw === undefined) return all;
  const picked: Source[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    const parsed = SourceSchema.safeParse(name);
    if (!parsed.success) {
      warnings.push(`RECYCLEWHEEL_SOURCES: an unrecognized source name was ignored (valid: ${all.join(', ')}).`);
    } else if (!picked.includes(parsed.data)) {
      picked.push(parsed.data);
    }
  }
  if (picked.length === 0) {
    warnings.push('RECYCLEWHEEL_SOURCES has no valid source; all sources stay enabled.');
    return all;
  }
  return picked;
}

function parseHttpUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return raw.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/** Hostnames for which plain http is not a network risk. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

/** https always passes; http only for loopback hosts unless `allowInsecure`. */
export function isSecureRemoteUrl(raw: string, allowInsecure: boolean): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    if (u.protocol !== 'http:') return false;
    return allowInsecure || isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

const SECRET_ENV_NAMES = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'LIBRARIES_IO_API_KEY',
  'RECYCLEWHEEL_REMOTE_CACHE_TOKEN',
] as const;
const SECRET_ENV_PATTERN = /^RECYCLEWHEEL_SERVER_.*_TOKEN$/;
const MIN_SECRET_LENGTH = 8;

/**
 * Values of the secret-bearing environment variables (length >= 8), for
 * value-based masking in logs. Duplicates are removed.
 */
export function collectSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>();
  for (const name of Object.keys(env)) {
    if (!(SECRET_ENV_NAMES as readonly string[]).includes(name) && !SECRET_ENV_PATTERN.test(name)) continue;
    const value = env[name]?.trim();
    if (value && value.length >= MIN_SECRET_LENGTH) found.add(value);
  }
  return [...found];
}

/** Replaces every occurrence of each secret with `***`, longest secret first. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  const ordered = [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of ordered) out = out.split(secret).join('***');
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: LoadConfigOptions = {}): Config {
  const warnings: string[] = [];
  const platform = opts.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const cwd = opts.cwd ?? process.cwd();

  // Cache location: RECYCLEWHEEL_CACHE_DIR, else OS default (PLAN §5).
  let cacheDir = read(env, 'RECYCLEWHEEL_CACHE_DIR');
  if (cacheDir !== undefined) {
    cacheDir = p.resolve(cwd, cacheDir);
  } else if (platform === 'win32') {
    const home = opts.homedir ?? osHomedir();
    const base = read(env, 'LOCALAPPDATA') ?? p.join(home, 'AppData', 'Local');
    cacheDir = p.join(base, 'recyclewheel');
  } else {
    const home = opts.homedir ?? osHomedir();
    const base = read(env, 'XDG_CACHE_HOME') ?? p.join(home, '.cache');
    cacheDir = p.join(base, 'recyclewheel');
  }

  const projectRootRaw = read(env, 'RECYCLEWHEEL_PROJECT_ROOT');
  const projectRoot = projectRootRaw !== undefined ? p.resolve(cwd, projectRootRaw) : cwd;

  // Remote cache: off unless a valid URL and an explicit mode are both given.
  let remoteCacheUrl: string | undefined;
  const urlRaw = read(env, 'RECYCLEWHEEL_REMOTE_CACHE_URL');
  const allowInsecureRemote = parseBool(
    read(env, 'RECYCLEWHEEL_ALLOW_INSECURE_REMOTE'),
    'RECYCLEWHEEL_ALLOW_INSECURE_REMOTE',
    warnings,
  );
  let insecureRefused = false;
  if (urlRaw !== undefined) {
    remoteCacheUrl = parseHttpUrl(urlRaw);
    if (remoteCacheUrl === undefined) {
      warnings.push('RECYCLEWHEEL_REMOTE_CACHE_URL is not a valid http(s) URL; remote cache disabled.');
    } else if (!isSecureRemoteUrl(remoteCacheUrl, allowInsecureRemote)) {
      warnings.push(
        'RECYCLEWHEEL_REMOTE_CACHE_URL uses plain http on a non-loopback host, which would send the Bearer token unencrypted; ' +
          'remote cache disabled (use https, or set RECYCLEWHEEL_ALLOW_INSECURE_REMOTE=1 to accept the risk).',
      );
      remoteCacheUrl = undefined;
      insecureRefused = true;
    }
  }
  let remoteCacheMode = parseEnum(
    read(env, 'RECYCLEWHEEL_REMOTE_CACHE_MODE'),
    'RECYCLEWHEEL_REMOTE_CACHE_MODE',
    REMOTE_MODES,
    'off',
    warnings,
  );
  if (remoteCacheMode !== 'off' && remoteCacheUrl === undefined) {
    if (urlRaw === undefined && !insecureRefused) {
      warnings.push(`RECYCLEWHEEL_REMOTE_CACHE_MODE=${remoteCacheMode} needs RECYCLEWHEEL_REMOTE_CACHE_URL; remote cache disabled.`);
    }
    remoteCacheMode = 'off';
  }

  const config: Config = {
    noGhCli: parseBool(read(env, 'RECYCLEWHEEL_NO_GH_CLI'), 'RECYCLEWHEEL_NO_GH_CLI', warnings),
    cacheDir,
    cacheDbPath: p.join(cacheDir, 'cache.db'),
    cacheMaxMb: parsePositiveInt(
      read(env, 'RECYCLEWHEEL_CACHE_MAX_MB'),
      'RECYCLEWHEEL_CACHE_MAX_MB',
      DEFAULTS.cacheMaxMb,
      warnings,
    ),
    offline: parseBool(read(env, 'RECYCLEWHEEL_OFFLINE'), 'RECYCLEWHEEL_OFFLINE', warnings),
    projectRoot,
    sources: parseSources(read(env, 'RECYCLEWHEEL_SOURCES'), warnings),
    remoteCacheMode,
    allowInsecureRemote,
    budget: {
      rounds: parsePositiveInt(read(env, 'RECYCLEWHEEL_BUDGET_ROUNDS'), 'RECYCLEWHEEL_BUDGET_ROUNDS', DEFAULTS.budget.rounds, warnings),
      evals: parsePositiveInt(read(env, 'RECYCLEWHEEL_BUDGET_EVALS'), 'RECYCLEWHEEL_BUDGET_EVALS', DEFAULTS.budget.evals, warnings),
      web: parsePositiveInt(read(env, 'RECYCLEWHEEL_BUDGET_WEB'), 'RECYCLEWHEEL_BUDGET_WEB', DEFAULTS.budget.web, warnings),
    },
    logLevel: parseEnum(read(env, 'RECYCLEWHEEL_LOG_LEVEL'), 'RECYCLEWHEEL_LOG_LEVEL', LOG_LEVELS, DEFAULTS.logLevel, warnings),
    warnings,
  };

  if (remoteCacheUrl !== undefined) config.remoteCacheUrl = remoteCacheUrl;
  const remoteCacheToken = read(env, 'RECYCLEWHEEL_REMOTE_CACHE_TOKEN');
  if (remoteCacheToken !== undefined) config.remoteCacheToken = remoteCacheToken;
  const librariesIoApiKey = read(env, 'LIBRARIES_IO_API_KEY');
  if (librariesIoApiKey !== undefined) config.librariesIoApiKey = librariesIoApiKey;
  const serverWriteToken = read(env, 'RECYCLEWHEEL_SERVER_WRITE_TOKEN');
  if (serverWriteToken !== undefined) config.serverWriteToken = serverWriteToken;
  const serverReadToken = read(env, 'RECYCLEWHEEL_SERVER_READ_TOKEN');
  if (serverReadToken !== undefined) config.serverReadToken = serverReadToken;

  return config;
}
