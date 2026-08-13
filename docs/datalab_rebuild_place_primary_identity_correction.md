# DataLab Place Primary Identity Correction

작성일: 2026-08-14 KST

## 결론

네이버 업체의 기본 식별자는 Place 목록과 지도 URL에서 얻는 `place_id`다. 지도 URL
`/place/35644668`의 `35644668`처럼 경로에 표시되는 숫자를 수집한다. 저장 업체 키는
`naver-place:{place_id}`다.

`bookingBusinessId`는 같은 업체의 네이버 예약 상품·가격·재고를 조회할 때만 필요한 선택적
연결값이다. 조회 실패나 미제공 상태가 Place 업체의 존재, 순위, 광고 또는 기본 식별자를
무효화해서는 안 된다.

## 로컬 수정

- 네이버 `/place/{id}`와 `/accommodation/{id}` URL에서 Place ID를 추출한다.
- 비네이버 URL에서는 Place ID를 추출하지 않는다.
- 후보 병합은 Place ID를 예약 연동 ID보다 먼저 사용한다.
- 저장 projection은 `companyKey === naver-place:{place_id}`를 검증한다.
- 예약 상세가 모두 없는 `rank_only` 실행에서도 Place 업체 20개를 보존한다.

## 경계

동결 collector, Provider, Render 및 운영 저장소는 변경하거나 호출하지 않았다. 이 수정은 Place
기본 식별 계약과 로컬 소비·저장 경계만 바로잡으며, Phase 3 예약 연동 ID의 독립 live parity
실패를 성공으로 재분류하지 않는다.
