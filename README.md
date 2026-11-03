# recyclewheel

> **Don't reinvent the wheel.** 새 코드를 쓰기 전에 이미 있는 것을 찾고, 쓸지 말지를 증거와 함께 기록하게 하는 코딩 에이전트용 reuse-first 게이트.

recyclewheel은 Claude Code 플러그인(스킬 + MCP 서버) 하나로 배포됩니다.

- **스킬** (`skills/recyclewheel/SKILL.md`): 언제, 어떤 순서로 재사용을 확인할지 에이전트에게 지시하는 절차. 분해 → 검색 → 평가 → 결정 → 흡수 → 구현.
- **MCP 서버** (`node dist/cli.js mcp`): 검색, 정규화, 점수 계산, 라이선스 판정, 캐시, 기록 같은 **결정적인 일**을 하는 도구 8개.
- 판단(분해, 적합도 `fit`, 최종 결정)은 에이전트가 하고, 호출·계산·기록·검증은 MCP가 합니다.

```
┌─────────────── Claude Code plugin "recyclewheel" ───────────────┐
│ skills/recyclewheel/SKILL.md   절차와 규율 (언제/어떻게)             │
│ .claude-plugin/plugin.json     MCP 서버를 node dist/cli.js 로 등록   │
└───────────────────────┬─────────────────────────────────────────┘
                        │ stdio (MCP)
┌───────────────────────▼─────────────────────────────────────────┐
│ MCP 서버: rw_status rw_decompose rw_search rw_evaluate            │
│           rw_record_evidence rw_decide rw_ledger rw_cache         │
│ 어댑터: GitHub · npm · PyPI · MCP 레지스트리 · deps.dev            │
│ 로컬 SQLite 캐시 ── (옵트인) 원격 공유 캐시 서버                      │
└───────────────────────┬─────────────────────────────────────────┘
                        │ append
              <프로젝트>/.recyclewheel/ledger.jsonl   결정 원장
```

## 무엇이 다른가

기존 `search-first` 류 스킬은 "먼저 검색하라"는 **산문 규율**입니다. 호출을 대신해 주는 도구도, 캐시도, 기록도 없습니다. recyclewheel은 다음을 한 묶음으로 제공합니다.

1. **분해**: 작업을 컴포넌트로 나누고 컴포넌트별 검색 계획(쿼리)을 만듭니다 (`rw_decompose`).
2. **다중 소스 검색**: GitHub, npm, PyPI, MCP 공식 레지스트리, Hugging Face 모델(ML 컴포넌트일 때)을 어댑터로 검색해 하나의 `Candidate` 형태로 정규화하고 중복을 병합합니다 (`rw_search`).
3. **점수와 라이선스 판정**: 유지보수, 인기, 커뮤니티, 라이선스, 의존성, 적합도(`fit`)를 일관된 100점 척도로 계산하고, 프로젝트 라이선스·배포 형태 기준으로 호환성을 판정합니다 (`rw_evaluate`). 방식은 [scoring.md](skills/recyclewheel/reference/scoring.md), [license-matrix.md](skills/recyclewheel/reference/license-matrix.md)에 있습니다.
4. **원장**: `adopt` / `extend` / `reference` / `build` 결정을 근거, 증거(`evidence_id`), 출처(attribution)와 함께 프로젝트 안의 JSONL에 남기고 Markdown 보고서와 NOTICES 초안으로 내보냅니다 (`rw_decide`, `rw_ledger`).
5. **모델 가중치와 호스팅 서비스**: 코드와 라이선스가 따로인 모델 가중치(`hf:<owner>/<model>`)와, 저장소 지표가 없는 SaaS(`saas:<vendor>/<product>`)도 후보로 평가합니다. 모델 카드의 라이선스는 코드 라이선스와 같은 매트릭스로 판정하고, 사용자 정의 라이선스(`other`)는 `unknown`으로 둡니다. SaaS는 에이전트가 벤더 페이지에서 확인한 성숙도·가격·데이터 사용·종속성·탈출 경로로 점수를 매깁니다. 벤더의 도메인(`vendor_domains`)을 함께 받아, 인용한 증거의 URL이 그 도메인에 있는지로 약관의 출처를 서버가 `first_party`/`secondhand`/`none`으로 판정합니다. 가격이나 데이터 사용 약관을 확인하지 못했거나, 근거가 원장에 없거나, 다른 사이트(리셀러, 비교 페이지)에만 있으면 `reference`까지만 허용합니다. 서버는 페이지를 가져와 확인하지 않으므로 URL과 `vendor_domains`는 에이전트가 기록한 값입니다(원장과 보고서에 남아 감사할 수 있습니다).
6. **교차 관심사 체크리스트**: 패키지 조사로는 드러나지 않는 비용, 배포 정책(스토어 심사 등), 법무·개인정보, 운영, 보안을 다섯 가지 관심사로 나눠 `rw_decompose`가 체크리스트를 주고, 에이전트가 웹에서 조사한 결과를 `rw_record_evidence`의 `concern`으로 기록합니다. 하나도 확인하지 않은 채 결정이 쌓이면 경고합니다. `rw_decompose`의 `project.markets`(대상 시장 코드, 예 `["KR", "US"]`)를 주면 시장별 질문(한국 AI 기본법·개인정보 국외 이전, 미국 통화 녹음 동의, EU GDPR·AI Act 등)이 체크리스트에 붙고, `legal_privacy`는 `rw_record_evidence`의 `market`으로 시장마다 확인 여부를 따로 셉니다. 생략하면 한글·가나로 KR·JP를 추정해 알려 줍니다.
7. **캐시**: GitHub 레이트리밋을 줄이는 로컬 캐시(TTL, ETag 재검증, stale-if-error)와, 팀이 직접 운영하는 선택적 공유 캐시.

웹 검색은 에이전트의 WebSearch/WebFetch가 하고, MCP는 그 결과를 증거로만 기록합니다(`rw_record_evidence`). MCP 서버 안에서는 LLM을 호출하지 않습니다.

## 요구사항

- Node.js **>= 22.13** (내장 `node:sqlite` 사용. 첫 실행 때 `ExperimentalWarning`이 나올 수 있으며 서버가 stderr에서 걸러냅니다).
- 선택: `gh` CLI 로그인 또는 `GITHUB_TOKEN`. 없어도 동작하지만 GitHub 검색이 분당 10회로 제한되고, 코드 검색(`github_code`)은 쓸 수 없습니다.

## 설치

### (a) Claude Code 플러그인 (스킬 + MCP)

플러그인은 `dist/cli.js` 번들을 실행하므로 **빌드된 `dist/`가 필요**합니다. 이 저장소는 `dist/`를 git에서 제외하므로, 로컬 클론에서 직접 빌드한 뒤 로컬 경로로 마켓플레이스를 등록하는 방식이 기본 경로입니다.

```bash
git clone https://github.com/recyclewheel/recyclewheel.git
cd recyclewheel
npm ci
npm run build
```

Claude Code 안에서:

```text
/plugin marketplace add <클론한 절대 경로>
/plugin install recyclewheel@recyclewheel
```

셸에서는 `claude plugin marketplace add <경로>`, `claude plugin install recyclewheel@recyclewheel`로도 같습니다. 로컬 경로 마켓플레이스의 플러그인은 그 디렉터리에서 직접 로드되므로(`${CLAUDE_PLUGIN_ROOT}`가 클론 경로를 가리킴), 소스를 고치고 `npm run build`를 다시 하면 다음 세션(또는 `/reload-plugins`)에 반영됩니다. 버전은 `.claude-plugin/plugin.json`의 `version`으로 고정되어 있어, git으로 받은 사본의 업데이트는 그 값을 올려야 감지됩니다.

> git URL(`owner/repo`)로 마켓플레이스를 추가하면 Claude Code는 저장소를 clone해서 **git이 추적하는 파일**만 캐시로 복사합니다. `dist/`를 커밋하지 않은 저장소를 이렇게 설치하면 MCP 서버가 시작되지 않습니다. 이 경로는 `dist/`를 포함해 배포한 릴리스 브랜치/태그에서만 쓰세요.

설치 확인(수동):

1. `/mcp`에 `plugin:recyclewheel:recyclewheel`이 `connected`로 표시되는지 봅니다.
2. 스킬 목록에 `recyclewheel:recyclewheel`이 있는지 봅니다.
3. 새 세션에서 도구 이름은 `mcp__plugin_recyclewheel_recyclewheel__rw_status`처럼 접두어가 붙습니다.

한 세션만 시험하려면 설치 없이 `claude --plugin-dir <클론 경로>`로 실행할 수 있습니다.

플러그인이 MCP 서버에 넘기는 환경변수는 `GITHUB_TOKEN`, `GH_TOKEN`, `LIBRARIES_IO_API_KEY`이고(비어 있으면 없는 것으로 취급), 그 밖의 변수(아래 환경변수 표)는 Claude Code를 실행한 셸의 환경에서 그대로 읽습니다.

### (b) MCP 서버만

```bash
git clone https://github.com/recyclewheel/recyclewheel.git
cd recyclewheel
npm ci
npm run build
claude mcp add recyclewheel --scope user -- node /abs/path/to/recyclewheel/dist/cli.js mcp
```

Windows 예시 (경로에 공백이 있으면 따옴표). `node`를 직접 실행하므로 `cmd /c npx` 래퍼가 필요 없습니다.

```powershell
claude mcp add recyclewheel --scope user -- node D:\path\to\recyclewheel\dist\cli.js mcp
```

토큰을 넘기려면 이름 뒤, `--` 앞에 `-e GITHUB_TOKEN=...`을 둡니다(`claude mcp add recyclewheel --scope user -e GITHUB_TOKEN=... -- node ... mcp`). 이 경우 스킬은 없으므로 MCP prompt `reuse_first_workflow`(스킬 본문과 같은 절차를 돌려줍니다)를 쓰거나 (c)를 함께 하세요.

### (c) 스킬만

`skills/recyclewheel/` 디렉터리를 `~/.claude/skills/`에 복사합니다. MCP 도구가 없으면 스킬은 [수동 모드](skills/recyclewheel/reference/manual-mode.md)(`gh search repos`, `npm search --json`, WebSearch)로 같은 절차를 수행하고 `.recyclewheel/ledger.md`에 표로 기록합니다.

## 빠른 사용

설치 후 평소처럼 요청하면 됩니다. 새 프로젝트·기능·모듈·CLI처럼 약 50줄 이상의 새 코드를 쓰기 직전에 스킬이 발동하도록 설계되어 있습니다(버그 수정, 작은 수정, 리팩터링에는 발동하지 않는 것이 의도입니다).

```text
> Markdown 파일을 PDF로 바꾸는 CLI를 만들어줘
```

기대하는 흐름 (스킬이 지시하는 순서):

1. `rw_status`로 토큰, 오프라인 여부, 예산, 원장 위치를 확인.
2. 저장소의 manifest와 기존 모듈에서 이미 있는 것을 확인.
3. `rw_decompose`로 3~10개 컴포넌트로 분해(예: Markdown 파서, PDF 렌더러, CLI 인자 처리).
4. 컴포넌트별 `rw_search` → 상위 후보를 `rw_evaluate`(에이전트가 `fit` 0~5와 근거를 입력). 후보가 사전학습 모델을 불러오면 `weights_ref`로 그 모델을, 모델을 불러오지 않으면 `weights_exempt_reason`을, 호스팅 서비스면 `saas:` ref와 `saas` 블록을 넘깁니다(필수는 `vendor_domains`, `lock_in`, `exit_path` 셋이고, 읽은 벤더 페이지는 `source_url`로 적으면 서버가 증거로 기록합니다). SDK·플러그인 후보에는 그 서비스를 `service_ref`로 연결합니다.
5. `rw_decide`로 `adopt` / `extend` / `reference` / `build` 기록. `build`는 `no_candidate`, `license_incompatible`, `unmaintained_or_risky`, `too_heavy`, `core_differentiator`, `trivial`, `integration_glue` 중 하나의 사유가 필요합니다.
6. 새 런타임 의존성이나 `conditional` 라이선스가 있으면 Reuse Report를 보여주고 진행 여부를 확인.
7. `rw_decompose`의 `concerns_checklist`를 따라 비용, 배포 정책, 법무·개인정보, 운영, 보안을 웹에서 조사하고 `rw_record_evidence({ concern, kind: 'web', ... })`로 기록. 해당 없는 관심사도 이유와 함께 기록합니다.
8. 최종 응답에 Reuse Report 요약을 포함. 결정은 `<프로젝트>/.recyclewheel/ledger.jsonl`에 쌓이며 git에 커밋하는 것을 권장합니다.

보고서는 `rw_ledger`(또는 CLI `recyclewheel ledger export`)로 내보냅니다. 형식 예시는 다음과 같습니다(값은 형식을 보이기 위한 **가상의 예**이며 실제 검색 결과가 아닙니다).

| Component | Decision | Choice | License | Score | Evidence | Rationale |
|---|---|---|---|---|---|---|
| markdown-parser | adopt | npm:example-md | MIT (compatible) | 82 | ev_01, ev_02 | 요구사항을 설정만으로 충족, 최근 릴리스 있음 |
| pdf-renderer | extend | github:example/pdf-kit | Apache-2.0 (compatible) | 61 | ev_03 | 얇은 어댑터로 감싸서 사용 |
| cli-args | build | - | - | - | ev_04 | `trivial`: 표준 라이브러리로 충분 |

## MCP 도구

도구 8개와 prompt 1개입니다. 모든 도구는 `structuredContent`와 요약 Markdown을 함께 반환하고, 공통 선택 인자로 `project_root`(원장 위치 기준)를 받습니다. `project_root`는 서버의 `RECYCLEWHEEL_PROJECT_ROOT`(기본: 서버 cwd) **안**이어야 하며 모든 도구에 적용됩니다. 벗어나면 오류이고, 원장 디렉터리 `.recyclewheel` 자체나 그 하위를 가리켜도 오류입니다. 다른 프로젝트를 다루려면 그 디렉터리를 `RECYCLEWHEEL_PROJECT_ROOT`로 두고 서버를 시작하세요. 읽기 전용(`readOnlyHint: true`)은 `rw_status` 하나뿐입니다. `rw_search`와 `rw_evaluate`는 원장에 증거를 쓰므로 읽기 전용이 아닙니다. 상세 스키마는 [docs/PLAN.md §7](docs/PLAN.md)입니다.

| 도구 | 성격 | 설명 | 주요 인자 |
|---|---|---|---|
| `rw_status` | read-only | 버전, 토큰 출처(`env`/`gh_cli`/`none`), 오프라인 여부, 원격 캐시 상태, 레이트리밋, 어댑터 활성 여부, 예산, 캐시 크기, 원장 위치, 교차 관심사 커버리지(`cross_cutting[{ concern, checked, evidence_count, markets? }]`, `markets`는 대상 시장이 있을 때 `legal_privacy`의 시장별 현황). `.recyclewheel`/`ledger.jsonl`이 링크이면 `ledger_exists:false`와 경고. 결정이 1건 이상인데 확인하지 않은 관심사가 있으면 `cross-cutting concern not checked: <concern>` 경고 | `project_root` |
| `rw_decompose` | 원장 기록 | 프로젝트와 컴포넌트(1~30개)를 검증·저장하고 컴포넌트별 검색 계획을 반환. ML로 보이는 컴포넌트는 `hf_models` 쿼리도 계획에 포함. 출력의 `concerns_checklist[{ concern, relevance, reason, questions, search_hints }]`는 교차 관심사 5개의 조사 목록(한국어·영어 키워드 규칙으로 `likely`/`consider` 구분)이고, `project.markets`가 있으면 `[KR]` 같은 접두어가 붙은 시장별 질문이 더해진다. 출력 `markets{ codes, source: input/inferred/none }`는 쓰인 대상 시장과 출처 | `project`(`markets?` 포함), `components[]`, `replace` |
| `rw_search` | open-world, 원장 기록 | 소스별 어댑터를 병렬 호출해 정규화·중복 병합한 후보를 반환하고 검색 증거를 기록. 예산 경고와 하드 리밋(2배)이 있음 | `component_id`, `query`, `sources`, `limit_per_source`, `force`/`force_reason` |
| `rw_evaluate` | open-world, 원장 기록 | 후보(1~5개)를 보강 조회해 점수, 라이선스 판정, `hint`(adopt/extend/reference/build)를 계산. `hf:` 후보는 모델 카드 라이선스를, `saas:` 후보는 `saas` 블록으로 SaaS 점수(성숙도·약관·종속성·SDK·적합도 각 20점)를 계산 | `component_id`, `candidates[{ref, fit, fit_reason, weights_ref?, weights_exempt_reason?, service_ref?, no_service_reason?, saas?}]`, `project_license`, `distribution`, `deep` |
| `rw_record_evidence` | 원장 기록 | 에이전트의 웹/코드 검색 결과를 증거로 기록(0건도 허용). `concern`을 주면 교차 관심사 조사로 기록하며(`market`을 더하면 대상 시장별 조사) 이때는 `component_id`가 선택 사항이고, 컴포넌트 검색 예산과 build 2소스 규칙에는 포함되지 않음(관심사별 웹 쿼리 `RECYCLEWHEEL_BUDGET_WEB`회, `legal_privacy`는 대상 시장 수를 곱한 만큼, 초과 시 경고만) | `component_id`, `concern`(`cost`/`distribution_policy`/`legal_privacy`/`operations`/`security`), `market`(`concern`과 함께만), `kind`(`web`/`code_search`/`manual`), `results[]`, `summary` |
| `rw_decide` | 원장 기록 | 검증 규칙을 적용해 결정을 기록하고 `decision_id`와 경고를 반환. `ref`/`alternatives`에 `hf:`/`saas:` ref 허용. 가중치 라이선스가 `custom_model_license`/incompatible이거나 SaaS 약관이 미확인(`saas_terms_unverified`)이거나 근거가 원장에 없거나(`saas_evidence_missing`) 벤더 도메인 밖의 페이지뿐이면(`saas_terms_secondhand`) `adopt`/`extend`를 거부(`decided_by: "user"`이면 경고로 완화) | `component_id`, `decision`, `ref`, `rationale`, `build_reason`, `alternatives`, `attribution`, `override` |
| `rw_ledger` | 조회/내보내기 | 원장 조회 또는 `markdown`/`json`/`notices` 내보내기. `write_to`는 프로젝트 루트 안의 보이는 `.md`/`.json` 경로만 허용하고, 이미 있는 파일은 내보내기 마커가 있을 때만 덮어씀(아래 "원장 내보내기 쓰기 규칙"). `write_to` 없이 호출하면 `markdown`/`notices`/`json` 모두 텍스트 content 전체를 `<untrusted_third_party_data>`로 감쌈. 출력에 `cross_cutting` 커버리지가 들어가며(컴포넌트로 한정하면 생략) Markdown 보고서에는 "Services (SaaS)"(벤더 도메인과 항목별 약관 출처)와 "Cross-cutting checks"(`legal_privacy`는 시장별) 절이 생김. NOTICES 초안에서 `saas:` 결정은 제외 | `action`(`get`/`export`), `format`, `component_id`, `write_to` |
| `rw_cache` | 로컬 캐시 | `stats` / `lookup`(메타데이터만, 본문 없음) / `purge`(`confirm: true` 필요, destructive). 원격 캐시에는 영향 없음 | `action`, `url`, `source`, `older_than_days`(정수), `confirm` |
| prompt `reuse_first_workflow` | - | 스킬 본문(frontmatter 제외)을 그대로 반환 | `task` |

검색 소스(`rw_search`의 `sources`): `github_repo`, `github_code`, `npm`, `pypi`, `mcp_registry`, `hf_models`(모델 가중치). 평가 보강에는 deps.dev도 쓰입니다.

**ref 표기**: `github:owner/repo`, `npm:name`, `pypi:name`, `mcp:id`, `hf:owner/model`, `saas:vendor/product`, `web:https://...`. `hf:`는 모델 가중치 자체이고, 코드 후보가 불러오는 모델은 `weights_ref`로 따로 넘겨 라이선스를 판정합니다(최종 verdict는 코드와 가중치 중 나쁜 쪽).

**모델 가중치 라이선스** (Hugging Face 모델 카드):

- `downloads`는 최근 30일 합계라서 주간 값으로 환산(`round(downloads * 7 / 30)`)하고, `likes`는 stars로 씁니다.
- `license: other`, 표에 없는 id, `license_name`이 있는 카드는 사용자 정의 라이선스입니다. verdict는 `unknown`이고 플래그 `custom_model_license`가 붙습니다. 원문을 읽고 판단해야 합니다.
- 비상업(`cc-by-nc-*` 등)은 `application`/`saas`/`library` 배포에서 `incompatible`, `internal`에서 `conditional`입니다. OpenRAIL, Llama, Gemma, CC-BY-SA, CC-BY-ND는 `conditional`입니다. 게이트가 걸린 모델은 `gated_model` 플래그가 붙습니다. 표는 [license-matrix.md](skills/recyclewheel/reference/license-matrix.md) §8입니다.
- 이름(강한 용어와 약한 용어)과 설명·키워드·토픽(강한 용어만)이 사전학습 모델을 불러올 것으로 보이는 github/npm/pypi/mcp 후보에 `weights_ref`가 없으면 `model_weights_unverified` 플래그와 경고가 붙습니다. 경고만 하고 `hint`는 바꾸지 않는 휴리스틱입니다. 가중치가 필요 없는 후보(원격 API 게이트웨이처럼 모델을 불러오지 않거나, 가중치가 코드와 같은 LICENSE로 패키지에 들어 있는 경우)는 `weights_exempt_reason`을 주면 플래그가 풀리고 이유가 원장과 보고서에 남습니다. 설명에 `embedding(s)`만 있는 후보(벡터 DB 클라이언트 등)는 이름이나 키워드에 있을 때만 플래그가 붙습니다. `llm`/`gpt`처럼 원격 API를 가리키는 말만으로는 플래그가 붙지 않습니다(`llama.cpp`, `whisper.cpp`, `onnx` 등은 붙습니다). `rw_evaluate` 출력의 "Model weights:" 목록에 후보별 코드·가중치 verdict가 나옵니다.

**SaaS 평가** (`saas:<vendor>/<product>`): `saas` 블록은 `saas:` ref에 필수이고 다른 ref에는 금지입니다. 필수는 `vendor_domains`, `lock_in`(`low`/`medium`/`high`), `exit_path` 셋이라서 약관을 읽기 전에도 호출 한 번으로 등록할 수 있습니다(hint는 `reference`에 머묾). 선택 필드는 `maturity`(`ga`/`beta`/`preview`/`unknown`, 기본 `unknown`), `pricing{ checked?, summary?, evidence_id?, source_url? }`(기본 `{checked:false}`), `data_use{ policy(`no_training`/`opt_out`/`trains`/`not_stated`/`unknown`), retention?, evidence_id?, source_url? }`(기본 `{policy:"unknown"}`; `unknown`은 벤더 페이지를 아직 읽지 않았다는 뜻이고 `not_stated`는 읽었으나 학습 사용 여부가 명시되지 않았다는 뜻으로, `saas_terms_unverified`를 올리지 않고 hint 상한 없이 `saas_data_use_not_stated` 플래그와 "DPA 확인 또는 문의 필요" 경고만 붙으며 점수는 first_party 4, secondhand 2, none 0), `sdk_ref?`입니다. `source_url`(http/https, userinfo 불가, 저장·출력 시 비밀 쿼리 값은 가림; 같은 호출을 되풀이해도 같은 증거는 재사용)을 주면 서버가 그 페이지를 증거로 기록하고(`recorded_evidence`, kind `manual`) 출처 판정까지 한 호출에서 끝냅니다. `pricing.source_url`은 `checked: true`를 뜻하며 `checked: false`나 `evidence_id`와 함께 쓰면 오류입니다. 자동 기록 증거는 웹 검색 예산과 build의 "출처 2곳" 규칙에 세지 않습니다. 점수는 성숙도, 약관, 종속성, SDK, 적합도 각 20점이며 공식은 [scoring.md](skills/recyclewheel/reference/scoring.md) §11입니다. 가격이나 데이터 사용 정책을 확인하지 못하면 `saas_terms_unverified`가 붙고 `hint`는 `reference`가 상한입니다. `vendor_domains`(1~5개의 소문자 호스트명, 필수; `github.io`, `co.kr` 같은 공개 접미사는 불가)는 벤더 본인의 도메인이고, https URL만 `first_party`이며 http는 `secondhand`, `pricing.evidence_id`/`data_use.evidence_id`가 가리키는 증거의 URL이 그 도메인(하위 도메인 포함)에 있으면 출처 `first_party`, 없으면 `secondhand`, 증거가 원장에 없으면 `none`입니다. 출처는 서버가 계산하며 입력으로 줄 수 없습니다. `secondhand`는 약관 점수가 절반만 인정되고 `saas_terms_secondhand`, `none`은 `saas_evidence_missing` 플래그가 붙으며, 둘 다 `saas_terms_unverified`처럼 `hint`를 `reference`로 묶고 `adopt`/`extend`를 막습니다. 벤더 페이지를 `rw_record_evidence`로 남기고 그 `evidence_id`로 `rw_evaluate`를 다시 부르면 풀립니다. 한계: 서버는 페이지를 가져와 확인하지 않으므로 URL과 `vendor_domains`는 에이전트가 기록한 값입니다. `decided_by`도 에이전트의 자기 보고이며, `"user"`로 게이트를 넘기면 서버가 `waived_gates`를 원장에 남기고 REUSE.md에 "gate waived by user: <flag>"로 표시합니다(하드 차단은 없음). `rw_evaluate`는 모든 이벤트를 검증한 뒤에야 쓰고(전부 쓰거나 전혀 안 씀), 이미 평가한 ref만 다시 보내는 재평가는 예산 한도를 넘어도 경고 없이 통과합니다. 그 밖의 플래그: `saas_trains_on_data`, `no_sdk`.

**SDK·플러그인이 가리키는 서비스**: github/npm/pypi/mcp 후보에 `service_ref: "saas:<vendor>/<product>"`를 주면 그 후보의 실제 선택은 서비스로 취급합니다. 같은 호출에 서비스를 함께 넣으면 서비스를 먼저 처리하고, 이전 호출의 평가도 찾습니다. 서비스의 최신 평가가 없거나 `saas_terms_unverified`/`saas_evidence_missing`/`saas_terms_secondhand`가 있으면 클라이언트에 `service_terms_unverified` 플래그가 붙고 `hint`는 `reference`가 상한이며, `rw_decide`는 결정 시점에 서비스의 최신 평가로 다시 판정해 adopt/extend를 거부합니다(`decided_by: "user"`이면 경고). 서비스 클라이언트처럼 보이는데(이름의 벤더 토큰 `openai`, `firebase`, `elevenlabs` 등, 또는 "official … SDK", "SDK for … API" 같은 설명) `service_ref`가 없으면 `service_client_suspected` 플래그와 경고만 붙습니다(`hint`와 게이트는 그대로). 서비스가 필요 없는 패키지는 `no_service_reason`(10~300자, `service_ref`와 함께 쓸 수 없음)으로 면제하며 이유가 원장과 보고서에 남습니다. LLM 게이트웨이처럼 보이는 후보(이름 토큰 `litellm`/`openrouter`/`portkey`, 또는 "LLM gateway/proxy/router", "100+ LLMs" 같은 설명)는 뒤의 모델 제공자가 별개의 결정이므로 `service_ref`(제공자 `saas:`) 또는 `weights_ref`(자체 호스팅 모델)가 없으면 `upstream_provider_unverified` 플래그와 경고가 붙습니다(`hint`와 게이트는 그대로인 휴리스틱이고 `no_service_reason`으로는 풀리지 않음). 서비스나 제공자가 미확인인 채 결정된 adopt/extend는 REUSE.md의 "Services used through a client but not evaluated" 절과 `rw_ledger`·`rw_status` 경고로 사유와 함께 드러납니다.

**프로젝트 필드 유지**: `rw_decompose`를 다시 부를 때 생략한 `license`, `distribution`, `ecosystems`, `markets`는 원장의 최신 프로젝트 값을 그대로 유지합니다(`distribution` 기본값은 상속 뒤에 적용). 값을 주면 덮어쓰고, `replace: true`여도 컴포넌트만 교체됩니다. 유지된 필드는 출력의 `inherited_project_fields`와 본문에 표시됩니다. `markets`는 기존 규칙대로 출처가 `input`일 때만 상속하고 아니면 다시 추론합니다.

**교차 관심사**: `cost`, `distribution_policy`, `legal_privacy`, `operations`, `security`. 관심사당 웹 조사 1회 이상이 기본이고 해당 없으면 이유를 기록합니다. 대상 시장(`project.markets`)이 있으면 `legal_privacy`는 시장마다 `market`을 붙여 따로 기록해야 확인으로 세고(시장 태그 없는 일반 증거만으로는 미확인), 아니면 `cross-cutting concern not checked for market <코드>: legal_privacy` 경고가 나옵니다. 스토어 규정은 대체로 전 세계 공통이라 `distribution_policy`는 `market` 없는 증거가 1건 이상이어야 확인이고, 한 나라의 근거만 있으면 `cross-cutting concern not checked: distribution_policy (only market-specific evidence)` 경고가 나옵니다. 체크리스트에는 제3자 AI 전송 고지·동의(App Store 5.1.2)와 구독 결제 규정(App Store 3.1.1, Google Play Billing) 질문이 고정으로 들어 있습니다.

**원장 내보내기 쓰기 규칙** (`rw_ledger`의 `write_to`와 CLI `ledger export --out` 공통):

- **허용**: 프로젝트 루트 안의 `.md`/`.json` 파일. 예: `docs/REUSE.md`, `THIRD_PARTY_NOTICES.md`, `reports/x.md`.
- **경로 거부**: 프로젝트 루트 밖(심볼릭 링크·junction은 실제 경로로 판정), `.recyclewheel` 안(별칭, junction, 8.3 이름 `RECYCL~1`, `x.md:stream` 같은 ADS 포함), 세그먼트에 `:` 또는 `~숫자`가 있거나 끝이 점/공백인 경로, `.`으로 시작하는 세그먼트가 하나라도 있는 경로(`.claude`, `.github` 같은 dot 디렉터리와 dot 파일명), 디렉터리.
- **폴더 이름 거부**: 경로 어디든 폴더 이름이 `commands`, `agents`, `skills`, `hooks`, `.claude`(대소문자 무시)이면 거부합니다. 코딩 에이전트가 명령, 서브에이전트, 스킬, 훅을 읽는 위치이기 때문입니다. `commands.md`나 `my-skills/x.md`처럼 이름이 정확히 같지 않은 경로는 허용합니다.
- **링크 경유 거부**: 루트 안의 링크/junction을 통해 위 폴더나 파일로 이어지는 경로도 거부합니다. 철자뿐 아니라 링크를 푼 실제 경로에도 같은 규칙(세그먼트, 폴더 이름, 파일명)을 다시 적용합니다.
- **파일명 거부**: 에이전트 지시 파일 `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENT.md`, `GEMINI.md`, `QWEN.md`, `WARP.md`, `SKILL.md`, `.cursorrules`, `.windsurfrules`, `copilot-instructions.md`(대소문자 무시). Windows에서는 장치 이름(`nul.x.md` 포함)도 거부합니다.
- **덮어쓰기**: 내보내기 파일은 마커로 식별합니다. Markdown/NOTICES는 첫 줄이 `<!-- recyclewheel:export v1 -->`, JSON은 첫 키가 `"recyclewheel_export": 1`입니다. 이미 있는 파일은 이 마커가 있을 때만 덮어쓰며, 마커가 없는 파일(손으로 쓴 문서, 이전 버전의 내보내기)은 거부합니다. 그럴 때는 다른 경로를 쓰거나 파일을 직접 삭제한 뒤 다시 내보내세요.

## CLI

```text
recyclewheel [serve|mcp]            stdio MCP 서버 (기본)
recyclewheel doctor [--no-network] [--json]
recyclewheel cache-server [--host 127.0.0.1] [--port 8787] [--db <path>] [--trusted-hops <n>]
recyclewheel ledger export [--format markdown|json|notices] [--out <file>] [--root <dir>] [--component <id>]
recyclewheel --version | --help
```

- `node dist/cli.js doctor`: Node 버전, `node:sqlite`, 캐시 디렉터리, `gh`/토큰, 원장 위치(`ledger_path`: `.recyclewheel`이 링크이면 경고), 원격 캐시, (옵션) 외부 API 도달성(`net_huggingface` 포함)을 점검합니다. 하드 실패가 있을 때만 종료 코드 1입니다.
- `ledger export --out`은 `rw_ledger`의 `write_to`와 같은 쓰기 규칙(위 "원장 내보내기 쓰기 규칙")을 따릅니다. 프로젝트 루트 안의 보이는 `.md`/`.json` 경로만 허용하고, 기존 파일은 내보내기 마커가 있을 때만 덮어씁니다.

## 환경변수

`src/config.ts`가 읽는 값입니다. 빈 문자열은 "없음"으로 취급하고, 잘못된 값은 기본값으로 대체하며 경고를 `rw_status`/`doctor`에 표시합니다(경고에는 변수 이름만 나오고 환경변수의 원시 값은 출력하지 않습니다). 불리언은 `1`/`true`/`yes`/`on`이 참입니다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `GITHUB_TOKEN` / `GH_TOKEN` | - | GitHub 토큰 (이 순서로 우선). 권한이 없는 fine-grained PAT(공개 데이터 읽기 전용)를 권장 |
| `RECYCLEWHEEL_NO_GH_CLI` | 꺼짐 | 켜면 토큰이 없을 때 `gh auth token`을 실행하는 폴백을 쓰지 않음 |
| `RECYCLEWHEEL_CACHE_DIR` | Windows `%LOCALAPPDATA%\recyclewheel`, 그 외 `${XDG_CACHE_HOME:-~/.cache}/recyclewheel` | 로컬 캐시 디렉터리 (`cache.db`가 이 안에 생김) |
| `RECYCLEWHEEL_CACHE_MAX_MB` | `200` | 로컬 캐시 상한. 넘으면 오래된 항목부터 정리 |
| `RECYCLEWHEEL_OFFLINE` | 꺼짐 | 켜면 네트워크 호출 금지 (캐시만 사용) |
| `RECYCLEWHEEL_PROJECT_ROOT` | 현재 작업 디렉터리 | 원장(`.recyclewheel/ledger.jsonl`) 위치 기준. 도구의 `project_root` 인자는 이 디렉터리 안이어야 함 |
| `RECYCLEWHEEL_SOURCES` | 전부 | 활성 검색 소스(쉼표 구분): `github_repo,github_code,npm,pypi,mcp_registry,hf_models` |
| `RECYCLEWHEEL_REMOTE_CACHE_URL` | - | 원격 캐시 base URL. https 또는 loopback(`localhost`, `127.0.0.1`, `[::1]`)의 http만 허용 |
| `RECYCLEWHEEL_REMOTE_CACHE_MODE` | `off` | `off` / `read` / `readwrite`. URL이 없거나 거부되면 `off`로 되돌아감 |
| `RECYCLEWHEEL_REMOTE_CACHE_TOKEN` | - | 원격 캐시 Bearer 토큰 (읽기/쓰기 공용) |
| `RECYCLEWHEEL_ALLOW_INSECURE_REMOTE` | 꺼짐 | 켜면 loopback이 아닌 호스트의 평문 http 원격 캐시 URL도 허용(토큰이 암호화 없이 전송되므로 권장하지 않음). 꺼져 있을 때 그런 URL은 경고와 함께 mode `off`가 됨 |
| `RECYCLEWHEEL_BUDGET_ROUNDS` | `3` | 컴포넌트당 `rw_search` 라운드 수 |
| `RECYCLEWHEEL_BUDGET_EVALS` | `5` | 컴포넌트당 `rw_evaluate` 대상 수 |
| `RECYCLEWHEEL_BUDGET_WEB` | `2` | 컴포넌트당 웹 검색 횟수. 교차 관심사 조사는 관심사마다 이 횟수를 따로 쓰며(`legal_privacy`는 대상 시장 수를 곱함) 초과해도 경고만 합니다 |
| `LIBRARIES_IO_API_KEY` | - | 있으면 PyPI 검색을 libraries.io로 보강 |
| `RECYCLEWHEEL_LOG_LEVEL` | `warn` | stderr 로그 수준: `silent` / `error` / `warn` / `info` / `debug` |
| `RECYCLEWHEEL_SERVER_WRITE_TOKEN` | - | `cache-server`: 쓰기 토큰. 없으면 서버는 읽기 전용. 설정한다면 **16자 이상** (아래 "원격 공유 캐시") |
| `RECYCLEWHEEL_SERVER_READ_TOKEN` | - | `cache-server`: 설정하면 읽기에도 토큰이 필요. **16자 이상** |

## 캐시

- **위치**: 위 표의 `RECYCLEWHEEL_CACHE_DIR` 아래 `cache.db` (SQLite, WAL). 여러 Claude 세션이 동시에 써도 됩니다.
- **TTL**: 검색 12시간, 저장소 상세 6시간, 릴리스/기여자 24시간, 패키지 메타·다운로드 24시간, deps.dev 72시간, MCP 레지스트리 상세 24시간, Hugging Face는 검색 12시간·모델 상세 24시간, 404는 1시간. 만료 후에도 ETag/Last-Modified로 재검증하고, 오류나 레이트리밋일 때는 최대 7일 된 항목을 대신 돌려줍니다(stale-if-error).
- **레이트리밋**: 응답 헤더를 추적해 한도가 소진되면 호출하지 않고 캐시를 사용합니다. 평가 보강은 가능하면 GitHub 대신 deps.dev를 먼저 씁니다.
- **관리**: `rw_cache`의 `stats` / `lookup` / `purge`(`confirm: true` 필요). 오프라인 모드는 `RECYCLEWHEEL_OFFLINE=1`.
- **파일 권한**: POSIX에서 캐시 디렉터리는 `0700`, DB 파일은 `0600`으로 만듭니다. 비공개 저장소의 메타데이터가 들어갈 수 있기 때문입니다(Windows에서는 무시).
- **응답 크기**: 업스트림 응답은 8MB까지만 읽습니다.
- 허용 호스트: `api.github.com`, `registry.npmjs.org`, `api.npmjs.org`, `pypi.org`, `api.deps.dev`, `registry.modelcontextprotocol.io`, `libraries.io`, `huggingface.co`. 그 밖의 호스트로는 요청하지 않습니다.

## 원격 공유 캐시 (선택, 기본 꺼짐)

팀이나 여러 에이전트가 공개 API 응답을 공유해 GitHub 호출을 줄이는 기능입니다. **켜지 않으면 아무것도 전송하지 않습니다.** 신뢰된 팀 서버를 전제로 하며, 공개 익명 서비스는 목표가 아닙니다.

서버:

```bash
export RECYCLEWHEEL_SERVER_WRITE_TOKEN="$(openssl rand -hex 32)"
node dist/cli.js cache-server --port 8787 --host 127.0.0.1 --db ./rw-server.db
```

서버 토큰(쓰기·읽기)은 **16자 이상**이어야 합니다. 더 짧으면 서버가 시작을 거부하고(우회용 환경변수는 없음) 메시지로 `openssl rand -hex 32` 같은 생성 방법을 안내합니다.

클라이언트(각 개발자):

```bash
RECYCLEWHEEL_REMOTE_CACHE_URL=https://cache.example.com
RECYCLEWHEEL_REMOTE_CACHE_MODE=readwrite      # off(기본) | read | readwrite
RECYCLEWHEEL_REMOTE_CACHE_TOKEN=<토큰>
```

프라이버시 요약:

- **보내는 것**: 키 해시(`sha256("rw1|" + 정규화한 URL)`), 정제된 공개 응답 본문, 출처 종류, 유효기간, etag/last-modified.
- **보내지 않는 것**: 원본 URL, 검색어 평문, 프로젝트명, 원장, GitHub 토큰, 요청 헤더. libraries.io 응답, 비공개로 확인되지 않은 GitHub 항목, 릴리스/기여자 응답은 업로드하지 않습니다.
- `mode=read`는 키 해시만 보내 조회하고, `readwrite`만 업로드합니다.
- **한계**: 해시 키는 평문 은닉이 아닙니다. 흔한 검색어나 유명 저장소 URL은 같은 방식으로 해시를 계산해 사전 대입으로 추측할 수 있습니다. 민감한 검색어를 쓴다면 켜지 마세요.
- 쓰기 토큰을 가진 사람은 캐시 내용을 바꿀 수 있어(캐시 오염), 원격 캐시에서 온 라이선스 정보에는 `license_from_remote_cache` 플래그가 붙습니다. 이 플래그가 있는 후보의 `adopt`/`extend`는 `rw_decide`가 `decided_by: "user"`(사용자 확인)일 때만 받아들이고, 에이전트 단독 결정은 오류입니다. 대안은 원격 캐시를 끄거나 오프라인으로 `rw_evaluate`를 다시 실행해 라이선스를 로컬에서 재평가하는 것입니다.
- 원격에서 받은 항목은 클라이언트가 다시 검증합니다. `fetched_at`은 현재 시각을 넘지 않게 자르고, `expires_at`은 `fetched_at` + 해당 요청 종류의 TTL 이하로 제한하며, 유효하지 않은 JSON이나 크기를 넘는 항목은 버립니다. `etag`/`last_modified`는 인쇄 가능한 ASCII 1~256자(`^[\x20-\x7e]{1,256}$`)만 허용합니다. 서버는 어긋난 값의 PUT을 400으로 거부하고, 클라이언트는 그런 항목을 버립니다.
- 서버 장애 시 1.5초 타임아웃과 circuit breaker로 조용히 업스트림을 사용합니다.
- 서버는 인증 실패가 IP당 분당 20회를 넘으면 `429` + `Retry-After`로 막습니다. IPv6는 /64 접두 단위로, IPv4-mapped IPv6(`::ffff:a.b.c.d`)는 해당 IPv4 주소로 집계합니다. 서버 전체의 인증 실패 상한(서버 옵션 `globalAuthFailLimitPerMin`, 기본 분당 600회, `0`이면 끔. CLI 플래그는 없음)을 넘으면 주소와 무관하게 인증에 실패한 요청이 `429`를 받습니다. 이 전역 상한은 실패 **응답의 수**를 제한할 뿐 토큰 추측 속도를 늦추지 않습니다(올바른 토큰은 상한과 무관하게 통과). 추측 방어는 토큰 길이(최소 16자)와 무작위성이 맡으므로 `openssl rand -hex 32` 같은 긴 임의 값을 쓰세요. `--trusted-hops <n>`(1–32, 기본 1)으로 리버스 프록시 단수를 지정합니다(`X-Forwarded-For`의 오른쪽에서 n번째 항목을 클라이언트 IP로 사용).
- **리버스 프록시가 필수입니다.** 서버를 loopback에 직접 노출하면 `X-Forwarded-For`를 돌려 IP별 제한을 피할 수 있습니다.
- `GET /v1/health`는 토큰 없이 `{ ok: true }`만 돌려주고, 유효한 읽기/쓰기 토큰을 보내면 `version`과 `entries`를 더합니다.

실행 옵션, 토큰, 리버스 프록시(Caddy) 예시, API, 정제 규칙, 트러스트 모델은 [docs/cache-server.md](docs/cache-server.md)에 있습니다.

## 보안과 신뢰 경계

- **서드파티 텍스트는 신뢰할 수 없는 데이터입니다.** 레포·패키지 설명, 레지스트리 설명, 웹 검색 결과는 공격자가 지시문을 심을 수 있습니다. 도구 결과의 Markdown에서는 이런 텍스트를 `<untrusted_third_party_data>` 블록으로 감싸고(블록 안에서 같은 태그는 무력화), 제로폭/bidi/제어문자는 어댑터에서 제거합니다. 서버 instructions와 `reuse_first_workflow` prompt, 스킬에도 같은 경고가 있습니다.
- **`structuredContent`는 감싸지 않습니다.** 정제는 어댑터 수준(제어문자 제거, 길이 제한)뿐이므로, 도구 결과를 프로그램으로 처리하는 클라이언트는 `description` 같은 서드파티 문자열을 신뢰하면 안 됩니다. 모델이나 셸, 파일 쓰기로 그대로 넘기지 마세요.
- **도구 출력 정제**: 원장이나 입력에서 온 동적 문자열(컴포넌트 이름·id, 사유, ref 등)은 도구 결과 텍스트에서 한 줄로 정제하고 Markdown/HTML 구문을 이스케이프합니다. 정제 전에 입력을 먼저 8KB로 잘라, 적대적으로 긴 입력이 와도 처리 시간이 입력 길이에 비례(선형)하도록 합니다. 오류 메시지에 나오는 id/ref도 코드 스팬으로 표시합니다. `rw_ledger`의 텍스트 content는 `markdown`/`notices`/`json` 모두 통째로 `<untrusted_third_party_data>`로 감쌉니다(`write_to`를 쓰면 텍스트에는 경로와 요약만 있습니다). `write_to`로 쓴 파일과 `structuredContent`는 원본 그대로입니다.
- **쓰기 범위**: 모든 도구의 `project_root`는 서버의 `RECYCLEWHEEL_PROJECT_ROOT` 안으로 제한되고 `.recyclewheel` 및 그 하위는 가리킬 수 없습니다. `rw_ledger`의 `write_to`(와 CLI `--out`)는 프로젝트 루트 안의 보이는 `.md`/`.json` 경로에만, 그것도 마커가 있는 기존 파일이나 새 파일에만 쓸 수 있습니다. `.recyclewheel` 안, dot 디렉터리·dot 파일(`.claude`, `.github` 등), `CLAUDE.md`/`AGENTS.md`/`SKILL.md` 같은 에이전트 지시 파일, `commands`/`agents`/`skills`/`hooks` 폴더, 링크를 통해 이들로 이어지는 경로, 별칭 경로, Windows 장치 이름은 거부합니다(전체 목록은 위 "원장 내보내기 쓰기 규칙"). `rw_cache purge`는 `confirm: true`가 필요합니다. 그래도 에이전트가 사용자가 요청하지 않은 결정을 기록하거나 파일을 쓰지 않는지는 사용자가 확인해야 합니다.
- **원장 로딩과 링크**: `component.id`는 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`여야 하고, 이름(name)과 ref에 제어·bidi·숨김 문자가 있으면 안 됩니다. 어긋난 원장 줄은 로딩 때 경고(`ledger line N skipped: ...`)와 함께 건너뜁니다. `.recyclewheel` 디렉터리나 `ledger.jsonl`이 심볼릭 링크/junction이거나 프로젝트 루트 밖으로 해석되면 모든 원장 도구가 거부하고, `rw_status`는 `ledger_exists:false`와 경고를, `doctor`는 `ledger_path` 점검 경고를 냅니다. `ledger.jsonl`이 하드링크(`nlink > 1`)여도 `has N hard links` 사유로 거부합니다. append는 경로가 아니라 실제로 연 파일 핸들(fd)을 검사해 일반 파일이고 이름이 하나인지 확인하며, POSIX에서는 열린 파일과 경로가 가리키는 파일의 dev/ino도 비교합니다.
- **원장 한도**: 한 줄이 256KB를 넘으면 로딩 때 `ledger line N skipped: too long`으로 건너뛰고(파싱하지 않음), 자유 텍스트 필드가 2000자, 증거 summary가 50KB를 넘는 이벤트도 로딩 때 건너뜁니다. 쓸 때는 같은 한도를 말줄임(`…`)으로 줄여 저장하고, 한 줄은 64KB 이하로 유지합니다. 원장 파일이 64MB를 넘으면 읽기를 거부하므로 오래된 이벤트를 보관하거나 정리하세요. 이벤트 배열 길이에는 스키마 상한이 없고 줄/파일 상한에만 의존합니다.
- **네트워크**: 허용 호스트 allowlist 밖으로는 요청하지 않습니다. 업스트림 응답은 8MB까지만 읽습니다. 원격 캐시 URL은 https 또는 loopback http만 허용하고(`RECYCLEWHEEL_ALLOW_INSECURE_REMOTE`로 해제 가능), 리다이렉트는 따르지 않습니다. 원격 캐시의 응답은 검증 후에만 쓰며, 라이선스 정보에는 `license_from_remote_cache`가 붙습니다.
- **ref 검증**: `github:`, `npm:`, `pypi:`, `mcp:` id에서 `.`/`..` 세그먼트와 `%`, `\`, `?`, `#`, 제어문자를 거부해 요청 경로 조작을 막습니다. `web:` ref는 http(s) URL이어야 하고 원문에 백슬래시, 대괄호, 소괄호, 꺾쇠, 백틱, 세로줄(<code>\ [ ] ( ) &lt; &gt; ` |</code>)이 없어야 합니다(Markdown 링크·표를 깨는 문자. `%5B` 같은 퍼센트 인코딩은 허용). ref id는 최대 1000자입니다.
- **비밀값**: 토큰은 Authorization 헤더 외에는 쓰이지 않습니다. 마스킹은 두 가지로 나뉩니다. (1) **값 기반**: 설정된 비밀값(`GITHUB_TOKEN`/`GH_TOKEN`, `LIBRARIES_IO_API_KEY`, 원격 캐시/서버 토큰; 8자 이상)을 `***`로 가립니다. 적용 범위는 stderr 로그, CLI의 오류와 경고, `doctor`/`status` 출력, config 경고, GitHub 어댑터 오류 문장입니다. config 경고는 잘못된 환경변수의 원시 값을 출력하지 않고 변수 이름만 보여줍니다. (2) **패턴 기반**: 그 밖의 도구 결과와 오류 전반에는 값 기반 마스킹이 없고 GitHub 토큰 패턴(`ghp_`, `github_pat_` 등)만 제거합니다. 패턴에 맞지 않는 비밀값이 도구 결과에 섞이면 가려지지 않을 수 있습니다.
- **파일 권한**: POSIX에서 원장 디렉터리 `0700`/파일 `0600`, 캐시 디렉터리 `0700`/DB `0600`. 원장에는 프로젝트 구조와 결정 근거가 들어가므로 커밋 전에 내용을 확인하세요.
- **알려진 잔여 위험**: 경로의 디렉터리 구성요소를 검사 직후 링크로 바꿔치는 경쟁은 이식 가능한 방식으로 닫을 수 없습니다(Windows에는 NOFOLLOW와 dev/ino 비교가 없음). `write_to`는 경로 검사와 실제 쓰기 사이에 짧은 창이 있습니다. 원장 이벤트의 배열 길이에는 스키마 상한이 없어 줄/파일 상한에만 의존합니다. npm/mcp 같은 `web:`이 아닌 ref에는 마크업 문자가 올 수 있어 출력 이스케이프로 처리합니다. `structuredContent`는 정제하지 않습니다. 서버를 loopback에 직접 노출하면 XFF 회전으로 IP별 제한을 피할 수 있습니다(리버스 프록시 필수). 캐시 서버의 전역 인증 실패 상한은 추측 속도를 늦추지 않아 토큰 길이가 유일한 방어입니다. 도구 결과에는 값 기반 마스킹이 없습니다. POSIX 권한 테스트는 Linux CI에서 처음 실행됩니다. 헤드리스 스킬 시나리오는 아직 실행하지 않았습니다. 자세한 내용은 [docs/PLAN.md §15.4](docs/PLAN.md)입니다.

## 한계

- **PyPI는 검색 API가 없습니다.** 이름 프로브(후보 이름으로 JSON API 조회)와 GitHub `language:Python` 검색에 의존하고, `LIBRARIES_IO_API_KEY`가 있으면 libraries.io 검색을 더합니다. 좋은 PyPI 패키지를 놓칠 수 있습니다.
- **`github_code`(코드 검색)는 GitHub 토큰이 필요합니다.** 토큰이 없으면 `unauthenticated`로 표시되고 Grep MCP 사용을 안내합니다. 비인증 저장소 검색은 분당 10회로 제한됩니다.
- **contributors 같은 일부 지표는 `missing`일 수 있습니다.** 기여자 수와 최신 릴리스는 `deep: true` 평가에서만 수집하며, 이 두 응답은 원격 공유 캐시로 공유되지 않으므로 원격 캐시 의존 환경에서는 비어 있는 경우가 많습니다. 값이 없다고 후보를 제외하지는 않고 기본 점수를 부여하며 `missing`/`metrics_partial`로 표시합니다.
- **키워드 검색 품질에는 한계가 있습니다.** 좋은 후보를 놓칠 수 있어 스킬이 쿼리를 바꾼 재검색과 웹 검색을 지시하지만, 완전한 탐색은 보장하지 않습니다.
- **법률 자문이 아닙니다.** 라이선스 판정은 SPDX 식과 단순화한 호환성 매트릭스에 기반한 보수적 휴리스틱입니다. 불확실하면 `unknown`으로 처리하며, adopt 전에 LICENSE 원문을 확인해야 합니다. 법적 효력이 필요한 결정은 전문가와 상의하세요.
- 스킬 행동 시나리오(`test/skill-scenarios/*.md`)를 헤드리스로 돌려 본 적은 아직 없어, 스킬의 발동 정확도는 실사용에서 확인해야 합니다. 정적 점검(`npm run lint:skill`)만 자동화되어 있습니다.
- 적합도(`fit`) 판단은 에이전트의 품질에 의존합니다. 점수는 결정의 근거를 구조화할 뿐 결정을 대신하지 않습니다.
- v0.1에서 하지 않는 것: MCP 서버 내부의 LLM/임베딩 검색, 서버 쪽 웹 검색, crates.io/Go/Maven/NuGet 어댑터, 취약점 스캔, 의존성 자동 설치, 원격 캐시의 프록시 모드. 자세한 목록은 [docs/PLAN.md §15](docs/PLAN.md)입니다.

## 트러블슈팅

- **레이트리밋**: `rw_status`의 `rate_limits`와 `rw_cache stats`로 확인합니다. `gh auth login` 또는 `GITHUB_TOKEN`을 설정하면 한도가 늘어납니다. 소진되면 캐시(stale 포함)를 대신 사용하고, 그것도 없으면 `rate_limited`와 재설정 시각, 수동 대안을 알려줍니다.
- **`node:sqlite` ExperimentalWarning**: 서버가 SQLite 경고만 stderr에서 걸러냅니다. 직접 `node`로 다른 스크립트에서 쓰는 경우에는 보일 수 있습니다. Node가 22.13보다 낮으면 `doctor`가 실패로 알려줍니다.
- **MCP 서버가 `connected`가 되지 않음**: `dist/cli.js`가 있는지(`npm run build`), `node dist/cli.js doctor`가 통과하는지 확인합니다. git URL로 설치한 경우 위 (a)의 `dist/` 주의 사항을 보세요.
- **Windows**: `node`를 직접 실행하므로 `npx`용 `cmd /c` 래퍼가 필요 없습니다. 경로에 공백이 있으면 따옴표로 감쌉니다.
- **원장 도구가 "Refusing to use the ledger"로 거부함**: `<프로젝트>/.recyclewheel` 또는 `ledger.jsonl`이 심볼릭 링크/junction이거나 프로젝트 루트 밖으로 해석되거나, `ledger.jsonl`이 하드링크입니다(`has N hard links`). `rw_status`(`ledger_exists:false`와 경고)와 `doctor`(`ledger_path`)가 같은 이유를 보여줍니다. 링크를 지우고 일반 디렉터리/파일로 되돌리세요. `ledger.jsonl`이 64MB를 넘어 읽기가 거부되는 경우에는 오래된 이벤트를 보관하거나 줄인 뒤 다시 시도합니다. 원장 줄이 `ledger line N skipped: ...` 경고와 함께 빠지면 그 줄의 `component.id` 형식이나 name/ref의 숨김 문자를 고칩니다.
- **원격 캐시 장애**: 서버가 죽어도 로컬 캐시와 업스트림으로 동작합니다. `doctor`와 `rw_status`가 `/v1/health` 도달 여부를 보여줍니다.

## 개발과 테스트

```bash
npm ci
npm run typecheck
npm test                 # 단위 테스트 (네트워크 없음)
npm run build            # dist/cli.js (의존성을 인라인한 단일 번들)
npm run test:smoke       # 빌드 후 실제 stdio MCP 스모크
npm run lint:skill       # SKILL.md 정적 점검
npm run check            # 위 전부
RECYCLEWHEEL_LIVE=1 npm run test:live   # 실제 공개 API 호출 (비인증, 최대 8회). 기본/CI에서는 실행하지 않음
node dist/cli.js doctor
```

**이 저장소를 직접 도그푸딩**하려면 `npm run build` 후 저장소 루트에서 `claude --mcp-config .mcp.dogfood.json`으로 실행합니다. 저장소 루트의 `.mcp.json`은 플러그인 루트로 자동 로드되어 서버가 이중 등록될 수 있어, 설정 파일 이름을 `.mcp.dogfood.json`으로 두었습니다. 이 저장소의 `docs/REUSE.md`와 `.recyclewheel/ledger.jsonl`이 그 결과물입니다. `docs/REUSE.md`는 내보내기 마커가 있는 파일이라 `rw_ledger`/CLI 내보내기로 다시 만들 수 있습니다(손으로 쓴 부록 A는 내보내기 뒤에 직접 다시 붙여야 합니다).

CI(`.github/workflows/ci.yml`)는 ubuntu/windows × Node 22.13.x/24.x에서 `npm ci` → typecheck → build → test (+ lint:skill, smoke)를 실행하고, 라이브 테스트는 수동 실행(workflow_dispatch의 `live` 옵션)으로만 돌립니다.

설계와 작업 분해는 [docs/PLAN.md](docs/PLAN.md)가 단일 진실 원천입니다. 계약(타입, 도구 스키마, 캐시 API)을 바꿔야 하면 먼저 그 문서를 고칩니다.

## 라이선스

MIT. [LICENSE](LICENSE).

`dist/cli.js`에 포함되는 서드파티 코드의 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.
