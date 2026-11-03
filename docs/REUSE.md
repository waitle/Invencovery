<!-- recyclewheel:export v1 -->
# Reuse Report

**Project:** recyclewheel — Reuse-first gate for coding agents: a Claude Code plugin \(skill + stdio MCP server\) that decomposes a task, searches GitHub/npm/PyPI/MCP registry for existing solutions, scores them and records adopt/extend/reference/build decisions in a JSONL ledger.
**License:** MIT · **Distribution:** application · **Ecosystems:** npm

## Decisions

| Component | Decision | Choice | License | Score | Evidence | Rationale |
|---|---|---|---|---|---|---|
| mcp-sdk | adopt | `npm:@modelcontextprotocol/sdk` @^1.32.1 | MIT (compatible) | 88/100 | 3: search×1, evaluate×1, manual×1 | Official TypeScript SDK \(eval total 88, fit 5, MIT on npm\). Provides McpServer, StdioServerTransport and the Client/InMemoryTransport used in tests; no reason to reimplement the protocol. LICENSE checked manually: repo is in an MIT to Apache-2.0 transition, both compatible. |
| schema-validation | adopt | `npm:zod` @^4.6.6 | MIT (compatible) | 96/100 | 4: search×2, evaluate×1, manual×1 | Eval total 96, fit 5, MIT, zero dependencies, 44k stars and the schema type the MCP SDK expects for registerTool. LICENSE text checked manually. |
| spdx-expression-parse | adopt | `npm:spdx-expression-parse` @^5.0.0 | MIT (compatible) | 94/100 | 3: search×1, evaluate×1, manual×1 | Eval total 94, fit 5, MIT; parses AND/OR/WITH SPDX expressions that the license matrix needs, and writing a correct parser is error-prone. LICENSE text checked; data deps need NOTICES entries. |
| bundler | adopt | `npm:tsup` @^8.5.1 | MIT (compatible) | 88/100 | 5: search×3, evaluate×1, manual×1 | Eval total 88, fit 5, MIT; zero-config esbuild wrapper that inlines dependencies into a single dist/cli.js so the plugin runs without node\_modules. Dev-only. The generic search did not surface it; found by a name query after esbuild results. |
| test-runner | adopt | `npm:vitest` @^5.0.3 | MIT (compatible) | 88/100 | 5: search×3, evaluate×1, manual×1 | Eval total 88, fit 5, MIT, 17k stars; native TypeScript and ESM support, fake timers and no network mocks needed since fetch is injected. Dev-only. Only one real candidate surfaced from the searches, so no alternatives are recorded. |
| github-api-client | build | — (integration_glue) | — | — | 4: search×2, evaluate×1, manual×1 | Thin wrapper over the platform fetch that owns ETag revalidation, rate-limit tracking and the shared cache key scheme for about six GitHub endpoints. octokit scored extend \(82, fit 3\) but would still need that cache and ETag layer rebuilt around it while adding a dependency tree \(11 direct deps for npm:octokit\). Searched github\_repo and npm; see evidence ids. |
| local-cache | build | — (integration_glue) | — | — | 6: search×4, evaluate×1, manual×1 | Cache table layout, TTL classes and rate-limit state are written over the built-in node:sqlite \(verified on this runtime\), so no database dependency is added. better-sqlite3 scored extend \(86, fit 3\) but needs a native addon; keyv and flat-cache lack ETag and rate-limit state and WAL concurrency. |
| registry-metadata | build | — (integration_glue) | — | — | 2: search×1, evaluate×1 | Five thin mapping adapters \(GitHub, npm, PyPI, deps.dev, MCP registry\) call public APIs directly through the shared HttpClient so every response is cached and rate-limited uniformly. Found clients cover only npm \(query-registry, package-json\) and the multi-registry service is AGPL-3.0 and hosted \(evaluated incompatible\), so none can be reused. |
| workflow-design | reference | `github:shimo4228/search-first` | MIT (compatible) | 61/100 | 3: search×2, evaluate×1 | Only the idea of a search-before-building checklist, candidate table and scoring axes is taken; SKILL.md is written from scratch and no text is copied. These candidates were judged from repository metadata and descriptions, not read in depth. |
| code-search-mcp | reference | `mcp:io.github.github/github-mcp-server` | MIT (compatible) | 81/100 | 3: search×2, evaluate×1 | The official GitHub MCP server already provides repo and code search; the skill tells the agent to use it \(or a Grep MCP\) when installed instead of bundling code search. Delegation, not adoption of a dependency; no Grep MCP server was surfaced by the registry search. |
| cache-server | build | — (integration_glue) | — | — | 6: search×4, evaluate×1, manual×1 | A single optional server on built-in node:http for four routes. Judgement call: hono scored adopt \(90, fit 4, 0 deps\), so this is not forced by evidence; chosen to avoid a runtime dependency in the bundle for the optional server, while the real logic \(hashed keys, auth, payload sanitization\) is project specific. |
| scoring-license-ledger | build | — (core_differentiator) | — | — | 4: search×3, evaluate×1 | Scoring candidates across maintenance, popularity, license by distribution, dependencies and fit, and an append-only decision ledger with markdown export, is the product itself \(project summary: scores them and records adopt/extend/reference/build decisions\). Found health scorers are single-ecosystem CLIs with 2 to 11 stars and no license-by-distribution rules. |
| type-checker | adopt | `npm:typescript` @~5.9.3 | Apache-2.0 (compatible) | 90/100 | 3: search×1, evaluate×1, manual×1 | Eval total 90, fit 5, Apache-2.0 \(manual LICENSE check\). tsc --noEmit only. Note the score reflects typescript@latest 7.0.2 \(20 deps\) while the project deliberately pins ~5.9.3; TS 7 is deferred to v0.2. |

## Undecided components

_None._

## Alternatives considered

### mcp-sdk

- `npm:@modelcontextprotocol/server` — Server-only split package \(Apache-2.0\); we also need Client and test transports, so the full sdk is still required.
- `github:modelcontextprotocol/python-sdk` — Python SDK; this project is TypeScript.

### schema-validation

- `npm:ajv` — JSON Schema validator; would be a second validation system next to zod which the MCP SDK API requires.
- `npm:joi` — No static type inference; does not fit the zod-inferred contract types.

### spdx-expression-parse

- `github:aboutcode-org/license-expression` — Python library with no license detected by the tool; wrong language.

### bundler

- `npm:esbuild` — tsup is built on it; direct use needs a custom build script for entries and bundling options.
- `npm:rolldown` — Rust bundler with Rollup-style config; more setup for a single-file CLI and less proven here.

### github-api-client

- `npm:octokit` — All-batteries SDK with 11 direct dependencies for about six endpoints; our cache and ETag layer must own the HTTP calls anyway.
- `github:octokit/rest.js` — Same: official REST client, but request lifecycle conflicts with our shared cache keying; throttling plugins add more dependencies.

### local-cache

- `npm:better-sqlite3` — Native addon build \(prebuild friction on Windows\) while Node 22.13+ ships node:sqlite built in.
- `npm:keyv` — Generic key-value store with adapter dependencies; no ETag, TTL class or rate-limit tables.
- `npm:flat-cache` — File-backed JSON store without WAL or safe concurrent writers across several MCP server processes.

### registry-metadata

- `npm:package-json` — npm registry only; cannot cover PyPI, deps.dev or the MCP registry and bypasses our cache layer.
- `github:velut/query-registry` — npm registry and downloads only; 34 stars; bypasses our cache layer.
- `github:ecosyste-ms/packages` — AGPL-3.0 network copyleft \(evaluated incompatible\) hosted service; adds a third-party runtime dependency.

### workflow-design

- `github:leotong628/search-first` — Searches issues and releases before coding; no scoring or ledger, 0 stars.
- `github:agenticluke/claude-skill-search-first-plus` — Fork of an ECC search-first skill; 0 stars, nothing beyond the original checklist idea.

### code-search-mcp

- `mcp:ai.smithery/smithery-ai-github` — Third-party server from a different publisher \(ai.smithery namespace\); the official GitHub-published server is preferred for delegation. Not evaluated in depth.

### cache-server

- `npm:hono` — Zero-dependency and fits \(hint adopt\), but routing for four routes is a small part of the server; we skip adding a bundled dependency for it.
- `npm:express` — 28 direct dependencies for four routes.

### scoring-license-ledger

- `github:barissozudogru/dep-health` — npm freshness scoring only, 2 stars; no license compatibility or decision ledger.
- `github:xxrraa/repo-health-radar` — Repository health CLI with 11 stars; not a candidate scorer with license rules or ledger.

---

## 부록 A. Dogfooding 실행 기록 (T40)

이 문서의 위 부분은 `.recyclewheel/ledger.jsonl`을 `rw_ledger({ action: 'export', format: 'markdown' })`로 내보낸 것이다.
원장은 빌드된 `dist/cli.js`를 stdio MCP 클라이언트(`@modelcontextprotocol/sdk`의 `Client` + `StdioClientTransport`)로 띄워 실제 도구 8개 중 7개(`rw_status`, `rw_decompose`, `rw_search`, `rw_evaluate`, `rw_record_evidence`, `rw_decide`, `rw_ledger`)로 기록했다. 모델 호출은 없다. 네트워크는 토큰 없이(`github_auth: none`) 실제 GitHub, npm, MCP 레지스트리, deps.dev를 호출했고 레이트리밋에 걸리지 않았다(GitHub 검색 10회/분 한도 안에서 간격을 두고 호출).

### 기록 방식과 한계

- 평가 점수는 `typescript@latest`처럼 **최신 버전** 기준이다. 프로젝트가 고정한 버전과 다를 수 있다(예: typescript 최신은 7.0.2이고 직접 의존 20개이지만, 이 프로젝트는 `~5.9.3`을 쓴다).
- `workflow-design`의 참고 후보(search-first 계열)는 저장소 메타데이터와 설명만 보고 판단했고 본문을 깊게 읽지 않았다. PLAN §4.1이 말한 ECC, kisune `search-first`, `skill-scout`는 이번 검색에서 후보로 나오지 않았다.
- `cache-server`는 `hono`가 평가에서 `adopt` hint(90점, 의존성 0)였다. `build`(`integration_glue`)는 증거가 강제한 결정이 아니라 판단이며, rationale에 그렇게 적었다.
- `local-cache`, `github-api-client`, `cache-server`의 `build`는 Node 내장(`node:sqlite`, `fetch`, `node:http`) 위의 얇은 계층이라는 뜻이다. 현재 `build_reason` 7종에는 "플랫폼 내장으로 충분"에 해당하는 값이 없어 `integration_glue`로 가장 가깝게 기록했다.
- `adopt` 후보 6개는 모두 `metrics_partial` flag(`contributors`를 얻지 못함)가 있어, SKILL.md 규칙대로 LICENSE 원문을 직접 확인하고 `manual` 증거로 남겼다. 이 확인에서 `modelcontextprotocol/typescript-sdk`의 LICENSE가 MIT에서 Apache-2.0으로 전환 중이라는 안내를 발견했다(npm에 게시된 1.32.x는 MIT 선언). 둘 다 MIT 애플리케이션과 호환된다.
- 원장 이벤트는 추가만 가능하므로 `code-search-mcp`의 결정은 두 번 기록됐다(대안 `why_not` 문구를 사실에 맞게 고쳤다). `component`당 최신 결정이 유효하다.

### 헤드리스 시나리오 (`test/skill-scenarios`)

**실행하지 못했다.** `claude -p ... --plugin-dir <repo> --output-format stream-json --verbose`는 플러그인 로드까지는 성공했으나(init 이벤트에서 MCP 서버 `plugin:recyclewheel:recyclewheel`이 `connected`, 도구 `mcp__plugin_recyclewheel_recyclewheel__rw_*` 8개와 스킬 `recyclewheel:recyclewheel`이 등록됨) 첫 모델 호출에서 `Failed to authenticate: OAuth session expired and could not be refreshed`로 중단됐다. `claude auth status`는 `loggedIn: false`였다. 따라서 시나리오 01, 02, 04, 07의 행동 체크리스트는 **통과도 실패도 판정하지 못했다**. 로그인한 터미널에서 다시 실행해야 한다.

모델 없이 확인한 것(시나리오 통과 근거가 아님):

- 플러그인으로 띄운 MCP 서버의 cwd와 `CLAUDE_PROJECT_DIR` 환경변수는 모두 `claude`를 실행한 디렉터리였다(프로브 플러그인으로 실측). 서버를 해당 cwd에서 `RECYCLEWHEEL_PROJECT_ROOT` 없이 띄우면 `rw_status.project_root`가 그 디렉터리를 가리킨다.
- `rw_status`는 `.recyclewheel/`를 만들지 않는다(시나리오 02의 "원장이 생성되지 않음" 전제와 일치).
- 서버 측 가드: 증거 없는 `build`, 평가 없는 `adopt`, `saas` 프로젝트에서 AGPL 후보의 `adopt`는 모두 `isError`로 거부되고 아무것도 기록되지 않았다(시나리오 04의 서버 책임 부분).
