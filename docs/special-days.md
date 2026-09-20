# 한국천문연구원 특일정보 연결

공식 출처: [공공데이터포털 한국천문연구원 특일 정보](https://www.data.go.kr/data/15012690/openapi.do).
2026-09-21 포털의 상세기능 목록과 각 기능의 요청주소를 확인했다. 아래 다섯 기능이 모두 현재 문서에 있다.

| 분류 키 | 표시 이름 | 공식 operation |
| --- | --- | --- |
| `holidays` | 공휴일 | `getRestDeInfo` |
| `nationalDays` | 국경일 | `getHoliDeInfo` |
| `anniversaries` | 기념일 | `getAnniversaryInfo` |
| `solarTerms` | 24절기 | `get24DivisionsInfo` |
| `sundryDays` | 잡절 | `getSundryDayInfo` |

기념일 API는 과거 예제가 아니라 현재 포털에 표시된 기능을 기준으로 지원한다. 국경일 API와 공휴일 API가 같은 항목을 반환하더라도 분류별 원본 응답을 유지한다. **공휴일 판정에는 `getRestDeInfo` 응답 중 `isHoliday`가 `Y`인 항목만 사용한다.** 다른 분류의 휴일 여부를 합쳐 공휴일을 만들지 않는다. 날짜가 같아도 명칭이나 순번이 다른 항목은 모두 보존한다.

## 모듈과 서버 연결

`scripts/lib/special_days.cjs`는 서버를 시작하거나 환경변수에서 키를 직접 읽지 않는다. 서버에서 저장 경로와 키 조회 함수를 주입한다.

```js
const { createSpecialDaysService } = require('./lib/special_days.cjs');
const specialDays = createSpecialDaysService({
  dataDir: path.join(DATA_DIR, 'history', 'special_days'),
  readServiceKey: () => /* 서버에서 승인된 키 반환 */ ''
});

await specialDays.status();          // 키 설정 여부와 저장 현황, 외부 요청 없음
await specialDays.status(2026);      // 위 정보 + yearStatus, 외부 요청 없음
await specialDays.getYear(2026);     // 없거나 24시간 지난 분류만 갱신
await specialDays.getYear();         // 한국 시간의 현재 연도
await specialDays.getYear(2026, { refresh: true });
await specialDays.verify(2026);      // 공휴일 1페이지, 1행 요청으로 연결 확인
```

`fetchImpl`, `timeoutMs`(기본 12초), `now`를 주입할 수 있다. 테스트에서는 가짜 응답과 임시 저장 폴더만 사용한다. `verify()`는 전체 연도 자료를 덮어쓰지 않는다. 기본 연도는 한국 시간의 현재 연도이며, 다음 연도도 같은 방식으로 최초 조회 시 수집한다.

서버 통합 경로는 `GET /api/special-days?year=2026`, 설정 상태 조회, 관리자 갱신 요청으로 구분한다. 키 저장·권한 확인은 서버의 책임이다. 모듈은 공개 응답, 캐시 파일, 오류 메시지에 키와 쿼리 문자열을 포함하지 않는다. HTTPS만 사용하며 인증키가 다른 주소로 전달되지 않도록 리디렉션을 거부한다. 포털에서 제공하는 인코딩 키와 디코딩 키 모두 정확히 한 번 인코딩한다.

관리자는 **설정 → API·연동 → 특일정보**에서 연도와 종류, 기간을 선택한다. 기본 목록은 접혀 있으며 공휴일 날짜 수와 다가오는 공휴일을 요약한다. `자료 불러오기`는 유효한 캐시를 사용하고 `새로 확인`은 제공기관에 다시 조회한다. 최초 화면의 상태 조회만으로는 외부 API를 호출하지 않는다. 별도 정시 자동수집 작업은 추가하지 않았다.

| 경로 | 역할 |
| --- | --- |
| `GET /api/settings/special-days?year=2026` | 설정 여부와 저장 상태만 확인 |
| `GET /api/special-days?year=2026` | 연도 자료 조회, 누락·만료 분류 갱신 |
| `POST /api/settings/special-days/refresh` | JSON `{ "year": 2026 }`로 관리자 수동 갱신 |

세 경로 모두 관리자 인증이 필요하다. 갱신은 JSON 및 요청 출처를 검사하고 연도 외 접속주소·인증키 등의 입력을 거부한다. 인증키 우선순위는 `DATA_GO_KR_SPECIAL_DAYS_SERVICE_KEY`, `DATA_GO_KR_SERVICE_KEY`, `KTO_DATA_GO_KR_SERVICE_KEY`, `KTO_TOURISM_SERVICE_KEY`다. 기존 공통키로 승인된 특일정보를 조회할 수 있으면 키를 복사하거나 추가 저장할 필요가 없다.

## 반환 값

`getYear()`는 `{year, configured, status, source, updatedAt, stale, items, holidays, categories, errors, networkAttempted}`를 반환한다.

- `items`: 다섯 분류 전체의 날짜순 목록. 분류 사이의 중복은 유지한다.
- `holidays`: 공휴일 분류 중 실제 공휴일 항목만 추린 목록.
- 항목: `{date, name, kind, kindLabel, isHoliday, seq, dateKind, kst, sunLongitude}`. 날짜는 `YYYY-MM-DD`, `isHoliday`는 boolean이다. 절기 시간과 황경은 제공된 문자열을 보존하고, 없으면 `null`이다.
- `categories`: 분류 키를 사용하는 객체. 각 값은 `{kind, label, operation, status, count, updatedAt, stale, error, items}`이다.
- `error`: 고정된 `{code, message}` 또는 `null`. 제공기관의 원문 오류나 URL을 노출하지 않는다.
- 전체 `updatedAt`: 저장되어 있는 분류 중 가장 오래된 성공 시각. 분류별 정확한 시각은 각 `updatedAt`을 사용한다.
- `networkAttempted`: 이번 호출에서 실제 외부 조회를 시도했는지 여부이며, 제공기관의 남은 할당량은 아니다.

| 전체 상태 | 의미 |
| --- | --- |
| `ready` | 다섯 분류 모두 유효기간 안의 정상 저장 자료 |
| `partial` | 일부 정상 자료가 있고 나머지 분류는 실패했거나 오래된 자료 |
| `error` | 정상 저장 자료가 없고 조회 또는 저장에 실패 |
| `missing_key` | 정상 저장 자료도 없고 인증키도 없음 |

분류 상태는 `ready`, `stale`, `error`, `missing_key`다. 성공한 빈 목록은 `ready`이고 성공 시각이 있다. 미수집 또는 실패는 성공 시각이 없는 상태이므로, 빈 배열만 보고 공휴일이 없다고 판단하면 안 된다. 키가 제거되어도 아직 유효한 기존 자료는 `ready`로 읽을 수 있으며 `configured:false`로 구분한다.

`status()`는 `{configured, source, cacheTtlHours, retryCooldownSeconds, supportedYears, categories, cachedYears, lastVerification}`를 반환한다. 연도 인수가 있으면 네트워크를 사용하지 않는 `yearStatus`를 추가한다. `lastVerification`은 현재 프로세스에서 마지막으로 수행한 확인 결과이며 재시작 시 초기화된다.

## 저장과 실패 처리

`history/special_days/special-days-YYYY.json`에 정상 완료된 분류만 저장한다. 임시 파일을 쓴 뒤 교체하므로 실패 응답이 기존 성공 자료를 덮어쓰지 않는다. 일부 분류가 성공하면 해당 분류만 새 자료로 바뀌며 실패한 분류는 이전 성공 자료와 시각을 유지한다.

일반 조회는 24시간 이내 캐시를 재사용한다. 실패한 분류는 5분 동안 일반 조회로 다시 요청하지 않는다. 관리자 `refresh:true`는 유효기간과 재시도 간격을 건너뛴다. 동일 연도의 동시 요청은 하나로 합친다. 실패 재시도 간격과 최근 실패 상태는 프로세스 메모리에 있으며 재시작 시 초기화된다. API 호출 한도 증설이나 공급기관 할당량 변경은 하지 않는다.

문서의 `ServiceKey`, `solYear`, `pageNo`, `numOfRows`를 사용하고 `_type=json`을 요청한다. 월을 생략해 연도 전체를 페이지당 100개씩 조회한다. 페이지 번호·총건수·실제 항목 수를 확인하고, 같은 날짜·순번·명칭의 완전 동일 항목이 반복되거나 중간 페이지가 비어 있으면 실패로 처리한다. 분류별 최대 50페이지/5,000개로 제한한다.

JSON과 문서에 명시된 XML 응답을 지원한다. XML은 고정된 응답 항목만 읽으며 DTD, 외부 엔티티, HTML 오류 페이지는 거부한다. HTTP 200이라도 공공데이터포털의 인증 오류 XML이나 실패 결과코드는 성공으로 취급하지 않는다. 시간 초과, 인증·호출량·응답 형식·파일 저장 실패를 고정 코드와 한국어 메시지로 구분한다.

입력 연도는 앱의 지원 범위인 2000–2100으로 제한한다. 이는 해당 기간의 모든 자료가 제공된다는 보장이 아니다. 날짜의 실제 유효성과 요청 연도 일치도 확인한다. 잘못된 연도만 `INVALID_YEAR` / HTTP 400 성격의 예외를 던지고, 제공기관 또는 저장 오류는 상태로 반환한다.

검증 명령: `npm run test:special-days`. 모듈의 실패·캐시·페이지 처리와 실제 서버의 관리자 권한·입력 검증·키 비노출을 검사한다. 실제 인증키나 외부 API를 사용하지 않는다. 기존 숙박 예약 수량·매출·평일 계산은 이 연결에서 변경하지 않는다.
