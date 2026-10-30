# 키워드 월별 분석

관리자의 **업종분석 → 키워드 월별**에서 정확한 검색어와 실제 관측 자료가 있는 숙박월을 선택한다. 같은 업체·숙박일·상품유형의 최신 유효 관측을 한 번씩 반영하고, 조건을 맞출 수 있는 전월 자료를 비교한다. 기존 월간 리포트의 초안·발행·PDF 흐름은 유지한다.

운영 조회 기능은 검증된 정규화 사본의 파생 집계를 읽는다. 운영 집계 준비와 화면 조회를 분리하며, 배포만으로 자료 준비나 재수집을 시작하지 않는다. KOSIS 전면 보류를 유지하며 정규 수집 일정·원본·예약 이력·호출 간격·동시 요청 수·한도·보호 장치를 변경하지 않는다.

## 명시적 사본 준비와 읽기 전용 조회

두 단계는 분리되어 있다.

1. 운영과 분리해 준비한 정규화 source 사본을 명시적 오프라인 builder에 입력한다. builder는 **존재하지 않는 새 출력 디렉터리**에만 파생자료를 만든다. 입력 사본과 provenance는 수정하지 않으며 기존 디렉터리나 과거 결과를 덮어쓰지 않는다.
2. 화면의 GET은 이미 준비된 파생자료만 제한적으로 읽고, 기존 순수 월별 엔진과 비교 함수를 메모리에서 실행한다. 원본 JSONL·DB 스캔, KOSIS·context 조회, 공급자 호출, queue 실행, cache 생성, 파일 쓰기와 `utimes`는 없다. 자료가 없거나 오래됐다고 자동 준비·수집을 시작하지 않는다.

수집 완료 hook이나 자동 갱신 연결은 포함하지 않는다. 새 자료를 반영하려면 별도 사본을 준비해 새 버전의 projection을 명시적으로 검증해야 한다. 이 문서의 준비 명령 자체가 운영 적용이나 경로 교체의 승인을 뜻하지는 않는다.

## 입력 계약과 오프라인 명령

source JSON은 기존 월별 엔진의 정규화 자료다. 필수 배열은 `companies`, `runs`, `observations`이며 `rankObservations`는 선택이다. 오류·누락·부분 응답 flag, 가격의 null, 재고·공유·공급 기준과 관측 시각을 보존한다. 고객·연락처·주소·계정·인증·원문 payload·KOSIS/context 자료는 이 입력에 포함하지 않는다.

정규화 사본은 같은 버전의 `createMonthlyReportSources` 경로로 준비해야 한다. 이 경로의 canonical identity 검사, 회사별 현재 객실 기준 투영, 저장 원문 재계산의 같은 키 대체 순서를 유지한다. `inventory.productSnapshot.daily` 원시 행을 직접 덧붙이거나 발행본의 최신 선택 행만 복사한 자료를 완전한 정규화 이력으로 취급하지 않는다. 원시 부분 응답에는 이전 객실 기준이 남을 수 있고, 저장 원문 재계산에서만 생성되는 부분·무효 행도 있으므로 금액 소계와 대상 분모가 달라질 수 있다. 준비 단계의 원본·정규화·제외 계수와 실행/회사/기간 범위, 코드 버전 및 SHA를 별도 완전성 영수증으로 대조한다.

검증된 `savedProductRecoveries: [{row, certificate}]`만 기존 엔진의 증명 규칙으로 재생할 수 있다. row digest가 다른 복구나 임의 품질 승격은 허용하지 않는다. 같은 시각 관측의 선택 순서와 복구 digest를 보존하기 위해 정규화 row를 임의로 다시 작성하지 않는다.

`--provenance`에는 최대 64KiB의 작은 일반 JSON 파일을 지정한다. 허용 필드는 다음과 같다.

```json
{
  "inputSha256": "실제 source 파일의 소문자 SHA256 64자리",
  "inputBytes": 12345,
  "copiedAt": "2026-10-30T00:00:00.000Z",
  "observationScope": "selected_only",
  "selectionCutoffs": {
    "2026-09": "2026-09-22",
    "2026-10": "2026-10-22"
  }
}
```

위 SHA·크기·시각은 형식 예시다. 실제 파일 값과 확인된 복사 시각으로 작성한다. `inputSha256`·`inputBytes`가 있으면 CLI가 실제 source 바이트와 일치하는지 검사하고 실제 값을 builder에 전달한다. 다른 필드나 모순된 값은 거부한다. 복사 시각을 `--copied-at`에도 지정하면 provenance의 시각과 같아야 한다.

`observationScope`는 `selected_only`, `normalized_multirun`, `verified_history_subset`, `unspecified` 중 하나다. 원본 전체 관측이나 전체 회차 목록을 확인하지 않은 사본을 완전한 이력으로 표시하지 않는다.

기존 상위 폴더 아래의 새 출력 경로를 사용한다. 다음 명령의 경로·시각은 해당 사본의 실제 근거로 바꾼다.

```powershell
node scripts/build_keyword_monthly_projection.cjs `
  --source C:/isolated/monthly/source.json `
  --provenance C:/isolated/monthly/source-provenance.json `
  --output C:/isolated/monthly/projection-v1 `
  --now 2026-10-30T00:00:00.000Z `
  --data-through 2026-10-22T10:32:41.525Z
```

`--now`는 명시적 검증 기준 시각이며 생략하면 실행 시각이다. `--data-through`는 사본 자료의 확인된 마지막 시각이다. 입력의 관측·시도 시각보다 앞선 값은 거부한다. builder는 출력 경로가 source나 provenance를 포함하는 경우도 거부한다.

CLI source 상한은 64MiB다. runtime index는 1MiB, keyword/month별 저장 projection은 32MiB로 제한한다. 완전 정규화 자료가 32MiB를 넘으면 값을 버리지 않고 gzip으로 저장한다. 해제 크기는 64MiB 상한과 index의 정확한 `uncompressedBytes`를 함께 검사한다. 알 수 없는 인코딩·손상·크기 불일치는 검증 오류이며 기존 JSON 형식도 유지한다. 파일·부모 경로의 symlink와 경로 이탈을 검사하고, 일반파일의 hardlink·읽기 전후 identity/크기/시각 변경을 거부한다. index가 발표한 scope와 SHA·크기·원본 fingerprint를 확인하며 변경·오류를 정상 0으로 바꾸지 않는다.

## 기준일과 사본 범위

일반 `normalized_multirun`·`verified_history_subset` 사본의 기본 관측 마감일은 **오늘, 숙박월 말일, 사본 `dataThrough`의 KST 날짜 중 가장 이른 날**이다. 사용자가 마지막 자료 시각 이후를 명시하면 `stale`과 `CUTOFF_AFTER_DATA_THROUGH`로 구분한다. 중간 관측이 완전하지 않으면 그 한계를 별도로 표시한다.

`selected_only`는 이미 특정 기준일에 선택된 최종 row만 있는 사본이다. 그 row를 과거 날짜로 단순 필터해 과거 상태를 재구성할 수 없다.

- 실제 관측월마다 검증된 `selectionCutoffs`가 필수다. 예시의 9월 22일·10월 22일은 해당 발행 source와 전월 source의 기준일을 함께 확인했을 때만 사용한다.
- options의 `defaultCutoffs`·`supportedCutoffs`를 화면 기본값으로 사용하며 날짜 입력은 해당 기준일만 지원한다.
- 다른 기준일 요청은 `snapshot: null`, `status: missing`, `CUTOFF_NOT_RECONSTRUCTIBLE`, `supportedCutoffDate`로 응답한다. 이를 관측 0건이나 매출 0원으로 표시하지 않는다.
- 명시된 기준일이 마지막 실제 관측보다 늦어도 해당 기준일의 고정 선택 결과를 재생할 수 있다. 전월도 정렬된 기준일의 source가 있어야 비교하며, 없으면 `PREVIOUS_CUTOFF_NOT_RECONSTRUCTIBLE`로 비교를 제외한다.

기본 projection 유효 기간은 materialized 시각으로부터 24시간이다. 만료는 `stale`·`PROJECTION_EXPIRED`로 표시한다. `materializedAt`, `dataThrough`, 입력 SHA와 `originalFreshnessVerified: false`를 함께 반환한다. 방금 사본을 만들었다는 사실은 운영 원본의 최신 변경을 확인했다는 뜻이 아니다.

## 월별 수치와 전월 비교

- 대상 월은 수집월이 아닌 **숙박일이 속한 월**이다. 순위만 관측한 업체도 표본에 남기되 재고·매출은 결측으로 둔다.
- 동일 canonical 업체 ID·숙박일·상품유형의 최신 유효 관측 1건만 채택한다. 같은 회차의 중복 row나 반복 회차 스냅샷을 합산하지 않는다. 관측 마감일 후와 숙박일 후 관측은 제외한다.
- 더 최신인 오류·무효 응답이 이전 유효 관측을 지우지 않는다. 부분 재고·부분 금액은 정상 소계와 구분한다. 실제 0과 자료 없음·가격 미확인은 별개다.
- 숙박과 데이유즈는 각각 집계하며 단위와 비교 대상도 구분한다. 예상 금액은 실제 결제 매출이 아니다.
- 전월 비교는 같은 업체와 월중 대응 날짜 중 공급 수량·공급 근거·공유 기준·재고 버전·가격 산정 정책·관측 선행일수가 같은 쌍만 사용한다. 두 달의 가격 근거가 함께 확인된 쌍에만 금액 증감을 계산한다. 이전 금액이 실제 0이면 증가율은 null이다.
- `comparisonByProduct.lodging`과 `comparisonByProduct.dayuse`를 제공하고 기존 `comparison`은 숙박 비교 alias다. 양월의 해당 상품 유효 관측이 없으면 비교는 null이다. 신규 관측·전월 미관측은 개업·폐업을 뜻하지 않는다.

수집월별 activity는 **제공된 run 집합에서 확인한 고유 회차**만 센다. `coverageBasis: provided_unique_run_set`, `counterScope: provided_runs_only`이며 전체 월의 시도·실패·차단 수를 뜻하지 않는다. `runInventoryComplete`는 기본 false이고 명시적으로 검증된 `sourceDiagnostics.runInventoryComplete === 1`만 true다. 포함 목록의 실패 0을 전체 운영 실패 0으로 해석하지 않는다. `latestAttempt`도 이 목록 범위이며 `lastSuccessfulAttempt`는 선택된 실제 마지막 유효 관측을 뜻한다.

## 관리자 API와 보안 경계

| 요청 | 읽는 자료 |
| --- | --- |
| `GET /api/keyword-monthly/options` | 준비된 index의 정확한 키워드·관측월·기본/지원 기준일 |
| `GET /api/keyword-monthly?keyword=...&month=...&cutoffDate=...` | 해당 scope의 준비된 projection과 동일 source의 전월 자료 |

API는 관리자 인증과 GET만 허용한다. POST·갱신·재구축 경로는 없다. server 연결 경로는 `DATA_DIR/keyword_monthly_analysis`이며 조회로 폴더를 만들지 않는다. 기존 단일 index와 독립 키워드·월 partition bundle을 지원한다. 기존 리포트 preview POST, integrated GET의 재계산, source cache `getOrBuild`, 수집·DB 후처리 queue를 호출하지 않는다.

## 운영 준비와 버전 연결

운영 원본에 기존 source adapter를 직접 실행하면 파생 catalog·관측 index·객실 기준이 갱신될 수 있다. 준비 작업은 별도 `export_keyword_monthly_source_copy.cjs`로 명시된 저장 자료의 메타데이터·용량을 먼저 확인한다. 업체 원장·관측 이력·객실 기준 등 핵심 자료만 새 물리 사본에 두고, 큰 outputs는 동결 목록에 포함된 파일만 읽기 전용으로 참조한다. 원본 파일·부모 경로와 실제 읽은 본문의 SHA를 전후 대조한다. 이는 outputs 전체 물리 사본이나 원본 행 전수 감사를 뜻하지 않는다.

정규화의 DATA_DIR와 파생 cache는 사본 경로만 사용한다. 원래 source adapter의 스트리밍 history 분기를 사용해 별도 SQLite/WAL을 만들지 않는다. 원본·개별 일정·broker·보호·KOSIS 자료는 수정하지 않는다. 사본·임시 작업의 별도 하드 상한을 1GiB로 제한하며 `statfs`의 호스트 여유 공간을 Render의 `/tmp` 서비스 한도로 해석하지 않는다. 실행기는 검증한 Node·guard 코드 지문과 seccomp 네트워크 차단을 확인한 뒤에만 정규화를 시작한다. 조회용 projection은 `--compression gzip`으로 손실 없이 압축할 수 있으며 기존 저장·해제 상한을 넓히지 않는다.

키워드별 source fingerprint와 월별 진단은 합쳐 쓰지 않는다. `build_keyword_monthly_bundle.cjs`는 각 준비 index와 projection의 바이트를 그대로 불변 generation에 보존하고 정확한 키워드·월을 해당 partition에 연결한다. 입력의 `exposeScopes`는 전월 자료를 포함한 partition에서 실제 공개할 월만 선택한다. 중복 scope·SHA/크기 불일치·경로 이탈은 거부한다. 마지막 `current.json` 발표는 기대 이전 SHA와 전용 lock을 대조해 원자 교체하며 이전 generation은 보존한다. 이후 단계에서 오류가 나면 미반영으로 단정하지 않고 실제 pointer를 다시 확인한다.

`prepare_keyword_monthly_release.cjs`는 후보를 순차 준비하고 정확한 현재·정렬 전월의 금액 지문을 실제 조회 factory와 대조한다. 정규화 child는 표준 입출력을 사용하지 않으며 원래의 엄격한 seccomp 실행기, 실제 PID가 일치하는 새 격리 proof·완료 영수증·source SHA로 검증한다. 영수증 없는 종료 코드 0은 성공이 아니다. 실패하면 다음 후보와 운영 pointer 발표를 중단하고 새 부분 산출물을 보존한다.

회사 목록을 합치면서 삽입 순서만 달라진 경우에는 양쪽 회사 고유번호의 유일성·수·집합을 확인하고 감사용 회사 배열만 원 순서로 복원한다. 그 뒤에도 변경하지 않은 원래의 전체 snapshot 지문과 정확히 같아야 통과한다. 원본·화면 배열·금융 값은 수정하지 않으며 원래/복원 지문과 적용 여부를 별도로 기록한다.

준비의 `--publish-months 이전월,현재월`은 공개하는 월 목록만 한정한다. 예를 들어 9월에 관측한 10월 숙박행은 11월/10월 준비본에서도 그대로 보존하지만 별도 검수하지 않은 9월을 추가 공개하지 않는다. 관측행·회차·원본 지문·금액 계산은 변경하지 않는다. 옵션을 생략하면 기존 전체 월 준비 동작을 유지한다.

정규화 과정의 진단 계수가 관측 마감일에 의존할 때에는 `normalizationCutoffs`로 실제 준비한 월별 기준일을 선언한다. 이는 여러 회차 관측을 `selected_only`로 바꾸는 필드가 아니다. 조회는 선언된 기준일만 지원하며 전월의 정렬 기준일이 준비되지 않았으면 비교를 제외한다. 기존 `selected_only.selectionCutoffs`와 두 정책을 동시에 선언할 수 없다.

24시간이 지난 준비본은 `stale` 상태와 자료 기준시각을 유지한다. 근거 범위 안의 값은 화면에서 **과거 저장근거 · 갱신 확인 필요**로 구분해 열람할 수 있고 현재 최신 자료로 승격하지 않는다. 자료 마감 이후의 기준일이나 검수 오류 응답은 수치 표시를 차단한다. Bundle을 새로 묶어도 개별 partition의 materializedAt·dataThrough를 갱신하지 않는다.

화면은 새 탭에서 이전 run bootstrap을 재개하지 않고 숨은 기존 결과를 다시 그리지 않는다. KOSIS 조회·늦은 렌더링은 새 탭에서 차단하며 탭 이탈·권한 변경·로그아웃 시 요청/민감 결과를 정리한다. 일반 조회 오류, 누락 projection, 불일치, 최신 실패와 마지막 유효 관측은 서로 구분한다.

## 검증 명령과 한계

```text
npm run test:keyword-monthly
```

기능 테스트(`analysis`, `http`, `projection_cli`, `analysis_ui`, `app_integration`), 압축 저장/읽기와 완전 사본 검수기의 반증 fixture, 기존 `test_monthly_report_comparison.cjs`를 실행한다. CLI 검증은 원 source/provenance·조회 후 파생파일 불변, 기준일 제한, 기존 출력 거부, 경로·크기·링크·변경 검출을 포함한다. 기존 package scripts는 유지한다.

가공 사본 재생·로컬 UI 검수와 운영 관리자 화면 검수는 다른 결과다. selected-only 사본은 중간 관측 전체, 전체월 호출·실패 이력, 원본 행 전수 감사의 증거가 아니다. 이 기능의 검증 통과만으로 운영 배포·수집 변경·KOSIS 보류 해제를 수행하지 않는다.

최초 제한 사본 검증에서는 최신 선택 행과 일부 원시 부분 행만 사용해 부분 금액 소계가 원발행과 달랐다. 당시 `legacyFullParity: false`와 보류 증거는 수정하지 않고 보존했다.

2026-10-30 2차 검수는 발행 코드 버전의 순수 source adapter와 prepare/project/saved-recalculation 경로를 새 물리 사본에서 재생했다. 가평 23업체·2,437관측, 경남 30업체·7,396관측의 두 숙박월 전체 정규화 사본을 사용했으며 최신 선택 행만 복사한 자료가 아니다. 가평의 누락 7개 키를 복원하고, 경남은 원시 snapshot의 26실 대신 저장된 capacity registry의 15실이 준비 단계를 거쳐 반영되도록 원래 경로를 유지했다. 부분 소계는 가평 숙박 27,305,000원·데이유즈 255,000원, 경남 숙박 53,716,000원으로 원발행과 일치했다.

원발행 지문 대조는 요약·일별·canonical 업체별 소계·선택 관측 digest·부분 응답 근거·전월 비교의 6개 항목을 독립 추출 witness에 연결한다. 원 source 계수·관측 멀티셋·회사 고유번호 연결·명시적 신원 미확정 제외와 source SHA를 함께 확인한다. 같은 source에 대한 현 엔진 일치, 두 배 관측의 소계 불변, 최신 무효/실패 관측이 이전 정상값을 지우지 않는 반증은 별도 검사다. 두 배 실자료 입력은 메모리의 순수 엔진으로 검수하며 큰 중복 projection을 발행하지 않는다.

달마다 경고·신원 미확정 계수가 달라 `source.monthlySourceMetadata[YYYY-MM]`의 `warnings`, `sourceDiagnostics`, `globalWarnings`, `globalDiagnostics`를 현재/전월에 각각 적용한다. 수량·시각·회차 품질을 수정하지 않는다. 이 월맵을 사용하는 입력은 실제 관측 키워드가 하나여야 하며, 서로 다른 키워드의 진단을 평탄화해 합치면 거부한다.

완전성은 동결된 10/22 사본 내의 지정 키워드와 9·10월 정규화 관측에 한정한다. 전체 달 수집 완료·실제 결제 매출·모든 실패/미실행 회차·현재 운영 자료가 완전하다는 뜻이 아니다. 보유 사본의 독립 검수 결과와 화면의 기본 미확인/전체 이력 경고를 구분한다. 운영 배포·수집 일정·원본·이력·보호·KOSIS 보류는 변경하지 않았다.

## 새 수집 완료 후 자동 갱신 연결

`keyword_monthly_refresh`는 원래 수집/DB 후처리와 독립된 파생 작업 원장이다. 새 완료 회차의 run·키워드·manifest SHA·예약 회차를 고유 키로 삼고, **동일 run의 수집/품질과 durable DB 후처리 완료**를 모두 확인한 뒤에만 해당 키워드의 기록된 숙박월·수집월·기존 다음 달 비교 범위를 준비한다. 원래 DB 영수증에는 신규 완료분부터 `result.sourceManifestSha256`만 선택적으로 추가한다. 기존 영수증은 소급 수정하지 않으며, 과거 영수증에 이 SHA가 없다는 이유로 새 완료 근거를 만들어내지 않는다.

처음 활성화한 시각 이후의 새 완료분만 누락 신호를 대조한다. 관리자 GET/재조회는 원장을 활성화하거나 작업을 생성하지 않는다. 같은 회차의 반복 신호, 재시작, 늦은 신호는 같은 입력을 다시 더하지 않는다. 발행 직후 중단은 의도한 catalog와 실제 publication 영수증·scope 조회가 일치할 때만 복구한다. 불확실한 포인터를 자동 복원하거나 무조건 재발행하지 않는다.

갱신은 기존 분석 실행 제한의 background 작업이며, 수집 진행/대기·보호·미확인 보호 상태에는 대기한다. 다음 정규 슬롯까지 61분 이내이면 새 준비를 시작하지 않는다. 공급자 호출·수집 재실행·호출 간격/동시성/한도 변경은 없고 KOSIS 보류를 해제하지 않는다. 운영에 별도 `OUTPUTS_DIR`를 지정한 구성은 지원 여부를 명시적으로 보류하며 다른 폴더를 대신 읽지 않는다.

준비는 기존 물리 핵심 사본·동결 outputs 읽기·정확한 원래 정규화·엄격한 Python/seccomp 자식 실행을 유지한다. 파일 복사에서 사용하는 전역 fs 제한은 반드시 별도 복사 프로세스에만 적용한다. 웹 프로세스에 이 제한을 설치하지 않는다. 새 파생 세대를 완전히 검증한 뒤 CAS로 포인터를 바꾸고, 실패하면 기존 검증 자료를 유지한다. 자동 갱신 실패는 수집/DB 후처리 실패로 바꾸지 않는다.

상한은 자체 scratch 1GiB, 날짜별 작업 1GiB, 파생 bundle 1GiB이며 새 세대는 128MiB이다. 검증이 끝난 자기 UUID 임시 작업만 소유권·경로 확인 후 정리한다. 세대 정리는 완료된 **자기 자동 갱신 영수증**과 원래 publication SHA로 입증된 예전 자동본만 대상으로 하며, 현재본·최근 자동본 2개·수동/외부 세대·기존 최초 세대·완료 증거·원본 수집 및 이력을 보존한다. 정리는 같은 분석 실행 제한과 발행 잠금 안에서 수행한다. 상한/불명확한 소유권/정리 실패는 별도 검수 경고이고 원본 삭제나 수집 재실행의 근거가 아니다.

관리자 화면은 자료 마감 시각과 자동 반영 상태를 구분한다. 화면 재진입 또는 `저장 자료 조회`는 새로운 목록과 지원 마감일을 읽어 최신 검증본을 조회한다. 이미 열린 브라우저 화면을 강제로 바꾸는 push/실시간 폴링은 하지 않는다.

## 업체 선택과 전체 평균 비교

기본 전체 예약 추정률은 유효 관측의 `예약 추정 수량 합계 / 공급 합계`이며 **선택 업체를 포함하는 공급 가중 값**이다. 선택 제외 값은 별도로 표시한다. 각 업체의 월 예약률을 한 번씩 평균한 업체 동일가중 참고 평균은 다른 정의이므로 합치지 않는다. 월 원래 수치/전월 비교는 이 추가 비교 기능 때문에 바뀌지 않는다.

선택 업체와 전체의 차이는 `%p`로 표시한다. 업체마다 관측 날짜가 다를 수 있는 월 전체 값은 참고치이고, 같은 숙박일·관측 선행일수·재고/공유 기준이 맞는 표본을 따로 대조한다. 선택 업체의 한 관측을 상대 업체 수만큼 복제하지 않는다. 수량의 관측 업체·일당 평균과 완전 가격 관측의 업체·일당 금액은 분모와 표본 업체 수를 각각 표시한다. 완전 가격을 확인하지 못한 별도 부분 응답 금액을 정상 평균에 넣지 않는다.

업체 선택과 상품 전환은 같은 저장 snapshot에서만 순수 계산하며 추가 API/공급자 호출이 없다. 관측 없는 업체/날짜·0분모·부분 수량·품질 미확인·가격/재고 기준 불명확은 정상0으로 바꾸지 않는다. 평균 차이는 성과 우열이나 가격/쿠폰 자동 조정의 근거가 아니다.
