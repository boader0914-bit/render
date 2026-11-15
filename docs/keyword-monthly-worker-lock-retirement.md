# 재배포 뒤 남은 증분 게시 잠금의 검토 복구

`worker-lock.json`은 `/var/data`에 남지만 PID·부팅·네임스페이스는 재배포 때 바뀔 수 있다. 운영 schema2의 `OWNER_OTHER_INSTANCE`는 이전 실행과 현재 실행의 식별자가 다르다는 뜻이다. 나이, 현재 PID 부재, HTTP 정상 응답은 이전 인스턴스가 종료됐다는 근거가 아니다. 기본 획득은 계속 `EEXIST`를 거부하며 자동 회수·자동 재시도는 없다.

기존 복구는 같은 인스턴스의 검증된 종료만 처리했다. 이번 도구는 **운영자가 별도로 검토한 인스턴스 퇴역·영속 디스크 인계 증거**를 명시적으로 받을 때만 다른 인스턴스를 검토한다. 기존 schema1과 같은 인스턴스에는 이 예외를 적용하지 않는다. 서비스는 중앙 `srv-da9q6don74is738t7id0`, 실제 마운트는 `/var/data`로 한정한다.

## 1. 읽기와 외부 근거

로그인된 중앙 웹 Render Shell에서 다음 명령은 저장 파일과 현재 `/proc`만 읽는다. raw hostname·boot ID·token은 출력하지 않는다.

```sh
node scripts/lib/keyword_monthly_worker_lock.cjs --inspect-context
```

`sourceKey`와 일치하는 소유 작업의 queue jobId를 찾아야 한다. 새로 막힌 작업이 다른 버전/sourceKey이면 그 작업 번호로 이전 잠금을 복구하지 않는다.

외부 근거로 실제 서비스·디스크 연결·인스턴스 수, 이전 배포와 새 배포 시각, 이전 전체 hostname이 나온 기존 증거를 확인한다. Render의 영속 디스크 단일 인스턴스 인계 보장은 [공식 문서](https://render.com/docs/disks)를 검토한다. 정책 문서만으로 실제 서비스의 디스크 연결이나 인스턴스 종료를 확인했다고 표시하지 않는다.

전체 이전 hostname은 저장된 `owner.bootId`와 `SHA256(JSON([hostname, bootId]))`로 비교한다. pod suffix만 추측해서 일치했다고 처리하지 않는다. 시간은 실제 종료 시각을 만들지 않고, 독점 디스크 인계로 확인된 **종료 상한** `retirementNoLaterThan`으로 저장한다.

## 2. 퇴역 증거 문서

`/var/data/operations` 아래 소유자 권한 0600인 별도 JSON을 운영자가 준비한다. 다음 필드를 모두 요구한다. 문서 전체 바이트 SHA를 CLI에 전달한다.

```json
{
  "schemaVersion": 1,
  "action": "reviewed_retired_instance_worker_lock",
  "serviceId": "srv-da9q6don74is738t7id0",
  "persistentDiskMount": "/var/data",
  "priorDeploymentId": "dep-실제이전배포번호",
  "priorDeploymentStartedAt": "실제 ISO 시각",
  "retirementNoLaterThan": "종료가 보장되는 ISO 상한",
  "retirementBoundBasis": "exclusive_persistent_disk_handover",
  "currentDeploymentId": "dep-실제현재배포번호",
  "currentInstanceStartedAt": "런타임 로그 또는 검증된 프로세스 출생 근거의 실제 ISO 시각",
  "reviewedAt": "실제 검토 ISO 시각",
  "lockSha256": "현재 읽은 잠금 바이트 SHA",
  "ownerContextSha256": "inspect-context 출력값",
  "currentContextSha256": "inspect-context 출력값",
  "priorInstanceHostname": "기존 증거의 전체 hostname",
  "priorHostnameEvidenceSha256": "기존 hostname 증거의 SHA",
  "providerEvidenceSha256": "배포·종료 상한·실제 서비스 디스크 검토 근거의 SHA",
  "diskExclusivityEvidenceSha256": "검토한 영속 디스크 인계 보장 근거의 SHA",
  "priorInstanceTerminationBoundVerified": true,
  "exclusiveDiskHandoverVerified": true
}
```

위 예시는 실행 가능한 실제 증거가 아니다. 도구는 외부 provider를 호출하거나 증거의 진위를 대신 확인하지 않는다. 두 true 값은 운영자가 해당 근거를 실제 검토한 경우에만 설정한다. 이전 배포 시작 ≤ 잠금 생성 ≤ 종료 상한 ≤ 새 인스턴스 시작 ≤ 검토 시각이어야 한다. `currentInstanceStartedAt`은 실제 런타임 시작 로그나 검증된 프로세스 출생 근거를 사용한다. Render UI의 새 배포 요청·trigger 시각은 디스크 인계 이전일 수 있으므로 이 필드에 사용하지 않는다. 종료 상한을 새 인스턴스 시작 시각과 같게 두는 것은 독점 디스크 인계에 따른 상한이며, 이전 인스턴스의 정확한 종료 시각이라는 뜻은 아니다. 두 배포 번호가 다르고, 현재 문맥 지문도 저장 소유자와 달라야 한다.

첫 런타임 이벤트의 관측 시각을 사용하면 정확한 pod 출생 시각이 아니라 서비스 시작이 확인된 보수적 상한이라고 외부 검토 근거에 명시한다. 초 단위로 표시된 npm 로그를 밀리초 단위 실제 출생 시각으로 확대 해석하지 않는다.

## 3. 전체 사전검사·별도 승인·보존 복구

```sh
node scripts/lib/keyword_monthly_worker_lock.cjs --inspect --job-id OWNER_QUEUE_JOB_ID --server-pid CURRENT_WEB_PID --retired-instance-proof /var/data/operations/retirement.json --retired-instance-proof-sha EXACT_FILE_SHA
```

현재 웹의 실제 Node와 조상 계통, 다른 계산·수집·후처리·보호 상태, 원본 manifest와 업체 DB 완료 근거, 이전 정상 source checkpoint·공개 pointer·발행 영수증, 대상의 미확정 publication intent 부재를 모두 다시 확인한다. 이전 owner/child의 PID는 퇴역한 다른 네임스페이스의 번호이므로 현재 PID와 비교하여 생존·종료를 판단하지 않는다. 현재 인스턴스의 다른 작업·peer 확인은 유지한다.

이 snapshot을 검토한 기존 `reviewed_dead_worker_lock_recovery` 문서는 그대로 필요하다. 퇴역 경로의 `incident`만 다음 세 필드로 연결한다.

```json
{"kind":"retired_instance","retirementProofSha256":"snapshot.retiredInstance.proofSha256","evidenceSha256":"providerEvidenceSha256"}
```

같은 `--retired-instance-proof` 인수에 기존 `--reviewed-proof`·`--proof-sha`를 더하고 `--dry-run`을 먼저 실행한다. 실제 승인은 `--commit`으로만 수행한다. 도구는 잠금을 삭제하지 않고 `renameat2(RENAME_NOREPLACE)`로 새 전용 감사 폴더의 `original-lock.json`에 원래 바이트·inode·mode를 보존한다. 새로운 잠금·문맥 변경·출판 상태 불명확 시 중단하며 미완료 감사 claim을 남긴다. source·원본·발행본·큐 기록·수집·정기예약은 변경하지 않는다. 이후 계산 재실행은 별도의 명시적 작업이며 복구 도구가 시작하지 않는다.

## Render의 읽기 불가한 외부 포트 검사 peer

`/proc/PID/exe`가 EACCES/EPERM인 같은 UID 프로세스는 기본적으로 계속 중단 사유다. 이름·UID만으로 Render 소유라고 자동 판정하지 않는다. 실제 Render 배포의 포트 검사 로그와 커널 metadata를 운영자가 별도로 검토한 경우에만 단일 `portdetectorv2` peer를 예외로 할 수 있다.

```sh
node scripts/lib/keyword_monthly_worker_lock.cjs --inspect-provider-peers --job-id OWNER_QUEUE_JOB_ID --server-pid CURRENT_WEB_PID
```

이 읽기 전용 명령은 정확히 한 개의 같은 UID 읽기 불가 후보를 요구한다. `/proc/stat`, comm, 선택한 status 필드를 전후로 읽는다. PPid=0, UID 네 값 모두 현재 UID, CapInh/Prm/Eff/Amb 모두0, NoNewPrivs=1, Seccomp=0, 실제 웹보다 이른 startTicks가 필수다. CapBnd는0을 요구하지 않는다. 동적으로 바뀌는 Vm·thread·CPU 카운터는 지문에 포함하지 않는다. cmdline·환경변수는 읽지 않는다. PPid=0은 namespace 밖 부모라는 커널 관측일 뿐 Render 소유권을 스스로 증명하지 않는다.

출력된 `peer` 객체를 그대로 사용해 운영자 검토 proof를 `/var/data/operations` 아래 0600 파일로 준비한다.

```json
{
  "schemaVersion": 1,
  "action": "reviewed_render_external_port_detector",
  "serviceId": "srv-da9q6don74is738t7id0",
  "targetJobId": "읽기 명령의 targetJobId",
  "lockSha256": "읽기 명령의 lockSha256",
  "currentContextSha256": "읽기 명령의 currentContextSha256",
  "serverPid": 0,
  "serverStartTicks": "읽기 명령의 serverStartTicks",
  "peer": {},
  "providerEvidenceSha256": "현재 실제 Render 배포 포트 검사·서비스 문맥을 검토한 근거 SHA",
  "reviewedAt": "실제 검토 ISO 시각"
}
```

예시의0과 빈 객체는 유효한 값이 아니다. 실제 출력의 serverPid와 전체 peer를 넣어야 한다. full inspect/dry-run/commit에 `--provider-peer-proof /var/data/operations/peer.json --provider-peer-proof-sha EXACT_FILE_SHA`를 추가한다. 기존 retirement proof와 최종 snapshot approval도 계속 필요하다.

예외는 `peers()`의 해당 PID에 대한 EACCES/EPERM 분기에만 적용한다. owner·child liveness 검사나 일반 제외 PID 목록에는 적용하지 않는다. PID/start/PPid/UID/선택 status·comm·현재 문맥·실제 웹 출생이 달라지거나 새 unreadable peer가 생기면 계속 중단한다. 다음 배포의 새 PID 문맥에는 기존 proof를 재사용하지 않고 실제 상태를 읽어 다시 검토한다. snapshot과 감사 영수증은 provider proof 지문을 보존한다.

## 재발 방지와 수명

서버의 정상 종료는 integration.close → queue abort → 자식 close 대기 → worker lease release로 연결해야 한다. 이 연결은 서버 소유 코드의 별도 변경이다. SIGKILL·OOM은 JavaScript 정리를 실행하지 않으므로 위 검토 복구가 필요할 수 있다. 향후에도 잠금 나이만으로 자동 회수하지 않는다.

저장 bundle의 명시적인 prepared 변환 작업은 별도 maintenance marker를 먼저 획득한다. 일반 worker는 자신의 `wx` 전·후에 marker를 확인하고 active/미확인을 `deferred:true`로 반환한다. 둘이 겹쳐 계산하거나 정상 수집 설정을 바꾸지 않는다.
