# 시나리오 06: 이미 의존성에 있는 라이브러리로 해결한다 (내부 adopt)

- 검증 대상: SKILL.md Step 1(내부 재사용 먼저), 검색 생략 규칙, 내부 모듈의 "Internal reuse" 보고.
- 기대 결과 요약: 이미 설치된 패키지를 새로 검색하지 않고 평가 후 adopt하며, 같은 역할의 두 번째 라이브러리를 추가하지 않는다.

## 준비

1. 임시 디렉터리 `<tmp-project>`에 작은 CLI 프로젝트를 만든다.
   - `package.json`: `dependencies`에 `commander`와 `papaparse`(버전은 설치 시점의 최신 안정판), `license: "MIT"`.
   - `src/cli.js`: `commander`로 `hello` 서브커맨드 하나를 등록한 약 20줄.
   - `src/lib/fs-utils.js`: `readTextFile(path)`와 `writeTextFile(path, text)`를 export하는 약 15줄.
   - `npm install`을 실행해 `node_modules`를 만든다.
2. 환경: 네트워크 가능, `RECYCLEWHEEL_CACHE_DIR=<tmp-cache>`.

## 입력 프롬프트

```
이 CLI에 CSV 파일을 읽어서 JSON 파일로 변환하는 `convert` 서브커맨드를 추가해줘. 입력 경로와 출력 경로를 옵션으로 받고, 헤더 행을 키로 써서 객체 배열로 만들어줘.
```

## 실행

```
claude -p "<위 프롬프트>" --plugin-dir <recyclewheel-repo> --output-format stream-json --verbose
```

## 기대 행동 (순서 포함)

- [ ] `rw_status` 이후 `package.json`을 읽는다(Step 1). 이 읽기가 `rw_decompose`보다 먼저다.
- [ ] 컴포넌트 목록에 CSV 파싱이 있고, 에이전트가 이미 `papaparse`가 설치되어 있음을 언급한다.
- [ ] CSV 파싱 컴포넌트에 대해 `rw_search`가 호출되지 않는다(0회).
- [ ] `rw_evaluate`가 `npm:papaparse` 하나로 호출되고 fit이 4 이상이다.
- [ ] `rw_decide`가 `adopt`, `ref: 'npm:papaparse'`이고 `rationale`에 "package.json에 이미 있음"과 같은 취지의 내부 근거가 있다.
- [ ] CLI 서브커맨드 등록은 기존 `commander`를 쓴다. 새 CLI 인자 파싱 라이브러리를 추가하지 않는다.
- [ ] `src/lib/fs-utils.js`를 재사용하고, 이를 컴포넌트로 만들지 않으며 최종 보고의 "Internal reuse"에 경로를 적는다.
- [ ] 최종 diff에서 `package.json`의 `dependencies`에 새 항목이 추가되지 않는다.

## 원장 확인

```
node -e "for (const l of require('fs').readFileSync('.recyclewheel/ledger.jsonl','utf8').trim().split('\n')) { const e=JSON.parse(l); console.log(e.type, JSON.stringify(e.decision||e.component||e.evidence||e.evaluation||e.project).slice(0,160)) }"
```

- [ ] CSV 컴포넌트에 `kind: 'search'`인 `evidence.add`가 없다.
- [ ] 같은 컴포넌트에 `evaluation.add`(ref `npm:papaparse`)와 `decision.add`(`adopt`)가 있다.
- [ ] `adopt` 결정의 `license`가 `compatible`이다(MIT).
- [ ] `fs-utils`에 해당하는 컴포넌트나 결정이 원장에 없다.

## 실패 판정 (하나라도 해당하면 실패)

- 이미 있는 CSV 라이브러리를 두고 다른 CSV 라이브러리(`csv-parse` 등)를 검색해 추가했다.
- CSV 파서를 직접 구현했다(`build`).
- `package.json`을 읽기 전에 외부 검색을 시작했다.
- `rw_evaluate` 없이 `rw_decide(adopt)`를 호출했다(서버가 거부하지만 시도 자체가 절차 위반이다).
- `src/lib/fs-utils.js`와 같은 기능의 새 모듈을 만들었다.
