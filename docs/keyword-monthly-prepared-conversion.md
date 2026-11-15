# 기존 월별 키워드 자료의 준비 결과 전환

이 작업은 기존 불변 catalog1의 노출 조건을 그대로 catalog2로 게시하는 명시적 운영 작업이다. 원본 재수집·통합 DB 재계산·과거 발행본 수정·인사이트 정기수집 재활성화가 아니다. 기존 `materializedAt`, `dataThrough`, 관측 마감일과 원본 지문은 유지한다. 전환 성공만으로 최신 원본 검증을 완료했다고 표시하지 않는다.

## 실행 조건

- 현재 포인터의 정확한 SHA를 명시한다. 예전 세대 번호만으로 실행하지 않는다.
- 단일 유지보수 marker를 배타적으로 보유한다. 새 분석 작업은 이 marker 뒤에서 대기하며 기존 분석·점검 읽기·메모리 표본 작업이 끝날 때까지 최대 60초 확인한다. 대기 중인 분석 작업은 실행하지 않고 보류한다.
- 기존 worker lock·복구 claim·게시 lock이 있으면 실행하지 않는다. 오래됐다는 이유로 삭제하지 않는다.
- localhost `127.0.0.1:10000`에서 기존 운영 관리자 환경변수로 로그인하고 읽기 전용 상태 API로 실제 분석·수집·수집 후처리의 종료와 수집 대기열 공백을 확인한다. `GLAMPING_ADMIN_USER`/`ADMIN_USER`, `GLAMPING_ADMIN_PASSWORD`/`ADMIN_PASSWORD`가 명시적으로 있어야 하며 앱의 기본 비밀번호로 대체하지 않는다. 비밀번호·쿠키는 메모리에서만 사용한다.
- Linux 격리 실행, fresh memory 55% 이하, 디스크 여유 약 1.75GiB 이상이 필요하다. 자식 V8 heap 512MiB, 55분, 준비 결과 총 128MiB·개별 8MiB, 작업 폴더 1GiB 한도를 유지한다. 한도를 넘으면 이전 포인터를 보존한다.

## 1. 준비와 동등성 검증

운영 Shell에서 현재 코드 경로와 실제 포인터 SHA를 확인한 뒤 실행한다. 아래 자리표시자는 실제 검증값으로 바꾼다.

```sh
node scripts/convert_keyword_monthly_prepared.cjs --mode stage --data-dir /var/data --code-root /opt/render/project/src --expected-current-sha <현재_current.json_SHA256> --now <고정_ISO_시각>
```

`/var/data/operations/keyword-prepared-conversion-YYYYMMDD/<식별자>` 아래 전용 비공개 폴더를 만든다. 같은 원본·계산 코드의 동일 작업 폴더가 이미 있으면 자식을 다시 실행하지 않는다.

정확한 SHA로 고정한 전환 자식만 Python launcher에서 실행한다. 실행 전 seccomp로 네트워크·상속 소켓·우회 FD 경로를 차단하고 환경변수를 정리한다. 자식은 현재 포인터와 해당 세대만 읽고 자신의 폴더에만 쓴다. 원본 history/outputs, 업체 DB, 발행본과 고객 설정은 읽기 허용 범위에도 넣지 않는다.

각 노출 키워드·숙박월의 기본 마감일에서 기존 결과를 계산하고, 준비 결과를 별도 게시한 뒤 전체 `snapshot`(현재·이전월 비교 포함), `request`, `activity`, `latestAttempt`, `lastSuccessfulAttempt`, `diagnostics`의 논리 SHA가 정확히 같은지 확인한다. 어떤 조건이 실패하거나 미확인이면 해당 값을 0으로 만들거나 조건을 제외하여 게시하지 않는다. 전체 조건이 통과해야 준비가 완료된다.

출력의 `jobDir`, `completionSha256`, `scopeCount`, `preparedResultCount`를 확인한다. stage는 운영 포인터를 바꾸지 않는다.

## 2. 정확한 준비 결과 게시

```sh
node scripts/convert_keyword_monthly_prepared.cjs --mode publish --job-dir <stage의_jobDir> --completion-sha <stage의_completionSha256> --expected-current-sha <stage_전의_current.json_SHA256>
```

새 유지보수 marker를 획득하고 상태를 다시 확인한다. 격리 증거·동일 자식 PID·코드 지문·준비 영수증·모든 원본 세대 파일의 SHA/메타데이터를 재검증한다. 부모는 금융 계산을 하지 않고 준비된 바이트의 해시·경로·수량·최종 catalog를 검증·복사한다. 실제 catalog2 SHA와 별도의 기존 scope plan SHA를 게시 intent에 남긴 후 예상 이전 SHA가 일치할 때만 원자적으로 포인터를 바꾼다.

새 세대와 이전 세대는 모두 남기며 기존 발행본·원본·수집 보호/예약 설정은 변경하지 않는다. 전환 게시를 자동 수집 완료로 위장하지 않으며 기존 증분 source checkpoint도 수정하지 않는다. 다음 정상 증분 게시가 있으면 그 경로가 자신의 정상 영수증으로 checkpoint를 갱신한다.

## 단절·실패 후

```sh
node scripts/convert_keyword_monthly_prepared.cjs --mode inspect --job-dir <jobDir>
```

이 명령은 읽기 전용이다. `publish-intent`가 있거나 포인터가 이미 바뀐 상태에서는 같은 게시를 다시 실행하지 않는다. 정확한 새 세대·게시 영수증을 별도로 검수하며, 불명확한 결과를 이전 포인터로 자동 복원하거나 작업 폴더·유지보수 marker를 자동 삭제하지 않는다. 프로세스가 정상 종료하면 자신이 만든 marker만 정확한 바이트·inode로 확인해 해제한다. 프로세스 강제 종료로 남은 marker는 별도 운영 검토 대상이다.

운영 검수는 최초·반복·전체 새로고침·후속 자동 갱신을 나누어 측정하고, `sourceRevalidated:false`/`originalFreshnessVerified:false`를 실제 최신 원본 반영 완료와 구별한다.
