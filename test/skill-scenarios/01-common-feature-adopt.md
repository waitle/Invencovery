# 시나리오 01: 흔한 기능은 기존 라이브러리를 adopt한다

- 검증 대상: SKILL.md Step 0~9 전체 경로(정상 경로), 스킬 발동(트리거).
- 기대 결과 요약: 새 CLI 요청에서 스킬이 발동하고, 일반적인 하위 기능은 `adopt`(또는 `extend`)로 결정되며, 원장에 근거가 남는다.

## 준비

1. 임시 디렉터리 `<tmp-project>`를 만든다. 내용: `package.json`(`name`, `license: "MIT"`, `dependencies`는 비어 있음), `LICENSE`(MIT). 소스 파일은 없다.
2. 환경: 네트워크 가능, `RECYCLEWHEEL_CACHE_DIR=<tmp-cache>`(캐시 격리). `GITHUB_TOKEN`은 있어도 없어도 된다.
3. recyclewheel 플러그인(MCP + 스킬)이 연결되어 있다.

## 입력 프롬프트

```
Markdown 파일을 PDF로 변환하는 CLI 도구를 새로 만들어줘. 입력 파일 경로와 출력 경로를 인자로 받고, 코드 블록과 표가 깨지지 않아야 해.
```

## 실행

`<tmp-project>`를 cwd로 하고 headless로 실행한다. 정확한 플래그는 실행 시점의 Claude Code 문서로 확인한다.

```
claude -p "<위 프롬프트>" --plugin-dir <recyclewheel-repo> --output-format stream-json --verbose
```

## 기대 행동 (순서 포함)

- [ ] 코드 작성 전에 `recyclewheel` 스킬이 로드된다.
- [ ] 첫 `rw_*` 호출이 `rw_status`다.
- [ ] `package.json`을 읽는다(Step 1). 내부 재사용 후보가 없다고 판단한다.
- [ ] `rw_decompose`가 호출되고 컴포넌트가 3~10개다. 예: Markdown 파싱, PDF 렌더링, CLI 인자 처리, 파일 입출력. 파일 입출력처럼 표준 라이브러리로 되는 것은 `trivial: true`다. `project.license`는 `MIT`다.
- [ ] trivial이 아닌 컴포넌트마다 `rw_search`가 1회 이상 호출된다(컴포넌트당 3회 이하).
- [ ] `rw_evaluate`가 컴포넌트당 5개 이하 후보로 호출되고, 후보마다 `fit_reason`이 10자 이상이다.
- [ ] 변환 핵심 기능(Markdown to PDF)은 `adopt` 또는 `extend`로 결정된다. `build`가 아니다.
- [ ] adopt 후보의 `flags`에 `license_unknown`, `no_license`, `license_from_remote_cache`, `metrics_partial`이 있었다면 LICENSE 확인 증거(`rw_record_evidence`의 `kind: 'manual'`)가 먼저 남는다.
- [ ] 새 런타임 의존성이 생기므로 Reuse Report가 제시된다(Step 6). 비대화형이므로 `docs/REUSE.md`에 저장하거나 최종 응답에 포함한다.
- [ ] `package.json`에 adopt한 패키지가 설치되고 버전이 고정된다.
- [ ] 최종 응답에 Reuse Report 표가 있고, "검색했다"는 진술마다 `evidence_id`가 붙는다.

## 원장 확인

```
node -e "for (const l of require('fs').readFileSync('.recyclewheel/ledger.jsonl','utf8').trim().split('\n')) { const e=JSON.parse(l); console.log(e.type, JSON.stringify(e.decision||e.component||e.evidence||e.evaluation||e.project).slice(0,160)) }"
```

- [ ] 이벤트 순서가 `project.set` → `component.upsert`(여러 개) → `evidence.add`(`kind: 'search'`) → `evaluation.add` → `decision.add`다.
- [ ] 모든 non-trivial 컴포넌트에 `decision.add`가 있다.
- [ ] `adopt`/`extend` 결정의 `ref`에 대응하는 `evaluation.add`가 있다.
- [ ] 변환 핵심 컴포넌트의 `decision`이 `adopt` 또는 `extend`이고 `license`가 `compatible`이다.
- [ ] 각 결정의 `evidence_ids`가 비어 있지 않고 실제 존재하는 evidence id를 가리킨다.
- [ ] 결정마다 `alternatives`가 있고 `why_not`이 비어 있지 않다(후보가 2개 이상이었던 컴포넌트).

## 실패 판정 (하나라도 해당하면 실패)

- `rw_decompose` 이전에 구현 코드(변환 로직)를 작성하기 시작했다.
- 변환 핵심 컴포넌트를 `build`로 결정했다. (검색 결과에 fit ≥ 4 후보가 있었다면 명백한 실패이고, 없었다면 시나리오 07의 기준으로 재판정한다.)
- `override`가 사용됐다.
- 한 컴포넌트에서 `rw_search`가 7회 이상 호출됐다(hard limit 초과). 또는 `force`가 쓰였다.
- 최종 응답에 `evidence_id` 없는 검색 주장이 있다.
- 원장 파일이 생성되지 않았다.
