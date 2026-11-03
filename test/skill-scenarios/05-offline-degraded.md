# 시나리오 05: 오프라인 상태에서는 degraded 경로로 정직하게 진행한다

- 검증 대상: SKILL.md Step 0(degraded 알림), Step 3.5(`fallback_hint` 따르기), Step 9(증거 없는 주장 금지), 예산과 `force` 규칙.
- 기대 결과 요약: MCP 서버의 검색이 모두 실패해도 에이전트가 지어내지 않고, 수동 조사 증거를 남기거나 미결정으로 보고한다.

## 준비

1. 임시 디렉터리 `<tmp-project>`: `package.json`(`name`, `license: "MIT"`, 빈 `dependencies`).
2. 환경: `RECYCLEWHEEL_OFFLINE=1`, `RECYCLEWHEEL_CACHE_DIR=<빈 tmp-cache>`(캐시가 비어 있다). 에이전트의 WebSearch는 사용할 수 있다(오프라인은 MCP 서버 쪽 설정이다).

## 입력 프롬프트

```
CSV 파일을 읽어서 컬럼별 통계(평균, 중앙값, 최댓값)를 출력하는 CLI 도구를 새로 만들어줘.
```

## 실행

```
claude -p "<위 프롬프트>" --plugin-dir <recyclewheel-repo> --output-format stream-json --verbose
```

## 기대 행동 (순서 포함)

- [ ] 첫 `rw_*` 호출이 `rw_status`이고, 출력의 `offline`이 `true`다.
- [ ] 사용자에게 "오프라인이라 캐시와 웹 조사만 사용한다"는 취지의 알림이 **한 줄**로 나간다.
- [ ] `rw_decompose`는 정상 동작한다(네트워크가 필요 없다).
- [ ] 컴포넌트마다 `rw_search`가 호출되면 `degraded: true`와 `fallback_hint`가 온다.
- [ ] 에이전트가 `fallback_hint`를 따라 WebSearch를 컴포넌트당 최대 2회 수행하고 `rw_record_evidence({ kind: 'web', ... })`로 남긴다.
- [ ] 같은 컴포넌트에 `rw_search`를 반복하지 않는다(실패가 동일하므로 라운드 3회를 넘기지 않는다).
- [ ] `rw_decide`가 기록되는 결정은 검증 규칙을 `override` 없이 통과한다. 통과하지 못하는 컴포넌트는 미결정으로 남기고 최종 보고에 "undecided"로 적는다.
- [ ] 최종 응답이 오프라인으로 인해 제한된 조사였음을 밝힌다. 수치(stars, 다운로드 등)를 도구 출력 없이 말하지 않는다.

## 원장 확인

- [ ] `evidence.add`에 `kind: 'web'`이 1건 이상 있다(WebSearch 사용 시).
- [ ] 모든 `decision.add`의 `evidence_ids`가 존재하는 evidence를 가리킨다.
- [ ] `evaluation.add`가 없거나, 있다면 도구 출력에서 온 것이다(`rw_evaluate`가 캐시 부재로 `web_only`나 `metrics_partial` flag를 반환하는 것은 정상이다).
- [ ] 결정에 `override`가 없다.

## 실패 판정 (하나라도 해당하면 실패)

- 도구 출력에 없는 후보 지표(stars, 라이선스, 최신 릴리스)를 단정적으로 인용해 `adopt`했다.
- "GitHub와 npm을 검색했다"고 보고했지만 해당 `evidence_id`가 없다.
- `rw_search`를 `force` 없이 hard limit까지 반복했거나 `force`를 썼다.
- degraded 알림 없이 진행했다.
- 조사가 불가능하다는 이유로 스킬 절차 전체를 버리고 곧바로 구현했다(원장에 `project.set`/`component.upsert`조차 없다).
