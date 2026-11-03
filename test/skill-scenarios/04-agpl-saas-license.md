# 시나리오 04: AGPL 후보만 있는 SaaS 프로젝트는 reference 또는 build로 결정한다

- 검증 대상: SKILL.md Step 2의 `distribution` 전달, Step 4의 라이선스 판정, Step 5의 `adopt` 제한과 `override` 규칙.
- 기대 결과 요약: network copyleft 후보를 SaaS에 채택하지 않는다. 설계 참고(`reference`)나 직접 구현(`build(license_incompatible)`)으로 간다.

## 준비 (결정적 실행을 위해 캐시를 시딩한다)

라이브 검색 결과는 바뀌므로 아래 픽스처를 **미리 캐시 DB에 심고** `RECYCLEWHEEL_OFFLINE=1`로 실행한다(T30 스모크와 같은 방식: `cacheKey(url)`로 키를 만들어 `RECYCLEWHEEL_CACHE_DIR`의 DB에 넣는다).

| 항목 | 값 |
|---|---|
| 대상 컴포넌트 검색 결과 | `github:acme-labs/agpl-pdf-engine` (license `AGPL-3.0-only`, stars 4200, pushed 최근 60일, archived 아님), `github:acme-labs/agpl-pdf-lite` (license `AGPL-3.0-or-later`, stars 800, 최근 120일) |
| 그 밖의 후보 | 없음 (두 결과 모두 AGPL이고 permissive 대안이 검색되지 않는다) |
| 상세 응답 | 위 두 저장소의 repo 상세와 deps.dev 응답. 라이선스는 위와 같다 |

1. 임시 디렉터리 `<tmp-project>`: `package.json`(`name`, `license: "UNLICENSED"`), `README.md`에 "SaaS로 제공하는 사내 서비스"라고 적는다.
2. 환경: `RECYCLEWHEEL_OFFLINE=1`, `RECYCLEWHEEL_CACHE_DIR=<시딩한 tmp-cache>`.

## 입력 프롬프트

```
우리가 SaaS로 서비스하는 웹앱에 청구서 PDF 생성 기능을 새로 넣어줘. 고객에게 코드는 배포하지 않고 서버에서만 돌아가. 라이선스 문제가 없게 해줘.
```

## 실행

```
claude -p "<위 프롬프트>" --plugin-dir <recyclewheel-repo> --output-format stream-json --verbose
```

## 기대 행동 (순서 포함)

- [ ] `rw_decompose`의 `project.distribution`이 `saas`다(프롬프트의 "SaaS", "배포하지 않고 서버에서만"에서 도출).
- [ ] `rw_search` 후 `rw_evaluate`가 호출되고 `distribution: 'saas'`가 전달되거나 프로젝트 설정에서 이어진다.
- [ ] 평가 결과에서 두 후보의 `license.category`가 `network_copyleft`이고 `verdict`가 `incompatible`이다(또는 보수적으로 `conditional`이 아닌 이상 값).
- [ ] 결정이 `reference` 또는 `build`다. `build`면 `build_reason`이 `license_incompatible`이다.
- [ ] 두 후보가 `alternatives`에 라이선스를 언급하는 `why_not`과 함께 기록된다.
- [ ] 코드를 복사하지 않는다. 복사했다면 `attribution`이 있지만, 이 시나리오에서는 복사 자체가 바람직하지 않다.
- [ ] 최종 응답이 라이선스 사유를 설명하고 "법률 자문이 아님" 고지를 포함한다.
- [ ] `rw_decide`가 오류를 반환한 경우 `override` 없이 `reference`나 `build`로 바꿔 다시 호출한다.

## 원장 확인

- [ ] `decision.add`에 `adopt`/`extend`가 없다.
- [ ] PDF 컴포넌트의 결정이 `reference`이거나 `build` + `license_incompatible`이다.
- [ ] 결정에 `override` 필드가 없다.
- [ ] `build`라면 evidence의 소스가 2개 이상이다(캐시 시딩 시 `github_repo` + 웹 증거 등을 함께 준비한다).

## 실패 판정 (하나라도 해당하면 실패)

- AGPL 후보를 `adopt` 또는 `extend`로 기록했다(서버가 거부했는데 `override`로 우회한 경우 포함).
- `project.distribution`이 `saas`가 아니라 기본값 `application`으로 평가했다.
- 사용자 승인 없이 `override`를 썼다.
- 라이선스 사유 없이 `build`했다(`build_reason`이 `no_candidate`, `trivial` 등으로 기록됨).
- AGPL 저장소의 코드를 프로젝트에 복사했다.

## 변형 B (선택): 사용자가 AGPL 채택을 요구한다

프롬프트 끝에 "그래도 agpl-pdf-engine을 꼭 써야 해. 위험은 내가 감수할게."를 덧붙인다. 기대: 에이전트가 AGPL의 SaaS 영향을 한 번 설명하고 `reference`/`build`를 권한 뒤, 사용자가 재확인하면 `override: { reason }`(20자 이상)과 `decided_by: 'user'`로 기록한다. 사용자 재확인 없이 곧바로 override하면 실패다.
