# 상품별 최대관측 수량과 런치·디너 재사용 정책

계산 버전: `inventoryEvidence.version = 5`, `phoneValuationPolicy = proportional_product_shortfall_v2`, `dayUseSharingPolicy = lunch_dinner_room_reuse_v1`.

이 정책은 저장 원본을 바꾸지 않는 계산용 읽기 모델이다. 원본 CSV·상품 JSON·수집 영수증·기존 발행 리포트는 갱신하거나 덮어쓰지 않는다. 변경된 계산 결과와 앞으로 발행할 리포트에서 정책 버전과 근거를 보존한다.

## 객실 기준 우선순위

- 업체 객실 총량은 DB 검수값이 최우선이다. 상품별 최대 수량을 합쳐 업체 총량을 임의로 늘리지 않는다.
- DB에서 상품별 객실 수를 검수한 `lodgingOverride.products`는 누적 최대나 현재 관측으로 상향하지 않는다.
- 같은 업체·같은 상품 번호의 정상 원본에서 확인한 누적 최대를 상품별 부족수량 계산에 사용한다. 입력 연결부는 업체 식별과 관측 시점 이전의 근거임을 검증한다.
- 연결 입력은 `inventoryCapacityBaseline.lodgingProducts[bizItemId] = count` 또는 `{ count, sourceDate, observedAt, runId }`이다. `observedProductMaximums` 배열의 `{ bizItemId, capacity, ... }`도 지원한다.
- 추출 함수 `observedProductCapacityEvidence(item, baseline)`는 상품별 DB 재고 보정, 안내상품 제외, 검수된 번호 객실 정규화 후의 값을 반환한다. 정상 `observed && stockObserved && !inventoryConflict`만 최대관측 근거로 사용할 수 있다.
- 실패·차단·누락·응답 오류의 0은 정상 0실이 아니다. 오류 자료는 가격 대체 근거나 최대 수량에 넣지 않는다.
- 상품별 최대 합계가 업체 총량을 초과하면 업체 총량을 유지하고 `product_maxima_exceed_company_capacity` 경고를 남긴다. 직접 관측한 방막기 매출은 보존하되, 겹친 모수를 이용해 추가 부족수량을 임의로 배분하지 않는다.

## 런치·디너 공유 객실 차감

런치·디너는 같은 객실을 시간대별로 재사용한다. 같은 날짜·같은 객실군에서는 `max(런치 공개판매 수량, 디너 공개판매 수량)`을 숙박 방막기에서 한 번만 제외한다. 여러 독립 객실군은 각각 계산한 결과를 합산한다. 런치와 디너의 판매 횟수·데이유즈 매출은 각각 보존한다.

객실군은 `sharedRoomGroupId` 등 명시적인 연결값이 우선이다. 자동 연결에서는 상품명에서 런치·점심·디너·다이닝·저녁과 시간 구간, 문장부호를 제거한 동일 명칭을 사용한다. A룸·B룸처럼 남아 있는 객실 구분은 유지한다. 일반 데이유즈 상품을 업체 단위로 모두 묶어 최대값으로 처리하지 않는다. 런치·디너 객실군의 명칭이 일치하지 않으면 독립 수량으로 남기고 `unmatched_lunch_dinner_room_group` 경고를 기록한다.

`sharedRooms.status = separate / confirmed_separate / not_shared`인 업체는 데이유즈의 숙박 차감을 하지 않는다. 알려진 데이유즈 상품의 날짜별 응답이 빠졌으면 전체 부족수량을 숙박 판매로 추정하지 않는다.

## 상품별 부족수량과 금액 배분

1. 정상 응답에서 직접 확인한 상품별 방막기와 같은 상품의 가격으로 계산 가능한 금액을 먼저 보존한다.
2. 상품별 잔여 부족수량은 `상품 최대관측 수량 − 예약가능 − 공개예약 − 이미 배분한 직접 방막기`이다.
3. 직접 방막기에 먼저 반영하고 남은 공유 데이유즈 차감이 여러 상품에 걸쳐 있으면, 차감 후 숙박 추정 수량을 잔여 부족수량 비율로 배분한다.
4. 각 상품의 숙박일 가격을 적용한다. 없는 가격은 같은 상품의 정상 관측 가격 중 같은 요일, 가까운 날짜 순으로 대체한다. 다른 상품의 가격을 빌려오지 않는다.
5. 비례 배분 후보 중 하나라도 같은 상품의 가격 근거가 없으면 잔여 수량 전체를 정수인 가격 미확인 수량으로 유지한다. 다른 상품으로 재배분해 채우지 않고 이미 계산된 직접 방막기 금액만 보존한다. 미확인 금액을 0원 매출 확정으로 표현하지 않는다.

상품 배분 수량의 소수는 관측된 실제 객실수가 아니라 계산 가중치다. `phonePriceEstimates`의 기존 가격 근거 `source`는 유지하고 `allocationSource/quantitySource = proportional_product_shortfall`, `estimatedQuantity = true`, `priceSource`와 원래 가격 관측일을 저장한다. 업체·날짜별 예약 수량과 가격 미확인 수량은 정수로 유지한다. 배분 가격의 가능한 하한·상한은 상품별 잔여 부족수량을 초과하지 않는 범위에서 계산한다. 가격이 일부 없으면 완전한 금액 범위를 만들 수 없으므로 `completePriceCoverage = false`와 `null` 범위를 기록하고 `proportional_price_evidence_incomplete` 경고를 남긴다.

금액은 날짜별 계산을 끝낸 후 원 단위로 반올림하고 월 합계는 반올림한 날짜별 금액의 합으로 만든다. `phoneValuation.unroundedRevenue`에는 반올림 전 값을 남긴다. 이미 계산된 예약·금액에 추가분을 다시 더하는 방식이 아니라 원본에서 읽기 모델을 재생성하므로 반복 계산해도 중복 합산되지 않는다.

## 보존 필드

- 상품 기준: `lodging.productCapacityEvidence[]`의 `productKey/count/source/sourceDate/observedAt/runId`.
- 날짜별 배분: `phoneAllocatedBookings`, `phoneAllocatedRevenue`, `phoneRevenueLow`, `phoneRevenueHigh`, `phoneRevenueRangeComplete`, `phoneValuation`, `phonePriceEstimates`.
- `phoneFallbackBookings/Revenue`는 비례 배분과 겹치지 않는 직접 수량의 대체 가격만 합산한다. 비례 배분에서 대체 가격을 썼다면 `phoneAllocatedBookings/Revenue`에 포함하고 각 상품의 `priceSource/sourceDate`로 가격 근거를 보존한다. 따라서 예약 수량 필드는 정수이며 상품별 소수 가중치는 세부 근거에만 남는다.
- 공유 차감: `sharedDayUseEvidence`의 세션 수, 재사용 후 객실 수, 실제 차감 수, 객실군, 상품 번호, 분류 근거, 경고.
- 가격 누락 수량: `phoneMissingPriceBookings`는 계산 불가능한 금액의 수량이며 정상 0실과 구별한다.

## 검증

`node --test scripts/test_inventory_product_allocation.cjs scripts/test_inventory_blocked_revenue.cjs`

`node scripts/test_inventory_estimation.cjs`

피카푸의 보존된 9월 7일 원본을 사용한 고정 재현에서는 런치·디너 재사용으로 9월 4일의 숙박 차감이 2실에서 1실이 된다. 상품별 기준 14/8/8/8을 적용했을 때 종전 미확인 37실과 재사용으로 늘어난 1실의 추가 추정매출은 날짜별 반올림 합계 9,191,226원이다. 이 재현값은 당시 선택된 7개 날짜 원본 기준이며, 운영에서 새롭게 유효한 원본이 선택되면 최신 결과는 달라질 수 있다.
