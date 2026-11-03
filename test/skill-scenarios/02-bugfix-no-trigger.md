# 시나리오 02: 버그 수정과 작은 수정에서는 발동하지 않는다

- 검증 대상: SKILL.md `description`의 비적용 범위, "적용 범위" 절. PLAN §13.5의 트리거 정확도 점검이다.
- 기대 결과 요약: 버그 수정, 리팩터링, 오타 수정 요청에서 스킬이 로드되지 않고 `rw_*` 도구가 호출되지 않는다.

## 준비

1. 임시 디렉터리 `<tmp-project>`에 작은 Node 프로젝트를 만든다.
   - `package.json`(`name`만 있음)
   - `src/date.js`: `formatDate(d)`가 `YYYY-MM-DD`를 반환하되, 2월 29일을 `02-28`로 잘못 출력하는 결함이 있다(약 20줄).
   - `src/slug.js`: 약 15줄의 `slugify(text)`.
   - `README.md`: 오타 한 곳(`recieve`).
2. 환경: 네트워크 가능, `RECYCLEWHEEL_CACHE_DIR=<tmp-cache>`. recyclewheel 플러그인이 연결되어 있다.

## 입력 프롬프트 (각각 별도 세션으로 3회 실행)

```
A. src/date.js의 formatDate가 윤년의 2월 29일을 02-28로 출력해. 버그를 고쳐줘.
B. src/slug.js의 slugify 함수를 읽기 좋게 리팩터링해줘. 동작은 바꾸지 마.
C. README.md의 오타 recieve를 receive로 고쳐줘.
```

## 실행

```
claude -p "<프롬프트>" --plugin-dir <recyclewheel-repo> --output-format stream-json --verbose
```

## 기대 행동

- [ ] A, B, C 모두 `recyclewheel` 스킬이 로드되지 않는다(`Skill` tool_use 이벤트에 `recyclewheel`이 없다).
- [ ] `rw_status`를 포함해 `rw_*` 도구가 한 번도 호출되지 않는다.
- [ ] A는 `src/date.js`만, B는 `src/slug.js`만, C는 `README.md`만 수정한다.
- [ ] 라이브러리 도입(예: date-fns 설치 제안)이 없다.

## 원장 확인

```
ls <tmp-project>/.recyclewheel
```

- [ ] `.recyclewheel/` 디렉터리가 존재하지 않는다(원장이 생성되지 않았다).
- [ ] 스트림 출력에서 `"name":"rw_` 문자열이 0건이다: `grep -c '"name":"rw_' <stream.jsonl>` → `0`.

## 실패 판정 (하나라도 해당하면 실패)

- 세 입력 중 하나라도 스킬이 로드되거나 `rw_*` 도구가 호출됐다. 이 경우 `description`의 비적용 문구와 "적용 범위" 절을 보강하고 재실행한다.
- `.recyclewheel/` 디렉터리가 생겼다.
- A에서 "날짜 라이브러리로 교체"를 제안하며 의존성을 추가했다(범위 초과).
