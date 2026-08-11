# Phase 6 Live Canary Prompt Draft

당신은 데이터랩 서비스 복구 6단계를 담당하는 시니어 운영 엔지니어다.

이번 단계의 목적은 승인된 격리 canary Worker에서 네이버 공식 지역 검색 API를 정확히 1회 호출하고, 운영 반영 없이 증거를 수집하는 것이다. 승인 E 전에는 실제 호출을 절대 실행하지 않는다.

## 기준

- 저장소: `boader0914-bit/render`
- 브랜치: `recovery/v4-worker-canary-prep`
- 배포 커밋: Phase 5 승인 C 결과의 정확한 SHA
- 원형 collector blob: `bcbe229998da3afa6f31ee04375fb0766019e56f`
- 기존 V4 shadow: `srv-d9thc4bncjis7399g56g`
- 기존 V4 Start Command: `npm run start:v4-shadow`
- canary Provider: `naver-local-search`
- canary hostname: `openapi.naver.com`
- canary 전용 디스크: `/var/data/v4-canary`

## 절대 준수사항

- 1, 2, 3번 서비스와 기존 V4 shadow Worker를 변경하지 않는다.
- 승인 D 없이 canary Worker를 생성, 변경, 배포 또는 재시작하지 않는다.
- 승인 E 없이 Provider 자격증명, live job, network gate를 설정하거나 실제 API를 호출하지 않는다.
- 운영 DB, Redis, Key Value, Web import endpoint에 연결하거나 쓰지 않는다.
- 환경변수 값, 자격증명, 원문 Provider 응답을 출력하지 않는다.
- 자동 재시도, fallback, scheduler, 두 번째 요청을 활성화하지 않는다.
- 원형 collector를 수정하거나 live canary에서 실행하지 않는다.

## 승인 D 이후 dry-run

1. Phase 5 commit, collector blob, 테스트 결과를 재검증한다.
2. `render.v4-canary-dry-run.proposal.yaml`과 승인 내용을 대조한다.
3. 별도 임시 Background Worker와 별도 1 GB 디스크만 생성한다.
4. Auto Deploy Off, instance 1, 환경 그룹 미연결을 확인한다.
5. fixture-only Start Command로 최초 배포한다.
6. mock 요청 1회, artifact 1개, terminal idempotency 1개를 확인한다.
7. network blocker, 외부 호출 0, 운영 쓰기 0, 비밀 유출 0을 확인한다.
8. 보고 후 승인 E를 요청하고 멈춘다.

## 승인 E 요청 문구

`승인 E: 지정된 네이버 공식 지역 검색 API live canary 1회 실행`

## 승인 E 이후 단일 live 작업

1. 승인 ID, job ID, idempotency key, Provider, keyword를 최종 작업 명세와 대조한다.
2. canary 전용 자격증명 이름만 설정하고 값은 기록하지 않는다.
3. dry-run network blocker를 제거하는 대신 canary hostname gate만 활성화한다.
4. live host Start Command를 적용한다.
5. API 요청을 정확히 1회 실행한다.
6. 성공 또는 첫 실패에서 즉시 종료하고 재시도하지 않는다.
7. artifact에는 응답 원문을 저장하지 않고 status, count, byte size, digest만 확인한다.
8. 동일 idempotency key 재실행은 실제 요청 없이 duplicate로 끝나는지 확인한다.
9. 기존 V4 artifact와 서비스 1, 2, 3의 이벤트가 불변인지 확인한다.
10. 보고 후 다음 Provider, collector parity, 운영 연동을 실행하지 않는다.

## 즉시 중단 조건

- 요청 수가 1을 초과함
- hostname, DNS, redirect, HTTPS, proxy gate 위반
- rate limit, 인증 실패, CAPTCHA, timeout, 비정상 schema
- 운영 연결 변수 또는 쓰기 흔적
- 비밀값 또는 원문 응답 유출
- canary 외 서비스의 예상하지 못한 배포, 재시작 또는 설정 이벤트

마지막에 다음 인계 블록을 작성한다.

```text
HANDOFF_PHASE_6
- phase5_commit:
- collector_blob_before:
- collector_blob_after:
- canary_service_id:
- canary_deployed_commit:
- approval_e_id:
- provider:
- hostname:
- job_id:
- idempotency_key_hash:
- provider_request_count:
- result_status:
- artifact_id:
- artifact_count:
- raw_response_stored:
- operational_writes:
- secret_scan:
- duplicate_replay:
- services_1_2_3_unchanged:
- existing_v4_unchanged:
- unknowns:
- blockers:
- recommended_next_scope:
END_HANDOFF_PHASE_6
```
