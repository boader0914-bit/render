# 복구된 lock 실패 회차의 명시적 재대기

이 도구는 사용자가 승인한 특정 **파생 집계** 작업 하나만 재대기시킨다. 수집 재실행·예약 변경·보호 해제·원본 수정·기존 발행본 교체는 하지 않는다. 자동 재시도 정책이나 큐 버전도 바꾸지 않는다.

대상은 현재 v5의 `needs_verification / KEYWORD_INCREMENTAL_WORKER_LOCKED`이며 남은 시도 횟수가 있어야 한다. 완료된 lock 복구의 정확한 receipt·snapshot·보존 lock·원래 job-input과 target jobId/sourceKey가 일치해야 한다. v4→v5 추정 매핑은 허용하지 않는다. 원본 manifest·업체 DB 완료 영수증도 복구 시점의 SHA와 일치해야 한다. active worker lock·recovery claim·publish lock·해당 source의 미확정 intent·이미 완료한 receipt가 있으면 중단한다.

## 읽기 검토

중앙 웹 Render Shell에서 운영 root는 `/var/data`로 고정된다. 아래 실제 SHA·ID는 해당 파일의 읽기 결과로 채운다.

```sh
node scripts/retry_keyword_monthly_reviewed_lock.cjs --mode inspect --job-id TARGET_V5_JOB_ID --expected-job-sha EXACT_FAILED_JOB_FILE_SHA --recovery-id COMPLETED_RECOVERY_UUID --recovery-sha EXACT_RECOVERY_COMPLETE_FILE_SHA
```

출력의 `snapshot`과 `reviewSha256`을 검토한다. inspect는 디렉터리 생성·인증·큐 실행 없이 읽기만 한다.

## 승인된 동일 작업만 재대기

```sh
node scripts/retry_keyword_monthly_reviewed_lock.cjs --mode commit --job-id TARGET_V5_JOB_ID --expected-job-sha EXACT_FAILED_JOB_FILE_SHA --recovery-id COMPLETED_RECOVERY_UUID --recovery-sha EXACT_RECOVERY_COMPLETE_FILE_SHA --review-sha REVIEWED_INSPECTION_SHA
```

commit은 공유 maintenance marker를 `wx`로 획득한다. 운영 인증정보는 loopback 로그인 프로세스 메모리에서만 사용하고 출력·저장하지 않는다. 실제 분석·수집·후처리 idle을 확인한 뒤 원장 변경 직전에 다시 확인한다. 미확인·경합은 중단하며 다른 작업이나 보호를 강제로 끝내지 않는다.

`/var/data/operations/keyword-reviewed-lock-retry-YYYYMMDD/JOB_ID/`를 새로 만들고 `owner.json`을 배타적으로 기록한다. 기존 실패 job의 **원래 바이트**는 `original-job.json`, 승인 snapshot은 `reviewed-preflight.json`, 계획된 다음 값은 `planned-job.json`으로 보존한다. 같은 감사 폴더는 덮어쓰지 않는다.

정확한 inode·크기·변경시각·SHA와 maintenance 소유권을 마지막까지 대조하고 임시 파일을 sync한 뒤 원자 rename한다. 이 방식의 신뢰 경계는 기존 중앙 단일 writer와 공유 maintenance 제외 프로토콜이다. Node rename이 악의적인 비협조 writer에 대한 원자 compare-and-swap syscall이라고 주장하지 않는다. 관측된 바이트·inode 변경은 덮어쓰지 않는다.

새 job은 같은 `intent`·`jobId`·`attempts`·`maxAttempts`·`createdAt`을 보존한다. 상태만 `queued`, 사유는 `KEYWORD_INCREMENTAL_REVIEWED_LOCK_RETRY`로 바꾸고 새 `recoveredAt/nextAttemptAt`을 기록한다. 이전 lock 진단은 원래 감사본에 남기고 새 대기 표시에서는 제거한다. `retry-complete.json`에 전후 SHA를 기록한다.

**실행 중인 서버 큐는 메모리 사본을 가지고 있으므로 `restartRequired:true`이다.** 이 도구는 Render 재시작이나 실제 집계를 시작하지 않는다. 운영자가 동일 commit으로 정상 재시작한 뒤 기존 큐가 이 단일 queued 작업을 읽는지 확인한다. 이후 실제 최신성은 manifest→업체 DB→새 partition/준비 결과→운영 화면의 수집 번호와 반영 값을 따로 검수한다. queued 출력은 계산 완료가 아니다.

rename 뒤 감사 저장이나 readback이 실패하면 `KEYWORD_REVIEWED_RETRY_NEEDS_READBACK`으로 중단한다. 이미 바뀐 job을 무조건 되돌리거나 또 재시도하지 않고, 남은 감사 파일과 실제 job을 먼저 확인한다. 원래 실패 이력과 다른 job·원본·발행본은 보존한다.

검증 명령:

```sh
node --test scripts/test_keyword_monthly_reviewed_lock_retry.cjs
```
