/**
 * recyclewheel command line entry (docs/PLAN.md §12 T20, §13).
 *
 *   recyclewheel [serve|mcp]                         MCP server over stdio (default)
 *   recyclewheel doctor [--no-network] [--json]      environment check
 *   recyclewheel cache-server [--host --port --db --trusted-hops]   shared cache server
 *   recyclewheel ledger export [--format --out --root --component]
 *   recyclewheel --version | --help
 *
 * In `serve` mode stdout carries only JSON-RPC frames, so nothing else may be
 * written there: diagnostics go to stderr and `console.log` is redirected.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as formatText, parseArgs } from 'node:util';
import { redactGithubToken } from './auth/github-token.js';
import type { RunGh } from './auth/github-token.js';
import { collectSecrets, loadConfig, maskSecrets } from './config.js';
import { VERSION, formatDoctor, installSqliteWarningFilter, runDoctor } from './doctor.js';
import type { Config } from './types.js';

const USAGE = `recyclewheel ${VERSION} - reuse-first gate for coding agents

Usage:
  recyclewheel [serve|mcp]            Run the MCP server on stdio (default)
  recyclewheel doctor [options]       Check the environment (exit 1 only on a hard failure)
      --no-network                    Skip the network probes
      --json                          Machine-readable output
  recyclewheel cache-server [options] Run the shared cache server
      --host <host>                   Bind address (default 127.0.0.1)
      --port <port>                   Port (default 8787)
      --db <path>                     SQLite file (default <cache dir>/cache-server.db)
      --trusted-hops <n>              Reverse proxies that append to X-Forwarded-For (default 1);
                                      the client IP is read n entries from the right
      env: RECYCLEWHEEL_SERVER_WRITE_TOKEN, RECYCLEWHEEL_SERVER_READ_TOKEN
  recyclewheel ledger export [options]
      --format <markdown|json|notices>  Output format (default markdown)
      --out <file>                    Write inside the project root (default: stdout)
      --root <dir>                    Project root (default RECYCLEWHEEL_PROJECT_ROOT or cwd)
      --component <id>                Only this component
  recyclewheel --version | --help
`;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Replaces the `gh` runner in `doctor` (tests). */
  runGh?: RunGh;
}

const defaultIo: CliIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
};

/** Exit code, or 'running' when a long-lived command (serve, cache-server) took over. */
export type CliOutcome = number | 'running';

const LOG_RANK: Record<Config['logLevel'], number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Pattern-based GitHub token redaction plus value-based masking of every configured secret. */
function scrub(message: string, secrets: readonly string[]): string {
  return maskSecrets(redactGithubToken(message), secrets);
}

/** Exported for tests. */
export function makeLogger(io: CliIo, level: Config['logLevel']) {
  const secrets = collectSecrets(io.env);
  const at =
    (min: Config['logLevel']) =>
    (message: string): void => {
      if (LOG_RANK[level] >= LOG_RANK[min]) io.stderr(`[recyclewheel] ${scrub(message, secrets)}\n`);
    };
  return { error: at('error'), warn: at('warn'), info: at('info') };
}

class UsageError extends Error {}

function parseOptions<T extends Record<string, { type: 'string' | 'boolean' }>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runServe(io: CliIo): Promise<CliOutcome> {
  // stdout belongs to the protocol: keep stray console output off it.
  const toStderr = (...args: unknown[]): void => io.stderr(`${formatText(...args)}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const { createApp } = await import('./app.js');
  const { createServer } = await import('./mcp/server.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

  const app = createApp(io.env, { cwd: io.cwd });
  const log = makeLogger(io, app.config.logLevel);
  for (const w of app.config.warnings) log.warn(w);

  const server = createServer(app, { warn: (m) => log.warn(m) });
  const transport = new StdioServerTransport();

  let stopping = false;
  const shutdown = (code: number): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      try {
        await server.close();
      } catch {
        // Closing a transport that is already gone is fine.
      }
      app.close();
      process.exit(code);
    })();
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  process.stdin.once('end', () => shutdown(0));
  process.stdin.once('close', () => shutdown(0));
  transport.onclose = () => shutdown(0);

  await server.connect(transport);
  log.info(`MCP server ${VERSION} ready (cache: ${app.config.cacheDbPath})`);
  return 'running';
}

async function runDoctorCommand(args: string[], io: CliIo): Promise<CliOutcome> {
  const { values } = parseOptions(args, {
    'no-network': { type: 'boolean' },
    json: { type: 'boolean' },
  });
  const report = await runDoctor({
    env: io.env,
    cwd: io.cwd,
    network: values['no-network'] ? false : true,
    ...(io.runGh ? { runGh: io.runGh } : {}),
  });
  io.stdout(values.json ? `${JSON.stringify({ version: VERSION, ...report }, null, 2)}\n` : `${formatDoctor(report)}\n`);
  return report.exitCode;
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`--port must be an integer between 0 and 65535 (got ${JSON.stringify(raw)}).`);
  const n = Number(raw);
  if (n > 65535) throw new UsageError(`--port must be between 0 and 65535 (got ${n}).`);
  return n;
}

function parseTrustedHops(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 32) {
    throw new UsageError(`--trusted-hops must be an integer between 1 and 32 (got ${JSON.stringify(raw)}).`);
  }
  return Number(raw);
}

async function runCacheServer(args: string[], io: CliIo): Promise<CliOutcome> {
  const { values } = parseOptions(args, {
    host: { type: 'string' },
    port: { type: 'string' },
    db: { type: 'string' },
    'trusted-hops': { type: 'string' },
  });
  const config = loadConfig(io.env, { cwd: io.cwd });
  const log = makeLogger(io, config.logLevel);
  for (const w of config.warnings) log.warn(w);

  const host = values.host ?? '127.0.0.1';
  const port = parsePort(values.port ?? '8787');
  const trustedHops = values['trusted-hops'] !== undefined ? parseTrustedHops(values['trusted-hops']) : undefined;
  const dbPath = path.resolve(io.cwd, values.db ?? path.join(config.cacheDir, 'cache-server.db'));

  const { startCacheServer } = await import('./server/cache-server.js');
  const handle = await startCacheServer({
    host,
    port,
    dbPath,
    version: VERSION,
    logger: (level, message) => log[level](message),
    ...(trustedHops !== undefined ? { trustedHops } : {}),
    ...(config.serverWriteToken !== undefined ? { writeToken: config.serverWriteToken } : {}),
    ...(config.serverReadToken !== undefined ? { readToken: config.serverReadToken } : {}),
  });

  io.stdout(`recyclewheel cache-server listening on ${handle.url} (db: ${scrub(dbPath, collectSecrets(io.env))})\n`);
  if (config.serverWriteToken === undefined) {
    log.warn('RECYCLEWHEEL_SERVER_WRITE_TOKEN is not set: uploads (PUT) are disabled, the server is read-only.');
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    log.warn(`Listening on ${host}: put a TLS reverse proxy in front of this server (see docs/cache-server.md).`);
  }

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return 'running';
}

async function runLedger(args: string[], io: CliIo): Promise<CliOutcome> {
  const { values, positionals } = parseOptions(args, {
    format: { type: 'string' },
    out: { type: 'string' },
    root: { type: 'string' },
    component: { type: 'string' },
  });
  if (positionals[0] !== 'export' || positionals.length !== 1) {
    throw new UsageError("Usage: recyclewheel ledger export [--format markdown|json|notices] [--out <file>] [--root <dir>] [--component <id>]");
  }
  const format = values.format ?? 'markdown';
  if (format !== 'markdown' && format !== 'json' && format !== 'notices') {
    throw new UsageError(`--format must be markdown, json or notices (got ${JSON.stringify(format)}).`);
  }
  const config = loadConfig(io.env, { cwd: io.cwd });
  const root = values.root !== undefined ? path.resolve(io.cwd, values.root) : config.projectRoot;

  const { openLedger } = await import('./core/ledger.js');
  const { exportLedger } = await import('./mcp/tools/ledger.js');
  const toStdout = values.out === undefined || values.out === '-';
  const result = exportLedger({
    ledger: openLedger(root),
    projectRoot: root,
    format,
    ...(values.component !== undefined ? { componentId: values.component } : {}),
    ...(!toStdout && values.out !== undefined ? { writeTo: values.out } : {}),
  });
  const secrets = collectSecrets(io.env);
  if (!result.ok) {
    io.stderr(`recyclewheel: ${scrub(result.error, secrets)}\n`);
    return 1;
  }
  for (const w of result.warnings) io.stderr(`recyclewheel: ${scrub(w, secrets)}\n`);
  if (toStdout) io.stdout(result.content);
  else io.stdout(`Wrote ${result.writtenTo ?? values.out}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<CliOutcome> {
  try {
    installSqliteWarningFilter();
    const [first, ...rest] = argv;

    if (first === '--version' || first === '-v') {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (first === '--help' || first === '-h' || first === 'help') {
      io.stdout(USAGE);
      return 0;
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      io.stdout(USAGE);
      return 0;
    }

    const command = first === undefined ? 'serve' : first;
    switch (command) {
      case 'serve':
      case 'mcp':
        if (rest.length > 0) throw new UsageError(`Unexpected argument: ${rest[0]}`);
        return await runServe(io);
      case 'doctor':
        return await runDoctorCommand(rest, io);
      case 'cache-server':
        return await runCacheServer(rest, io);
      case 'ledger':
        return await runLedger(rest, io);
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (err) {
    // Usage errors quote what the user typed (an argument may be a pasted token), so both paths are masked.
    const secrets = collectSecrets(io.env);
    if (err instanceof UsageError) {
      io.stderr(`recyclewheel: ${scrub(err.message, secrets)}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`recyclewheel: ${scrub(err instanceof Error ? err.message : String(err), secrets)}\n`);
    return 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runCli(process.argv.slice(2)).then((outcome) => {
    if (outcome !== 'running') process.exitCode = outcome;
  });
}
