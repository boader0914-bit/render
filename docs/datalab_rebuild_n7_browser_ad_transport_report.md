# N7 네이버 통합검색 Place 광고 Browser Transport

## 기준과 목적

- 기준 커밋: `d2e6e1280a6b779a53f85696ee567911d33cfe04`
- 로컬 브랜치: `recovery/v2-naver-browser-ad-transport`
- 목적: `/accommodation/list`에서 누락된 광고를 사용자의 네이버 통합검색 실화면에서 정제해 기본 Place UI 결과와 결합한다.
- 유기 Place 결과 원천은 기존 `/accommodation/list`를 유지한다.

## 구현 경계

1. 수동 bookmarklet은 `https://search.naver.com`의 이미 렌더링된 `li`만 읽는다.
2. 화면에 보이는 정확한 `광고` 표식과 `ader.naver.com` 목적지의 숫자 Place ID가 함께 있어야 한다.
3. CSS class에는 의존하지 않고, 광고 컨테이너·대표 링크의 첫 텍스트 자식·Place ID로 업체명을 식별한다.
4. Place ID로 반복 링크를 중복 제거하고 최대 100건만 정제한다.
5. JSON에는 광고 순서, Place ID, 업체명과 증거 수준만 저장한다.
6. 원문 HTML, 추적 URL, 쿠키, Provider 응답과 인증 정보는 저장하지 않는다.
7. DataLab UI의 JSON import는 검색어, 생성 시각, schema, 중복, privacy 계약을 다시 검증한다.
8. 광고 결과는 브라우저 메모리에서만 기존 Place 결과와 결합하며 서버 디스크와 운영 DB에 쓰지 않는다.

## 실화면 검증

기존에 열려 있던 `경남 글램핑` 네이버 검색 탭을 새로고침하거나 다시 요청하지 않고 동일 transport의 읽기 전용 실행 경로를 검증했다.

- 광고 컨테이너: 4개
- 광고 링크: 48개
- Place ID 중복 제거: 44개
- 최종 광고: 4개
- 거절된 컨테이너: 0개
- 합천H글램핑: `1000421329`
- 럭셔리 비토섬 제이글램핑: `1995649140`
- 옥돌캠핑장: `2092090019`
- 아르비토 호텔 글램핑: `2000486899`

첫 실화면 실행에서는 앞의 세 업체만 대표 링크 첫 자식이 `span`이었고, 아르비토 호텔 글램핑은 `div` 기반 카드라 3건만 잡혔다. 대표 링크의 첫 텍스트 자식을 `span` 또는 `div`로 일반화하고 해당 alternate layout을 회귀 fixture에 추가한 후 4건 모두 일치했다.

## UI 통합 검증

- 로컬 URL: `http://127.0.0.1:4181/`
- Demo 유기 Place: 5건
- browser 광고: 4건
- 광고 원천 표시: `통합검색 실화면 · 4건`
- 추가 Provider 요청: 0
- 운영 쓰기: 0
- 데스크톱 1440x1000: 문서 가로 overflow 0
- 모바일 390x844: 문서 가로 overflow 0, 테이블은 기존 전용 scroll container 안에서만 가로 스크롤
- 브라우저 console error/warn: 0

## 남은 범위

- 실제 bookmarklet 클릭에 의한 JSON 다운로드는 사용자 브라우저 다운로드 동작이므로 이번 읽기 전용 실화면 검증에서는 실행하지 않았다. 동일 source의 추출·직렬화·다운로드 경계는 격리 테스트로 검증했다.
- 현재 방식은 자동 수집이 아니라 사용자가 네이버 검색 화면에서 캡처하고 JSON을 UI에 가져오는 수동 transport다.
- commit, push, Render 배포와 기존 Web Service 변경은 실행하지 않았다.
