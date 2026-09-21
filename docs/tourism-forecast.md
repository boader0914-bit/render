# 관광지 집중률 방문자 추이 예측 연결

공식 출처는 [공공데이터포털 한국관광공사 관광지 집중률 방문자 추이 예측 정보](https://www.data.go.kr/data/15128555/openapi.do)다. 2026-09-21 현재 포털의 Swagger와 첨부 v4.1 매뉴얼을 확인했다. v4.1 변경일은 2026-05-19이며, 변경 내용은 endpoint URL 오타 수정이다.

이 자료는 KT 이동통신 방문 패턴을 이용한 **관광지별 상대 집중률 예측**이다. 가장 붐비는 수준을 100으로 나타내며 방문자 실측 인원, 객실 점유율 또는 매출을 뜻하지 않는다. 제공기관의 예측을 그대로 표시하고, 숙박 수량이나 매출 계산에 합치지 않는다.

## 공식 조회 형식

- HTTPS endpoint: `https://apis.data.go.kr/B551011/TatsCnctrRateService/tatsCnctrRatedList`
- 유일 operation: `tatsCnctrRatedList`. 별도 관광지 목록 API는 없다.
- 필수 인수: `serviceKey`, `pageNo`, `numOfRows`, `MobileOS`, `MobileApp`, `areaCd`, `signguCd`.
- 선택 인수: `tAtsNm`, `_type`. 모듈은 `_type=json`, `MobileOS=ETC`, `MobileApp=STAYDATALAB`을 사용한다. 현재 Swagger에 `WEB`과 `ETC` 모두 명시되어 있으며 실제 연결을 확인한 `ETC`로 통일했다.
- 항목: `baseYmd`, `areaCd`, `areaNm`, `signguCd`, `signguNm`, `tAtsNm`, `cnctrRate`.
- 정상 결과코드는 매뉴얼 응답 예제의 `0000`과 오류표의 `00`을 지원한다. `03`은 `NODATA_ERROR`이며 실제 집중률 0과 구분한다.

선택한 시군구를 `tAtsNm` 없이 한 번 조회한다. 관광지 목록과 각 관광지의 시계열을 같은 지역 캐시에 저장하여 관광지 선택·검색 때 추가 조회하지 않는다. 페이지당 1,000개, 최대 20페이지/20,000개로 제한한다. 페이지별 항목을 모두 합친 뒤 관광지별 완전성을 검사한다. 한 관광지의 30개 행이 두 페이지에 나뉘어도 정상 처리한다. 전국 예측 자동 수집은 하지 않는다.

## 공식 지역 코드표

포털 첨부 [v4.1 배포 ZIP](https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000003643086&fileDetailSn=1)의 `한국관광공사_OpenAPI_관광지_시군구_코드정보_v1.0.xlsx`, `시도,시군구코드` 시트 A1:D253을 읽었다. 원본에는 17개 시도와 252개 시군구가 있으며 빈 값과 중복 행이 없다. 관광지 이름 자체의 목록은 포함하지 않는다.

`web/data/tourism_forecast_regions.json`에 네 열을 그대로 보존했다. 원본 헤더 `sigunguCd`, `sigunguNm`의 철자만 공식 API 인수인 `signguCd`, `signguNm`로 정규화했다. 이름이나 코드를 다른 지역 체계로 임의 변환하지 않았다. 원본 XLSX의 SHA-256은 `8499fdda8e2118443396945a883aacf44bfbf4bf5e7d7c05ca2a239a624325a9`다. JSON의 `source`에 출처와 확인일을 기록했다.

요청은 코드표에 존재하는 정확한 시도·시군구 쌍만 허용한다. 예를 들어 원주시 `51 / 51130`, 포천시 `41 / 41650`이다. 응답의 모든 행도 요청 코드와 일치해야 한다. 같은 이름의 관광지가 다른 시군구에 있어도 섞지 않는다. 관광공사 고유 관광지 ID는 이 API에 없으므로 내부 `id`는 `[areaCd, signguCd, 정확한 관광지명]`의 JSON을 base64url로 인코딩한 식별자다.

## 서버 모듈 계약

관리자 화면은 `지역분석 → 수요 전망 → 관광지 방문 전망`에서 사용한다. 상단의 공통 분석 지역을 고른 뒤 **관광지 불러오기**를 누르고, 반환된 목록에서 정확한 관광지를 선택한다. 이름 검색과 관광지 선택은 받은 목록만 사용하므로 외부 API를 추가 호출하지 않는다. 날짜별 목록은 접거나 펼칠 수 있다. 관광지 선택과 펼침 상태는 지역별로 유지한다. `설정 → API·연동`에는 연결 상태, 마지막 저장 갱신 시각과 저장 지역을 명시한 갱신 기능을 둔다.

서버 인증키는 `DATA_GO_KR_TOURISM_FORECAST_SERVICE_KEY`, `DATA_GO_KR_SERVICE_KEY`, `KTO_DATA_GO_KR_SERVICE_KEY`, `KTO_TOURISM_SERVICE_KEY` 순서로 사용한다. 기존 공공데이터 공통키를 재사용할 수 있으며 브라우저에는 인증키를 전달하지 않는다.

다음 경로는 로그인한 관리자만 사용할 수 있다. 일반 회원과 비로그인 요청은 차단한다.

- `GET /api/settings/tourism-forecast`: 설정 여부, 공식 지역 목록, 저장 자료 상태만 확인. 제공기관 호출 없음.
- `GET /api/tourism-forecast?areaCd=41&signguCd=41650`: 해당 지역을 조회하고 당일 정상 자료가 있으면 재사용.
- `POST /api/settings/tourism-forecast/refresh`: JSON `{areaCd, signguCd}`로 명시적 갱신. 키나 다른 API 주소는 입력받지 않으며 JSON 형식과 요청 출처를 검사.

지역 조회와 명시적 갱신에는 관리자별 기존 관광 API 제한인 10분당 30회가 적용된다. 실제 조회는 화면에서 요청할 때 수행한다. 별도의 예약 작업을 만들거나 기존 숙소 수집 일정에 관광지 예측 조회를 추가하지 않는다.

`scripts/lib/tourism_forecast.cjs`의 `createTourismForecastService({dataDir, readServiceKey, fetchImpl?, now?, timeoutMs?})`를 사용한다. 서버의 저장 위치는 `DATA_DIR/history/tourism_forecast`다. 모듈은 환경변수나 운영 인증키를 직접 읽지 않으며, 서버에서 키 조회 함수를 주입한다.

`status()`는 외부 조회 없이 다음을 반환한다.

```js
{
  configured, source,
  regions: [{ areaCd, areaNm, signguCd, signguNm }],
  cachedRegions: [{ areaCd, areaNm, signguCd, signguNm,
    collectedAt, queryDate, destinationCount, stale, status }],
  retryCooldownSeconds: 300
}
```

`getRegionForecast({areaCd, signguCd}, {refresh:false})`의 반환 값은 다음과 같다.

```js
{
  status, region: { areaCd, areaNm, signguCd, signguNm }, source,
  collectedAt, queryDate, stale, networkAttempted,
  destinations: [{
    id, name, areaCd, areaNm, signguCd, signguNm,
    series: [{ date: 'YYYY-MM-DD', value: 0 }],
    startDate, endDate, upcomingDayCount, complete, providerLagDays
  }],
  errors: [{ code, message }]
}
```

`value`는 원본 `cnctrRate`의 수치다. 결측을 0으로 만들지 않는다. `complete:true`는 제공기관이 반환한 30개 날짜가 연속이라는 뜻이며 예측의 정확성을 보증하지 않는다. `startDate`와 `endDate`는 실제 제공 기간이다. `upcomingDayCount`는 오늘을 포함한 남은 날짜 수이며, `providerLagDays`는 시작일과 한국 시간의 오늘 사이의 차이다. 예를 들어 9월 21일에 9월 20일–10월 19일 자료를 받으면 30개 원본 행, 남은 29일, 지연 1일을 표시한다. 과거 시작일을 오늘로 옮기지 않는다.

매뉴얼은 갱신 주기를 일 1회로 안내하지만 갱신 시각이나 최대 지연 보장은 명시하지 않는다. 모듈은 임의의 지연 허용일을 공급기관 보장으로 제시하지 않는다. 제공 기간 전체가 과거이면 `stale:true`로 표시한다. 요청일보다 1일 넘게 뒤에 시작하거나 30일 넘게 뒤에 끝나는 기간, 불가능한 날짜, 2000–2100 밖의 날짜는 비정상 응답으로 처리한다.

| 상태 | 의미 |
| --- | --- |
| `ready` | 당일 조회한 완전한 지역 예측 자료 |
| `partial` | 오래된 저장 자료 또는 갱신 실패 후 보존된 자료 |
| `no_data` | 제공기관이 해당 지역 자료 없음을 반환 |
| `missing_key` | 사용할 저장 자료와 인증키가 모두 없음 |
| `error` | 사용할 정상 자료가 없고 조회·검증·저장 실패 |

`errors`는 고정된 코드와 한국어 메시지만 포함한다. `no_data`도 `NO_DATA` 메시지가 있으며, 오류·자료 없음·집중률 0을 같은 결과로 해석하면 안 된다. `stale`는 저장 자료의 조회일·갱신 실패·기간 만료 상태이고, 시작일 지연은 별도 `providerLagDays`로 확인한다.

## 캐시와 검증

정상 지역 자료를 `tourism-forecast-시도코드-시군구코드.json`에 임시 파일 후 교체 방식으로 저장한다. 해당 KST 조회일에 받은 자료를 재사용하며 다음 KST 날짜에는 갱신한다. 실패한 요청은 5분 동안 자동 재시도하지 않고 관리자 `refresh:true`만 간격을 건너뛴다. 동일 지역의 동시 요청은 하나로 합친다. 실패 상태와 재시도 간격은 프로세스 메모리, 정상 자료는 디스크에 보존한다.

`queryDate`는 요청 시작일, `collectedAt`은 실제 수신 완료 시각이다. 자정을 지나 완료되어도 완료 시각을 바꾸지 않는다. 요청일 기준으로 캐시를 판정하므로 다음 조회에서 새 날짜의 자료를 받는다.

지역 코드·0~100 범위·날짜 중복·30일 연속성·페이지 총건수·반복 페이지를 검증한다. 저장된 동일 관광지보다 이전 기간이 반환되어도 기존 자료를 보존한다. 실패나 빈 응답으로 기존 성공 자료를 덮지 않는다. 처음 조회한 지역의 정상 빈 응답은 당일 `no_data` 캐시로 보관해 반복 호출을 막는다. 기존 자료가 있는 지역의 빈 응답은 이전 자료와 `NO_DATA` 메시지를 함께 반환한다.

기본 timeout은 12초다. JSON과 고정된 공식 XML 응답 구조를 지원하며, XML DTD·외부 엔티티·HTML 오류 페이지를 거부한다. HTTPS만 사용하고 리디렉션을 거부한다. 인코딩 키는 한 번 디코딩 후 URL에 정확히 한 번 인코딩한다. 키, 전체 쿼리 URL, 제공기관 원문 오류를 공개 응답이나 캐시 파일에 기록하지 않는다.

`node scripts/test_tourism_forecast.cjs`로 외부 인증 조회 없이 검증한다. 테스트는 임시 폴더와 가짜 응답을 사용하며, 1,530행 두 페이지·51개 관광지, 자정 경계, 같은 이름의 다른 지역, 0과 결측, 자료 없음, 실패 후 원본 유지, 비밀 비노출을 확인한다.
