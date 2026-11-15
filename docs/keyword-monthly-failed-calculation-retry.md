# 저장 자료 계산 실패의 명시적 1회 재시도

`retry_keyword_monthly_failed_calculation.cjs`는 수집을 실행하지 않는다. v5 파생 계산이 `needs_verification`, 실제 시도 3회, 자동 상한 3회로 끝난 경우에만 운영자가 실패 자료와 배포 코드를 검토한 후 한 번 더 계산하도록 같은 작업을 대기 상태로 바꾼다. 대기 등록 시 기존 누적 3회와 자동 상한 3회를 보존하며, 실제 실행 시 이번 승인에 한해 누적 4번째 시도를 기록한다. 자동 상한은 계속 3회다. 실패·중단·계산 중 입장 보류가 발생해도 5번째 실행을 자동 예약하지 않는다.

1. 운영 서버에 진단·보완 코드를 배포하고 현재 실행 파일을 확인한다.
2. `--mode inspect`와 작업 번호, 실패 당시 작업 파일 SHA, 실패 영수증 UUID·SHA, 현재 공개 포인터 SHA, 현재 원본 체크포인트 포인터 SHA를 전달한다. 실제 파일을 읽어 원본 manifest·DB 후처리 완료, 실패 격리 증거, 배포된 guard 변경, 마지막 정상 발행 근거, 작업 잠금·발행 의도·완료 영수증 부재를 확인한다. 이 단계는 기록을 쓰지 않는다.
3. 반환한 `reviewSha256`를 검토한 뒤 같은 인수에 `--mode commit --review-sha <검토 SHA>`를 전달한다. 공유 유지보수 잠금과 인증된 내부 API의 실제 유휴 상태를 재확인한다.
4. 원래 실패 작업의 바이트는 `operations/keyword-failed-calculation-retry/<jobId>/<codeFingerprint>/original-job.json`에 0600·배타적 생성으로 보존한다. 검토본·1회 승인본·대기 작업·결과 영수증도 같은 전용 폴더에 남는다. 해당 작업과 코드 조합의 폴더가 이미 있으면 재승인하지 않는다. 불완전 감사 폴더도 자동 삭제하거나 덮어쓰지 않는다.
5. `restartRequired:true`를 확인한 뒤 기존 프로세스의 메모리 상태를 안전하게 종료·재시작하는 별도 운영 절차를 따른다. CLI는 서버 재시작이나 작업 실행을 하지 않는다. 큐는 실행 직전 고정 경로의 승인 영수증·원래 실패 기록·현재 코드 지문을 다시 확인한다.

필수 CLI 옵션:

```
--mode inspect|commit
--job-id <64자리 SHA>
--expected-job-sha <실패 작업 파일 SHA>
--failure-id <실패 실행 UUID>
--expected-failure-sha <failed-incremental 영수증 SHA>
--expected-public-pointer-sha <현재 공개 포인터 SHA>
--expected-source-pointer-sha <현재 원본 체크포인트 포인터 SHA>
--review-sha <inspect 검토 SHA, commit만>
```

변경 없는 코드에서 과거의 일반 `KEYWORD_PREP_CHILD_FAILED`를 진단할 때만 `--diagnostic-purpose diagnose_prior_generic_child_failure`를 명시할 수 있다. 자동 재시도나 제한 초기화 옵션은 없다. 현재 공개 결과가 실패 작업의 최초 포인터와 달라진 경우 이 도구는 보류한다. 수집 원본·발행본·보호 상태·예약·수집 횟수·요청 속도는 수정하지 않는다.

재시도 승인 후 작업 파일 교체 또는 감사 저장이 불확실하면 `KEYWORD_FAILED_RETRY_NEEDS_READBACK`으로 알리며, 원래 자료로 자동 되돌리거나 다시 실행하지 않는다. 오류 출력에는 통제된 코드와 해시만 남기고 비밀번호·토큰·고객 정보·자식 오류 메시지를 출력하지 않는다.
