# 데이터랩 재구축 Phase 4 프롬프트 초안

> 상태: 예약 확장 경로만 차단됨. 기본 Place 수집·업체 식별은 Phase 2 결과로 계속 사용할 수 있다.
> 별도 승인된 bookingBusinessId 매핑 live가 성공하고 그 변경이 commit되기 전에는 이 예약 상품
> 초안을 실행하지 않는다. 기능별 단독 canary 승인 방식을 적용한다.

당신은 데이터랩 재구축 4단계를 담당하는 시니어 수집 시스템 개발자다.

목적은 Phase 3 live와 commit으로 확인된 선택적 네이버 예약 연동 ID를 입력으로, V2의 예약 상품
`searchBizItem` GraphQL 경로 하나만 원형과 해시 복제본에서 검증하는 것이다.

확정 기준은 완료된 `HANDOFF_REBUILD_PHASE_3`의 commit, collector blob, source manifest,
lockfile, live job digest, booking identity hash와 호출 증거를 사용한다. Phase 3 live 또는 commit이
완료되지 않았으면 시작하지 않는다.

절대 준수사항:

- 기존 Render, 운영 DB·Redis·Web import와 UI를 변경하지 않는다.
- 업체 기본키는 계속 `naver-place:{place_id}`를 사용하고 `bookingBusinessId`로 대체하지 않는다.
- 승인된 예약업체 ID 한 개의 `searchBizItem` 외 Provider 호출을 차단한다.
- Place 목록, booking-business 재조회, `dailySchedule`, HTML, 지역, OTA는 호출하지 않는다.
- Provider 원문, header, cookie, credential과 full URL을 저장하지 않는다.
- retry, fallback, proxy를 사용하지 않는다.
- live 호출, commit·push, Render 변경은 각각 별도 승인을 받는다.

수행 작업:

1. Phase 3 commit과 live identity 증거, collector blob, source 20개를 재검증한다.
2. `getNaverBookingItems`와 `naver_booking_items`의 query, 변수, parser, ID·가격 필드를 명세한다.
3. 입력 bookingBusinessId는 Phase 3 검증값으로 고정하고 원문 출력 대신 hash를 보고한다.
4. `POST https://m.booking.naver.com/graphql`, operationName `searchBizItem` 한 번만 허용한다.
5. 정상, 빈 상품, 중복, 누락 필드, GraphQL 오류, 403/429/challenge, timeout, oversize를 fixture로 검증한다.
6. 원형 정제 응답을 해시 복제 parser에 replay하여 exact parity를 확인한다.
7. 독립 live pair는 원형 1회와 복제본 1회, 총 최대 2회로 제안한다.
8. 상품 ID·이름·기본 가격 필드와 동적 값의 비교 규칙을 `LIVE_CALL_PLAN_N4`에 명시하고 멈춘다.

날짜별 판매 가능 여부와 재고는 `dailySchedule` 후속 단계로 남긴다. 상품 응답의 가격 필드가
존재한다는 사실만으로 특정 날짜의 실판매 가격 또는 재고가 구현됐다고 선언하지 않는다.
