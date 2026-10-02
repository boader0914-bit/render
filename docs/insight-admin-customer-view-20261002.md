# 관리자 고객 화면

관리자 로그인 성공 후 `/customer-view#home`으로 이동한다. 기존 로그인 세션에서는 `/admin`의 **고객 화면 보기**로 들어간다. 고객 화면 상단의 **관리자 화면**으로 관리 업무에 복귀할 수 있다.

## 데이터와 권한

- 관리자마다 중앙 고객 저장소에 고유한 체험 프로필을 유지한다. `memberId=insight-admin:<adminId>`, `accountKind=admin_preview`로 일반 고객과 구분한다. 별도 고객 비밀번호나 고객 로그인 세션을 발급하지 않는다.
- 서버가 로그인한 관리자 ID로 프로필을 결정한다. 브라우저가 다른 고객 ID를 지정하거나 일반 고객 쿠키로 관리자 체험에 진입할 수 없다.
- 내 매장 1곳, 경쟁업체 기본 3곳, 관심지역 기본 1곳 등 기존 고객의 등록·중복·검수 규칙과 동일한 처리 함수를 사용한다. 매장 확인과 공통 업체 정보 수정은 기존 검수 절차를 거친다.
- 변경·요청은 실제 저장된다. 관리자 고객 화면임을 상단에 표시하고, 관리 목록의 일반 고객 수와 관리자 체험 수를 분리한다. 체험 계정 자료 준비 요청만으로 수집이 실행되지는 않는다.
- 관리자 비활성화·로그아웃·세션 만료 시 체험 접근도 종료된다. 일반 고객의 세션 쿠키는 덮어쓰지 않는다.
- 고객 리포트 화면 등 기존 연결 준비 중 기능은 그대로 표시한다. 이 변경은 미구현 리포트 기능의 완성을 의미하지 않는다.

## 검증

`node --test scripts/test_insight_admin.cjs scripts/test_insight_connection.cjs scripts/test_insight_app_integration.cjs scripts/test_insight_signup.cjs scripts/test_monthly_report_sources.cjs customer-portal/test/*.test.cjs` — 57개 통과.

실제 격리 서버 통합 검증에 관리자별 프로필 분리, 일반 고객과 쿠키 동시 보유 시 분리, 다른 고객 ID 삽입 거부, CSRF, 일반 고객 한도·매장 검수 유지, 체험 내 관리자 한도 명령 거부, 재시작 후 보존, 관리자 권한 철회 후 접근 거부를 추가했다.

브라우저에서 로그인 후 자동 이동, 가상 매장 검색·등록·확인 대기 표시, 관리자 화면 복귀·체험 프로필 구분, 고객 화면 재진입을 확인했다. 브라우저 오류 로그 없음. 실제 운영 고객의 등록 자료를 검수용으로 수정하지 않았다.

## 운영 배포 확인

2026-10-02 20:49 KST, `b8dc2eea89e9a209fb0e1b66274d73d6e484a758` 배포 확인:

- 데이터랩 `dep-davpjk942hec73dmp5mg` — `Deploy succeeded | Live`, 42.6초.
- 인사이트 `dep-davpjo60tbcc73esv4g0` — `Deploy succeeded | Live`, 29.2초.
- 두 웹 `/api/health` HTTP 200, `buildCommit=b8dc2eea89e9`. 인사이트 `mode=connected`.
- 운영 관리자 `admin`의 기존 로그인 세션으로 고객 홈을 실제 확인했다. 내 매장 0/1, 경쟁업체 0/3, 관심지역 0/1인 관리자 체험 프로필이 생성·보존됐다. 고객 화면→관리자 화면→고객 화면 왕복을 확인했고, 일반 고객 0명·관리자 체험 1개로 구분됐다. 운영 매장·경쟁업체 등록은 임의로 하지 않았다.
- 비로그인 고객 체험 상태·업체 검색 API HTTP 401, 운영 브라우저 오류 로그 없음.
- 배포 후 수집·대기 작업 0, 워커 보호 중단 없음. BG 예약의 다음 실행 `2026-10-03T08:00:00.000Z`(17:00 KST), 다른 두 워커 예약과 기존 일일 수집 비활성 상태 모두 유지. 디스크 여유 8,603 MiB. 수집 워커는 배포하지 않았다.
- 증빙: `C:/Users/User/.codex/visualizations/2026/10/02/insight-customer-view/production-customer-view.png`, `central-live.png`, `insight-live.png`.
