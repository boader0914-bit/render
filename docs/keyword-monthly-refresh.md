# 월별 키워드 자동 갱신 조정기

`scripts/lib/keyword_monthly_refresh.cjs`는 수집과 별개의 작은 파생자료 갱신 원장이다. 자체적으로 수집기·공급자·앱 서버를 실행하거나 수집 일정·원본·DB 후처리·호출 한도·보호·KOSIS 정책을 수정하지 않는다. 이 문서는 연결 계약이며 운영 활성화나 실제 수집 완료 증거가 아니다.

## 연결 계약

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

## 시험

```text
node --check scripts/lib/keyword_monthly_refresh.cjs
node --test scripts/test_keyword_monthly_refresh.cjs
```

시험은 조정기의 중복·대기·부분/실패 제외·중단 복구·발표 불확실성·저장 오류 복구·기록 한도·경로 탈출·읽기 전용 상태 경계를 검증한다. 실제 정규화 사본의 금액/원본 지문/전월 비교와 실제 관리자 화면 검수는 별도의 증거다.
