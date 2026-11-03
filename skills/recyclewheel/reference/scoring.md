# 점수화 기준 (scoring_version 1)

`rw_evaluate`가 후보마다 계산하는 점수와 `hint`의 규칙이다. 구현은 `src/core/score.ts`이고, 이 문서의 수치는 단위 테스트(`test/unit/core/score.test.ts`)가 코드와 대조한다. 코드와 문서가 어긋나면 테스트가 실패한다.

핵심 성질:

- **결정적이다.** 같은 입력(지표, 라이선스 판정, fit, 평가 시각)이면 항상 같은 결과가 나온다. LLM이나 네트워크가 개입하지 않는다.
- **모든 축 점수는 정수이고, `total`은 축 점수의 합(0–100)이다.** 계산 도중의 소수는 각 축에서 반올림한다(0.5는 올림).
- **fit(0–5)만 에이전트의 판단이다.** 나머지 다섯 축은 수집한 지표와 라이선스 판정에서 기계적으로 나온다. 그래서 fit은 `fit_reason`에 근거를 적어야 한다.
- **점수는 결정의 보조 수단이다.** 최종 결정은 에이전트가 `rw_decide`로 내리고, 점수와 다른 결정은 `rationale`에 이유를 적는다.

## 1. 축과 배점

| 축 | 배점 |
|---|---|
| maintenance | 25 |
| popularity | 15 |
| community | 10 |
| license | 20 |
| dependencies | 10 |
| fit | 20 |

합계는 100점이다.

## 2. maintenance (25)

기준 시각: `last_commit_at`, 없으면 `last_release_at`. 평가 시각(`now`)과의 차이를 **경과 일수(소수점 버림, 음수면 0)**로 계산한다.

| 경과 일수 | 점수 |
|---|---|
| ≤ 90 | 25 |
| ≤ 180 | 20 |
| ≤ 365 | 14 |
| ≤ 730 | 6 |
| 730 초과 | 0 |

- `archived` 또는 `deprecated`이면 경과 일수와 관계없이 **0점**이다. flag `archived` / `deprecated`가 붙는다.
- 두 시각이 모두 없거나 해석할 수 없으면 **8점**이고 `missing`에 `last_commit_at`을 기록한다.
- OpenSSF Scorecard의 `Maintained` check 값(0–10)을 알면 `max(위 점수, check × 2.5)`를 쓴다(상한 25). `archived`/`deprecated`에는 적용하지 않는다.
- 활동이 365일보다 오래됐으면(그리고 archived/deprecated가 아니면) flag `stale`이 붙는다.

## 3. popularity (15)

`max( 15 · log10(stars + 1) / 4 , 15 · log10(downloads_weekly + 1) / 6 )`, 상한 15, 반올림. 있는 지표만 쓴다. stars 10,000 또는 주간 다운로드 1,000,000에서 만점이다.

| 입력 | 점수 |
|---|---|
| stars 0 | 0 |
| stars 9 | 4 |
| stars 99 | 8 |
| stars 999 | 11 |
| stars 9999 | 15 |
| stars 10000 | 15 |
| downloads_weekly 999 | 8 |
| downloads_weekly 99999 | 13 |
| downloads_weekly 999999 | 15 |

stars와 downloads_weekly가 모두 없으면 0점이고 `missing`에 `stars`, `downloads_weekly`를 기록한다.

## 4. community (10)

세 항목의 합이다. 값이 없는 항목은 0점이고 `missing`에 기록한다.

| 항목 | 조건 | 점수 |
|---|---|---|
| 릴리스 | `last_release_at`이 365일 이내 | 4 |
| 기여자 | `contributors` ≥ 5 | 4 |
| 기여자 | `contributors` ≥ 2 | 2 |
| Scorecard | `scorecard` ≥ 5 | 2 |

기여자 수는 `deep: true` 평가에서만 수집되므로 기본 평가에서는 대개 `missing`에 `contributors`가 들어간다. 이는 정상이다.

## 5. license (20)

`LicenseVerdict.verdict`에서 그대로 온다. 판정 자체는 `reference/license-matrix.md`를 따른다.

| verdict | 점수 | flag |
|---|---|---|
| compatible | 20 | — |
| conditional | 10 | — |
| unknown | 0 | `no_license`(SPDX 값이 없음) 또는 `license_unknown`(값은 있으나 판정 불가) |
| incompatible | 0 | `license_incompatible` |

판정 출처가 원격 캐시(`source: remote_cache`)이면 어떤 verdict이든 flag `license_from_remote_cache`가 붙는다. adopt 전에 LICENSE 원문을 확인한다.

## 6. dependencies (10)

직접 의존성(direct dependencies) 수 기준이다.

| 직접 의존성 수 | 점수 |
|---|---|
| 0–3 | 10 |
| ≤ 10 | 7 |
| ≤ 30 | 4 |
| 30 초과 | 1 |
| 알 수 없음 | 5 (`missing`에 `direct_dependencies`) |

## 7. fit (20)

에이전트가 입력한 fit(0–5 정수) × 4. 기준: 5 = 요구사항을 모두 그대로 충족 / 4 = 핵심을 충족하고 설정으로 해결 가능한 차이만 있음 / 3 = 절반 이상 충족, 래퍼나 확장 필요 / 2 = 설계·아이디어 참고용 / 1 = 주변적 / 0 = 무관. 범위를 벗어난 값은 오류다.

## 8. hint 규칙

위에서부터 **처음 맞는 규칙**이 적용된다.

| 순서 | 조건 | hint |
|---|---|---|
| 1 | license가 `incompatible` 또는 `unknown`이고 fit ≥ 2 | reference |
| 1 | license가 `incompatible` 또는 `unknown`이고 fit < 2 | build |
| 2 | total ≥ 70 이고 fit ≥ 4 | adopt |
| 3 | total ≥ 50 이고 fit ≥ 3 | extend |
| 4 | fit ≥ 2 | reference |
| 5 | 그 밖 | build |

- 1번이 가장 먼저다. 라이선스를 쓸 수 없거나 모르면 점수가 아무리 높아도 `adopt`/`extend`가 되지 않는다.
- `conditional` 라이선스는 1번에 걸리지 않지만 license 축이 10점뿐이라 `adopt`에 필요한 총점 70이 더 어렵다. 의무(obligations)를 확인한 뒤 결정한다.

### 권고(recommendation) 선택

여러 후보 중에서는 hint 우선순위 **adopt > extend > reference > build**로 먼저 고르고, 같은 hint 안에서는 `total`이 가장 큰 후보를 고른다. 동점이면 fit이 높은 쪽, 그다음은 ref 문자열 오름차순이다(입력 순서와 무관). 후보가 없거나 모두 `build`면 권고는 `build`이고 ref는 없다.

## 9. flag와 missing

| flag | 의미 |
|---|---|
| `archived` | 저장소가 아카이브됨 → maintenance 0 |
| `deprecated` | 패키지가 deprecated → maintenance 0 |
| `stale` | 마지막 활동이 365일보다 오래됨 |
| `no_license` | SPDX 라이선스 값이 없음 |
| `license_unknown` | 라이선스 값은 있으나 판정할 수 없음 |
| `license_incompatible` | 프로젝트 라이선스/배포 형태와 충돌 |
| `license_from_remote_cache` | 라이선스 정보가 원격 공유 캐시에서 옴 |
| `metrics_partial` | `missing`이 비어 있지 않음(일부 지표를 얻지 못함) |
| `custom_model_license` | 모델 가중치 라이선스가 `other`, 표에 없는 id, 또는 `license_name`이 있는 사용자 정의 라이선스(verdict unknown). §12 |
| `gated_model` | 모델을 내려받으려면 Hugging Face에서 약관 동의나 접근 신청이 필요함 |
| `model_weights_unverified` | 코드 후보의 이름이나 설명이 ML처럼 보이는데 `weights_ref`도 `weights_exempt_reason`도 없음. hint는 바뀌지 않는다. §12 |
| `saas_terms_unverified` | `saas:` 후보의 가격 페이지 또는 데이터 사용 정책을 확인하지 않음(최소 입력으로 등록한 서비스의 기본 상태). hint 상한은 reference. §11 |
| `service_terms_unverified` | `service_ref`가 있는 코드 후보인데 그 서비스가 평가되지 않았거나 `saas_terms_unverified`, `saas_evidence_missing`, `saas_terms_secondhand` 중 하나가 있음. hint 상한은 reference. §12 |
| `service_client_suspected` | `service_ref`도 `no_service_reason`도 없는 코드 후보가 호스팅 서비스의 클라이언트처럼 보임. 경고만 하고 hint는 바뀌지 않는다. §12 |
| `upstream_provider_unverified` | `service_ref`도 `weights_ref`도 없는 코드 후보가 LLM 게이트웨이·프록시·라우터처럼 보임(이름 토큰 `litellm`, `openrouter`, `portkey` 또는 설명의 "LLM/AI/model gateway·proxy·router", "100+/multiple/any LLMs·providers" 등). `no_service_reason`과 `weights_exempt_reason`으로는 풀리지 않고 `service_ref`(제공자 `saas:`) 또는 `weights_ref`(자체 호스팅 모델)로 풀린다. 경고만 하고 hint와 adopt 게이트는 그대로다. 결정된 adopt/extend는 REUSE.md의 "Services used through a client but not evaluated" 절과 `rw_ledger`·`rw_status` 경고에 사유와 함께 나온다. §12 |
| `saas_trains_on_data` | 벤더가 제출 데이터로 학습할 수 있음 |
| `saas_data_use_not_stated` | `data_use.policy`가 `not_stated`: 벤더 페이지를 읽었으나 데이터 사용(학습)을 밝히지 않음. hint 상한은 없고 경고만 한다. §11 |
| `saas_evidence_missing` | 확인했다고 한 가격·데이터 사용 정책의 `evidence_id`가 없거나 원장에 없는 id임(출처 `none`). hint 상한은 reference. §11 |
| `saas_terms_secondhand` | 확인했다고 한 가격·데이터 사용 정책이 벤더 도메인 밖의 페이지에만 근거함(출처 `secondhand`). hint 상한은 reference. §11 |
| `no_sdk` | `saas:` 후보에 평가한 SDK가 없음(sdk 축 0점) |

`missing`은 얻지 못한 지표 이름 목록이다(`last_commit_at`, `stars`, `downloads_weekly`, `last_release_at`, `contributors`, `scorecard`, `direct_dependencies`; `saas:` 후보는 `pricing`, `data_use`). 어댑터가 보고한 `missing`은 도구 계층이 합친다. 누락 값은 위 표의 기본 점수로 처리되며, 값이 없다는 이유로 후보를 제외하지 않는다.

## 10. 계산 예

- 최근 30일 안에 커밋, stars 2,000, 직접 의존성 5개, MIT(compatible), 릴리스 60일 전, 기여자 12명, scorecard 7, fit 4:
  maintenance 25 + popularity 12 + community 10 + license 20 + dependencies 7 + fit 16 = **90** → hint `adopt`.
- 같은 후보에서 license가 `incompatible`이고 fit 4: 총점은 70이지만 1번 규칙으로 hint `reference`.
- 지표를 거의 얻지 못한 경우(날짜·stars·의존성 모두 없음), MIT, fit 3: maintenance 8 + popularity 0 + community 0 + license 20 + dependencies 5 + fit 12 = **45** → fit ≥ 2이므로 hint `reference`, flag `metrics_partial`.

## 11. 호스팅 서비스 (`saas:<vendor>/<product>`, profile `saas`)

호스팅 서비스에는 저장소 지표가 없다. 에이전트가 벤더 페이지에서 확인한 값(`saas` 블록)이 입력이고, 구현은 `scoreSaas`(`src/core/score.ts`)다. 각 축은 정수이고 합계가 `total`이다.

| 축 | 배점 |
|---|---|
| maturity | 20 |
| terms | 20 |
| lock_in | 20 |
| sdk | 20 |
| fit | 20 |

**maturity** (벤더가 밝힌 출시 단계)

| 값 | 점수 |
|---|---|
| ga | 20 |
| beta | 12 |
| preview | 6 |
| unknown | 0 |

**terms** = 가격 페이지 확인(`pricing.checked`) 8점 + 데이터 사용 정책 점수, 상한 20. 아래 점수는 근거가 벤더 본인의 페이지(`first_party`)일 때다. 서버는 인용된 증거의 `results[].url`을 `vendor_domains`와 비교해 `pricing.source`와 `data_use.source`를 정한다(입력이 아니다). `secondhand`면 가격은 4점, 데이터 사용 정책 점수는 소수점을 버리고 절반이며, `none`이면 둘 다 0점이다.

| `data_use.policy` | 점수 |
|---|---|
| no_training | 12 |
| opt_out | 8 |
| not_stated | 4 |
| trains | 0 |
| unknown | 0 |

`unknown`은 벤더 페이지를 아직 읽지 않았다는 뜻이고, `not_stated`는 벤더 페이지를 읽었으나 AI 학습에 쓰는지 밝히지 않았다는 뜻이다. `not_stated`는 4점이고 `secondhand`면 2점(소수점 버림), `none`이면 0점이다.

| `pricing.source` | 가격 점수 |
|---|---|
| first_party | 8 |
| secondhand | 4 |
| none | 0 |

출처 판정 규칙: URL을 파서로 읽어 호스트를 소문자로 만들고 끝의 점을 뗀 뒤, `vendor_domains` 중 하나와 같거나 그 하위 도메인이면 `first_party`다. 라벨 경계로 비교하므로 `evil-deepgram.com`과 `deepgram.com.evil.io`는 `deepgram.com`이 아니다. `http`/`https`만 읽되 `https`만 `first_party`로 인정하고 `http`는 `secondhand`다. URL에 userinfo가 있으면 입력 오류이고 저장·출력 URL은 비밀 쿼리 값을 가린다. `vendor_domains`는 `github.io`, `co.kr`, `vercel.app` 같은 공개 접미사 자체일 수 없다. 같은 원장에 있는 어느 컴포넌트의 증거든 되고, 증거 id가 없거나 원장에 없으면 `none`, 있는데 벤더 도메인 URL이 하나도 없으면 `secondhand`다. 확인했다고 하지 않은 항목(`pricing.checked: false`, `data_use.policy: unknown`)은 출처로 판정하지 않고 `saas_terms_unverified`가 맡는다.

**lock_in** (다른 벤더로 옮기는 비용)

| 값 | 점수 |
|---|---|
| low | 20 |
| medium | 12 |
| high | 4 |

**sdk** = SDK 라이선스 점수 + round(SDK maintenance 축(0–25) × 10 / 25). `saas.sdk_ref`로 평가한 SDK가 없으면 **0점**이고 flag `no_sdk`가 붙는다.

| SDK 라이선스 verdict | 점수 |
|---|---|
| compatible | 10 |
| conditional | 5 |
| unknown | 0 |
| incompatible | 0 |

**fit** = 에이전트의 fit(0–5) × 4. §7과 같다.

**약관 게이트.** `pricing.checked`가 false이거나 `data_use.policy`가 `unknown`이면 flag `saas_terms_unverified`가, 확인했다는 항목의 출처가 `none`이면 `saas_evidence_missing`이, `secondhand`이면 `saas_terms_secondhand`가 붙는다. 셋 중 하나라도 있으면 총점과 관계없이 hint는 `reference`(fit ≥ 2) 또는 `build`로 제한된다. 라이선스가 unknown일 때의 §8 규칙 1번과 같다. 확인하지 않은 약관, 근거 없는 약관, 남의 사이트에 적힌 약관은 점수로 메우지 않는다. 그 밖의 hint는 §8의 임계값을 그대로 쓴다.

`data_use.policy`가 `not_stated`이면 "읽었다"로 보므로 `saas_terms_unverified`가 붙지 않고, 근거(`evidence_id`/`source_url`)는 다른 항목처럼 출처 판정을 받는다(벤더 본인의 페이지가 아니면 `saas_terms_secondhand`/`saas_evidence_missing`이 게이트로 작동한다). 대신 flag `saas_data_use_not_stated`가 붙는다. 이 flag는 hint 상한이 없고 경고만 한다: `rw_decide`가 adopt/extend 때 "벤더가 데이터 사용을 명시하지 않음; DPA 확인 또는 문의 필요" 취지로 경고하고, 결정된 서비스는 `rw_ledger`·`rw_status` 경고와 REUSE.md의 Services 표(Data use 열과 Flags 열)에 드러난다.

라이선스 판정은 합성값이다: `candidate_spdx` "Vendor terms of service", category `non_oss`, verdict `conditional`, source `agent`. 벤더 약관은 오픈소스 라이선스가 아니므로 의무에 약관 수락을 적는다. `rw_decide`는 `saas_terms_unverified`, `saas_evidence_missing`, `saas_terms_secondhand` 중 하나라도 있는 `saas:` 후보의 adopt/extend를 거부한다(`decided_by: 'user'` 또는 `override`로만 경고로 낮출 수 있다). 풀려면 벤더 페이지를 읽고 그 URL을 `pricing.source_url`/`data_use.source_url`로 적어 `rw_evaluate`를 다시 호출하거나(서버가 증거를 기록한다), `rw_record_evidence`로 남긴 뒤 그 `evidence_id`를 적는다. `saas` 블록의 필수는 `vendor_domains`, `lock_in`, `exit_path`뿐이고 `maturity`는 기본 unknown(0점), `pricing`은 `{checked:false}`, `data_use`는 `{policy:"unknown"}`이다. `source_url`로 자동 기록된 증거는 kind `manual`이라 웹 검색 예산과 build의 출처 2곳 규칙에 세지 않는다.

한계: 증거의 URL은 에이전트가 기록한 값이고 서버가 페이지를 가져와 확인하지 않는다. `vendor_domains`도 에이전트의 주장이다. 둘 다 원장과 Reuse Report(Services 표)에 그대로 남아 감사할 수 있지만, 서버가 내용을 검증하는 것은 아니다.

계산 예: maturity ga 20 + terms(가격 확인 8 + no_training 12) 20 + lock_in low 20 + sdk(MIT compatible 10 + maintenance 25 → 10) 20 + fit 4 → 16 = **96** → hint `adopt`. 같은 서비스에서 가격 페이지를 확인하지 않으면 terms 12, total 88이지만 `saas_terms_unverified`로 hint는 `reference`다. 가격과 데이터 사용 정책의 근거가 모두 다른 사이트의 페이지(`secondhand`)이면 terms는 4 + 6 = 10, total 86이지만 `saas_terms_secondhand`로 hint는 `reference`다.

## 12. 모델 가중치

코드와 가중치는 라이선스가 따로다. `hf:<owner>/<model>` 후보와 `weights_ref`는 Hugging Face 모델 카드의 라이선스를 판정하고(`src/core/model-license.ts`, 규칙은 `reference/license-matrix.md`의 "모델 가중치"), 점수 축은 §1과 같은 OSS 프로파일을 쓴다.

- `weights_ref`가 있는 코드 후보의 최종 verdict는 **코드와 가중치 중 나쁜 쪽**이다(incompatible > unknown > conditional > compatible). license 축 점수와 §8 규칙 1번은 이 최종 verdict로 계산한다. 코드와 가중치 각각의 verdict는 평가 기록의 `weights_license`(`verdict`, `code_verdict`)에 남는다.
- `hf:` 후보 자체의 license 축은 모델 카드 판정에서 온다. 사용자 정의 라이선스(`other`, 표에 없는 id, `license_name`)는 unknown이고 flag `custom_model_license`가 붙는다.
- `model_weights_unverified`는 휴리스틱 경고일 뿐 점수와 hint를 바꾸지 않는다. 후보의 이름(강한 단어와 약한 단어)과 설명·키워드·토픽(강한 단어만)에서 onnx, safetensors, whisper, llama.cpp, embedding, turn detection 같은 모델 도구·형식 용어를 찾는다. 원격 API를 부르는 말(`llm`, `llms`, `gpt`)은 가중치 휴리스틱에서 제외한다. 그런 말만 있는 API 게이트웨이(예: litellm)는 로컬 가중치를 불러오지 않기 때문이다. 검색 계획(rw_decompose)은 이 말들도 ML로 본다. 미탐이 이 휴리스틱이 줄이려는 실수이므로 오탐은 경고 하나로 둔다.
- 후보가 모델을 불러오지 않는 것을 확인했으면 `weights_exempt_reason`(10~300자, `weights_ref`와 함께 쓸 수 없음, 코드 후보만)을 준다. 그러면 휴리스틱을 건너뛰고 flag 없이 평가되며, 가중치가 패키지에 코드와 같은 LICENSE로 들어 있는 경우에도 근거를 적어 쓴다. `weights` 용도에서는 `embedding`/`embeddings`가 약한 용어라 설명의 언급만으로는 flag가 붙지 않는다(이름·키워드에서만). 검색 계획(`search` 용도)은 그대로다. 이유는 평가 기록의 `weights_exempt_reason`에 남아 `rw_evaluate` 출력의 "Model weights:" 목록과 Reuse Report에 나온다. rationale에 적는 것만으로는 flag가 풀리지 않는다.
- LLM 게이트웨이(litellm, openrouter, portkey처럼 이름에 토큰이 있거나 설명이 "LLM gateway/proxy/router", "100+ LLMs" 같은 말을 쓰는 코드 후보)는 가중치를 불러오지 않아도 뒤의 모델 제공자가 별개의 결정이다. 그래서 `service_ref`(제공자 `saas:` 평가, 약관 게이트가 그대로 적용된다)도 `weights_ref`(자체 호스팅 모델)도 없으면 flag `upstream_provider_unverified`와 경고가 붙는다. `no_service_reason`, `weights_exempt_reason`으로는 풀리지 않는다. 휴리스틱이라 점수·hint·adopt 게이트는 바꾸지 않고, 결정된 adopt/extend는 REUSE.md "Services used through a client but not evaluated" 목록과 `rw_ledger`·`rw_status` 경고에 남는다.
- Hugging Face의 `downloads`는 최근 30일 합계이므로 `downloads_weekly`는 round(downloads × 7 / 30)로 환산한다. `likes`는 `stars`로 쓴다.
