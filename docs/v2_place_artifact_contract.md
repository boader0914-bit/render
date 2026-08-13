# V2 네이버 Place 산출물 계약

기준 커밋: `8adbb1d10ba0c137130662813ce0f3b2ccca4841`  
실행 소스 기준: `b5de9c40199f40a4409f93b1b66f0b9ccea17a83`  
collector blob: `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3`

이 문서는 UI가 아니라 동결된 V2 collector 코드와 Phase 2 오프라인·승인 live 실행 결과를 기준으로 한다.

## 1. 실행 경계

Place-only 산출물 경로는 다음 환경에서 원형 collector의 native writer까지 도달한다.

- `NAVER_LEGACY_LIMITED_ACTIVATION=1`
- `NAVER_COLLECTOR_STRATEGY=legacy_candidate`
- `NAVER_COLLECTOR_SCOPE=main_place_only`
- `NAVER_LIMITED_ACTIVATION_PROFILE=preview-admin-keyword-fast-main-place.v1`
- `COLLECTION_MODE=fast`, `COLLECTION_PURPOSE=basic_db`
- `NAVER_PROVIDER_CALL_BUDGET=1`
- `NAVER_AUTOMATIC_RETRY=0`, `NAVER_AUTOMATIC_FALLBACK=0`

실제 허용 요청은 `GET https://pcmap.place.naver.com/accommodation/list`의 `query` 파라미터 한 개다.
redirect는 `manual`, target별 요청 예산은 1, 응답 상한은 2 MiB다. 예약 GraphQL, 가격·재고,
지역 반복, OTA는 이 profile에서 호출하지 않는다.

N2-Live에서 원형과 해시 복제본이 이 요청을 각각 정확히 1회 실행해 모두 HTTP 200·parsed를
반환했다. 두 target은 자연 50행과 광고 18행을 만들었고 자연 Place ID, 광고 Place ID와 각 순서가
모두 일치했다. replay는 외부 요청 없이 원형 정제 응답을 사용했다.

## 2. Place·순위·광고 계약

| 항목 | V2 동작 |
|---|---|
| 자연 원본 | `selectNaverOrganicResult(...).items` |
| 광고 원본 | 선택된 `adBusinesses(...)`의 `ROOT_QUERY[key].items` |
| 자연 순위 | 배열 순서의 `index + 1`을 `overall_rank`로 저장 |
| 광고 순서 | 배열 순서의 `index + 1`을 `ad_order`로 저장 |
| Place ID | `item.id || ""`; `placeId` fallback은 writer에 없음 |
| 자연 상한 | 첫 50개 |
| 광고 상한 | 별도 slice 없음. Provider 광고 배열을 그대로 저장 |
| Provider total | 자연·광고 total을 report에 기록하지만 저장 행 수와 같다고 가정하지 않음 |
| 중복 제거 | 없음. 자연 내부 중복, 광고 내부 중복, 자연·광고 교차 중복을 모두 보존 |
| 광고 ID | `item.adId || ""` |
| 빈 값 | 대체로 빈 문자열. 리뷰·평점은 nullish 값만 빈 문자열이고 숫자 0은 보존 |
| 정렬 | 추가 정렬 없음. Provider 배열 순서 보존 |

광고 집행 클러스터만 이름 또는 Place ID set으로 교차 여부를 계산한다. 이 set은 행 삭제용이
아니며 중복 행은 그대로 남는다.

기본 정규화 필드는 `place_id`, `업체명`, `카테고리`, `주소`, `객실수(노출)`,
`객실명(일부)`, `금액`, `특장점`, `총리뷰`, `방문자리뷰`, `평점`, `예약`, `url`이다.
`예약`은 `hasBooking`이 명시적인 boolean일 때만 `Y` 또는 `N`이고, 없으면 빈 문자열이다.
fast profile은 예약 API를 호출하지 않고 재고 필드에 수집 생략 상태를 기록한다.

## 3. native 산출물

파일 prefix는 입력 keyword를 NFKC 정규화하고 파일 금지 문자를 공백으로 바꾼 뒤 공백을
underscore로 바꾼 최대 80자 값이다. `경남 글램핑`의 prefix는 `경남_글램핑`이다.

| role | 파일 |
|---|---|
| `platform` | `{prefix}_플랫폼통합.csv` |
| `report` | `{prefix}_수집리포트.md` |
| `overall` | `{prefix}_네이버전체순위.csv` |
| `ads` | `{prefix}_네이버광고순위.csv` |
| `regional` | `{prefix}_네이버지역별순위.csv` |
| `ddnayo` | `{prefix}_떠나요검색결과.csv` |
| `workbook` | `{prefix}_전체수집결과.xlsx` |
| `naverWorkbook` | `{prefix}_네이버순위통합.xlsx` |
| manifest | `manifest.json` |

따라서 Place-only fast profile의 native 파일은 5 CSV, 2 XLSX, report, manifest로 총 9개다.

CSV는 UTF-8 BOM, source에 선언된 열 순서, RFC 4180 형태의 quote escaping을 사용한다.
`=`, `+`, `-`, `@`로 시작하는 셀은 apostrophe를 붙여 formula 실행을 막는다.

전체 workbook sheet 순서는 `요약`, `플랫폼테스트`, `네이버전체순위`, `네이버광고순위`,
`네이버지역별상위5`, `떠나요`다. 네이버 workbook은 `요약`, `지역별상위5`, `전체순위`,
`광고순위`다. 열 순서는 대응 CSV와 동일하고 rank/order는 number, Place ID는 string이다.

manifest는 `documentType=lodging-collection-manifest`, `schemaVersion=2`다. provenance, profile,
호출 예산, 파일 role, counts는 기록하지만 파일 content digest는 기록하지 않는다. native
Place-only JSON 파일도 생성하지 않는다. Phase 2의 sanitized replay와 `pair-result.json`은
명시적인 comparison-only 산출물이다.

## 4. 저장·실패 계약

limited profile은 최종 디렉터리 옆 `.pending-{pid}-{random}` 디렉터리에 먼저 쓴다.
manifest까지 성공하면 디렉터리 전체를 `fs.rename`으로 최종 경로에 승격한다. 실패 시 pending
디렉터리를 recursive remove한다. 기존 최종 경로가 있으면 overwrite하지 않고 실행이 실패한다.

`승인 N2-Dependencies`에 따라 lockfile을 변경하지 않고 `write-excel-file@4.1.1`과
`fflate@0.8.3`을 설치했다. 원형·replay·해시 복제본은 각각 실제 XLSX 2개를 생성했다. OOXML
archive를 다시 읽어 sheet·header·row·cell type을 원형 workbook 호출과 대조했고, `수집일시`
동적 셀만 canonicalize한 semantic digest가 세 target에서 일치했다. workbook 호출 감사와
sanitized replay·pair result는 comparison-only지만 생성된 XLSX 자체는 native V2 artifact다.

## 5. live 동등성과 확인된 제한

- Phase 2 live evidence는 광고 18행과 순서를 보존했고 두 target의 광고 Place ID·순서가 일치했다.
- 독립 live 요청 사이에서 6개 광고의 `adId`와 `adDescription`은 변동했다. Place ID와 순서는
  그대로였으므로 동적 광고 메타데이터로 기록하며 byte-exact parity로 선언하지 않는다.
- 원형 정제 응답을 복제본에 replay한 canonical CSV/XLSX/report/manifest 계약은 정확히 일치했다.
- 독립 live 응답은 schema, sheet, header, 자료형, 행 수, manifest key와 file role의 structural
  parity만 확인했다. 동적 응답의 raw exact parity는 확인 항목이 아니다.
- 새 comparison JSON을 V2 native JSON으로 분류하지 않는다.
