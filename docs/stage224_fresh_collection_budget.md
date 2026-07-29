# Stage 224 신규 수집 예산 동결

- 상태: Stage 224 승인 기준 동결
- 기준 시각: 2026-07-29 KST
- V2 기준 commit: 4e4e1906e2967fe58df66f8ad67f832043d2763b
- Cluster 비교 commit: 57a6c561496812126e2ff2e8a61bff51099b2423
- 대상 서비스명: glamping-datalab-v2
- 현재 외부 수집 실행 권한: 없음
- 현재 외부 provider별 realRequestLimit: 0회
- 현재 외부 provider별 approvedCapKRW: 0원
- 현재 외부 provider별 expectedCostKRW/hardMaxCostKRW: 0원/0원

이 문서는 기존 V2·Cluster 데이터의 이관 예산이 아니라, 빈 통합 store에서 시작하는
신규 수집 예산만 정의한다. Stage 224에서는 실제 외부 요청을 한 건도 실행하지 않는다.
provider 계약, 자격 증명, 쿼터, 비용 단가가 승인되기 전에는 아래의 모든 외부 수집
feature flag가 false이고, 승인되지 않은 호출은 runtime guard가 요청 전 차단해야 한다.

## 1. 동결 결정

1. migration, backfill, import, seed-from-legacy, dual-write 건수는 각각 0건이다.
2. V2와 Cluster의 outputs, DB, cache, history, config 및 수집 산출물은 신규 store의
   입력으로 사용할 수 없다.
3. 신규 store의 최초 상태는 collection row 0건, identity mapping 0건,
   provider cursor 0건이다.
4. 기존 파일에서 얻은 값은 구현 근거와 예산 산식 검증에만 사용한다. 기존 수집 결과를
   신규 store의 사업 데이터로 저장하지 않는다.
5. 정적 자산은 승인된 allowlist 항목만 runtime에서 읽을 수 있다. KOSTAT 2013
   시군구 경계 GeoJSON 1개만 원천 blob과 checksum 대조를 거쳐 허용한다.
6. provider 승인 전 실제 호출량·일일 quota·비용 cap은 모두 숫자 0으로 동결한다.
7. 승인 역할은 모두 지정되어 있으므로 Stage 224 blocker는 0개다. provider enable은
   현재 단계의 blocker가 아니라 별도 변경 승인을 요구하는 후속 release gate다.
8. Stage 223 integration preview는 계약 테스트 fixture만 보존한다. runtime migration,
   backfill, seed 또는 dual-write 경로로 사용할 수 없다.

## 2. 근거와 재현 범위

| 구분 | 근거 경로 | 확인한 예산 입력 |
|---|---|---|
| V2 crawler | scripts/gyeongnam_glamping_crawl.cjs | quick 요청, booking detail fan-out, OTA 요청 수, concurrency, delay, legacy booking ID fallback |
| V2 app server | scripts/glamping_app_server.cjs | quick/detail 예상 시간 모델, legacy store 경로 |
| V2 tourism | scripts/tourism_collector.cjs | 3개 API source, 지역·월별 호출 수, timeout, cache |
| V2 traffic probe | scripts/traffic_sources_probe.cjs | DataLab·SearchAd 호출 단위와 legacy output/config 접근 |
| Cluster scheduler/connectors | Cluster commit의 scripts/glamping_app_server.cjs | Trend, SearchAd, SNS, OTA job, 429 retry, scheduler retry, quota 경고·중단 |
| Cluster traffic probe | Cluster commit의 scripts/traffic_sources_probe.cjs | signal 후보와 provider 호출 단위 |

planning target 수 R=46은 web/data/tourism_region_map.json의 항목 수를 코드 인벤토리로
센 값이다. 이 파일은 현재 quarantine 상태이며 runtime seed로 허용되지 않는다. 따라서
R=46은 수집 승인이나 정적 자산 승인으로 간주되지 않고, 예산 상한을 재현하기 위한
고정 입력일 뿐이다.

## 3. 예산 변수와 표본 동결

| 기호 | 동결 값 | 정의 |
|---|---:|---|
| R | 46 | 계획용 지역 seed 수 |
| P | 10 | 지역별 detail 후보 상한 |
| D | 460 | detail 대상 상한, min(실제 quick 고유 발견 수, R × P) |
| L | 46 | leadtime 대표 업체 상한, min(D, R) |
| T | 7 | booking 관찰 일수 |
| W | 3 | leadtime 관찰 시점 수 |
| E | 0 | 별도 explicit signal keyword 수 |
| U | 3 | 지역×category당 고유 keyword 수 |
| K | 598 | signal keyword 수, E + R × U + D |
| S | 3 | tourism source 수 |
| M | 1 | tourism 대상 월 수 |
| Q | 30회/분 | 예상 시간 계산 전용 simulator 처리율 |

W=3 관찰 시점은 숙박일 기준 D-14, D-7, D-1로 고정한다. calendar span은 13일이다.
Q=30회/분은 provider가 허용한 rate limit이 아니며 오직 시간 산정용 수치다. 현재
runtime 허용 rate는 모든 provider에 대해 0회/분이다.

## 4. 수집 범주별 요청량·시간 예산

시간은 외부 호출이 승인되었다고 가정한 planning simulator 값이다. nominal 시간은
nominalCalls ÷ Q를 기본으로 하되, V2에 더 큰 source timing model이 있으면 큰 값을
사용한다. 현재 승인 상태의 실제 예상 완료 시간은 요청 허용량 0회이므로 실행 불가다.

| 범주 | 대상 수 | nominalCalls | hardMaxCalls | nominal 예상 시간 | hard-max 예상 시간 | 산식·근거 |
|---|---:|---:|---:|---:|---:|---|
| quick | 46 지역 | 46 | 46 | 110.4분 | 110.4분 | 지역 main 1회 × R. V2 source model 144초/job × R 적용 |
| detail | 460 업체 | 17,480 | 252,080 | 582.7분 | 8,402.7분 | nominal 38회 × D, hard 548회 × D |
| V2 OTA direct | 46 지역 scope | 230 | 230 | 7.7분 | 7.7분 | NOL 2 + Goodchoice 1 + Ddnayo 2 = 5회 × R |
| Cluster generic OTA | 460 업체 | 460 | 2,760 | 15.3분 | 92.0분 | 1 job × D, 최대 6 provider calls/job |
| leadtime | 138 관찰 | 1,104 | 9,384 | 36.8분 | 312.8분 | L × W × nominal 8회 또는 hard 68회 |
| tourism | 138 source-month-region | 138 | 138 | 4.6분 | 34.5분 | R × S × M. hard 시간은 15초 timeout × 138 |
| search-volume SearchAd | 598 keyword | 598 | 3,588 | 19.9분 | 119.6분 | K jobs, 최대 6 calls/job |
| search-volume Trend | 598 keyword | 598 | 3,588 | 19.9분 | 119.6분 | K jobs, 최대 6 calls/job |
| SNS mention | 598 keyword | 598 | 3,588 | 19.9분 | 119.6분 | K jobs, 최대 6 calls/job |
| 합계 | 범주별 분모 유지 | 21,252 | 275,402 | 817.3분 | 9,318.8분 | 직렬 실행 기준 13.62시간, hard 155.31시간 |

합계 coverage를 하나의 백분율로 합치지 않는다. 각 범주의 분모와 acceptance를 각각
통과해야 한다. 한 범주의 대량 성공이 다른 범주의 누락을 가릴 수 없기 때문이다.
합계 시간은 행별 표시값을 다시 더하지 않고 반올림 전 정확한 초 합계 49,036초와
559,130초에서 계산한다.

### 4.1 detail 호출 산식

V2 booking detail의 업체당 nominal은 다음 표본을 고정해 계산한다.

- booking ID GraphQL 1회
- item list 1회
- 첫 날짜 night 4개 + day-use 1개 schedule 5회
- coupon page 1회
- 추가 6일 × schedule 5회 = 30회
- 합계 38회

업체당 hard max는 source branch의 최대치를 그대로 고정한다.

- booking ID GraphQL 최대 2회
- place-page fallback 최대 4회
- item list 1회
- 첫 날짜 night 최대 40회 + day-use 최대 20회
- coupon page 최대 1회
- 추가 날짜마다 night 최대 40회 + day-use 최대 40회
- hard formula = 68 + 80 × (T - 1) = 548회

V2의 NAVER_BOOKING_ID_FALLBACK 기본값 true는 이전 OUTPUT_ROOT CSV를 탐색하므로
신규 통합 runtime에서 금지한다. runtime은 NAVER_BOOKING_ID_FALLBACK=0을 강제하고,
legacy fallback branch 진입 시 외부 호출 전에 job을 실패시켜야 한다.

### 4.2 OTA 호출 산식

V2 direct OTA와 Cluster generic OTA는 별도 budget line과 feature flag를 갖는다.
동시에 켜는 것이 기본값이 아니며 중복 provider·동일 관찰 창은 논리 중복 gate가
차단한다.

- V2 direct: 지역 scope당 NOL 2회, Goodchoice 1회, Ddnayo 2회, 자동 retry 0회.
- Cluster generic: 업체당 요청 1회, 요청 body에 channel 목록을 포함한다.
- Cluster hard max: 429 immediate attempt 3회 × scheduler execution 2회 = 6회/job.

### 4.3 leadtime 호출 산식

leadtime은 L=46개 대표 업체를 D-14, D-7, D-1에 신규 관찰한다. quick에서 얻은
신규 identity만 사용하며 legacy identity를 보완 입력으로 사용하지 않는다.

- nominal: 한 시점당 ID 1 + item 1 + schedule 5 + coupon 1 = 8회.
- hard: 한 날짜 detail upper bound 68회.
- nominal: L × W × 8 = 1,104회.
- hard max: L × W × 68 = 9,384회.

### 4.4 tourism 호출 산식

source는 visitors, resourceDemand, diversity의 3개다. 지역 46 × source 3 × 월 1로
138회가 nominal과 hard max다. 현재 지역 코드 46개 중 9개가 verify-before-api-call
상태이므로 기존 코드 그대로 호출 가능한 값은 37 × 3 = 111회다. 그러나 Stage 224의
실제 호출 허용량은 0회이며, 9개 코드 검증과 정적 자산 승인이 끝나기 전 111회도
실행할 수 없다.

### 4.5 search-volume·SNS 후보 산식

별도 explicit keyword E=0, 지역별 고유 keyword U=3, 업체별 신규 keyword 1개를
사용하여 K=0 + 46×3 + 460 = 598로 동결한다. U의 source 최대치는 6이지만 이번
예산의 수집 대상은 U=3으로 고정하며 변경 시 이 문서와 JSON 원장을 함께 승인해야 한다.

SearchAd, Trend, SNS는 각각 keyword당 1 job이다. Cluster retry 정책을 이식하는
경우 hard max는 6 calls/job이므로 provider별 598×6=3,588회다.

## 5. provider별 quota·rate·비용 동결

아래 수치는 Stage 224 runtime의 강제 값이다. 계약서나 provider console의 실제
허용량을 추정하지 않는다. 향후 enable 변경은 provider별 승인 단가와 rate를 숫자로
등록하고 동일 승인자들이 서명한 변경 기록이 있어야 한다.

| provider·용도 | 요청 owner | 필수 approver | real rate limit | daily quota | unitCostKRW | approvedCapKRW | 현재 실행 |
|---|---|---|---:|---:|---:|---:|---|
| Naver Place quick | Data Platform Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | 0회/분 | 0회/일 | 0원 | 0원 | 차단 |
| Naver Booking detail·leadtime | Data Platform Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | 0회/분 | 0회/일 | 0원 | 0원 | 차단 |
| NOL·Goodchoice·Ddnayo direct OTA | Provider Integration Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | 0회/분 | 0회/일 | 0원 | 0원 | 차단 |
| Generic OTA adapter | Provider Integration Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | 0회/분 | 0회/일 | 0원 | 0원 | 차단 |
| data.go.kr tourism 3 APIs | Data Platform Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | 0회/분 | 0회/일 | 0원 | 0원 | 차단 |
| Naver SearchAd | Signal Pipeline Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | 0회/분 | 0회/일 | 0원 | 0원 | 차단 |
| Naver Trend | Signal Pipeline Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | 0회/분 | 0회/일 | 0원 | 0원 | 차단 |
| Generic SNS mention | Signal Pipeline Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | 0회/분 | 0회/일 | 0원 | 0원 | 차단 |

승인 전 quota 분모가 0일 때 quota 사용률을 0으로 나누지 않는다. completedCalls=0이면
pass이고, completedCalls가 1 이상이면 사용률을 무한대로 취급하여 즉시 stop한다.
비용도 approvedCapKRW=0일 때 accruedCostKRW=0만 pass이며 1원 이상이면 즉시 stop한다.

## 6. retry·중단·재개 정책

### 6.1 공통 실행 상태

fresh collection job 상태는 queued, collecting, succeeded, failed, cancelled만 허용한다.
task idempotency key는 provider + collectionKind + targetKey + observationWindow +
configVersion의 SHA-256이다. 같은 key의 succeeded task를 다시 외부 호출할 수 없다.

- checkpoint: task terminal 전환마다 1회, collecting 중 heartbeat 30초마다 1회.
- lease: 300초. heartbeat가 300초를 넘긴 collecting task만 reclaim한다.
- scheduler execution 상한: 최초 1회 + 재실행 1회 = 총 2회.
- 429 immediate retry: 1,200ms 후 1회, 다시 429면 2,400ms 후 1회.
- 한 scheduler execution의 provider call 상한: 최초 포함 3회.
- 한 task의 retry 포함 provider call 상한: 3 × 2 = 6회.
- request timeout: 모든 이식 adapter에 15,000ms. timeout guard가 없는 adapter는 enable 불가.
- rate-limit 재실행 간격: 3,600초.
- network·HTTP 5xx 재실행 간격: 7,200초.
- provider quota 재실행 간격: 86,400초. 단 daily quota가 0이면 자동 재실행 금지.
- HTTP 401·403, schema mismatch, checksum mismatch, denylist 접근은 retry 0회.
- V2 direct OTA와 V2 tourism의 현재 source retry는 0회로 유지한다. 공통 retry를
  적용하려면 provider별 hard max를 다시 승인해야 한다.

Cluster generic connectors의 기존 request helper에는 timeout이 없는 경로가 있으므로
15,000ms timeout과 abort가 검증되기 전 관련 flag는 false를 유지한다. V2 main crawl은
queue·process state가 메모리에만 있고 종료 시점에 manifest를 쓰므로, task별 checkpoint
이식 전 detail flag를 true로 바꿀 수 없다.

### 6.2 자동 중단

다음 중 하나라도 발생하면 새 lease 발급을 0으로 만들고 현재 provider의 circuit을
open하며 fresh store에 stop reason을 기록한다.

1. quotaExceededEvents 1건 이상.
2. logicalDuplicateEvents 1건 이상.
3. companyIdCollisionEvents 1건 이상.
4. denylistAccessEvents 1건 이상.
5. staticAllowlistViolationEvents 1건 이상.
6. accruedCostKRW가 approvedCapKRW 이상. 현재 cap 0에서는 1원 이상.
7. min sample 충족 후 rolling success rate가 95% 미만.
8. read API p95가 1,000ms 초과.
9. enqueue/write API p95가 1,500ms 초과.
10. worker throughput이 계획치 30 tasks/min의 75%인 22.5 tasks/min 미만.

### 6.3 재개

자동 중단 후 자동 재개는 0회다. Release Manager가 incident root cause, 수정 commit,
provider quota·비용 잔액, denylist counter 0을 확인하고 Product Owner 승인 기록을
첨부한 경우에만 수동 재개한다. 재개는 새 runId를 만들되 기존 fresh store의 succeeded
idempotency key를 skip한다. expired collecting lease만 queued로 되돌리고 failed task는
attemptCount가 2 미만인 경우에만 재등록한다. legacy outputs나 history에서 cursor,
identity, timing을 복원할 수 없다.

## 7. acceptance 식과 숫자 기준

비율은 모두 100을 곱한 percent다. 경고선 도달 시 다음 rollout 승인을 보류하고,
중단선 도달 시 6.2의 자동 중단을 실행한다. 최소 표본 미달은 실패로 계산하지 않지만
releaseGate는 닫힌 상태로 유지한다.

| 지표 | 분자 | 분모 | 측정 창·최소 표본 | 경고선 | 중단선 | 허용치 | 승인자 |
|---|---|---|---|---:|---:|---:|---|
| coverage | 필수 field와 lineage가 유효한 고유 target 수 | 범주별 동결 target 수 | collection wave 1회, 범주별 최소 30 target 또는 전체 target이 30 미만이면 전체 | 98% 미만 | 95% 미만 | 95% 이상 | QA Lead, Product Owner |
| terminal success rate | succeeded terminal task 수 | succeeded + failed terminal task 수 | rolling 24시간, 최소 100 task | 98% 미만 | 95% 미만 | 95% 이상 | QA Lead, Release Manager |
| required-field missing rate | null·empty·schema-invalid 필수 field cell 수 | 기대한 필수 field cell 수 | wave 1회, 최소 300 cell | 2% 초과 | 5% 초과 | 5% 이하 | Data Governance Engineer, QA Lead |
| logical duplicate rate | rejected 포함 동일 logical key의 두 번째 이상 write attempt 수 | 전체 valid write attempt 수 | run 전체, 최소 1 write attempt | 1건 이상 | 1건 이상 | 0건 | Data Governance Engineer, Product Owner |
| companyId collision rate | 하나의 provider identity가 둘 이상의 companyId에 매핑되거나 상충 signature가 한 companyId에 매핑된 event 수 | identity mapping write attempt 수 | run 전체, 최소 1 mapping attempt | 1건 이상 | 1건 이상 | 0건 | Data Governance Engineer, Product Owner |
| freshness compliance | 범주별 freshness SLA 이내 record 수 | 해당 wave의 publish 대상 record 수 | wave 1회, 범주별 최소 30 record | 98% 미만 | 95% 미만 | 95% 이상 | Product Owner, QA Lead |
| read API p95 | 오름차순 latency의 `ceil(0.95 × N)`번째 sample | `N = completed read API request 수` | rolling 15분, 최소 500 request | p95 500ms 초과 | p95 1,000ms 초과 | p95 1,000ms 이하 | API Platform Owner, Release Manager |
| enqueue/write API p95 | 오름차순 latency의 `ceil(0.95 × N)`번째 sample | `N = completed enqueue/write API request 수` | rolling 15분, 최소 200 request | p95 750ms 초과 | p95 1,500ms 초과 | p95 1,500ms 이하 | API Platform Owner, Release Manager |
| worker throughput | succeeded task 수 | active worker minute 수 | rolling 30분이며 최소 100 task | 27 tasks/min 미만 | 22.5 tasks/min 미만 | 22.5 tasks/min 이상 | Data Platform Engineer, Release Manager |
| provider cost usage | accruedCostKRW | approvedCapKRW | provider별 wave 및 billing sample 최소 1개 | cap의 80% 이상 | cap의 100% 이상 | cap 이하 | Finance Approver, Product Owner |
| provider quota usage | completed provider calls | approved daily quota | provider별 KST 00:00~24:00, 최소 호출 1회 | 70% 이상 | 90% 이상 | 90% 미만 | Provider Operations Owner, Release Manager |
| quota exceeded | quota 초과 또는 provider quota rejection event 수 | provider call attempt 수 | provider별 KST 일간, 최소 attempt 1회 | 1건 이상 | 1건 이상 | 0건 | Provider Operations Owner, Product Owner |
| denylist access | runtime denylist read·write·stat·open attempt 수 | runtime filesystem access attempt 수 | process lifetime, 최소 access 1회 | 1건 이상 | 1건 이상 | 0건 | Security & Compliance Owner, Release Manager |
| static allowlist violation | allowlist 밖 정적 자산 access attempt 수 | 정적 자산 access attempt 수 | process lifetime, 최소 access 1회 | 1건 이상 | 1건 이상 | 0건 | Security & Compliance Owner, Release Manager |

freshness SLA는 다음 숫자로 고정한다.

- quick, detail, OTA, leadtime: collectedAt 기준 24시간 이하.
- search-volume, Trend, SNS: collectedAt 기준 168시간 이하.
- tourism: 수집 완료 시각 168시간 이하이고, observation month는 현재 이용 가능한
  최종 마감 월보다 1개월 이상 뒤처질 수 없다.

provider cost와 quota는 현재 cap과 quota가 0이므로 실제 최소 표본 1회를 만들 수 없다.
이 상태는 acceptance 실패가 아니라 외부 실행 gate closed를 뜻한다. 호출 0회·비용 0원인
동안만 Stage 224 계약을 통과하며, 호출 또는 비용이 발생하면 즉시 실패한다.

범주별 coverage 분모는 다음과 같이 고정한다.

| 범주 | coverage 분모 |
|---|---:|
| quick | 46 region targets |
| detail | 460 company targets |
| V2 OTA direct | 46 region scopes |
| Cluster generic OTA | 460 company targets |
| leadtime | 138 company-observation targets |
| tourism | 138 region-source-month targets |
| SearchAd | 598 keyword targets |
| Trend | 598 keyword targets |
| SNS | 598 keyword targets |

## 8. 정적 자산 allowlist와 quarantine

Stage 224 runtime allowlist는 다음 1개로 동결한다. upstream raw byte의 SHA-256이
V2 기준 commit의 Git blob과 일치함을 확인했고, Windows working tree의 CRLF 변환
checksum도 별도로 고정했다.

| 경로 | source·version | license | runtime SHA-256 | canonical upstream/Git blob SHA-256 | approver |
|---|---|---|---|---|---|
| web/assets/korea_municipalities.geojson | https://github.com/southkorea/southkorea-maps/blob/master/kostat/2013/json/skorea_municipalities_geo_simple.json · KOSTAT 2013 · WGS84 · 1% simplified | KOSTAT: free to share or remix; attribution 유지 | 1CD70BC95EC6CE5CBCE1A98EA49FE7A81BDAADA98A536B075F25C471E998AAE8 | E0CF2030DC893F40B6E97DFA7183D47C2197EA74551B041EABFD7BC318A74285 | Data Governance Engineer, Security & Compliance Owner |

아래 파일은 수집 데이터가 아닌 후보 정적 자산이지만 출처·version·license·checksum
요건을 모두 만족하지 않으므로 quarantine한다. checksum은 현재 파일의 식별용이며
승인 의미가 없다.

| 경로 | 확인된 version | 출처 | license | SHA-256 | runtime |
|---|---|---|---|---|---|
| web/data/tourism_region_map.json | tourism-region-map-v0.1 | upstream URL 없음 | 없음 | 6C82E7C57E130C22C78656E09856E9AAA8B6110AB5D677BD28132A9DFCF19F94 | 차단 |
| web/data/location_dictionary.json | location-dictionary-v0.2 | 입지_판단_사전자료.xlsx 표기만 있고 원본 workbook 없음 | 없음 | B4F6565D429CF166AAE1AC594D5700B820C9E32FA22ABBA425C67E71ABEBE4B0 | 차단 |

정적 자산을 allowlist에 추가하려면 source URL, upstream release/version, 명시 license,
SHA-256, Data Governance Engineer owner, Security & Compliance Owner approver가 모두
있어야 한다. 하나라도 없으면 runtime access limit은 0이다.

## 9. 기존 데이터 denylist

denylist는 logical identifier와 resolved path prefix를 함께 비교해야 한다. symlink,
junction, 상대 경로, 대소문자 차이로 우회할 수 없도록 realpath를 정규화한 뒤 access
전에 검사한다.

| source | 식별자·경로 | 금지 동작 |
|---|---|---|
| V2 service | service glamping-datalab-v2 | 기존 runtime volume에서 read, import, copy, backfill |
| V2 disk | disk glamping-datalab-v2-data, mount /var/data | read, write, stat, open, enumerate |
| V2 legacy data | DATA_DIR/outputs | CSV·JSON·manifest read, booking ID fallback, import |
| V2 legacy config | DATA_DIR/config | 신규 store seed, provider cursor 복원 |
| V2 customer DB | DATA_DIR/customer_db | read, copy, attach, ETL |
| V2 history | DATA_DIR/history | crawl_timings.json 포함 read·timing 보정 |
| V2 company master | DATA_DIR/company_master | identity seed·mapping import |
| V2 tourism | DATA_DIR/tourism_data | snapshot·cache read, seed, copy |
| V2 crawl fallback | scripts/gyeongnam_glamping_crawl.cjs의 OUTPUT_ROOT prior-run CSV 탐색 경로 | runtime branch 진입 |
| V2 traffic probe | scripts/traffic_sources_probe.cjs의 local output/config 경로 | runtime read·write와 신규 store import |
| Cluster service | service glamping-cluster-app | 기존 runtime volume에서 read, import, copy, backfill |
| Cluster disk | disk glamping-data, mount /var/data | read, write, stat, open, enumerate |
| Stage 223 preview | integration-preview fixture와 preview contract artifact | production runtime import, migration, backfill, dual-write |

runtime guard는 denylistAccessEvents를 증가시키고 요청을 거부해야 한다. acceptance는
분자 0건을 요구한다. 계약 테스트는 임시 test directory의 synthetic fixture만 사용할
수 있고 위 service·disk·path와 연결될 수 없다.

## 10. feature flag 동결

모든 flag의 기본값은 false다. owner와 approver는 개인 이름이 아니라 운영 역할로
고정하며 역할 공석은 배포 차단 사유다. 현재는 모든 역할이 정의되어 있고 flags가
false이므로 Stage 224 blocker는 0개다.

| flag | owner | 전체 approvalRoles | flag dependsOn | 비-flag 선행 gate | 기본값 | 대상 역할 | rollout 순서 | 관찰 지표 | rollback |
|---|---|---|---|---|---|---|---:|---|---|
| freshCollection.enabled | Data Platform Engineer | Product Owner, Release Manager | V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED | fresh-store-schema, deny-guard, empty-store-proof | false | collector-admin | 200 | denylist-access, logical-duplicate-rate, provider-cost | 새 lease 0, 모든 하위 flag false, 성공 evidence 보존 |
| freshCollection.quick | Data Platform Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | freshCollection.enabled | provider-approval | false | collector-worker | 210 | coverage, success-rate, provider-cost | quick circuit open, queued quick 취소 |
| freshCollection.detail | Data Platform Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | freshCollection.quick | atomic-task-checkpoint, timeout-guard | false | detail-worker | 220 | coverage, missing-rate, worker-throughput | detail circuit open, active lease 만료 후 중단 |
| freshCollection.leadtime | Data Platform Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | freshCollection.detail | W=3-schedule | false | leadtime-worker | 230 | coverage, freshness-compliance, logical-duplicate-rate | future observation 취소, 성공 observation 보존 |
| freshCollection.ota | Provider Integration Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | freshCollection.quick | provider-specific-approval | false | ota-worker | 240 | coverage, provider-cost, provider-quota | 영향받은 provider별 circuit open |
| freshCollection.tourism | Data Platform Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | freshCollection.enabled | 46-region-code-verification, approved-static-allowlist | false | tourism-worker | 250 | coverage, freshness-compliance, static-allowlist-violation | tourism source circuit open, cache write 금지 |
| freshCollection.searchVolume | Signal Pipeline Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | freshCollection.enabled | K=598-manifest, SearchAd-and-Trend-approval | false | signal-worker | 260 | coverage, provider-quota, provider-cost | 영향받은 search-volume provider circuit open |
| freshCollection.sns | Signal Pipeline Engineer | Product Owner, Provider Operations Owner, Security & Compliance Owner, Finance Approver | freshCollection.enabled | K=598-manifest, SNS-provider-approval | false | signal-worker | 270 | coverage, provider-quota, provider-cost | SNS provider circuit open |

rollout 순서는 숫자가 작은 flag의 acceptance가 모두 통과한 후 다음 숫자를 검토한다는
뜻이다. flag를 true로 바꾸는 변경은 이 문서의 0 rate·0 quota·0 cost cap도 동시에
승인된 숫자로 변경해야 하며, flag만 단독으로 true로 만들 수 없다.

## 11. RACI

| 활동 | Responsible | Accountable | Consulted | Informed |
|---|---|---|---|---|
| 대상·호출 산식 유지 | Data Platform Engineer | Product Owner | Provider Integration Engineer, Signal Pipeline Engineer, QA Lead | Release Manager |
| provider 계약·credential·rate 확인 | Provider Operations Owner | Product Owner | Security & Compliance Owner, Finance Approver, Legal Reviewer | Data Platform Engineer, Release Manager |
| 비용 단가·cap 승인 | Finance Approver | Product Owner | Provider Operations Owner | Release Manager, QA Lead |
| fresh store와 deny guard 구현 | Data Platform Engineer | API Platform Owner | Security & Compliance Owner, Data Governance Engineer, QA Lead | Product Owner |
| 정적 자산 검증·allowlist 승인 | Data Governance Engineer | Security & Compliance Owner | Legal Reviewer, QA Lead | Product Owner, Release Manager |
| identity·duplicate 품질 승인 | Data Governance Engineer | Product Owner | QA Lead, Data Platform Engineer | Release Manager |
| acceptance 자동화·검증 | QA Lead | Release Manager | Product Owner, Data Platform Engineer, Finance Approver | 전체 개발 역할 |
| 자동 중단·수동 재개 | Release Manager | Product Owner | Provider Operations Owner, Security & Compliance Owner, Finance Approver | QA Lead, Data Platform Engineer |
| rollout 승인 | Release Manager | Product Owner | QA Lead, Provider Operations Owner, Security & Compliance Owner, Finance Approver | 전체 운영 역할 |

필수 승인 역할은 Product Owner, Provider Operations Owner, Security & Compliance Owner,
Finance Approver다. 정적 자산에는 Data Governance Engineer와 Legal Reviewer 검토가
추가된다. 역할 자체가 미정인 항목은 없으며, 향후 담당자가 배정되지 않은 상태에서는
관련 flag를 false로 유지한다.

## 12. 자동 검증 계약

Stage 224의 budget 검사는 최소한 다음을 자동 주장해야 한다.

1. 외부 provider 모든 realRequestLimit이 0이다.
2. 외부 provider 모든 daily quota와 approvedCapKRW가 0이다.
3. nominalCalls 합계가 21,252이고 hardMaxCalls 합계가 275,402다.
4. quick/detail/OTA/leadtime/tourism/SearchAd/Trend/SNS의 target, nominal, hard가
   위 표의 숫자와 일치한다.
5. migration, backfill, import-from-legacy, dual-write 항목 수가 각각 0이다.
6. static allowlist 길이가 1이고 승인 GeoJSON의 두 checksum과 quarantine 2개
   checksum이 일치한다.
7. denylist runtime access counter가 0이다.
8. logical duplicate, quota exceeded, companyId collision 허용치가 각각 0이다.
9. acceptance의 모든 비율에 분자, 분모, 측정 창, 최소 표본, 경고선, 중단선,
   승인자가 존재하고 숫자가 비어 있지 않다.
10. 모든 collection flag에 owner, approver, dependsOn, 기본값, 대상 역할,
    rollout 순서, 관찰 지표, rollback이 존재한다.
11. Stage 223 preview 경로가 runtime source, migration source, backfill source,
    dual-write target 목록에 0건이다.
12. fresh store empty-state 검증에서 collection row, identity mapping, provider cursor가
    모두 0건이다.

## 13. Stage 224 종료 판정

- 실제 외부 요청: 0건
- 실제 provider 비용: 0원
- legacy migration/backfill/import/dual-write: 0건
- static allowlist 항목: 1개
- 허용된 legacy runtime access: 0건
- 논리 중복 허용: 0건
- quota 초과 허용: 0건
- companyId 충돌 허용: 0건
- 승인자 미정 항목: 0개
- Stage 224 blocker: 0개

이 동결을 변경하지 않는 한 다음 단계는 외부 수집 없이 inventory, 계약 테스트,
fresh store guard와 worker의 synthetic fixture 검증만 수행할 수 있다.
