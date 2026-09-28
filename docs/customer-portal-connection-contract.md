# SABUN INSIGHT 운영 연결 계약

작성일: 2026-09-28 · 고객 도메인: **insight.sabun.co.kr** · 기준 코드: `d788402`

이 문서는 고객용 화면을 실제 회원·업체·지역·발행 리포트에 연결할 때의 개발 계약이다. 현행 소스만 읽어 작성했으며 운영 회원, 수집 자료, 환경변수, 인증값은 읽지 않았다. 아래 신규 API와 저장 모델은 구현 요구사항이다. 로컬 검수 화면이 동작하는 것과 운영 연결·DNS·TLS·배포가 완료된 것은 별개다.

## 1. 실행 경계

```text
고객 브라우저 → insight.sabun.co.kr의 고객 앱/BFF
                    ├─ 고객 전용 로그인·세션·등록 설정
                    └─ 고객별 권한 검증 → 허용된 분석·발행본 저장소

STAYDATALAB 관리자 → 회원 제공 한도·매장 연결 검토·자료 검수
                    └─ 고객에게 배정할 공개용 발행본 생성
```

- 고객 브라우저는 자기 도메인의 `/api/customer/v1/*`만 호출한다. 기존 `/api/monthly-reports`, `/api/runs`, 업체 원본 DB·워커·수집 API를 고객에게 전달하지 않는다.
- 고객 앱/BFF는 별도 실행 단위로 둔다. 내부 연결은 배정된 자료를 읽는 최소 권한 서비스 연결이며, 관리자 비밀번호나 관리자 세션으로 모든 API를 대신 호출하는 범용 프록시를 만들지 않는다.
- 고객별 매장 등록, 경쟁업체 등록, 리포트 열람은 새 크롤링이나 외부 통계 API 갱신을 시작하지 않는다. 자료 없음은 `pending`/`missing`으로 반환한다.
- 로컬 예시 앱은 루프백 주소에만 바인딩하고 별도 예시 저장소만 사용한다. 운영 모드·외부 바인딩에서는 예시 인증·예시 관리자 변경 API·계정 전환 기능을 시작 단계에서 거부한다. 실패 시 예시 데이터로 자동 대체하지 않는다.
- 운영 공개 전에는 별도 고객 앱의 인증·권한·동의·저장·복구 검수가 필요하다. DNS 연결만으로 로컬 검수 앱을 공개하지 않는다.

## 2. 기존 코드에서 재사용할 부분과 바꿔야 할 부분

행 번호는 기준 커밋 기준이며 아래 함수명으로 다시 찾을 수 있다.

| 기능 | 현재 코드 위치 | 연결 판단 |
| --- | --- | --- |
| 회원 기본 저장 | `scripts/glamping_app_server.cjs:86–95`, `readB2BMemberStore`, `writeB2BMemberStore` | 기존 `memberId`를 유지한다. 고객 설정은 별도 버전 저장소로 분리한다. |
| 사업 상태 | 같은 파일 `2412–2445`, `normalizeOwnershipStatus`, `memberProfileFromPayload` | `owned`/`planning`을 재사용한다. 현행 `agency`/`none`은 이관 시 임의로 바꾸지 않고 유형 확인 대상으로 둔다. |
| 가입·동의 | 같은 파일 `2568–2667`, `validateSignupPayload`, `consentRecordFromRequest`, `registerB2BMemberUnlocked` | 아이디·비밀번호 검증, 비밀번호 해시, 동의 버전 기록 패턴을 재사용한다. 새 서비스의 동의 범위는 별도로 기록한다. |
| 계정 상태 | 같은 파일 `2455–2483`, `2674–2686`, `3931–3989` | 현행 `active/disabled`와 매장 연결 승인 상태는 다른 값이다. 현행 가입은 `active` 생성이므로 ‘이미 회원 승인제가 완성됨’으로 표현하지 않는다. |
| 세션 | 같은 파일 `133–145`, `4310–4319`, `4367–4381`, **후행 정의** `4425–4468` | 현재 메모리 세션·12시간 유효기간·사용자 에이전트 결합·HttpOnly/SameSite=Lax/운영 Secure를 참고한다. 별도 고객 세션이 필요하다. |
| 역할 판정 | 같은 파일 `4333–4335`, `4965–4968` | 현행 정규화는 `b2b`가 아니면 관리자다. 새 고객 역할을 이 함수에 통과시키지 않는다. 명시적으로 허용한 역할 외에는 거부하는 검사를 만든다. |
| 관심숙소 저장 | 같은 파일 `2735–2758`, `2961–3002` | 기존 항목의 `interest-*`는 업체 고유번호가 아니다. 두 개 제한과 이름·수량 기반 ID를 신규 권한 식별자로 재사용하지 않는다. |
| 기존 회원 API | 같은 파일 `18338–18361` | 관심숙소·본인 검색 이력 API는 새 고객 상품과 범위가 다르다. 원본 실행 결과를 고객 리포트 API로 전환하지 않는다. |
| 기존 B2B 수집 | 같은 파일 `18396–18411` | 회원 역할로 검색·내 숙소 수집을 실행하는 경로가 있다. 고객 포털의 등록·검색 기능에 연결하지 않는다. |
| 월간 발행 | `scripts/lib/monthly_reports.cjs:498–686` | 집계·검토·발행·수정본·해시 검사를 재사용한다. 고객 배정과 공개용 내용 선별은 추가한다. |
| 월간 HTTP/PDF | `scripts/lib/monthly_report_http.cjs:6–69` | 모든 경로가 관리자용이다. 기존 관리자 API 권한을 낮추지 않고 고객 읽기 API를 추가한다. |
| 업체·지역 매핑 | `scripts/lib/monthly_report_sources.cjs:15–59`, `91–124` | 업체 고유번호, 검토 지역 우선, 실제 주소 지역, 합병 이력·플레이스 중복 검토를 사용한다. 연결 가능한 최소 필드만 고객에게 제공한다. |
| 지역 보조지표 | `scripts/lib/monthly_report_context.cjs`, `createMonthlyReportContext` | 저장된 KOSIS·관광·검색 트렌드만 사용한다. `networkAttempted=false` 불변 조건을 유지한다. |

## 3. 고객·등록 대상의 저장 계약

다음 모델의 필드명은 신규 고객 API 기준이다. 기존 운영 파일에 직접 덮어쓰는 의미가 아니다.

```json
{
  "schemaVersion": 1,
  "customerId": "cus_example",
  "memberId": "m_existing",
  "revision": 1,
  "accountStatus": "active",
  "businessStatus": "planning",
  "ownProperty": null,
  "planningProfile": { "businessType": "glamping", "projectName": "" },
  "entitlements": { "competitorLimit": 3, "interestRegionLimit": 1 },
  "competitors": [],
  "interestRegions": [],
  "accessVersion": 1
}
```

- `customerId`는 불변 ID이며 세션의 서버 측 회원 매핑에서 구한다. 고객 요청 본문의 `customerId`, `memberId`, `role`, `limits`는 권한의 근거가 아니다.
- `businessStatus=owned`는 내 매장 등록 선택을 뜻한다. `ownProperty={companyId, verificationStatus:pending|verified|rejected, ...}`를 별도로 둔다. 이름만 입력했다고 소유 확인·DB 검수 권한을 부여하지 않는다.
- 매장이 중앙 DB에 없으면 등록 요청 ID와 최소 신청 정보만 만든다. 가짜 `companyId`를 만들지 않는다. 검토 전에는 내 매장 지표·자동 소재 지역 제공을 준비 중으로 표시한다.
- `planning`은 업체번호 없이 이용한다. 예정 업종·가칭·예정 개업 정보는 선택 사항이다. 최초 선택 지역은 관심지역 한도에 포함한다.
- 각 경쟁업체 연결은 `{relationId, companyId, status, createdAt, archivedAt}`를 가진다. 활성 상태의 canonical `companyId` 중복 및 내 매장과의 중복을 거부한다.
- 지역 연결은 `{relationId, regionKey, status, createdAt, archivedAt}`를 가진다. `regionKey`는 활성·선택 가능한 지역 마스터에서 서버가 검증한다. 자유 입력 지명으로 지표를 조회하지 않는다.
- 검증된 내 매장 실제 소재지는 별도 기본 제공 범위다. 관심지역 한도를 차감하지 않는다. 동일 지역을 관심지역에 또 등록하면 중복 안내하고 두 개로 계산하지 않는다.
- 준비 중에서 매장 등록으로 전환해도 `customerId`, 경쟁업체, 관심지역, 기존 발행본 배정은 유지한다. 매장 검토 완료 시 그 업체가 경쟁업체였으면 관계를 보관 상태로 전환하고 경쟁 슬롯을 돌려준다.
- 업체 합병·지역 정정은 중앙 검토 결과의 현재 canonical ID로 신규 조회를 해석한다. 과거 발행본의 대상명·지역·객실 기준·수치는 다시 쓰지 않는다.

## 4. 고객별 수량 증감

최초 기본값은 경쟁업체 **3곳**, 관심지역 **1곳**이다. 관리자 전용 설정에서 0 이상의 정수로 조정한다. 초기 기본값과 고객별 실제 한도를 분리하며, 고객 화면은 서버가 준 `used/limit`를 표시한다.

관리자 감소 요청 예시:

```json
{
  "revision": 4,
  "competitorLimit": 1,
  "interestRegionLimit": 0,
  "keepCompetitorRelationIds": ["rel_keep"],
  "keepInterestRegionRelationIds": [],
  "reason": "제공 범위 변경"
}
```

- 감소로 현재 활성 항목 수가 초과하면 유지할 항목을 명시해야 한다. 명시가 없으면 `409 KEEP_SELECTION_REQUIRED`와 선택에 필요한 현재 목록을 반환한다. `.slice()`로 자동 절삭하지 않는다.
- 선택 ID가 고객 소유가 아니거나 중복되거나 새 한도를 넘으면 전체 변경을 거부한다. 유지 선택과 한도 변경을 단일 트랜잭션으로 저장한다.
- 제외된 관계는 `archived`로 바꾸며 과거 자료·리포트는 삭제하지 않는다. 보관 관계는 신규 실시간 분석 권한을 주지 않는다. 기존에 배정된 발행본은 별도 철회 전까지 계속 열람한다.
- 증액만으로 예전 보관 항목을 자동 활성화하지 않는다. 고객이 복원할 항목을 선택하고 당시 한도를 다시 검사한다.
- 수정에는 `revision`과 중복 요청 방지 키를 받는다. 동시 두 요청이 마지막 슬롯을 모두 차지하지 못하도록 고객별 쓰기 잠금/트랜잭션 안에서 한도를 검사한다.
- 감사 기록은 변경자, 전후 한도, 유지/보관된 관계 ID, 사유, 시각, revision을 남긴다. 고객 화면에 관리자 계정명·내부 메모를 반환하지 않는다.

## 5. 신규 고객 API와 관리자 API

`/api/customer/v1`은 고객 앱의 같은 출처 API다. 관리자 설정은 기존 STAYDATALAB의 관리자 인증 경계 안에 둔다. 아래는 새로 구현할 계약이며 기존 구현 완료 목록이 아니다.

| 요청 | 응답/효과 | 필수 검증 |
| --- | --- | --- |
| `POST /api/customer/v1/auth/signup` | 고객 계정 생성·동의 기록 | 실제 서비스 동의, 중복 계정, 입력·요청 횟수 검증 |
| `POST /api/customer/v1/auth/login`, `POST .../logout` | 고객 세션 생성/폐기 | 고객 전용 역할, 계정 활성 상태, 로그인 실패 제한 |
| `GET /api/customer/v1/me` | 상태, 등록 정보, 사용 수/한도, 제공 기능 | 세션에서 고객 ID 결정 |
| `PATCH /api/customer/v1/onboarding` | 내 매장 등록 또는 준비 중 정보 | revision, 허용 필드, 후보 업체·지역 검증; 한도 변경 금지 |
| `GET /api/customer/v1/catalog/companies?q=...` | ID·이름·소재지·플레이스 식별 정보 | 제한된 검색 결과와 페이지 크기; 원본/지표/고객정보 제외 |
| `GET /api/customer/v1/catalog/regions?q=...` | ID·지역명·단위 | 활성·선택 가능한 지역만 반환 |
| `POST/DELETE /api/customer/v1/competitors[/:relationId]` | 추가/보관 | 자기 고객, canonical 중복, 실제 한도, revision |
| `POST/DELETE /api/customer/v1/interest-regions[/:relationId]` | 추가/보관 | 자기 고객, 지역 유효성·중복·한도, revision |
| `GET /api/customer/v1/companies/:companyId/analysis` | 허용 업체의 저장 분석 | verified 내 매장 또는 활성 경쟁업체; 임의 target ID 차단 |
| `GET /api/customer/v1/regions/:regionKey/analysis` | 허용 지역의 저장 지표 | 검증된 내 매장 소재지 또는 활성 관심지역; 지역 표본의 업체별 상세는 별도 권한 |
| `GET /api/customer/v1/reports?periodType=monthly&month=...` | 배정된 발행본 목록 | 고객 배정·발행 상태·미철회만 반환 |
| `GET /api/customer/v1/reports/:deliveryId` | 고객 공개용 고정 스냅샷 | 목록과 동일한 서버 측 배정 검증 |
| `GET /api/customer/v1/reports/:deliveryId/pdf` | 같은 버전의 PDF | 파일 캐시 조회 전에 매 요청 배정·계정 상태 검증 |
| `PATCH /api/admin/customers/:customerId/entitlements` | 고객별 한도/보관 목록 변경 | 관리자 권한, 감소 유지 선택, revision·감사 기록 |
| `POST /api/admin/customers/:customerId/property-review` | 업체 연결 승인·반려 | 관리자 권한, 실제 업체, 검토 근거; 고객 입력 검수값 불인정 |
| `POST /api/admin/customers/:customerId/report-deliveries` | 공개용 발행본 배정 | 내부 published 해시 확인, 대상 범위·필드 검토, 명시적 고객 배정 |
| `POST /api/admin/customers/:customerId/report-deliveries/:id/revoke` | 열람권 철회 | 관리자 권한·사유 기록; 원본 발행본 불변 |

고객이 보낸 임의 `companyId`, `regionKey`, `deliveryId`는 모두 서버에서 다시 확인한다. 미인증은 401, 다른 고객의 대상/발행본 ID는 404, 본인의 계정이 중지됐거나 허용 기능이 없는 경우는 403으로 처리한다. 경쟁업체 전체 검색은 등록 후보 선택용 최소 메타데이터 공개이며 분석 열람 권한 부여와 구별한다.

## 6. 세션과 서비스 간 인증

- 고객 쿠키는 `__Host-sabun_insight_session; Path=/; Secure; HttpOnly; SameSite=Lax`와 같이 host-only로 발급한다. `Domain=.sabun.co.kr`을 지정해 OPS와 공유하지 않는다. 로컬 개발은 별도 쿠키 이름을 사용한다.
- STAYDATALAB의 관리자 쿠키를 고객 앱에 복사하지 않는다. 관리자도 고객 포털에서는 별도의 명시적인 지원 접근 절차 없이는 다른 고객 세션으로 전환하지 못한다.
- 현재 데이터랩은 메모리 `Map` 세션이므로 재시작 후 만료될 수 있다. 신규 고객 앱은 세션 저장소·만료·로그아웃·비밀번호 변경·계정 중지 시 철회를 일관되게 구현한다. 세션에 오래 저장된 한도·관계만 믿지 않고 현재 `accessVersion`과 계정 상태를 검증한다.
- 인증 성공 시 세션 ID를 새로 발급한다. 쓰기 API는 JSON 입력, 정확한 Origin 허용, CSRF 토큰을 검증한다. 형제 하위 도메인이라는 이유만으로 요청을 허용하지 않는다.
- BFF 서비스 자격증명은 서버에만 둔다. 내부 reader는 전달받은 고객 ID를 그대로 신뢰하지 않고 허용된 서비스 신원·요청 범위·배정 자료를 검증한다. 브라우저 번들·URL·로그에 자격증명을 넣지 않는다.
- 관리자용 서버에 붙은 기존 `normalizeUserRole()` 및 `requireAdminSession()`를 신규 고객 인증 검사로 가져오지 않는다. 허용 역할·대상·작업을 명시한 deny-default 정책으로 구현한다.

## 7. 월간 발행본을 고객에게 전달하는 계약

기존 월간 리포트는 숙박월·관측 마감일·업체 고유번호를 기준으로 집계하고, 발행 시 `snapshotHash`를 고정한다. 발행 상태에서는 `update/rebuild`가 거부되며 `revise`가 새 ID/버전을 만든다. PDF는 최초 생성 바이트를 원자적으로 저장해 재사용한다. 이 동작을 유지한다.

고객 배정 레코드는 최소한 다음 값을 갖는다.

```text
deliveryId, customerId, periodType, sourceReportId, sourceReportVersion,
sourceSnapshotHash, publicSchemaVersion, publicSnapshotHash,
scopeSnapshot(companyIds, regionKeys, aggregateOnly),
issuedAt, grantedAt, revokedAt, supersedesDeliveryId,
customerSnapshotRef, customerPdfRef, customerPdfHash
```

- 내부 보고서 전체를 그대로 전달하지 않는다. 내부 메모, 검토 담당자, 디스크 경로, 디버그 오류, 원본 예약 응답, 고객 권한 밖 업체 상세를 제외한 명시적 공개 필드 목록으로 발행한다.
- 지역/키워드 보고서에 고객이 등록하지 않은 업체가 포함될 수 있다. 지역 집계 제공 권한만 있으면 집계값과 표본 수·품질만 제공하고 미등록 업체의 상세 행·개별 시계열은 보내지 않는다. 이미 HTML에서 숨긴 행도 JSON/PDF에 남아 있으면 안 된다.
- 공개용 선별 후 집계 의미가 바뀌는 경우 기존 전체 합계를 부분 대상 합계처럼 표시하지 않는다. 범위가 동일한 공개본을 새로 집계·검토하거나 `aggregateOnly` 지역 표본임을 명시한다.
- 고객 스냅샷과 PDF는 같은 공개 projection에서 만든다. 공개 변환 버전과 해시를 고정하며, 내부 보고서 PDF를 다운로드 경로만 바꿔 전달하지 않는다.
- 이후 DB 보정·객실수 수정·한도 변경이 있어도 이미 배정된 보고서 바이트를 바꾸지 않는다. 정정은 내부 수정 발행본과 새 고객 배정본을 만들고 이전 버전 연결을 남긴다.
- 파일은 웹 정적 경로 밖에 둔다. detail/PDF 모두 권한 확인 후 스트리밍하며 `private, no-store`를 적용한다. 토큰 없는 공개 파일 URL·영구 공유 URL을 만들지 않는다.
- 발행 이후 권한 철회는 가능하지만 파일·스냅샷 수정과는 별개다. 고객 계정 중지 또는 배정 철회 후에는 이전에 받은 URL도 실패해야 한다. 이미 고객이 내려받은 PDF를 원격 회수했다고 표시하지 않는다.

## 8. 월간과 주간의 구현 범위

**월간은 기존 계산기 재사용 + 고객 공개본/배정/열람을 새로 추가한다.** 기존 숙박월 기준, DB 검토 객실 수 우선, 최대 관측 기준, 정상 0과 실패/누락 구분, 공개 녹색/방막기 추정 보라색, 데이유즈 공유 제외, 자료 충족률과 관측 시차 표시를 유지한다. 실제 결제 매출로 이름을 바꾸지 않는다.

**주간은 신규 기능이다.** 월간 보고서의 제목만 주간으로 바꾸지 않는다. `observationWeekStart/End`(KST), 비교용 동일 `stayDateRange`, 최초/최신 유효 관측, 동일 업체/공급/공유 기준의 비교 가능 표본을 명시한 계산기를 만든다. 주간 신규 관측과 예약 순증감은 실제 거래 신규예약/취소 건수가 아니다. 전주 공통 표본·누락·관측 간격을 함께 표시한다. 주간 계산 검증 전에는 고객 API의 `features.weeklyReports=false`, 화면은 준비 중으로 제공한다.

지역 지표는 `createMonthlyReportContext`의 저장 조회 원칙을 유지한다. KOSIS 공표기간, 관광지표 대상월, 검색 트렌드의 상대지수 기간을 각각 보존한다. 기준기간 불일치·미확보는 0으로 합산하지 않는다.

## 9. 기존 회원·관심숙소 이관

현행 서버 `B2B_INTEREST_LODGE_LIMIT=2`는 `publicB2BInterestLodgesForSession` 읽기와 `saveB2BInterestLodgesForSession` 쓰기에서 배열을 잘라낸다. 프런트도 `web/app.js`의 `B2B_INTEREST_LODGE_LIMIT`, `b2bMyLodgeMergeStoredValues` 주변 `10851–10870`, 정규화 `11340–11345`, 저장 `12888–12892`, 등록 `12917–12919`에서 한도를 적용한다. 신규 포털이 기존 API를 호출하면 3번째 이후 항목이 소실될 수 있다.

1. 신규 스키마 저장소를 별도 경로/테이블에 만든다. 이전 파일과 LocalStorage를 새 포털에서 양방향 자동 동기화하지 않는다. 기존 B2B 화면이 새 저장소를 두 개로 덮어쓰지 못하게 경계를 나눈다.
2. 기존 `memberId`→신규 `customerId` 매핑을 유일하게 생성한다. 구형 `username:` 소유 키는 실제 회원을 유일하게 확인할 때만 이관하고 공유 demo/master 계정을 개인 고객으로 만들지 않는다.
3. 운영 이관 도구는 먼저 dry-run으로 고객 수·중복·미확인 업체·한도 초과·보관 예정 수만 출력한다. 현재 단계에서 원본 운영 파일을 읽거나 변경하지 않는다.
4. 기존 `interest-*` ID·이름은 연결 관계의 원래 값으로 보존한다. 중앙 companyId/placeId로 확정 연결할 수 없는 항목은 `migration_pending`에 남기고 지표 권한을 주지 않는다. 같은 이름만으로 자동 합치지 않는다.
5. 기존 own/planning 분류는 보존하되 매장 소유 검토 완료로 간주하지 않는다. 운영·준비중 어디에도 맞지 않는 기존 분류는 최초 접속에서 유형 확인을 받는다.
6. 기존 기록이 기본 한도를 초과하면 관리자 유지 선택을 요구한다. 불명확한 항목을 삭제하거나 앞에서부터 자르지 않는다. 이관 실행은 백업·일관성 검수 후 별도 승인된 운영 단계에서 수행한다.
7. `migrationId`와 원본 식별자/해시·대상 ID를 남겨 동일 이관 재실행이 중복 관계를 만들지 않게 한다. 복구는 신규 이관분의 연결 상태를 되돌리며 원본 발행 리포트를 수정하지 않는다.

## 10. 단계별 완료 기준

| 단계 | 사용자에게 제공하는 효용 | 완료 근거 |
| --- | --- | --- |
| 로컬 검수 | 내 매장/준비중, 경쟁 3곳·관심 1곳, 관리자 한도 변경, 보고서 흐름 확인 | 예시 데이터 명시, 외부 통신/운영 자료 사용 없음, PC·모바일·라이트/다크 확인 |
| 고객 계정·설정 연결 | 실제 고객 가입, 매장 연결 신청, 고객별 한도 저장 | 고객 전용 세션, 영속 저장, 동시 슬롯/감소/역할 전환 테스트 |
| 월간 읽기 서비스 | 배정된 실제 월간 리포트 조회·PDF | 공개 projection 검토, A/B 격리, 원본/발행본 해시, 재시작 후 조회 |
| 주간 서비스 | 동일 숙박일에 대한 관측 변화 파악 | 별도 집계 검증·비교 가능 표본·누락 표시, 검토·발행 흐름 |
| 도메인 공개 | `insight.sabun.co.kr`에서 서비스 사용 | DNS/TLS, 정확한 서비스/커밋, 실 인증·PC/모바일 화면, 고객 간 직접 URL 접근 거부 확인 |

필수 인수 검수는 모의 고객 A/B와 격리 저장소로 먼저 수행한다.

- A의 세션으로 B의 고객 ID·관계 ID·업체 상세 ID·지역 ID·리포트 detail/PDF URL을 직접 요청해도 B의 자료를 받지 못한다. 목록 필터링만 통과한 것으로 완료하지 않는다.
- 비로그인, 계정 중지, 배정 철회, 오래된 세션/URL, 캐시된 PDF 경로에서도 같은 규칙을 검증한다. GET/HEAD·쿼리 변조·잘못된 HTTP 메서드도 검사한다.
- `customerId`, `role=admin`, `competitorLimit=999`를 고객 본문에 넣어도 상태·권한이 바뀌지 않는다. 고객 앱에서 관리자 설정 URL과 미리보기용 계정 전환 API는 거부된다.
- 경쟁업체 3곳 등록 후 동시 두 추가 요청이 모두 거부되며, 관리자가 5곳으로 늘리면 4·5번째만 허용한다. 1곳으로 감소할 때 명시한 업체만 활성으로 남고 기존 5개 이력·발행본은 보존된다.
- 준비 중→매장 등록 전환, 내 매장과 경쟁업체 중복, 동일 지역 중복, 업체 합병·소재지 정정 후 현재 권한과 과거 발행본의 처리 차이를 검증한다.
- 동일 발행본의 상세와 PDF 수치·범위·해시가 일치하며, 내보내기 필드에서 내부 메모·타 고객·미허용 업체 행이 없는지 확인한다. 원본 DB 수정 후에도 기존 발행본 바이트가 유지된다.
- 보고서 열기·검색·등록·페이지 새로고침 과정에서 수집 실행과 외부 API 요청이 0건임을 계측한다. 데이터 부족은 pending/missing이며 정상 관측의 0과 구별된다.

이 계약의 실제 운영 연결은 위 검수까지 완료한 뒤 별도 릴리스로 표시한다. 로컬 UI·모의 테스트·설계 문서만으로 실회원 연결이나 고객 서비스 운영 완료라고 보고하지 않는다.
