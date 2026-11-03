# 시나리오 03: 제품의 핵심 차별점은 검색 후 build(core_differentiator)로 결정한다

- 검증 대상: SKILL.md Step 3 검색 의무, Step 5 build 사유 `core_differentiator`, 일반 부품은 재사용하는지.
- 기대 결과 요약: 핵심 규칙 엔진은 근거를 들어 직접 구현하되, 검색 없이 곧바로 build하지 않는다. 주변의 일반 기능은 재사용한다.

## 준비

1. 임시 디렉터리 `<tmp-project>`: `package.json`(`name`, `license: "UNLICENSED"`, 빈 `dependencies`). 소스 없음.
2. 환경: 네트워크 가능, `RECYCLEWHEEL_CACHE_DIR=<tmp-cache>`.

## 입력 프롬프트

```
우리 회사 고유의 가격 규칙 엔진을 새로 만들어줘. 고객 등급, 계약 조건, 시즌 프로모션이 우리만의 우선순위 규칙으로 조합되어 최종 단가가 정해져. 이 계산 방식이 우리 제품의 핵심 차별점이야. 규칙은 JSON 파일로 읽어 들이고, 결과는 HTTP API로 제공해야 해.
```

## 실행

```
claude -p "<위 프롬프트>" --plugin-dir <recyclewheel-repo> --output-format stream-json --verbose
```

## 기대 행동 (순서 포함)

- [ ] `rw_status` → 내부 재사용 확인 → `rw_decompose` 순서로 진행한다.
- [ ] 컴포넌트가 최소 3개로 나뉜다. 예: 가격 규칙 평가 엔진(핵심), 규칙 JSON 스키마 검증, HTTP API 서버.
- [ ] 핵심 컴포넌트에도 `rw_search`가 1회 이상 호출된다. 이유: 서버는 trivial이 아닌 build에 서로 다른 소스 2개 이상의 증거를 요구하고, 스킬은 결정 전에 대체재를 확인하라고 한다.
- [ ] 핵심 컴포넌트가 `build` + `build_reason: 'core_differentiator'`로 결정된다. `rationale`이 사용자의 "핵심 차별점" 진술을 근거로 인용한다.
- [ ] 평가한 일반 규칙 엔진 후보가 있으면 그 후보들이 `alternatives`에 `why_not`과 함께 기록된다.
- [ ] 스키마 검증과 HTTP API 서버 컴포넌트는 `build`가 아니라 `adopt` 또는 `extend`로 결정된다(또는 후보가 정말 없었다면 `no_candidate`와 증거 2소스).
- [ ] 핵심 컴포넌트 결정에 `override`가 없다.

## 원장 확인

```
node -e "for (const l of require('fs').readFileSync('.recyclewheel/ledger.jsonl','utf8').trim().split('\n')) { const e=JSON.parse(l); console.log(e.type, JSON.stringify(e.decision||e.component||e.evidence||e.evaluation||e.project).slice(0,160)) }"
```

- [ ] `decision.add` 중 `decision: 'build'`이고 `build_reason: 'core_differentiator'`인 항목이 정확히 핵심 컴포넌트에 있다.
- [ ] 그 컴포넌트의 `evidence.add`가 존재하고, `sources`의 합집합(+ web/code_search evidence)이 서로 다른 소스 2개 이상이다.
- [ ] `build`가 아닌 결정이 최소 1개 있다(주변 기능 재사용).
- [ ] 핵심 결정의 `rationale`에 사용자 진술(차별점, 고유 규칙 등)이 들어 있다.

## 실패 판정 (하나라도 해당하면 실패)

- 핵심 컴포넌트에 검색 증거가 없다(검색 없이 build했다).
- 모든 컴포넌트를 `build`로 결정했다(주변 일반 기능까지 직접 구현).
- `build_reason`이 `core_differentiator`가 아닌 다른 값이면서 그 값의 성립 조건(SKILL.md 표)을 만족하지 않는다. 예: `trivial`로 우회.
- `rationale`이 "직접 만드는 게 더 간단해서"처럼 7가지 사유에 없는 이유다.
- `override`가 사용됐다.
