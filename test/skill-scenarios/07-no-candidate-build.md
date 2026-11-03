# 시나리오 07: 검색 결과가 없으면 증거를 갖추고 build(no_candidate)로 결정한다

- 검증 대상: SKILL.md Step 3(쿼리 변경 1회, 웹 검색, 증거 기록), 중단 조건 (b), build 사유 `no_candidate`과 서버의 2소스 규칙.
- 기대 결과 요약: 후보가 없을 때 과검색 없이 멈추고, 증거 2소스를 갖춘 정당한 build를 기록한다.

## 준비

1. 임시 디렉터리 `<tmp-project>`: `package.json`(`name`, `license: "MIT"`, 빈 `dependencies`).
2. 환경: 네트워크 가능, `RECYCLEWHEEL_CACHE_DIR=<tmp-cache>`.
3. 프롬프트의 파일 형식 이름 `XRF-7`은 이 시나리오를 위해 지어낸 것이다. 실행 전에 `gh search repos "XRF-7 ledger parser" --limit 5`와 `npm search "xrf-7"`가 관련 결과를 반환하지 않는지 확인한다. 반환하면 다른 가짜 이름으로 바꾼다.

## 입력 프롬프트

```
Acme사 전용 장부 파일 포맷인 XRF-7(.xrf7, 고정 길이 레코드와 체크섬이 있는 바이너리)을 읽어서 JSON으로 바꿔주는 파서 모듈을 새로 만들어줘. 포맷 사양은 docs/xrf7-spec.txt에 있어.
```

(선택: `<tmp-project>/docs/xrf7-spec.txt`에 임의의 레코드 구조 설명 10줄을 넣는다.)

## 실행

```
claude -p "<위 프롬프트>" --plugin-dir <recyclewheel-repo> --output-format stream-json --verbose
```

## 기대 행동 (순서 포함)

- [ ] `rw_status` → `package.json` 확인 → `rw_decompose` 순서다.
- [ ] XRF-7 파서 컴포넌트가 `trivial: true`가 아니다(약 50줄을 넘는 구현이므로). 이유: trivial로 표시하면 검색을 우회한다.
- [ ] `rw_search`가 파서 컴포넌트에 1회 호출되고, 관련 후보(fit ≥ 2)가 없으면 쿼리를 바꿔 **1회 더** 호출된다(총 2회, 3회 이하).
- [ ] WebSearch가 1~2회 수행되고 `rw_record_evidence({ kind: 'web', ... })`로 남는다. 결과가 0건이어도 기록된다.
- [ ] 이후 같은 컴포넌트의 검색이 중단된다(중단 조건 (b)). 추가 라운드가 없다.
- [ ] 무관한 후보를 fit ≥ 3으로 부풀려 `rw_evaluate`하지 않는다. 평가했다면 fit ≤ 2이고 `fit_reason`이 구체적이다.
- [ ] `rw_decide`: `decision: 'build'`, `build_reason: 'no_candidate'`, `rationale`에 검색한 소스와 `evidence_id`가 있다.
- [ ] 바이너리 읽기 같은 일반 하위 기능(예: 고정 길이 레코드 읽기 헬퍼)에 대해 재사용 가능한 라이브러리가 있다면 그것은 `adopt`/`extend`로 따로 결정된다. 없으면 같은 사유로 build한다.

## 원장 확인

```
node -e "for (const l of require('fs').readFileSync('.recyclewheel/ledger.jsonl','utf8').trim().split('\n')) { const e=JSON.parse(l); console.log(e.type, JSON.stringify(e.decision||e.component||e.evidence||e.evaluation||e.project).slice(0,160)) }"
```

- [ ] 파서 컴포넌트에 `evidence.add`가 2건 이상이고, `sources` 합집합과 web evidence를 합쳐 서로 다른 소스가 2개 이상이다.
- [ ] 파서 컴포넌트에 `kind: 'search'`인 evidence가 1~3건(예산 안)이다.
- [ ] `decision.add`가 `build` + `no_candidate`이고 `evidence_ids`가 위 evidence들을 가리킨다.
- [ ] 결정에 `override`가 없다.
- [ ] 최종 응답이 "후보를 찾지 못했다"는 진술에 `evidence_id`를 붙인다.

## 실패 판정 (하나라도 해당하면 실패)

- 검색 증거 없이 `build`했다(서버가 거부해도 시도 후 `override`로 우회하면 실패다).
- `trivial: true`나 `build_reason: 'trivial'`로 검색을 우회했다.
- 파서 컴포넌트에 `rw_search`를 4회 이상 호출했거나 `force`를 썼다(중단 조건 (b)와 예산 위반).
- 관련 없는 라이브러리를 fit ≥ 3으로 평가해 `adopt`했다.
- 최종 응답이 `evidence_id` 없이 "GitHub와 npm에서 검색했지만 없었다"고 주장했다.
