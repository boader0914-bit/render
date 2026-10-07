# 인사이트 예약 그래프·매출 캘린더 운영 배포

2026-10-07 사용자 배포 승인에 따라 Insight 웹 서비스만 반영했다.

## 배포 결과

- 코드: `42a4516d12cb15696475a6c547bcd32c3e1f1b97`
- 서비스: `sabun-insight-preview` (`srv-dathlifavr4c73dj3jt0`)
- 배포: `dep-db2q98c9v7es739sgrog`
- 시작: 2026-10-07 10:47:13 KST
- 소요: 30.4초
- 상태: Render `Deploy succeeded | Live`
- 운영 주소: https://sabun-insight-preview.onrender.com

예약률과 객실 수를 하나의 날짜별 누적 막대로 표시한다. 매출은 별도 월간 캘린더·표 전환으로 표시하고 날짜 선택을 연동한다. 녹색은 네이버 관측, 보라색은 타채널·전화 추정이다. 정상 0과 미확인을 구별하고 내 매장 수정 잠금 및 저장 자료를 유지한다.

## 검증

- 로컬 구문 검사 및 Insight 자동검사 124개 통과, 실패 0. 읽기 전용 독립 변경 검토에서 배포 차단 사항 없음.
- Render 빌드에서도 자동검사 124개 통과, 실패 0, Build successful 확인.
- 해당 SHA의 GitHub Actions·check-run·commit-status 등록은 0건이다. 별도 GitHub CI 성공 기록은 없으며 위 Render 빌드 검사가 배포 검증이다.
- 10:47:49 KST 운영 `/api/health`: `status=ok`, `mode=connected`, `buildCommit=42a4516d12cb`.
- 운영 `collection.js`, `company-detail.css`, `company-flow.js`, `company-view.js` 모두 HTTP 200. 줄바꿈을 LF로 정규화한 SHA-256이 검수한 로컬 파일과 각각 일치한다.
- 2026-10-07 운영 관리자 재로그인 후 실제 업체 자료 화면 검수를 완료했다. 앞선 로컬 PC·390px 모바일·라이트/다크 검수는 가상 자료 검수이며 아래 실제 운영 자료 검수와 구별한다.
- 내 매장 월명글램핑의 현재 숙박기간은 10월 7~26일이며 수량 확인은 20/20일이다. 10월 9일 예약 16/16실·100%(네이버 5실 + 타채널·전화 11실), 매출 490.4만원(네이버 151.5만원 + 타채널·전화 338.9만원)을 확인했다. 그래프·캘린더·표의 날짜 선택이 연동된다.
- 10월 매출 표는 확인일 소계 20/31일·1,656만원(네이버 1,285.2만원 + 타채널·전화 370.8만원)으로 표시하고 미확인일을 합산에서 제외한다. 10월 13일 정상 0은 예약 0실·0.0%로, 10월 1일은 미확인으로 구분한다.
- 경쟁업체 럭셔리안성M글램핑장은 수량 확인 0/26일이며 모든 날짜가 미확인이다. 예약 그래프의 26개 `×` 표시를 확인했으며 오류 자료를 정상 0으로 표시하지 않는다.
- 내 매장 매출 수정은 잠금 상태를 유지한다. 이번 인증 후 검수에서 실제 수집·DB 수정·추가 배포는 실행하지 않았다.

## 범위와 보존

배포 전후 DataLab `/api/health`의 `buildCommit=d157bed15242`가 동일하다. DataLab 및 수집워커 서비스는 배포·재시작하지 않았고, DB 수정·실제 수집·일정 변경도 하지 않았다. Insight의 자동배포 Off, 연결 브랜치, 빌드·시작 명령 및 환경 설정을 유지했다.

증빙: `C:/Users/User/.codex/visualizations/2026/10/07/insight-reservation-revenue-production/`의 `health.json`, `asset-validation.json`, `render-live.jpg`. 인증 후 운영 화면 증빙은 같은 폴더의 `production-own-store.jpg` 및 `authenticated-ui.json`으로 기록한다.
