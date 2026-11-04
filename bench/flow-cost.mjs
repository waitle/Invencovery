// Headless cost measurement of the recyclewheel tool flow (no LLM involved).
//   node bench/flow-cost.mjs [--legacy] [--dist <path/to/cli.js>] [--cache <dir>] [--candidates <n>] [--json]
// Runs the radio-app decomposition through the MCP server and reports what an agent would pay for the
// server side of the workflow: tool calls (= model turns), wall time, result text size (what enters the
// agent's context) and the tools/list schema size (sent on every model turn).
//   default : rw_decompose(search:true) -> rw_evaluate per component -> rw_decide(decisions[]) -> rw_record_evidence(entries[]) -> rw_ledger
//   --legacy: rw_status -> rw_decompose -> rw_search per component -> rw_evaluate per component -> rw_decide per component
//             -> rw_record_evidence per concern -> rw_ledger (the flow the skill prescribed before 2026-11-04; works with the old build)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const legacy = flag('--legacy');
const dist = path.resolve(opt('--dist', path.join(REPO, 'dist/cli.js')));
const cacheDir = opt('--cache', mkdtempSync(path.join(tmpdir(), 'rw-flow-cache-')));
const perComponent = Number(opt('--candidates', '2'));
const root = mkdtempSync(path.join(tmpdir(), 'rw-flow-root-'));

const sdk = (rel) => pathToFileURL(path.join(REPO, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client', rel)).href;
const { Client } = await import(sdk('index.js'));
const { StdioClientTransport } = await import(sdk('stdio.js'));
const env = { ...process.env, RECYCLEWHEEL_PROJECT_ROOT: root, RECYCLEWHEEL_CACHE_DIR: cacheDir, RECYCLEWHEEL_NO_GH_CLI: '1' };
const transport = new StdioClientTransport({ command: process.execPath, args: [dist, 'mcp'], env, cwd: root, stderr: 'ignore' });
const client = new Client({ name: 'rw-flow-cost', version: '0' });
await client.connect(transport);

const DECOMPOSE = {
  project: {
    name: 'radio-app',
    summary: 'React Native internet radio app for Android and iOS: play live HLS/MP3/AAC streams, browse/search station directory, background playback with lock-screen controls, ICY now-playing metadata, local favorites',
    license: 'MIT', distribution: 'application', ecosystems: ['npm'], markets: ['US', 'EU'],
  },
  components: [
    { name: 'Stream audio playback with background and lock-screen controls', description: 'Play live HLS/MP3/AAC streams in React Native, background playback, notification and lock-screen controls', keywords: ['react native audio player', 'track player', 'background audio', 'lock screen controls', 'hls streaming'] },
    { name: 'Station directory browse and search', description: 'Browse and search internet radio stations directory', keywords: ['radio browser api', 'internet radio directory', 'station search', 'radio stations api'] },
    { name: 'ICY now-playing metadata', description: 'Read ICY / in-stream metadata (StreamTitle) for now-playing display', keywords: ['icy metadata', 'shoutcast metadata', 'stream title', 'react native id3 timed metadata'] },
    { name: 'Local favorites persistence', description: 'Persist favorite stations locally on device', keywords: ['react native storage', 'mmkv', 'async storage', 'persist state'] },
  ],
};
const CONCERNS = ['cost', 'distribution_policy', 'legal_privacy', 'operations', 'security'];

const log = [];
let calls = 0, textChars = 0, structuredChars = 0, errors = 0;
const t0 = performance.now();
async function call(name, arguments_) {
  const start = performance.now();
  const r = await client.callTool({ name, arguments: arguments_ });
  calls++;
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  textChars += text.length;
  structuredChars += r.structuredContent ? JSON.stringify(r.structuredContent).length : 0;
  if (r.isError) errors++;
  log.push({ name, ms: Math.round(performance.now() - start), chars: text.length, error: r.isError === true });
  if (r.isError && flag('--verbose')) console.error(`${name} error: ${text.slice(0, 300)}`);
  return r.structuredContent ?? {};
}

const { tools } = await client.listTools();
const schemaChars = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.inputSchema).length, 0);

const fitFor = (i) => (i === 0 ? 4 : 3);
const pick = (candidates) =>
  candidates
    .filter((c) => !c.preview || c.preview.license_verdict !== 'incompatible')
    .filter((c) => /^(github|npm|pypi):/.test(c.ref))
    .slice(0, perComponent)
    .map((c, i) => ({ ref: c.ref, fit: fitFor(i), fit_reason: `Benchmark fit: rank ${i + 1} candidate of the first search round.` }));
const decisionFor = (component_id, ev) => {
  const rec = ev.recommendation ?? {};
  if ((rec.hint === 'adopt' || rec.hint === 'extend') && rec.ref) {
    return { component_id, decision: rec.hint, ref: rec.ref, rationale: `Benchmark decision: server recommendation ${rec.hint} for ${rec.ref}.` };
  }
  const ref = rec.ref ?? ev.evaluations?.[0]?.ref;
  return ref
    ? { component_id, decision: 'reference', ref, rationale: 'Benchmark decision: no adoptable candidate; keep the best one as a design reference.' }
    : { component_id, decision: 'build', build_reason: 'no_candidate', rationale: 'Benchmark decision: nothing usable was found in the search round.' };
};
const concernEntry = (concern) => ({ concern, kind: 'manual', results: [], summary: `Benchmark: ${concern} checked offline, nothing to record for this run.` });

let searches;
if (legacy) {
  await call('rw_status', {});
  const d = await call('rw_decompose', DECOMPOSE);
  const ids = d.search_plan.filter((p) => !p.skip_reason).map((p) => p.component_id);
  searches = [];
  for (const component_id of ids) searches.push({ component_id, ...(await call('rw_search', { component_id })) });
} else {
  const d = await call('rw_decompose', { ...DECOMPOSE, search: true });
  searches = d.searches.filter((s) => !s.error);
}
const evaluations = [];
for (const s of searches) {
  const candidates = pick(s.candidates ?? []);
  if (candidates.length === 0) continue;
  const ev = await call('rw_evaluate', { component_id: s.component_id, candidates });
  evaluations.push({ component_id: s.component_id, ev });
}
const decisions = evaluations.map(({ component_id, ev }) => decisionFor(component_id, ev));
if (legacy) {
  for (const decision of decisions) await call('rw_decide', decision);
  for (const concern of CONCERNS) await call('rw_record_evidence', concernEntry(concern));
} else {
  await call('rw_decide', { decisions });
  await call('rw_record_evidence', { entries: CONCERNS.map(concernEntry) });
}
await call('rw_ledger', { action: 'export', format: 'markdown' });
const totalMs = Math.round(performance.now() - t0);
await client.close();

const summary = {
  mode: legacy ? 'legacy' : 'current',
  dist,
  tool_calls: calls,
  tool_errors: errors,
  wall_ms: totalMs,
  result_text_chars: textChars,
  result_structured_chars: structuredChars,
  schema_chars_per_turn: schemaChars,
  approx_tokens: {
    results_text: Math.round(textChars / 4),
    schema_per_turn: Math.round(schemaChars / 4),
    schema_over_flow: Math.round((schemaChars * calls) / 4),
  },
  decisions: decisions.map((d) => `${d.component_id}: ${d.decision}${d.ref ? ` ${d.ref}` : ''}`),
  calls: log,
};
if (flag('--json')) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`mode ${summary.mode} | tool calls ${calls} (errors ${errors}) | wall ${(totalMs / 1000).toFixed(1)} s`);
  console.log(`result text ${textChars} chars (~${summary.approx_tokens.results_text} tokens) | structuredContent ${structuredChars} chars`);
  console.log(`schema desc+input ${schemaChars} chars (~${summary.approx_tokens.schema_per_turn} tokens per turn, ~${summary.approx_tokens.schema_over_flow} over the flow)`);
  for (const d of summary.decisions) console.log(`  ${d}`);
  for (const c of log) console.log(`  ${c.name.padEnd(20)} ${String(c.ms).padStart(6)} ms ${String(c.chars).padStart(7)} chars${c.error ? '  ERROR' : ''}`);
}
