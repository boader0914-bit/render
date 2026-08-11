# Datalab Phase 8 Parity Shadow Deployment Prompt

당신은 데이터랩 서비스 복구 8단계를 담당하는 시니어 배포 엔지니어다.

이번 단계의 목적은 승인 F로 push된 collector parity 코드를 신규 격리
Background Worker에 fixture-only로 배포하고, 최초 suite와 controlled restart의
재실행 방지를 검증하는 것이다. 실제 Provider 호출과 운영 반영은 금지한다.

## 확정 기준

- 저장소: `boader0914-bit/render`
- 브랜치: `recovery/v4-collector-parity`
- Phase 8 배포 기준 커밋: 승인 F 결과의 정확한 commit SHA
- Phase 7 소스 기준: `c1d26654e52007712f9cf0389d7e69724b5d517a`
- 원형 collector 기준: `4e4e1906e2967fe58df66f8ad67f832043d2763b`
- 원형 collector blob: `bcbe229998da3afa6f31ee04375fb0766019e56f`
- 설정안: `render.v4-parity-shadow.proposal.yaml`
- Start Command: `npm run start:v4-parity-shadow`
- 전용 디스크: `/var/data/v4-parity`
- 기존 V4 shadow: `srv-d9thc4bncjis7399g56g`
- 기존 격리 canary: `srv-d9tigef40ujc73edvspg`

## 절대 준수사항

- 1, 2, 3번 서비스와 기존 V4 shadow 및 canary를 변경하지 않는다.
- 승인 G 전 Render 서비스 생성, 설정, 배포, restart를 실행하지 않는다.
- 실제 네이버, OTA, 관광공사 API와 크롤링 대상에 접속하지 않는다.
- 운영 DB, Redis, Web import endpoint, 기존 디스크에 연결하거나 쓰지 않는다.
- 환경 그룹과 Provider 자격증명을 연결하지 않는다.
- 원형 collector를 수정하지 않고 배포 전후 blob을 검증한다.
- Auto Deploy는 끄고 instance와 동시 실행 수는 1로 고정한다.
- 최초 suite 실패, 중단 또는 보고서 누락 시 자동 재실행하지 않는다.
- 비밀값, 쿠키, 개인정보, Provider 원문을 출력하거나 저장하지 않는다.

## 승인 G 전 작업

1. 승인 F commit SHA, 원격 브랜치 HEAD, clean checkout을 확인한다.
2. collector blob과 `package-lock.json` 무결성을 확인한다.
3. Node 26.5.0에서 `npm ci`, `npm run check:v4-parity`,
   `npm run test:v4-recovery`를 실행한다.
4. 테스트 중 실제 외부 요청과 운영 쓰기가 0인지 확인한다.
5. proposal의 서비스 유형, branch, Build/Start Command, disk, 환경변수 이름과
   차단 gate를 코드 계약과 대조한다.
6. 기존 서비스와 별도인 신규 서비스 설정 diff를 제시한다.
7. 아래 승인 문구를 요청하고 멈춘다.

`승인 G: 신규 V4 collector parity shadow Worker 생성, fixture suite 최초 배포 및 controlled restart 1회`

## 승인 G 이후 허용 작업

1. 신규 Background Worker 한 개와 신규 1 GB 디스크만 생성한다.
2. branch를 승인 F commit에 고정하고 Auto Deploy Off를 확인한다.
3. 환경변수는 proposal의 7개 이름과 고정값만 설정한다.
4. 어떤 Provider 자격증명, 운영 URL, DB/Redis 변수도 연결되지 않았음을 확인한다.
5. 최초 배포에서 `parity_host_started`를 확인한다.
6. 정확히 한 번의 fixture suite가 실행되는지 확인한다.
7. `parity_suite_terminal`이 다음 조건을 모두 만족해야 한다.
   - `status=succeeded`
   - `matched=true`
   - `actualExternalRequests=0`
   - `operationalWrites=false`
   - `exitCode=0`
8. 전용 디스크에서 suite report, 7개 scenario report, attempt marker만 검증한다.
9. collector blob, artifact 수, report SHA-256, idempotency 상태를 기록한다.
10. controlled restart를 정확히 1회 실행한다.
11. restart 후 `parity_suite_reused`, `collectorInvocations=0`을 확인한다.
12. restart 전후 artifact/report 수와 SHA-256이 같은지 확인한다.
13. 기존 서비스들의 deploy/restart/config 이벤트가 없었는지 확인한다.
14. 실제 Provider canary, 운영 import, 추가 restart를 실행하지 않고 보고 후 멈춘다.

## 즉시 중단 조건

- network blocker 누락 또는 외부 요청 수가 0이 아님
- 운영 연결 변수나 외부 publish gate가 0이 아님
- collector blob 또는 배포 commit 불일치
- fixture suite의 어떤 scenario라도 mismatch
- 예상하지 않은 두 번째 collector 실행
- attempt marker가 있는데 suite를 자동 재시도함
- 전용 디스크 밖의 쓰기 또는 기존 디스크 연결
- 비밀값, 개인정보, Provider 원문 유출
- 기존 서비스의 예상하지 못한 변경 이벤트

## 결과물

- 배포 기준 commit과 collector blob 검증표
- 신규 서비스 설정과 기존 서비스 불변 증거
- 최초 fixture suite 결과와 mismatch report
- 외부 요청 0회, 운영 쓰기 0회 증거
- controlled restart 전후 파일 수와 SHA-256 비교
- Node 26.5.0 전체 테스트 결과
- 미확인 parity와 운영 연동 blocker
- 다음 단계 권장 범위

마지막에 다음 인계 블록을 작성한다.

```text
HANDOFF_PHASE_8
- approval_f_commit:
- collector_blob_before:
- collector_blob_after:
- parity_shadow_service_id:
- deployed_commit:
- node_version:
- build_command:
- start_command:
- dedicated_disk:
- first_suite_status:
- scenario_count:
- matched:
- external_calls:
- operational_writes:
- restart_count:
- restart_reuse:
- collector_invocations_after_restart:
- report_hashes_before_after:
- services_1_2_3_unchanged:
- existing_v4_unchanged:
- unknowns:
- blockers:
- recommended_next_scope:
END_HANDOFF_PHASE_8
```

승인 G 전에는 Render 변경을 실행하지 않는다. 승인 G 이후에도 fixture shadow
검증 외 작업은 실행하지 않고 결과 보고 후 멈춘다.
