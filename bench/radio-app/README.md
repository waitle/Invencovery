# Benchmark: radio app reuse research (with vs. without recyclewheel)

Date: 2026-11-04. One run per condition, so treat this as anecdotal, not statistical.

## Task (identical prompt for both)

Decide reuse for a smartphone internet-radio app (React Native, Android + iOS, MIT project, app-store distribution):
stream playback, station directory, background/lock-screen playback, ICY now-playing metadata, local favorites.
No app code is written; the output is a reuse report.

| Condition | How |
|---|---|
| A: plain agent | WebSearch + curl (GitHub API, npm registry). No recyclewheel. See [report-plain.md](report-plain.md). |
| B: recyclewheel | Agent follows `skills/recyclewheel/SKILL.md`; `rw_*` tools called through [rwcall.mjs](rwcall.mjs) because the MCP server was not attached to the subagent. See [report-rw.md](report-rw.md) and [ledger.rw.jsonl](ledger.rw.jsonl). |

## Result

| | A: plain | B: recyclewheel |
|---|---|---|
| Tool calls | 5 | 28 |
| Subagent tokens | about 70k | about 131k |
| Wall time | about 71 s | about 327 s |
| Final picks | react-native-track-player, Radio Browser API (own thin client), react-native-mmkv | react-native-track-player pinned to 4.1.2, radio-browser-api (extend), react-native-mmkv |
| Per-candidate score / license verdict | none | yes |
| Rejected alternatives with reasons | short list | recorded with reasons |
| Cross-cutting checks (cost, store policy, privacy, ops, security) | none | all 5, with evidence ids |
| Evidence trail | none | ledger with evidence ids |

### Main difference

`react-native-track-player` on GitHub `main` (V5, npm `@rntp/player`) is under a non-commercial license
(`license.txt`: "Free for non-commercial use ... requires a commercial license"). Only the 4.x line on npm
(`react-native-track-player@4.1.2`) is Apache-2.0. B flagged this and pinned 4.x. A noticed the v5 tag and the
`NOASSERTION` GitHub license value but did not identify the license change. Checked by hand on 2026-11-05.

### Caveats

- One run per condition; model output varies between runs.
- B used a CLI wrapper rather than the real plugin, so skill auto-trigger was not exercised.
- B hit tool friction: 3 of 4 default npm searches failed once, and `rw_evaluate` required `no_service_reason` on
  every SDK-like candidate. Follow-up (2026-11-04): the npm failures were not transient. The planned npm query joined every
  keyword (100+ characters) and the registry rejects `text` over 64 characters with HTTP 400 (`ERR_TEXT_LENGTH`); the
  planned GitHub query ANDed 12 words and returned one unrelated repository. The planner now sends short per-source
  queries (GitHub: up to 4 words plus alternatives when thin; npm: one keyword per query), and `rw_decompose` can run
  the first round for every component in one call (`search: true`). Re-run on the same four components, unauthenticated,
  from a cold cache: one call, about 1.6 s, and the four packages B finally chose
  (`react-native-track-player`, `radio-browser-api`, `@music-metadata/icy`, `react-native-mmkv`) all appear in the first
  round, three of them at rank 1, with the npm and GitHub records of the same project merged (so the npm license
  `Apache-2.0` shows next to GitHub's `NOASSERTION`). B needed 9 `rw_search` calls to reach the same candidates.
- The first version of the wrapper also printed `structuredContent`, which inflated B's context. This copy of the wrapper
  prints it only with `--json`.
- Only the license claims were independently verified. Apple forum and GitHub issue references in the reports were not.

## Reproduce

```bash
npm run build
mkdir -p /tmp/rw-bench && cd /tmp/rw-bench
RECYCLEWHEEL_CACHE_DIR=/tmp/rw-bench/cache node <repo>/bench/radio-app/rwcall.mjs rw_status
```

## Tool-side flow cost (headless, no LLM)

`node bench/flow-cost.mjs [--legacy] [--dist <cli.js>]` runs the same four components through the MCP server with a
fixed, rank-based `fit` (no model), so it measures only what the server side of the workflow costs an agent: tool calls
(each one is a model turn), wall time, result text (what enters the agent's context) and the tool schema sent on every
turn. Unauthenticated GitHub, cold cache, 2026-11-04.

| Build and call pattern | Tool calls | Wall | Result text | Schema x calls | Components with candidates |
|---|---|---|---|---|---|
| main before 2026-11-04, legacy pattern (status, decompose, search x4, evaluate, decide x N, evidence x5, ledger) | 16 | 7.2 s | ~4.1k tokens | ~88k tokens | 2 of 4 (npm HTTP 400, GitHub 0 hits) |
| current build, legacy pattern | 20 | 10.3 s | ~8.4k tokens | ~116k tokens | 4 of 4 |
| current build, current pattern (decompose with search, evaluate x4, decide batch, evidence batch, ledger) | **8** | **7.4 s** | **~5.5k tokens** | **~46k tokens** | **4 of 4** |

With the rank-based fit the current build picks `npm:react-native-track-player`, `npm:radio-browser-api` and
`npm:react-native-nitro-storage` (extend; a real agent's fit of 4-5 turns the first two into adopt) and keeps
`npm:icecast-metadata-stats` as a reference. The old build found candidates for only two components and picked
`github:hussainislive/musically` and `npm:apollo3-cache-persist`. Agent time (WebSearch, judgment, writing) is not in
this table; see the agent comparison above.

## Re-run with real agents (2026-11-05)

Same task text for every run, sent to a fresh subagent with an empty working directory and a cold cache; the
recyclewheel runs were told not to read the README, docs or earlier reports (the skill's example keywords, which came
from this task, were replaced first). One run per condition, so treat the numbers as anecdotal. Network in this
sandbox: api.deps.dev and api.npmjs.org blocked by policy, the anonymous GitHub API quota of the shared IP exhausted,
rntp.dev and radio-browser.info unreachable; registry.npmjs.org reachable. Both conditions had the same network.

| Run | Subagent tokens | Tool calls | Wall | Playback choice | Found the track-player license change | Evidence ledger |
|---|---|---|---|---|---|---|
| A: plain agent ([report](report-plain-2026-11-05.md)) | ~118k | 43 | ~421 s | `expo-audio@58.0.11` (+ ICY patch) | yes, by hand (npm tarball, raw license.txt) | no |
| B1: recyclewheel, before the npm fallback ([report](report-rw-2026-11-05.md)) | ~169k | 51 | ~593 s | `react-native-video@6.19.3` (+ ICY patch) | yes; the npm vs GitHub license in the search table was the signal | yes |
| B2: recyclewheel, after the npm fallback ([report](report-rw2-2026-11-05.md)) | ~166k | 56 | ~598 s | `react-native-track-player@4.1.2` pinned (extend) | yes, by hand | yes |

All license claims that decided a pick were checked independently on 2026-11-05: npm `react-native-track-player@4.1.2`
Apache-2.0; `@rntp/player@5.13.0` `SEE LICENSE IN <license.txt>`; `main/license.txt` non-commercial with a paid
commercial license; `v4/LICENSE` Apache-2.0; `expo-audio@58.0.11`, `expo-sqlite@58.0.15`, `radio-browser-api@6.0.3`,
`react-native-mmkv@4.3.2`, `@music-metadata/icy@0.2.1` MIT; `icecast-metadata-js@1.2.9` LGPL-3.0-or-later.

What this shows:

- **Cost: recyclewheel was not cheaper.** Both recyclewheel runs used about 40% more tokens and time than the plain
  agent. The `rw_*` calls themselves were few (11 and 12); the extra cost came from the procedure around them: more
  cross-cutting web research (B2: 10 WebSearch and 14 WebFetch against A's 4 and 9), recording evidence, and a 37 KB
  skill kept in context.
- **Accuracy: no difference in this task.** All three found the license change. The picks differ between the two
  recyclewheel runs as much as from the plain run, so run-to-run variance dominates; B2's pick (a frozen bridge
  module) is the one the plain agent rejected with reasons.
- **What only recyclewheel produced:** decisions with evidence ids in a ledger, a REUSE.md export, and the
  station-directory service kept at `reference` until its terms are read. The plain agent's report was as thorough on
  store policy and privacy.
- **Tool defects found and fixed after these runs:** with deps.dev and api.npmjs.org blocked every npm candidate tied at
  54/100 (fixed: registry-search fallback; same sandbox now 90 for expo-audio and react-native-video, 64 `stale` for
  the track player); `SEE LICENSE IN` reported as "no license" (fixed: `custom_license`); the package vs repository
  license change not reported, and forks published under the original repository URL keeping the original package from
  merging with its repository (fixed: the first search row now reads
  `npm:react-native-track-player (+github:doublesymmetry/react-native-track-player) | Apache-2.0 ≠ github:...: none |
  [stale, license_differs_by_source]`). These fixes are not yet measured with a real agent.
