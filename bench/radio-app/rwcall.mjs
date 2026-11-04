// Thin CLI client for the recyclewheel MCP server (benchmark helper).
//   node bench/radio-app/rwcall.mjs <tool_name> '<json args>'     (or @file.json to read args from a file)
// Project root = current working directory. Set RECYCLEWHEEL_CACHE_DIR to isolate the cache.
// Prints the tool's text content. Pass --json as the 3rd argument to also print structuredContent
// (off by default: it duplicates the text table and bloats the agent's context).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sdk = (rel) => pathToFileURL(path.join(REPO, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client', rel)).href;
const { Client } = await import(sdk('index.js'));
const { StdioClientTransport } = await import(sdk('stdio.js'));

const [tool, rawArgs = '{}', flag] = process.argv.slice(2);
if (!tool) {
  console.error('usage: node rwcall.mjs <tool> <json | @file> [--json]');
  process.exit(2);
}
const argText = rawArgs.startsWith('@') ? readFileSync(rawArgs.slice(1), 'utf8') : rawArgs;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(REPO, 'dist', 'cli.js'), 'mcp'],
  env: { ...process.env, RECYCLEWHEEL_PROJECT_ROOT: process.cwd() },
  cwd: process.cwd(),
  stderr: 'ignore',
});
const client = new Client({ name: 'rw-bench', version: '0.0.0' });
await client.connect(transport);
try {
  const reply = await client.callTool({ name: tool, arguments: JSON.parse(argText) });
  for (const c of reply.content ?? []) if (c.text) console.log(c.text);
  if (reply.isError) process.exitCode = 1;
  else if (flag === '--json' && reply.structuredContent) console.log('\n--- structuredContent ---\n' + JSON.stringify(reply.structuredContent));
} finally {
  await client.close();
}
