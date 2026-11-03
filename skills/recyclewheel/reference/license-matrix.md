# 라이선스 호환성 매트릭스

> **이 문서와 `rw_evaluate`의 라이선스 판정은 법률 자문이 아니다 (Not legal advice).**
> 후보 라이선스를 빠르게 걸러내기 위한 보수적 분류 도구일 뿐이다. 불확실하면 `unknown`/`conditional`로 판정한다.
> `adopt` 전에는 LICENSE 원문을 직접 확인하고, 배포나 상용 사용이 걸린 결정은 법무 검토를 받는다.

코드 원본은 `src/core/license.ts`의 `LICENSE_MATRIX`와 `CATEGORY_MEMBERS`이다. 이 문서의 표와 목록은 단위 테스트가
코드와 일치하는지 검사한다.

## 1. 판정 흐름

1. 후보 라이선스를 SPDX 식으로 파싱하고 정규화한다 (`MIT or Apache-2.0` → `MIT OR Apache-2.0`, `mit` → `MIT`).
2. 후보 분류(category) 6종 중 하나를 정한다 (아래 2장).
3. 매트릭스(3장)에서 배포 형태에 해당하는 칸을 찾아 verdict를 정한다.
4. 일부 칸은 프로젝트 라이선스에 따라 `compatible`/`incompatible`로 갈린다 (4장).
5. obligations(지켜야 할 의무)와 notes(주의)를 붙인다. notes에는 항상 `Not legal advice`가 들어간다.

## 2. 후보 분류 (category)

| category | 라이선스 |
|---|---|
| permissive | `MIT`, `MIT-0`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, `ISC`, `0BSD`, `Unlicense`, `CC0-1.0`, `Zlib`, `BSL-1.0`, `Python-2.0`, `BlueOak-1.0.0`, `PSF-2.0` |
| weak_copyleft | `LGPL-2.0*`, `LGPL-2.1*`, `LGPL-3.0*`, `MPL-2.0`, `EPL-2.0`, `MPL-1.1`, `EPL-1.0`, `CDDL-1.0`, `CDDL-1.1` |
| strong_copyleft | `GPL-2.0*`, `GPL-3.0*` |
| network_copyleft | `AGPL-3.0*` |
| non_oss | `SSPL-1.0`, `BUSL-1.1`, `Elastic-2.0`, `Commons-Clause`, `CC-BY-NC-*` |
| unknown | 위 목록에 없는 id, `LicenseRef-*`, 빈 값, `NONE`, `NOASSERTION`, SPDX 식이 아닌 문자열 |

- `*`는 `-only`, `-or-later`, `+` 같은 접미사를 모두 포함한다.
- `Commons-Clause`는 SPDX id가 아니므로, SPDX 파싱에 실패한 문자열에 `Commons Clause`가 들어 있으면 non_oss로 본다.
- 표에 없는 라이선스는 `unknown`이다. permissive로 추정하지 않는다.

## 3. 매트릭스 (행 = 후보 분류, 열 = 배포 형태)

`library`와 `application`은 같은 열을 쓴다.

| Candidate category | internal | library / application | saas |
|---|---|---|---|
| permissive | compatible | compatible | compatible |
| weak_copyleft | compatible | conditional | conditional |
| strong_copyleft | conditional | compatible if project is a compatible GPL, else incompatible | conditional |
| network_copyleft | conditional | compatible if project is AGPL, else incompatible | compatible if project is AGPL, else incompatible |
| non_oss | conditional | incompatible | incompatible |
| unknown | unknown | unknown | unknown |

칸의 의미

- **permissive / library·application**: `Apache-2.0` 후보를 `GPL-2.0-only`(`GPL-2.0`, `GPL-2.0-only`) 프로젝트에서 쓰면 `incompatible`이다.
  `GPL-2.0-or-later`, `GPL-3.0` 프로젝트는 문제없다.
- **weak_copyleft / library·application, saas**: `conditional`. 수정 없이 동적 링크로 쓰고, 수정한 파일은 같은 라이선스로 공개한다.
- **strong_copyleft / internal**: `conditional`. 조직 밖으로 배포하는 순간 의무가 생긴다.
- **strong_copyleft / saas**: `conditional`. GPL에는 네트워크 조항이 없어 SaaS 제공만으로는 소스 공개 의무가 없지만, 바이너리 배포나
  온프레미스 납품은 배포이다.
- **network_copyleft / internal**: `conditional`. AGPL 13조는 네트워크로 상호작용하는 사용자에게 적용되므로 내부 사용자도 포함될 수 있다.
- **non_oss / internal**: `conditional` (법무 검토). 소스 공개형(source-available)이나 비상업 조건이 있다.

## 4. 프로젝트 라이선스에 따른 판정

### strong_copyleft 후보 (library / application)

| 후보 | compatible인 프로젝트 라이선스 |
|---|---|
| `GPL-2.0-only` (`GPL-2.0`) | `GPL-2.0-only`, `GPL-2.0-or-later` |
| `GPL-2.0-or-later` (`GPL-2.0+`) | `GPL-2.0-*`, `GPL-3.0-*`, `AGPL-3.0-*` |
| `GPL-3.0-only`, `GPL-3.0-or-later` | `GPL-3.0-*`, `AGPL-3.0-*`, `GPL-2.0-or-later` |

- `GPL-2.0-only`와 `GPL-3.0`(AGPL-3.0 포함)은 서로 `incompatible`이다.
- LGPL, 허용형(MIT, Apache-2.0 등), 상용/비공개 프로젝트는 모두 `incompatible`이다. 결합 저작물 전체가 GPL 조건을 따라야 하기 때문이다.

### network_copyleft 후보 (library / application, saas)

- 프로젝트가 `AGPL-3.0*`이면 `compatible`, 아니면 `incompatible`이다.
- `GPL-3.0` 프로젝트는 GPL-3.0 13조에 따라 AGPL-3.0 코드와 결합할 수 있지만, 결합물에 AGPL의 네트워크 조항이 적용된다.
  이 도구는 보수적으로 `incompatible`로 판정하고 notes에 수동 검토를 안내한다.

### 프로젝트 라이선스가 없거나 알 수 없을 때

- 프로젝트 라이선스가 없으면 **permissive(비 copyleft)로 가정**하고 notes에 그 사실을 적는다.
- SPDX 식이 아닌 프로젝트 라이선스(예 `Proprietary`)는 비 copyleft로 가정하고 notes에 적는다.
- 어느 쪽이든 `project_spdx`는 입력 그대로(없으면 `null`) 남는다.

## 5. 식(expression) 처리

| 식 | 처리 |
|---|---|
| `A OR B` | 가장 유리한 쪽을 평가한다 (verdict가 좋은 쪽, 같으면 덜 제한적인 분류). `MIT OR GPL-3.0` → permissive |
| `A AND B` | 가장 불리한 쪽을 따른다. `MIT AND GPL-3.0` → strong_copyleft |
| `A WITH exception` | 예외는 적용하지 않고 기본 라이선스 `A`로 판정한다. notes에 예외 확인을 안내한다 |
| `A+` | `A-or-later`와 같다 (`GPL-2.0+` = `GPL-2.0-or-later`) |
| 괄호 | `(A OR B) AND C`처럼 SPDX 우선순위대로 평가한다 |
| `AND`에 unknown 포함 | unknown (알 수 없는 부분이 더 불리할 수 있다) |
| `OR`에 unknown 포함 | 알려진 쪽이 있으면 그쪽 (예 `MIT OR LicenseRef-x` → permissive) |

프로젝트 라이선스 식도 같은 규칙으로 해석한다(`OR` → 프로젝트가 가장 유리한 쪽을 고를 수 있다고 본다).

verdict 우선순위(좋음 → 나쁨): `compatible` < `conditional` < `unknown` < `incompatible`.

## 6. obligations 예

| category | obligations |
|---|---|
| permissive | Retain copyright and license notice. `Apache-2.0`은 NOTICE 파일 포함과 변경 사실 표시를 더한다. `0BSD`, `Unlicense`, `CC0-1.0`, `MIT-0`은 고지 의무가 없다 |
| weak_copyleft | Publish modifications to covered files under the same license. LGPL은 사용자가 라이브러리를 교체할 수 있어야 한다 |
| strong_copyleft | 배포 시 결합 저작물의 소스를 제공하고 GPL 호환 조건으로 라이선스한다 |
| network_copyleft | 네트워크 사용자에게 소스를 제공하고 AGPL 조건으로 라이선스한다 |
| non_oss | 법무 검토 |
| unknown | LICENSE 원문 확인 |

## 7. 한계

- 의존성의 의존성(전이 의존성)은 판정하지 않는다. 후보 패키지 한 개의 선언된 라이선스만 본다.
- 특허, 상표, 수출 규제, 이중 라이선스 선택권의 계약상 조건은 보지 않는다.
- 패키지 메타데이터의 라이선스 필드는 틀리거나 오래되었을 수 있다. `license_from_remote_cache`, `license_unknown` flag가 있으면
  LICENSE 원문을 반드시 확인한다.
- 사용 방식(링크 방식, 수정 여부)은 알 수 없으므로 weak_copyleft는 항상 `conditional`이다.

## 8. 모델 가중치 (Hugging Face)

**코드와 가중치는 라이선스가 따로다.** 저장소가 Apache-2.0이어도 그 저장소가 불러오는 가중치는 별도 라이선스(`license: other`와 `license_name`)일 수 있다. 예: `livekit-plugins-turn-detector`는 Apache-2.0 코드이고 가중치 `hf:livekit/turn-detector`는 `livekit-model-license`다. 코드 라이선스만 보고 adopt하면 이 차이를 놓친다.

구현은 `src/core/model-license.ts`다. Hugging Face 모델 카드의 `license` id(없으면 `license:` 태그)를 아래 규칙으로 판정하고, 판정 결과의 notes에는 항상 "가중치는 코드와 따로 라이선스된다"와 `Not legal advice`가 들어간다. 이 장의 id 목록은 단위 테스트가 코드와 대조한다.

| 모델 license id | verdict | 판정 방식 |
|---|---|---|
| `apache-2.0`, `mit`, `bsd-2-clause`, `bsd-3-clause`, `isc`, `unlicense`, `cc0-1.0`, `zlib`, `bsl-1.0` | compatible | 코드 매트릭스(2~4장)의 permissive |
| `mpl-2.0`, `epl-1.0`, `epl-2.0`, `lgpl-2.1`, `lgpl-3.0` | 배포 형태에 따름 | 코드 매트릭스의 weak_copyleft |
| `gpl-2.0`, `gpl-3.0`, `agpl-3.0` | 배포 형태에 따름 | 코드 매트릭스의 strong/network copyleft |
| `cc-by-nc-*`, `fair-noncommercial-research-license` | incompatible (internal은 conditional) | 비상업 조건. 코드 매트릭스의 non_oss(`CC-BY-NC-4.0`)로 판정하고 notes에 "상용 사용 불가"를 적는다 |
| `openrail`, `openrail++`, `creativeml-openrail-m`, `bigscience-openrail-m`, `bigscience-bloom-rail-1.0`, `bigcode-openrail-m` | conditional | 용도 제한(행동 사용 제한)이 라이선스의 일부이고 하위 사용자에게 전달해야 한다 |
| `llama2`, `llama3`, `llama3.1`, `llama3.2`, `llama3.3`, `llama4` | conditional | Llama 커뮤니티 라이선스와 허용 사용 정책(AUP) 수락, "Built with Llama" 표시. 오픈소스 라이선스가 아니다 |
| `gemma` | conditional | Gemma 이용약관과 금지 사용 정책 수락 |
| `cc-by-sa-3.0`, `cc-by-sa-4.0` | conditional | 파생물(재학습한 가중치 등)을 배포하면 같은 라이선스로 공유 |
| `cc-by-nd-4.0` | conditional | 변형 금지: 미세조정·양자화·병합한 변형을 공유할 수 없다 |
| `cc-by-2.0`, `cc-by-2.5`, `cc-by-3.0`, `cc-by-4.0` | compatible | 출처 표시 의무 |
| `other`, 표에 없는 id, `license_name`이 있는 카드 | unknown | 사용자 정의 라이선스. flag `custom_model_license`. LICENSE 원문(`license_link`)을 읽어야 한다 |
| 라이선스 정보가 없음, 모델을 가져오지 못함 | unknown | 라이선스가 없으면 사용 권한이 허락되지 않은 것이다 |

- 카드에 id가 여러 개면 AND로 보고 가장 나쁜 쪽을 따른다. `license_name`이 있으면 카드 전체를 사용자 정의 라이선스로 본다(id가 `apache-2.0`이어도).
- 표에 없는 id는 `compatible`로 추정하지 않는다. unknown이다.
- 게이트 모델(`gated`)은 verdict를 바꾸지 않고 flag `gated_model`과 notes로 알린다. `base_model:` 태그가 있으면 기반 모델의 라이선스가 조건을 더할 수 있다는 notes가 붙는다.
- 코드 후보가 모델을 불러오지 않거나 가중치가 패키지에 코드와 같은 LICENSE로 들어 있으면 `weights_ref` 대신 `weights_exempt_reason`(근거 포함)을 줘 `model_weights_unverified`를 푼다(이유는 평가 기록에 남는다).
- 코드 후보에 `weights_ref`를 주면 최종 verdict는 **코드와 가중치 중 나쁜 쪽**이다(우선순위는 5장 끝과 같다). 평가 기록의 `weights_license`에 가중치 verdict와 코드 verdict가 따로 남는다.
- `rw_decide`는 가중치 라이선스가 원인인 unknown/incompatible의 adopt/extend를 거부한다. 사용자가 원문을 읽고 수용하면 `decided_by: 'user'`로 경고로 낮출 수 있다. 코드 라이선스가 원인이면 `decided_by: 'user'`로도 낮아지지 않는다.

## 9. 호스팅 서비스 (SaaS)

`saas:<vendor>/<product>` 후보는 라이선스가 아니라 **벤더 약관**에 묶인다. 판정은 합성값이다: `candidate_spdx` "Vendor terms of service", category `non_oss`, verdict `conditional`, source `agent`. 의무에는 약관·허용 사용 정책 수락, API 키 관리, 사용량 기반 요금 예산이 들어간다. 데이터 사용 정책이 `trains`이면 "기밀·개인 데이터를 보내지 않는다(opt-out이 없으면)"가 추가된다.

- 약관의 실제 내용(가격, 데이터 사용 정책, 탈출 경로)은 에이전트가 벤더 페이지에서 확인한 값이며 `rw_evaluate`의 `saas` 블록으로 입력한다. 벤더의 도메인(`vendor_domains`)도 함께 입력하고, 서버가 인용된 증거의 URL 호스트와 비교해 각 항목의 출처를 `first_party`/`secondhand`/`none`으로 정한다. 확인하지 않았거나(`saas_terms_unverified`), 근거가 원장에 없거나(`saas_evidence_missing`), 벤더 도메인 밖의 페이지(또는 https가 아닌 http 페이지)뿐이면(`saas_terms_secondhand`) adopt/extend는 거부된다. 점수 규칙은 `reference/scoring.md` 11장이다. SDK·플러그인 후보는 코드 라이선스와 별개로 호스팅 서비스의 약관에 묶이므로 `service_ref`로 그 서비스를 연결한다. 서비스 약관이 확인되지 않으면 클라이언트도 `service_terms_unverified`로 adopt/extend가 거부된다(`reference/scoring.md` 12장). 벤더 페이지를 읽었으나 데이터 사용(학습)을 밝히지 않았으면 `data_use.policy`를 `not_stated`로 적는다(`unknown`은 아직 읽지 않음). 약관 게이트(`saas_terms_unverified` 등)는 걸리지 않고 flag `saas_data_use_not_stated`와 DPA 확인 경고만 붙는다. LLM 게이트웨이(litellm 등)는 뒤의 모델 제공자 약관 또는 가중치 라이선스가 따로 필요하므로 `service_ref`(제공자 `saas:`) 또는 `weights_ref`(자체 호스팅 모델)를 연결하지 않으면 `upstream_provider_unverified` 경고가 붙는다(`no_service_reason`으로는 풀리지 않음).
- 한계: 증거의 URL과 `vendor_domains`는 에이전트가 기록한 값이고 서버는 페이지를 가져오지 않는다. 둘 다 원장과 보고서에 남아 감사할 수 있다.
- 서비스는 우리 저장소에 코드를 들이지 않으므로 `THIRD_PARTY_NOTICES` 초안(`format: 'notices'`)에서 제외된다. 대신 Reuse Report의 "Services (SaaS)" 표에 벤더 도메인과 약관 확인 결과, 항목별 출처가 남는다.
- SDK를 쓰면 `saas.sdk_ref`로 따로 평가한다. SDK 라이선스는 일반 코드 라이선스 규칙(1~6장)을 따르고, 그 결과가 sdk 축 점수에 들어간다.
