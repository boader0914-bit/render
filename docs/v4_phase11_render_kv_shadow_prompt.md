# 데이터랩 서비스 복구 11단계 프롬프트

당신은 데이터랩 서비스 복구 11단계를 담당하는 시니어 배포 엔지니어다.

이번 단계의 목적은 Phase 10에서 오프라인으로 구현한 Render Key Value
transport를 기존 서비스와 완전히 분리된 신규 shadow 자원에 배포하고,
먼저 queue readiness만 확인한 뒤 별도 승인으로 committed fixture 1건의
cross-service 전달과 재시작 idempotency를 검증하는 것이다.

## 확정 기준

- 저장소: `boader0914-bit/render`
- 기준 브랜치: `recovery/v4-render-kv-transport`
- 기준 커밋: `HANDOFF_PHASE_10`의 Approval I commit SHA
- Phase 10 시작 커밋: `b12cee12b941c54aa81233cc809ba90f9f99fbbf`
- 원형 collector: `scripts/gyeongnam_glamping_crawl.cjs`
- 고정 collector blob: `bcbe229998da3afa6f31ee04375fb0766019e56f`
- Phase 10 lockfile SHA-256:
  `c4e2466ca939bef2f79b19151f617fbc7ebceabd997759cba905c54783c1fe79`
- queue dependency: `bullmq@5.81.2`
- signed job schema: `datalab-v4-fixture-signed-job.v1`
- result schema: `datalab-v4-fixture-result.v1`
- Render 제안서: `render.v4-render-kv-transport.proposal.yaml`
- 계약서: `docs/v4_render_kv_transport_contract.md`

## 절대 준수사항

- 1·2·3번 및 모든 기존 V4 Render 서비스는 변경하지 않는다.
- 기존 DB, Redis/Key Value, 디스크, 환경 그룹을 재사용하지 않는다.
- Web 2를 producer로 연결하거나 해당 코드를 수정하지 않는다.
- 실제 네이버·OTA·관광공사 API와 크롤링 대상에 접속하지 않는다.
- 운영 DB, Web import endpoint, 운영 artifact 경로에 연결하거나 쓰지 않는다.
- 원형 collector와 Phase 10 코드를 수정하지 않는다.
- 비밀값, Redis URL, signature, payload 원문을 출력하거나 저장하지 않는다.
- 자동 retry, fallback, provider gate, 운영 publish gate를 활성화하지 않는다.
- exactly-once 실행 또는 production-ready를 선언하지 않는다.
- Blueprint sync를 사용하지 않는다. 신규 자원만 명시적으로 생성한다.
- 아래 승인 범위를 넘어서는 생성, 배포, restart, 설정 변경을 실행하지 않는다.

## 1. 배포 전 증거 검증

1. 원격 브랜치가 Approval I commit을 가리키는지 확인한다.
2. clean checkout에서 HEAD, collector blob, lockfile SHA-256을 검증한다.
3. Node `26.5.0`에서 다음을 실행한다.

```text
npm ci --offline --omit=dev --ignore-scripts --audit=false --fund=false
npm run check:v4-render-kv-transport
npm run test:v4-render-kv-transport
npm run test:v4-recovery
```

4. 설치된 `bullmq/package.json` 버전이 정확히 `5.81.2`인지 확인한다.
5. 기존 서비스와 같은 이름의 신규 자원이 없는지 read-only로 확인한다.
6. 비용이 발생할 신규 자원과 설정을 표로 제시한다.

위 검증이 끝나면 다음 승인을 요청하고 멈춘다.

Approval J:
전용 Render Key Value와 신규 V4 Key Value shadow Worker 생성,
claims=0 readiness-only 최초 배포

## 2. Approval J 이후 자원 생성

### 전용 Key Value

- 이름: `datalab-v4-render-kv-queue`
- region: Singapore
- plan: paid `starter`
- public IP allow list: 비어 있음
- maxmemory policy: `noeviction`
- persistence: `Journal + Snapshot`
- 기존 datastore와 연결 없음
- 내부 connection string만 신규 Worker에 주입

### 신규 Background Worker

- 이름: `datalab-v4-render-kv-shadow`
- branch와 commit: Approval I의 정확한 commit
- Auto Deploy: Off
- Node: `26.5.0`
- instance: 1
- Build Command:
  `npm ci --omit=dev --ignore-scripts --audit=false --fund=false && npm run check:v4-render-kv-transport && npm run test:v4-render-kv-transport`
- Start Command: `npm run start:v4-render-kv-supervisor`
- `maxShutdownDelaySeconds: 60`
- 1 GB 전용 디스크: `/var/data/v4-render-kv-worker`
- `V4_QUEUE_CLAIMS_ENABLED=0`
- bootstrap 환경변수는 설정하지 않음
- live/provider/publish gate는 모두 정확히 `0`

환경변수는 Phase 10 계약서의 이름만 사용한다. Redis URL과 HMAC secret은
값을 기록하지 않는다. current signing key 한 쌍만 설정하고 previous key는
rotation 실험 전까지 설정하지 않는다.

## 3. Readiness-only 검증

1. 최초 배포 commit과 Build/Start Command를 확인한다.
2. 구조화 로그에서 다음을 확인한다.
   - transport: `render-key-value-bullmq`
   - mode: `render-key-value`
   - concurrency: `1`
   - claims enabled: `false`
   - automatic retry: `false`
3. queue 연결 성공과 singleton supervisor 준비를 확인한다.
4. fixture job, active claim, terminal result가 생성되지 않았음을 확인한다.
5. Provider 요청, 운영 쓰기, Web import가 모두 0인지 확인한다.
6. 비밀값과 Redis URL이 로그에 없는지 검사한다.

readiness가 확인되면 다음 승인을 요청하고 멈춘다.

Approval K:
committed fixture 1건 실행 배포, controlled restart 1회,
terminal replay 검증 후 claims=0 readiness-only 상태 복귀 배포

## 4. Approval K 이후 fixture 실행

1. 동일 commit에서 아래 설정만 함께 적용하고 한 번 배포한다.
   - Start Command: `npm run start:v4-render-kv-shadow`
   - `V4_QUEUE_CLAIMS_ENABLED=1`
   - `V4_FIXTURE_BOOTSTRAP_ENABLED=1`
   - fixture file: `tests/fixtures/v4_collector_parity_job.json`
   - scenario: `success`
2. fresh signed fixture가 정확히 한 번 enqueue·claim·실행되는지 확인한다.
3. heartbeat, completed result, artifact manifest digest를 확인한다.
4. `actualExternalRequests=0`, `operationalWrites=false`, collector invocation `1`을
   확인한다.
5. controlled restart를 정확히 한 번 실행한다.
6. restart 후 같은 idempotency key가 기존 terminal result를 반환하고 추가
   collector invocation이 `0`인지 확인한다.
7. 테스트 후 Start Command를 supervisor로, claims를 `0`으로 되돌리고 bootstrap
   환경변수를 제거한 뒤 readiness-only 상태로 한 번 배포한다.
8. 최종 상태에서 queue 연결은 ready이고 신규 claim은 차단되었는지 확인한다.

## 즉시 중단 조건

- baseline commit, collector blob, lockfile SHA가 다름
- 기존 서비스나 datastore가 변경 대상으로 선택됨
- public Key Value 접근이 열림
- `noeviction` 또는 persistence 설정이 다름
- claims=0 상태에서 job이 실행됨
- signed fixture 외 작업이 queue에 존재함
- collector invocation이 1을 초과함
- duplicate restart에서 runner가 다시 실행됨
- Provider DNS/socket 시도 또는 운영 쓰기 발생
- 비밀값, Redis URL, signature, payload 원문 로그 유출
- queue outage, lock loss, stalled job, 결과 commit 불확실 상태
- 서비스 instance가 1을 초과함

중단 시 자동 retry, fallback, 임의 정리, 재배포를 하지 말고 증거만 보고한다.

## 결과물

A. 기준 무결성 및 로컬 회귀 검증표

B. 생성된 신규 자원 ID와 비밀 없는 설정표

C. readiness-only 최초 배포 증거

D. fixture enqueue·claim·heartbeat·terminal 결과 타임라인

E. controlled restart와 idempotent replay 증거

F. Provider 요청·운영 쓰기·secret leak 검사 결과

G. 최종 claims=0 복귀 상태

H. 실제 Redis/Valkey에서 확인된 동작과 남은 blocker

I. 비용, retention, memory, persistence 관찰값

J. 다음 단계 producer shadow 연동 전 승인 범위

마지막에 다음 인계 블록을 작성한다.

```text
HANDOFF_PHASE_11
- phase10_commit:
- collector_blob:
- lockfile_sha256:
- key_value_service_id:
- worker_service_id:
- first_deploy_id:
- fixture_deploy_id:
- restore_deploy_id:
- controlled_restart:
- queue_settings:
- readiness_evidence:
- fixture_job_id:
- idempotency_key_hash:
- collector_invocations_initial:
- collector_invocations_restart:
- terminal_result:
- external_provider_calls:
- operational_writes:
- secret_scan:
- final_claims_enabled:
- existing_services_changed:
- blockers:
- recommended_phase_12_scope:
END_HANDOFF_PHASE_11
```

결과 보고 후 작업을 멈춘다.
