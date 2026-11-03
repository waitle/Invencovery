# recyclewheel 공유 캐시 서버

팀이나 여러 에이전트가 공개 API 응답(GitHub, npm, PyPI, MCP 레지스트리, deps.dev)을 공유해 GitHub 등의 레이트리밋 소모를 줄이는 **선택 기능**입니다. 기본값은 꺼짐(`off`)이며, 켜지 않으면 아무것도 전송되지 않습니다. 설계 근거는 [PLAN §9.4](PLAN.md)입니다.

## 트러스트 모델

- **팀이 직접 운영하는 신뢰된 서버**를 전제로 합니다. 공개 익명 캐시 서비스는 목표가 아닙니다.
- 서버는 URL을 알지 못합니다. 키(sha256 해시), 응답 본문, 출처 종류, 유효기간만 저장합니다.
- 쓰기 토큰을 가진 사람은 캐시 내용을 바꿀 수 있습니다(캐시 오염). 그래서 클라이언트는 원격에서 온 라이선스 정보에 `license_from_remote_cache` 플래그를 달고, 이 플래그가 있는 후보의 adopt/extend는 `rw_decide`가 `decided_by: "user"`일 때만 받아들입니다(아니면 오류. 원격 캐시를 끄거나 오프라인으로 `rw_evaluate`를 다시 실행해 로컬에서 재평가하는 것이 대안). 스킬은 adopt 전에 LICENSE 원문을 확인하도록 지시합니다. 클라이언트는 원격 항목도 검증합니다(`fetched_at`은 현재 시각 이하, `expires_at`은 `fetched_at` + 요청 종류별 TTL 이하, 유효하지 않은 JSON·크기 초과, 인쇄 가능한 ASCII 1~256자가 아닌 `etag`/`last_modified`는 버림).
- 서버를 운영하는 사람은 저장된 응답 본문을 볼 수 있습니다. 본문은 공개 API 응답이지만, 어떤 해시 키가 있는지는 보입니다(아래 "해시 키의 한계").

## 실행

```bash
export RECYCLEWHEEL_SERVER_WRITE_TOKEN="$(openssl rand -hex 24)"
export RECYCLEWHEEL_SERVER_READ_TOKEN="$(openssl rand -hex 24)"   # 선택: 설정하면 읽기에도 토큰이 필요
node dist/cli.js cache-server --port 8787 --host 127.0.0.1 --db ./rw-server.db   # 뒤에 프록시가 둘이면 --trusted-hops 2
```

Windows PowerShell:

```powershell
$env:RECYCLEWHEEL_SERVER_WRITE_TOKEN = "<긴 임의 문자열>"
node dist/cli.js cache-server --port 8787 --db .\rw-server.db
```

- 기본 바인딩은 `127.0.0.1:8787`입니다. 다른 머신에서 접근하게 하려면 TLS 리버스 프록시 뒤에 두고, 서버 자체는 loopback에 바인딩한 채로 두는 구성을 권장합니다. `--host 0.0.0.0`은 명시적으로 지정해야 하며 TLS 없이 인터넷에 노출하지 마세요.
- DB는 로컬 캐시와 같은 SQLite 저장소(WAL, 기본 200MB 상한, 오래된 순으로 정리)를 씁니다. 서버는 만료된 항목을 보관하지 않습니다.
- 프로그램에서 쓰려면 `startCacheServer({ host, port, dbPath, writeToken?, readToken?, maxBodyBytes?, maxTtlSec? })`를 호출합니다(`src/server/cache-server.ts`). 추가 옵션: `logger`, `rateLimitPerMin`, `trustProxy`, `trustedHops`, `authFailLimitPerMin`, `globalAuthFailLimitPerMin`, `maxTrackedClients`, `maxDbBytes`, `version`.
- CLI 플래그: `--host`, `--port`, `--db`, `--trusted-hops <n>`(기본 1, 아래 "리버스 프록시" 참고). `authFailLimitPerMin`, `globalAuthFailLimitPerMin` 같은 제한 값은 `startCacheServer` 옵션이며 CLI 플래그는 없습니다.
- POSIX에서 DB 디렉터리(새로 만든 경우)는 `0700`, DB 파일과 `-wal`/`-shm`은 `0600`으로 만듭니다. 비공개 저장소의 메타데이터가 들어갈 수 있기 때문입니다(Windows에서는 무시).

## 토큰

| 변수 (서버) | 효과 |
|---|---|
| `RECYCLEWHEEL_SERVER_WRITE_TOKEN` | **없으면 PUT/DELETE가 비활성화**되어 서버는 읽기 전용이 됩니다(403). 쓰기 토큰은 읽기에도 쓸 수 있습니다. |
| `RECYCLEWHEEL_SERVER_READ_TOKEN` | 설정하면 `GET /v1/entries/{key}`에 `Authorization: Bearer`가 필요합니다(401). 없으면 읽기는 공개입니다. |
| (공통) 토큰 최소 길이 | 쓰기·읽기 토큰은 **16자 이상**이어야 하며, 더 짧으면 서버가 시작을 거부합니다. 생성 예: `openssl rand -hex 32` |

토큰 비교는 상수 시간으로 하며, 토큰·키·본문은 로그에 남기지 않습니다. 쓰기 인증 실패는 항상 403입니다. 인증 실패(401/403)가 IP당 분당 20회(`authFailLimitPerMin`, `0`이면 끔)를 넘으면 그 IP는 `429` + `Retry-After`로 잠시 막힙니다(올바른 토큰도 대기). 성공한 요청은 이 횟수에 포함되지 않습니다. 서버 전체에도 인증 실패 상한이 있습니다(`globalAuthFailLimitPerMin`, 기본 분당 600회, `0`이면 끔). 소진되면 주소와 무관하게 인증에 실패한 요청은 401/403 대신 `429` + `Retry-After`를 받습니다. 올바른 토큰의 요청은 전역 상한에 걸리지 않으며(자기 IP가 잠금 상태면 위 규칙대로 대기), 전역 상한은 실패 응답의 양을 제한할 뿐 추측 시도 자체를 늦추지는 않습니다. 비교 전에 전역 상한을 확인하면 누구나 상한을 소진시켜 정상 클라이언트까지 막을 수 있으므로, 토큰을 먼저 비교하고 실패한 경우에만 전역 횟수를 소모합니다. 추측에 대한 방어는 토큰의 길이와 무작위성에 달려 있습니다.

클라이언트(각 개발자의 환경):

```bash
RECYCLEWHEEL_REMOTE_CACHE_URL=https://cache.example.com
RECYCLEWHEEL_REMOTE_CACHE_MODE=readwrite        # off(기본) | read | readwrite
RECYCLEWHEEL_REMOTE_CACHE_TOKEN=<읽기 또는 쓰기 토큰>
```

- `read`: 키 해시만 서버로 보내 조회합니다. 업로드는 하지 않습니다.
- `readwrite`: 조회에 더해 정제된 공개 응답을 업로드합니다. 쓰기 토큰이 필요합니다.
- 토큰은 `Authorization` 헤더에만 들어가며 URL에 넣지 않습니다.
- URL은 https 또는 loopback(`localhost`, `127.0.0.1`, `[::1]`)의 http만 허용합니다. 그 밖의 http URL은 토큰이 암호화 없이 전송되므로 경고와 함께 mode가 `off`가 됩니다. 위험을 알고 쓰려면 `RECYCLEWHEEL_ALLOW_INSECURE_REMOTE=1`(기본 꺼짐)을 설정하세요.

## 리버스 프록시 (Caddy)

```caddyfile
cache.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy가 TLS 인증서를 자동으로 관리합니다. Caddy의 `reverse_proxy`는 `X-Forwarded-For`를 클라이언트 IP **하나**로 덮어쓰므로 기본값(`--trusted-hops 1`)과 맞습니다.

속도 제한과 인증 실패 제한은 클라이언트 주소별로 집계합니다(분당 120회). IPv6 주소는 /64 접두 단위로 한 클라이언트로 묶고, IPv4-mapped IPv6(`::ffff:a.b.c.d`)는 해당 IPv4 주소로 취급합니다.

**리버스 프록시 없이 서버를 loopback에 직접 노출하지 마세요.** 기본 설정에서 loopback 피어의 `X-Forwarded-For`는 신뢰되므로, 같은 호스트에서 직접 접속하는 클라이언트는 이 헤더를 바꿔 IP별 제한을 피할 수 있습니다. 프록시가 `X-Forwarded-For`를 덮어쓰거나(Caddy 기본) 실제 접속 IP를 맨 뒤에 덧붙이도록(nginx `$proxy_add_x_forwarded_for`) 구성하고, 서버는 그 프록시만 접근할 수 있게 두세요. 이 경우에도 서버 전체 인증 실패 상한(`globalAuthFailLimitPerMin`)이 실패 응답의 총량을 제한합니다(추측 방어는 토큰 길이가 맡습니다).

프록시가 같은 호스트(loopback)에서 접속할 때만 서버는 `X-Forwarded-For`를 신뢰하며, **오른쪽에서 `trustedHops`번째 항목**을 클라이언트 IP로 씁니다(기본 1 = 마지막 항목). 왼쪽 항목은 클라이언트가 위조할 수 있으므로 쓰지 않습니다. 헤더에 항목이 `trustedHops`보다 적으면 소켓 주소를 씁니다.

- **nginx**: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`는 클라이언트가 보낸 값을 앞에 두고 실제 접속 IP를 **뒤에** 덧붙입니다. 기본값 1이 맞고(첫 값을 쓰면 위조로 제한을 우회할 수 있어 쓰지 않습니다), 이 위에 CDN 같은 프록시가 한 단계 더 있으면 `--trusted-hops 2`처럼 늘리세요. 값이 실제 프록시 수보다 크면 위조 가능한 항목을 읽게 됩니다.
- 프록시가 다른 호스트나 컨테이너에 있으면 `startCacheServer({ trustProxy: true })`가 필요합니다. 그렇지 않으면 전체 팀이 프록시 IP 하나의 제한을 나눠 씁니다. 서버를 프록시 없이 직접 노출했다면 `trustProxy: false`로 헤더를 무시하세요.
- 추적하는 IP 수는 `maxTrackedClients`(기본 10000)로 제한됩니다. 가득 차면 오래 쓰이지 않은 IP부터 버리므로 가짜 IP를 반복해도 새 클라이언트가 거부되거나 메모리가 늘지 않습니다.

## API v1

모두 JSON입니다. 키는 `^[0-9a-f]{64}$`입니다.

| 메서드 | 경로 | 인증 | 응답 |
|---|---|---|---|
| GET | `/v1/health` | 없음(상세는 토큰) | 인증 없이: `200 { ok: true }`. 읽기 또는 쓰기 토큰을 보내면: `200 { ok: true, version, entries }`. 잘못된 토큰도 `200 { ok: true }`이지만 인증 실패로 집계되고, 잠금 상태인 IP에는 상세를 주지 않습니다. |
| GET | `/v1/entries/{key}` | 읽기 토큰(설정 시) | `200 { key, source, status, body, etag?, last_modified?, fetched_at, expires_at }` / `404` |
| PUT | `/v1/entries/{key}` | 쓰기 토큰 | 요청 `{ source, status, body, etag?, last_modified?, fetched_at, expires_at }` → `204` |
| DELETE | `/v1/entries/{key}` | 쓰기 토큰 | `204` (운영용: 항목을 만료 처리하고 본문을 비웁니다) |

서버가 PUT에서 확인하는 것:

| 조건 | 응답 |
|---|---|
| 키 형식 오류, JSON 오류, 필드 누락, `status`가 200/404가 아님, 허용되지 않은 `source`, `etag`/`last_modified`가 `^[\x20-\x7e]{1,256}$`(인쇄 가능한 ASCII 1~256자)가 아님 | 400 |
| 쓰기 토큰이 없거나 틀림, 쓰기 토큰 미설정 | 403 |
| 요청 본문 또는 `body`가 `maxBodyBytes`(기본 1MB) 초과 | 413 |
| 정제 규칙이 거부한 항목(비공개 저장소 등) | 422 |
| IP별 분당 120회 초과, 또는 인증 실패 분당 20회 초과 | 429 + `Retry-After` |

`expires_at - fetched_at`은 `maxTtlSec`(기본 7일)로 잘리고, 미래의 `fetched_at`은 서버 시계로 제한됩니다. 이미 만료된 항목은 저장하지 않습니다.

## 무엇이 전송되는가 (프라이버시)

전송하는 것은 **키 해시, 공개 응답 본문, 출처 종류, 유효기간, etag/last-modified**뿐입니다. 원본 URL, 검색어 평문, 프로젝트명, 원장, GitHub 토큰, 요청 헤더는 보내지 않습니다.

업로드 전 정제(`src/cache/sanitize.ts`, 서버도 한 번 더 적용):

- 허용 출처: `github_repo`, `github_code`, `npm`, `pypi`, `mcp_registry`, `hf_models`, `depsdev`. libraries.io 응답은 업로드하지 않습니다.
- 상태 200(유효한 JSON, 1MB 이하)과 404만 업로드합니다.
- GitHub 저장소 검색: 공개임이 확인되지 않은 항목(`private`가 `false`가 아니거나 `visibility`가 `public`이 아님)을 제거하고 `total_count`를 보정합니다.
- 저장소 상세: `private: false`일 때만 업로드합니다.
- 릴리스, 기여자 목록처럼 공개 여부를 본문에서 확인할 수 없는 GitHub 응답은 업로드하지 않습니다.
- 코드 검색: 모든 결과의 `repository.private`가 `false`일 때만 업로드합니다.
- GitHub 토큰 형태(`ghp_`, `github_pat_` 등)가 본문에 있으면 업로드하지 않습니다.
- 키 계산 전에 `api_key`, `access_token`, `token`, `client_secret`, `key` 쿼리 파라미터는 제거됩니다(`src/cache/key.ts`).

## 해시 키의 한계

키는 `sha256("rw1|" + 정규화한 URL)`입니다. 서버는 URL을 모르지만, 흔한 검색어나 유명 저장소 URL은 누구나 같은 방식으로 해시를 계산해 **사전 대입으로 추측**할 수 있습니다. 따라서 해시 키는 평문 은닉이 아니라 우발적 노출을 줄이는 장치입니다. 민감한 검색어가 있다면 원격 캐시를 켜지 마세요. 서버를 신뢰된 팀 안에서만 운영하고, 읽기 토큰을 설정하는 것을 권장합니다.

## 장애 시 동작

클라이언트는 원격 캐시를 1.5초 타임아웃으로 호출하고, 3번 연속 실패하면 5분간 원격을 건너뜁니다. 서버가 죽어도 로컬 캐시와 업스트림으로 정상 동작합니다. `rw_status`와 `recyclewheel doctor`가 `/v1/health` 도달 여부를 보여줍니다.
