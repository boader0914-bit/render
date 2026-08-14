# DataLab N8 Browser Snapshot Workflow

Date: 2026-08-15 (Asia/Seoul)

## 방향 정정

네이버 통합검색 Place 광고는 별도 공식 API 기능으로 분류하지 않는다. 광고의 기준
증거는 실제 네이버 검색 화면에 렌더링된 `광고` 표식, 광고주 redirect의 목적지와
숫자 Place ID다. 따라서 수집 방식은 브라우저 DOM 크롤링과 정제 스냅샷이다.

N8-D1의 서버 HTML GET 진단은 새 구현의 기준선에 포함하지 않는다. 해당 commit과
브랜치는 실패 증거로만 보존하며, 이 작업은 N7 browser transport 기준 commit
`227c385662f87d6e22e7424bf7343aa82ebac04e`에서 새로 시작했다.

## 구현 흐름

```text
기본 Place 수집 완료
-> UI의 네이버 광고 버튼
-> 동일 검색어의 search.naver.com 창 열기
-> 사용자가 캡처 bookmarklet 실행
-> 렌더링된 visible DOM에서 광고 표식 확인
-> ader.naver.com 목적지에서 map.naver.com Place ID 추출
-> 업체명, Place ID, 광고 순서만 정제
-> 원래 DataLab UI에 postMessage로 전달
-> Place ID 기준으로 기존 Place 결과와 병합
```

브라우저의 cross-origin opener가 유지되지 않으면 기존 JSON 다운로드와 `스냅샷`
import가 fallback으로 남는다. 어떤 경로에서도 서버가 네이버 광고 API를 호출하지 않는다.

## 안전 계약

- 검색 대상 origin: `https://search.naver.com`
- 검색 path: `/search.naver`
- query parameter: `where=nexearch`, `query=<현재 검색어>`
- 전달 message: `v2-naver-visible-place-ad-handoff.v1`
- capture session nonce: cryptographic random 128-bit, lowercase hex 32자리
- 수신 검증: 정확한 event origin, popup Window 객체, nonce, 검색어, capture schema
- session lifetime: UI에서 최대 10분
- raw HTML, cookie, Provider 원문, 광고 tracking URL 저장: 0
- 운영 DB와 Web import 쓰기: 0
- bookmarklet 직접 전달 실패 시 정제 JSON만 다운로드

## 변경 파일

| 파일 | 역할 |
| --- | --- |
| `scripts/v2_naver_ad_snapshot_handoff_contract.cjs` | 검색 URL, nonce, message envelope의 브라우저/Node 공용 계약 |
| `scripts/test_v2_naver_ad_snapshot_handoff_contract.cjs` | origin, nonce, message, 전역 스코프 충돌 회귀 검증 |
| `scripts/v2_naver_ad_browser_transport.cjs` | 정제 capture를 원래 DataLab popup opener로 직접 전달 |
| `scripts/v2_basic_place_test_ui_server.cjs` | handoff 계약을 정적 JavaScript로 제공 |
| `web/v2-basic-place-test/index.html` | 네이버 광고, 캡처 도구, 스냅샷 실행 controls |
| `web/v2-basic-place-test/app.js` | popup session 생성, message 수신 검증, Place 결과 병합 |
| 테스트 및 `package.json` | 새 계약과 기존 N7/UI 회귀 명령 확장 |

## 검증 결과

Node 26.5.0:

| 검증 | 결과 |
| --- | --- |
| visible-ad contract | 46 assertions 성공 |
| snapshot handoff contract | 25 assertions 성공 |
| browser DOM transport | 27 assertions 성공 |
| 기본 UI server | 153 assertions 성공 |
| 기본 UI static contract | 78 assertions 성공 |
| 실제 Provider 요청 | 0 |
| 운영 쓰기 | 0 |
| raw Provider 응답 저장 | 0 |
| tracking URL 저장 | 0 |

로컬 브라우저 검증:

- Demo Place 결과 후 `네이버 광고` 버튼 활성화 확인
- 데스크톱과 390x844 모바일 viewport에서 control 겹침 없음
- 신규 계약과 기존 계약의 browser global 충돌을 발견해 IIFE 격리 후 제거
- 수정 후 새 page load에서 추가 application 오류 없음

## 무결성

- local branch: `recovery/v2-naver-browser-snapshot-workflow`
- baseline commit: `227c385662f87d6e22e7424bf7343aa82ebac04e`
- frozen collector blob:
  `bcbe229998da3afa6f31ee04375fb0766019e56f`
- `package-lock.json`: 변경 없음
- N8 server diagnostic 파일: 이 브랜치에 없음
- Render 변경 및 추가 Provider 호출: 0

## 현재 제한과 다음 검증

현재 workflow는 사용자가 네이버 검색창에서 bookmarklet을 한 번 실행하는 수동
browser snapshot 방식이다. 브라우저 보안상 DataLab 웹페이지가 다른 origin의 네이버
DOM을 직접 읽을 수 없으므로 이 실행 단계는 필요하다.

다음 live 검증에서는 기존 Web Service를 바로 변경하지 않는다. 먼저 이 변경을
commit/push한 뒤 로컬 또는 격리 배포에서 다음 한 경로만 검증한다.

1. DataLab에서 `경남 글램핑` Place 결과 생성
2. `네이버 광고`로 검색창 열기
3. bookmarklet을 정확히 1회 실행
4. 정제 광고 4건 또는 현재 화면에 실제 표시된 건수가 UI에 직접 반영되는지 확인
5. direct handoff가 브라우저 정책으로 차단되면 JSON fallback이 정상인지 확인

페이지 2 결과 누적과 여러 snapshot의 Place ID 중복 병합은 이번 변경에 포함하지 않는다.
첫 페이지 direct handoff가 실제 브라우저에서 확인된 뒤 별도 단계로 추가한다.
