# 월별 키워드 자동 갱신 조정기와 증분 입력

## 현재 v5 구현 경로

이 변경의 중앙 연결 버전은 `keyword-monthly-incremental-v5`다. `refresh_keyword_monthly_incremental.cjs`가 같은 run의 완전 수집·완전 DB 후처리 증거를 확인한 뒤, `reconstruct_keyword_monthly_incremental.cjs` 전용 프로세스에서 저장 입력을 정규화한다. 앱 진입점은 텍스트로 파싱해 필요한 선언만 사용하며 앱 서버·수집기·공급자 서비스를 실행하지 않는다. Linux launcher는 고정된 두 guard 이름, 코드·Node SHA, 같은 PID의 seccomp 증거와 네트워크 차단을 검사한다.

전송은 기존 launcher의 `receiptOnly` 방식으로 표준 입출력을 `/dev/null`에 연결한다. Linux Node 부모의 `pipe`는 Unix socket일 수 있으므로 엄격한 표준 입출력 검사를 완화하지 않는다. 부모는 종료 코드 0, 새로운 UUID 작업 폴더의 준비 완료 파일, 정확한 관측 시각, 자식/격리 proof/준비 결과의 같은 PID, proof SHA와 코드 SHA를 검증한다. stdout JSON은 완료 근거로 쓰지 않는다. v3/v4의 실패·보류 큐 원장은 보존하고 v5의 새 job identity로 같은 저장 수집·DB 근거를 검수한다. 이는 원본 재수집이 아니다. 유효한 v3/v4/v5 발행 영수증에는 동일한 기존 보존 정책과 각 버전의 정확한 sourceKey 검증을 적용한다. 정확한 source tuple과 완료 영수증이 있는 v4 작업은 v5 도입만으로 다시 준비하지 않는다. 실패·불명확한 이전 작업을 성공으로 바꾸거나 같은 원장을 덮지 않는다.

처리 방식은 합계에 새 금액을 더하는 방식이 아니다. 새 입력과 변경된 의존성만 private 상태에 채택하고, 영향받은 키워드·월을 기존 `monthly_reports.cjs`와 전월 비교·insights 계산기로 다시 만든다. 변경하지 않은 공개 scope는 기존 partition 연결을 유지한다. 이 문서의 설계·사본 회귀·트랜잭션 시험은 운영 배포나 실제 최신 run의 화면 채택 완료 증거를 대신하지 않는다.

### 최초 초기화와 이후 입력

- 최초 checkpoint가 없을 때만 원본 `company_master/companies.json`과 `history/observations.jsonl`을 각각 한 번 스트리밍한다. 각 파일 상한은 2GiB, 초기화 시간 상한은 15분이며 512MiB 물리 여유를 확인한다. 같은 읽기에서 원문 바이트 수·SHA와 읽기 전후 `dev/ino/size/mtimeNs/ctimeNs/nlink`를 검증한다. 검증하지 못한 부분 초기화는 성공 pointer가 될 수 없다.
- 이후 월별 worker는 원본 마스터·전체 이력 본문을 다시 읽지 않는다. 기존 원본 writer가 이미 보유한 자료에서 별도 immutable outbox에 변경/삭제된 업체와 원래 순서, 실제로 추가된 관측만 기록한다. 원래 writer가 수행하던 저장·읽기 계약은 유지한다. outbox 완료는 운반 내구성이고 DB 완료나 월 자료 채택을 뜻하지 않는다.
- worker는 원본별 정확한 before/after stamp 사슬로 delta를 연결한다. 중복 event는 한 번만 적용한다. 시각이 오래된 신규 자료도 처리하며, fork·누락·외부 변경·불완전 운반은 검수 필요로 중단한다. 가장 최근 관측시각만으로 자료를 건너뛰지 않는다.
- private 경로 `keyword_monthly_incremental/`에 업체 raw shard, 순서·식별 metadata, 물리행 순서의 history segment, 압축 checkpoint와 원문/저장 SHA를 둔다. 최초 이후에는 신규 delta와 필요한 private shard만 읽는다. 원본과 기존 회차 이력은 수정하지 않는다.
- 신규 history event마다 run·keyword·manifest SHA·schedule occurrence·완료시각을 포함한 DB 증거를 고정한다. child가 capture한 manifest와 대조하고 부모의 최초 검증 및 `beforePromote`에서도 같은 증거 tuple을 다시 확인한다. 다른 신규 run의 manifest가 바뀌어도 먼저 확인한 run ID만으로 통과시키지 않는다.

큐 활성시각과 v1/v2/v3/v4 기존 원장은 보존한다. checkpoint 초기화가 필요하면 활성시각 이후의 실제 완료 자료 중 최신 한 건으로 초기화를 요청하며, 모든 과거 완료 작업을 새로 실행하지 않는다. 완료·실패·보류 이력은 버전별로 구분한다. 기존 72개 legacy 원장과 그중 실패/검수 필요 20개를 정상 완료로 바꾸거나 삭제하지 않는다.

### 영향 범위와 계산 보존

업체 보정·관측·식별자/별칭/중복 place 연결·현재 객실 기준·상품별 시점 근거·달력·지역·계산 코드 변경은 영향받는 키워드와 과거 월까지 전파한다. 마스터에 keyword exposure가 없어도 저장 이력의 keyword와 run 참조에서 의존성을 찾는다. 부분 업체만 재준비할 때도 객실 이력의 alias 소유권은 전체 업체의 원래 순서로 판단한다. 신규 월과 그 월을 전월로 비교하는 기존 다음 달 scope도 검토한다. 회차 metadata만으로 실제 관측이 없는 새 월을 발행하지 않는다.

동일 업체·숙박일·상품의 모든 필요한 run 후보와 중간 관측을 보존한다. 원래 JSON key 순서, source 순서와 중복 선택 규칙을 유지하므로 동일 시각 tie도 바뀌지 않는다. 최초/최종 변화, 인접 관측 픽업, 순위와 관측 선행일수, 페이스·분포, 숙박/데이유즈 전월 비교를 기존 식으로 계산한다. 모집단에는 해당 월의 유효 순위만 있는 업체도 남기며 전체 달력 일수를 분모로 삼는다. 결측 `null`과 실제 관측 0을 구분하고, 확인된 부분 금액은 정상 예상매출에 합산하지 않는 별도 소계로 유지한다. 실패·unknown legacy·부분 회차의 원래 품질도 보존한다.

증분 keyword run 캐시는 별도 namespace에서 원문 run 지문, 전체 provider 식별 모집단과 보정 입력, 대상 업체, 원래 관측시각까지의 상품 근거, 계산 코드 SHA를 확인한다. 새 run이 추가됐다는 이유만으로 합계를 더하지 않는다. 기존 run의 의존성이 같으면 재사용하고 달라지면 그 계산단위를 다시 만든다. 의존성을 확정할 수 없을 때 전체 원본 복사나 옛 결과로 자동 우회하지 않는다.

### 게시와 복구

v5의 전체 partition 의미 검증은 1GiB heap 상한과 네트워크 차단을 유지한 정규화 child 안에서 수행한다. 새 입력뿐 아니라 재사용할 기존 immutable generation도 같은 `inputPartition` 분석기로 검증하며, 정확한 초기 pointer/catalog, 입력 directory·index·projection 바이트 SHA, 노출 scope·cutoff, 자료 마감과 선택 digest를 작은 준비 descriptor에 묶는다. 부모는 child 종료·같은 PID·proof SHA·준비 결과 SHA를 확인한 뒤 이 descriptor와 실제 바이트를 대조한다. 준비 descriptor가 없거나 달라지면 부모의 전체 계산으로 우회하지 않는다.

부모의 게시와 공개 readback은 projection의 압축 해제·정규화·당월/전월 snapshot 생성을 수행하지 않는다. 각 게시·readback 단계의 분석 횟수와 strict child 경로 전체의 부모 분석 횟수는 구분해서 기록한다. 일반 사본 publisher는 기존 의미 검증을 같은 프로세스에서 먼저 수행할 수 있으므로 그 경로의 전체 부모 분석 횟수를 0이라고 표현하지 않는다. 이 구조는 기존 웹 부모의 메모리 종료 원인이 특정 함수의 누수였다는 판정이 아니라, 실제로 확인된 큰 그래프 생성 경로를 한도가 있는 프로세스로 옮기는 변경이다.

원본 입력 채택 checkpoint와 공개 bundle pointer는 별도 단계다. worker는 전용 lock, 기대하는 이전 pointer SHA, immutable 준비 증거, 게시 intent, 원자 교체와 공개 readback을 사용한다. 게시 직후 중단된 작업은 현재 catalog가 intent와 정확히 같고 보관된 준비 증거의 압축 SHA·원문 SHA 및 해당 과거 checkpoint SHA가 모두 검증될 때만 완료를 복구한다. 자료가 없거나 다르면 재계산·재게시로 성공을 추정하지 않는다.

전용 worker lock은 v5에서 소유 프로세스의 boot/PID namespace·시작 tick과 공개 작업 ID를 기록한다. 소유 비밀 nonce와 작업 폴더 ID를 구분하며, 진단 결과에는 nonce·원문 잠금·nonce가 들어간 legacy 폴더 경로를 출력하지 않는다. 일반 시작 경로는 기존 lock이나 복구 claim을 나이만으로 제거하지 않는다.

별도 검토한 사망 작업 복구는 정확한 큐 job ID와 저장 lock·manifest·같은 run/slot DB 완료·준비/격리 증거·source checkpoint·현재 발행 영수증을 먼저 대조한다. 현재 서버와 검증된 조상 프로세스 이외의 Node/Python, 살아 있는 소유자/자식, 수집·DB 후처리·증분 작업의 실행/대기, 보호 상태 또는 미완료 발행 intent는 보류 사유다. 기존 v2의 역사 이월과 현재 실행은 구분한다. 기존 schema1 lock에는 별도로 검토한 종료 사건 근거도 필요하다. 고정된 snapshot SHA의 dry-run을 통과한 뒤 모든 근거를 다시 읽어 확인한다.

schema1의 과거 PID가 현재 검증된 서버·조상에서 재사용된 경우에는 별도 재사용 검토 대상으로만 표시한다. 고정 system `getconf CLK_TCK`, kernel boot 시각과 [`/proc/PID/stat`의 시작 tick](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html), 같은 time namespace 및 현재 wall/uptime 일치 검사를 거친다. 보수적인 현재 프로세스 시작 하한보다 독립 검토한 같은 과거 PID의 exit134 시각이 엄격히 앞설 때만 dry-run·복구를 허용한다. 동적 시계 표본은 snapshot SHA에 넣지 않으며 매번 새로 검증한다. chain 밖 live PID, schema2 재사용, 불명확한 시계·namespace·identity, 같은 시각 경계는 계속 보류한다.

복구는 원본 lock을 삭제하지 않고 새로운 0700 private recovery 폴더로 보관한다. Linux [`renameat2(RENAME_NOREPLACE)`](https://man7.org/linux/man-pages/man2/rename.2.html)를 사용해 보관 목적지가 이미 있으면 덮어쓰지 않는다. 고정된 system Python의 단일 OS 호출에만 의존하고 환경·사용자 site·표준 입출력 전달을 차단한다. 지원 불명·실패에는 덮어쓰는 일반 rename으로 우회하지 않는다. 이동 전후 바이트 SHA·inode·권한을 대조하고 감사 영수증을 남긴다. 근거 변경이나 불완전 복구는 claim과 증거를 유지해 다시 보류하며, 원본·수집/DB/실패 원장을 수정하지 않는다.

과거 완료 영수증 재사용은 그 source event를 이미 처리했다는 이력이다. 이후의 현재 pointer를 바꾸거나 현재 월의 최신 채택을 인증하지 않는다. 실제 run → 같은 DB 완료 → 정확한 작업/준비 영수증 → 현재 catalog/partition → 채택 관측 → 실제 UI를 별도로 확인한다. 화면 GET은 저장된 projection만 읽으며 수집·원본 정규화·게시를 시작하지 않는다. UI의 지표 정의·표 수치나 표시 식을 이 변경으로 수정하지 않는다.

### 저장소와 읽기 경계

| 대상 | 경계 |
| --- | --- |
| private source/checkpoint 신규 바이트 예약 | 960MiB, 기존/실패 파일도 검사하며 새 blob 쓰기 전에 예약 |
| 증분 keyword run 캐시 | 별도 64MiB, gzip, 최대 512단위 |
| 한 작업의 임시 공간 | 기존 1GiB, 쓰기 중 물리 할당 검사 |
| 한 번에 재계산하는 scope | 최대 128개를 순차 처리; 129개면 임의 절단 없이 보류 |
| 물리 저장소 여유 | 512MiB, 새 blob 크기도 함께 고려 |
| outputs metadata | 최대 15,000파일·깊이 10·파일 512MiB·합계 4GiB, symlink/hardlink 거부 |
| 원본 master/history metadata | 본문 읽기 없이 파일별 최대 8GiB 검사; 최초 bootstrap의 본문 상한 2GiB와 별개 |
| 작은 부속 입력 seed | capacity-bases, special_days, saved_product_recoveries만 `wx` 복사; 파일 8MiB·합계 64MiB |

960MiB 예약과 64MiB run 캐시, 1GiB 작업 한도를 따로 적용한다. 기존 namespace가 2GiB 이상이면 허용하는 새 기준으로 삼지 않고 보류한다. 한도 초과나 여유 부족을 자동 증설·원본 삭제·과거 기록 정리로 해결하지 않는다. host `statfs` 값은 물리 여유 검사이며 Render 서비스의 별도 quota 증거가 아니다.

도입 전 운영 catalog에 이미 65개 scope가 확인되어 v3의 파생 계획 상한은 128개로 정했다. 첫 전역 초기화에서는 이 기존 범위를 보존해야 한다. 이후에는 변경 키워드의 영향 범위를 처리한다. 이 상한은 새 파생 계산 계획의 경계이며 하루 6회 일정·호출 한도·기존 source-copy 8개 후보·작업/게시 저장소 한도를 늘리는 설정이 아니다. 다음 정규 슬롯까지 61분 이내이면 새 준비를 시작하지 않는 기존 guard도 유지한다. 호스트 작업은 60분, child 실행은 55분 안에서 제한한다.

원본 outputs는 metadata inventory에 묶인 읽기 전용 참조다. 실제 필요한 saved body의 SHA·읽기 전후 상태를 검사한다. 코드와 원본 참조를 읽기용으로 열어도 FileHandle/fd의 쓰기·truncate·chmod 등은 허용하지 않는다. 최초 이후 원본 master/history는 metadata 전용으로 제한한다. 입력 본문을 매회 전체 복사/재스캔하는 경로를 없앴지만, outputs의 전체 metadata 목록 검사, outbox·private 상태의 metadata 검사 및 영향 월의 private 후보 재계산은 남아 있다. 따라서 “어떤 전체 스캔도 하지 않는다”는 성능 주장은 하지 않는다.

기존 하루 6회 일정·120분 간격·provider 호출 한도·pacing·보호/hold·DB 후처리 원장은 유지한다. KOSIS 코드·factory·연결·데이터·수집/재개 정책은 이 경로에서 호출하거나 변경하지 않는다. outbox 기록 실패는 독립 월별 갱신의 검수 사유로 남기고 원래 저장·수집 성공을 실패로 바꾸지 않는다.

### 고정 사본에서 확인한 범위

현재 회귀는 최신 동결 마스터를 그대로 유지한 채 history 420행과 run 1개를 추가한 고정 사본 비교다. raw master 파일 변경은 0건이다. private prepared compact의 `_integratedCapacity.observedMaximum`과 warnings metadata가 15개 업체에서 달라져 기존 run 계산단위 23개를 보수적으로 다시 만들었다. 이 15개는 raw 업체 변경 건수가 아니다. 해당 기존 단위의 수치 객실 기준(`maximumRoomCapacity`)·상품별 as-of 근거·금액 변화 때문에 다시 계산한 것도 아니다. 현재 근거 metadata 전체를 보수적으로 해시에 포함한 결과다.

신규 run에 대한 새 계산단위는 2개였고, 같은 delta 반복에서는 추가 원본 master/history 본문 읽기·event/행 채택과 saved-run 재로딩이 0이었다. 기존 단위의 불필요한 재계산 일부는 남아 있다. 이 수치는 해당 사본의 입력과 의존성에 한정되며 일반 처리시간·운영 최신성·프로덕션 성공 수치로 확대하지 않는다. 전량 계산과 증분 계산의 정규화 source·중간 관측·부분 소계·전월/픽업 결과 동등성이 판단 기준이다.

## 저장 이력 조회와 의존성 판정 비용

증분 이력 reader는 저장 partition의 회사 식별 header와 숙박월을 먼저 대조한다. 회사 refs가 있는 조회는 해당하지 않는 immutable segment를 열지 않는다. header의 네 필드 순서와 월로 partition key를 다시 검증하고, segment의 key·월·행 수·물리 ordinal 범위를 대조한다. 선택한 blob의 크기·압축 SHA·읽기 전후 상태·압축 해제 상한·행 header 검증은 유지한다. runId는 종전과 같이 실제 행에서 판정하며, 불명확한 숫자나 객체 식별값은 보수적으로 읽는다. 이 최적화는 건너뛴 blob의 본문까지 검수했다는 뜻이 아니다.

seed의 전체 inode·mtime·바이트 SHA와 읽기 전후 안정성 검증, 재계산 범위를 정하는 전역 지문과 회사별 의존성 전파는 그대로 유지한다. 일부 업체 변경의 scope를 더 좁히는 별도 최적화 초안은 이번 운영 변경에 포함하지 않는다.

코드 지문 변경 직후의 첫 작업은 전체 재검증이 필요할 수 있다. 이후 같은 코드에서 일부 입력만 바뀐 작업과 구분해 성능을 판단한다. 준비 영수증은 정규화·projection 생성·최종 bundle 준비의 실제 자식 프로세스 경과 시간을 나눠 보존한다. 이 시간은 안전 검증과 디스크 I/O를 포함하며 CPU 시간이나 공급자 응답 시간은 아니다.

저장 조회의 503은 기존 분석 owner·atomic 구간·체크포인트 대기·메모리 가드를 계속 적용한다. 응답의 선택적 `readGuard`에는 허용된 원인 열거값과 실패 당시 시각·상태만 남긴다. 65%/55% 메모리 기준, 저수위 표본 2회, 체크포인트의 1.5초 절대 제한과 socket/취소 수명은 바꾸지 않는다. 진단을 읽는 동작은 sampler 초기화·보호 해제·작업 시작을 수행하지 않는다.

## 공통 원장과 이전 버전 계약

`scripts/lib/keyword_monthly_refresh.cjs`는 수집과 별개의 작은 파생자료 갱신 원장이다. 자체적으로 수집기·공급자·앱 서버를 실행하거나 수집 일정·원본·DB 후처리·호출 한도·보호·KOSIS 정책을 수정하지 않는다. 이 문서는 연결 계약이며 운영 활성화나 실제 수집 완료 증거가 아니다.

## 공통 조정기 연결 계약

```js
const refreshQueue = createKeywordMonthlyRefresh({
  dataDir: DATA_DIR,
  readCompletedEvidence: async intent => ({
    runId: intent.runId, keyword: intent.keyword,
    manifestSha256: intent.manifestSha256,
    scheduleOccurrenceId: intent.scheduleOccurrenceId,
    status: "complete", quality: "complete", postprocessStatus: "complete"
  }),
  canProcess: async job => ({ allowed: true }),
  refresh: async (evidence, intent, { jobId, attempt, recoveredAt, signal }) => ({
    status: "published", generation: "...32hex...", pointerSha256: "...64hex...",
    scopeCount: 3, providerCalls: 0, networkAttempted: false
  })
});
```

예시의 증거와 승인 값은 실제 연결자가 같은 run·manifest·schedule과 저장 DB 후처리를 읽고 검증해 제공해야 한다. 상수로 성공을 반환하는 운영 연결은 허용되지 않는다. 조정기는 같은 ID·키워드·manifest SHA·schedule을 대조한 뒤에만 `refresh`를 호출한다. 완전 수집과 같은 run의 완전 DB 후처리가 모두 있어야 한다. 부분·재사용·실패·알 수 없음은 새 정상 완료가 아니다.

- `enqueue({runId, keyword, manifestSha256, scheduleOccurrenceId?, scope?})`는 작은 의도만 저장한다. 오류도 별도 `needs_verification` 결과로 돌려주며 원래 DB 후처리까지 예외를 전파하지 않는다.
- `readCompletedEvidence(intent)`는 진행 중이면 `null`, `{pending:true}` 또는 `{ready:false}`를 반환할 수 있다. 이 경우 갱신을 시작하지 않고 다음 검수로 미룬다.
- `canProcess(job)`는 boolean 또는 `{allowed:boolean, reasonCode?}`를 지원한다. 보호·메모리·수집 실행 상태를 알 수 없으면 허용하지 않는다. 보호 해제는 하지 않는다.
- `refresh(evidence,intent,context)`는 기존 분석 실행 제한 안에서 검증된 source를 읽어 변경 범위만 새 bundle에 발표한다. 기본 수집/DB 후처리와 별도 작업이며 원래 성공 영수증을 변경하지 않는다.
- 발표는 기존 bundle의 기대 pointer SHA·전용 lock·원자 교체·readback을 사용해야 한다. `jobId`와 입력 지문으로 이미 발표했는지도 확인해, 조정기 완료 영수증 직전 재시작되어도 같은 회차를 다시 합산하지 않아야 한다.
- 결과에는 `published`·`unchanged`·`complete`와 작은 통제 메타데이터만 남긴다. 원본 행·오류 원문·인증·토큰·환경변수는 원장/상태에 넣지 않는다.

## 내구성과 조회

원장은 `DATA_DIR/keyword_monthly_refresh/` 전용 경로다. 같은 디렉터리에 대해 **중앙 web의 조정기 한 인스턴스만 쓰는 계약**이며 BG나 별도 프로세스에서 같은 원장을 동시에 쓰지 않는다. 디렉터리는 private owner·0700(Linux), 부모/파일 realpath·비symlink·일반파일 nlink1, 파일 크기와 읽기 전후 identity를 검사한다. 임시 파일·파일 sync·rename·디렉터리 sync·readback을 거쳐 기록한다.

첫 `start` 또는 유효 `enqueue`의 초기화가 `activation.json.activatedAt`을 한 번 저장한다. 재시작/배포로 이 시각을 바꾸지 않는다. 원래 후처리 완료와 갱신 의도 저장 사이 누락을 보완하는 연결자는 이 시각 이후 실제 완료한 기존 후처리만 제한적으로 대조해 재신호한다. 과거 이력을 자동으로 전부 재구축하는 기준으로 사용하지 않는다.

`status()`는 cold 상태에서도 읽기만 한다. 디렉터리 생성·초기화·중단 작업 복구·수집·갱신·pointer 발표를 하지 않는다. 읽기 오류는 `items:null`·`counts:null`과 검수 필요로 표시하고 0으로 바꾸지 않는다. 갱신 보류가 남으면 상위 상태도 검수 필요다. `start()`가 복구와 worker 시작을 명시적으로 담당한다.

같은 계산 버전·run·manifest·키워드·scope·schedule은 같은 작업 ID다. 늦은/반복 신호와 동시 신호는 완료 기록을 재사용한다. 중단된 실행은 유효 원장을 다시 읽어 제한된 횟수만 복구하며, 갱신 발표가 불확실하거나 pointer 충돌/lock이 있으면 자동 재시도하지 않는다. 입장 대기 또는 DB 후처리 대기 중인 옛 작업이 이후 완료한 다른 작업을 계속 막지 않도록 다음 검수시각 순으로 처리한다.

기본 상한은 대기128개·전체2048기록·원장8MiB·개별8KiB다. 기존 원장·원본 이력을 자동 삭제하지 않으며 가득 차면 별도 검수 필요로 중단한다. 임시/작업 공간도 수집량이 아니라 물리 저장소의 검증된 한도 안에서 제한해야 하며 host `statfs`를 Render `/tmp` 서비스 한도로 해석하지 않는다.

## v1/v2 이력: 전체 사본과 압축 운반

v2 자동 갱신의 명시적인 전체 사본 모드는 `historyCompression: "gzip"`를 사용했다. 이 절은 이전 버전의 계약과 독립 사본 도구의 호환 동작을 보존하며, 현재 v3 정상 갱신 경로를 뜻하지 않는다.
관측 이력의 모든 원문 바이트를 gzip으로 운반하고, 격리된 정규화 프로세스에서
정확한 논리 이력 경로만 스트리밍으로 해제한다. 원문과 저장 압축파일의 길이·SHA를
각각 검증하며, EOF·해제 상한·원문 SHA 검증이 끝나지 않은 이력은 발행할 수 없다.
회사 마스터와 다른 core 파일은 기존 물리 사본을 유지한다. 기본 내보내기 도구의
raw 모드는 바뀌지 않는다.

원문 이력 512MiB, 전체 물리 core 사본 512MiB, 전체 임시 작업 1GiB의 상한은 유지한다.
압축 전 원문 합계와 실제 물리 사본 합계는 다른 계수다. 사전검사는 원문 본문을 읽어
압축률을 추정하지 않고 물리 상한과 여유 예약을 사용한다. 복사하는 동안 실제 물리
바이트와 파일시스템 할당 한도를 계속 확인한다. 호스트 statfs를 Render 서비스의
별도 임시 저장소 quota로 표현하지 않는다.

읽기 전용 사전검사는 새 복사 prefix와 소유권 marker 생성 전에 끝낸다.
계약 불일치·비압축 core 상한·저장소 여유 부족은 별도 사유로 거부한다.
이미 있는 외부/소유권 불명 준비 폴더나 발행 불명확 상태는 무시·삭제하지 않는다.
기존 실패 이력도 정상 완료로 고치지 않는다.

v2 당시 중앙 연결자는 `keyword-monthly-refresh-compressed-v2` 큐 버전으로 신호를 기록했다. 현재 중앙 연결자는 `keyword-monthly-incremental-v5`를 사용하며 v1/v2/v3/v4 기록을 보존한다.
단독 큐의 기본 v1과 발행 sourceKey 계산 버전은 그대로다. 작업자는 자신의 버전만
실행·중단 복구하고 다른 버전의 원장 파일은 보존한다. 전역 오류와 전체 건수도
유지하면서 `currentVersionCounts`, `historicalCountsByVersion`,
`currentVersionNeedsVerification`, `historicalNeedsVerification`를 별도로 읽어 표시한다.
과거 발행 영수증 재사용은 이번 실행의 포인터 변경이나 현재 월 자료의 최신성 증거가
아니며, 그 옛 포인터를 기준으로 retention을 시작하지 않는다. 현재 반영 성공은
실제 run/DB 완료에서 현재 partition과 채택 관측·UI까지 따로 확인해야 한다.

## 시험

```text
node --check scripts/lib/keyword_monthly_refresh.cjs
node --test scripts/test_keyword_monthly_refresh.cjs
```

시험은 조정기의 중복·대기·부분/실패 제외·중단 복구·발표 불확실성·저장 오류 복구·기록 한도·경로 탈출·읽기 전용 상태 경계를 검증한다. 실제 정규화 사본의 금액/원본 지문/전월 비교와 실제 관리자 화면 검수는 별도의 증거다.
