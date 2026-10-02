# 인사이트 관리자 계정 · 2026-10-02

사용자 요청: 인사이트 운영 관리자 계정 생성. 일반 고객의 `b2b` 권한과 운영 관리자 권한을 혼용하지 않는다.

## 권한과 저장

- 고객 웹 `/admin`에서 인사이트 전용 계정으로 로그인한다. 기존 고객 로그인은 `b2b` 계정만 허용한다.
- 계정·비밀번호 해시·세션·생성/활성화/중지/로그인 감사 기록은 중앙 `DATA_DIR/customer_insight/admins.sqlite`에 저장한다. 고객 서버의 휘발성 파일시스템에는 저장하지 않는다.
- 비밀번호는 scrypt, 무작위 salt로 해시한다. 로그인 세션은 SHA-256 해시만 저장하며 8시간 유효하다. 운영 브라우저 쿠키는 `__Host-sabun_insight_admin`, Secure, HttpOnly, SameSite=Strict다. 고객 로그인 쿠키와 공유하지 않는다.
- 로그인 제한: 계정별 8회/15분, 전체 60회/15분. 비활성화는 모든 세션을 즉시 무효화한다. 해시 계산 도중 권한이 철회되어도 세션을 발급하지 않는다.
- 인사이트 고객 목록·상세·등록 대상·요청을 조회하고, 경쟁업체/관심지역 한도·내 매장 확인·고객 이용 상태를 변경할 수 있다. 기존 동시수정 방지·변경 사유·감사 이력을 사용한다.
- 데이터랩 전체 관리자 API, 크롤링 실행, 워커 설정, 계정 발급 권한은 인사이트 관리자에게 열지 않는다. 고객 BFF와 관리자 BFF 모두 경로·메서드를 명시적으로 제한한다.
- 현재 한도 축소에서 유지할 대상 선택, 업체 DB 보정, 수집 준비 실행은 기존 데이터랩 도구를 사용한다.

## 최초 설정

1. 데이터랩 운영 관리자가 `/insight-admin-accounts`에서 아이디를 준비한다. API는 기존 데이터랩 관리자 로그인과 동일 출처를 요구한다.
2. 준비한 계정은 `pending`이며 로그인할 수 없다. `admin` 이름만으로 권한을 얻지 않는다.
3. 사용자가 새 비밀번호·확인을 직접 입력한 뒤 **관리자 권한 부여 및 계정 활성화**를 누른다. 12자 이상, 영문·숫자·특수문자를 포함한다. 로컬 검수용 `0914`를 운영에 복사하지 않는다.
4. 활성화 후 고객 웹 `/admin`에서 로그인한다. 기존 데이터랩 관리자 세션과 자동으로 공유하지 않는다.
5. 계정 설정 화면에서 사용 중지할 수 있다. 공개 회원가입이나 고객 서비스 인증키만으로 관리자를 발급할 수 없다.

## 검증

`node --test scripts/test_insight_admin.cjs scripts/test_insight_connection.cjs scripts/test_insight_app_integration.cjs scripts/test_insight_signup.cjs scripts/test_monthly_report_sources.cjs customer-portal/test/*.test.cjs` — 57개 통과.

실제 격리 데이터랩+BFF에서 준비 계정 로그인 거부, 약한 비밀번호 거부, 동시 활성화 단일 성공, 고객/관리자 세션 분리, 권한 필드 삽입 거부, 동일 출처·CSRF 보호, 관리자 한도 변경·감사 기록, 서버 재시작 후 보존, 중지 즉시 세션 무효화, 워커·전체 관리자 API 접근 거부를 검증했다.

로컬 `57970`/`57971`의 가상 고객으로 관리자 로그인→목록→상세→한도 저장을 브라우저에서 확인했다. 390px 다크모드 가로 넘침 없음. 운영 비밀번호는 대신 입력하지 않는다.

## 운영 반영과 남은 사용자 설정

2026-10-02 20:05 KST 확인:

- 운영 코드 `08da40da39e8d7145c74838956612b2321f73149`를 두 웹에 명시적으로 배포했다. 수집 워커는 배포하지 않았다.
- 데이터랩 `srv-da9q6don74is738t7id0`: `dep-davouohsrm7s73cr7mbg`, Render `Deploy succeeded | Live`, 42.7초.
- 인사이트 `srv-dathlifavr4c73dj3jt0`: `dep-davov4m7bikc73etdelg`, Render `Deploy succeeded | Live`, 31.5초.
- 두 공개 `/api/health`의 `buildCommit=08da40da39e8`, 인사이트 `mode=connected`를 확인했다. 운영 `/admin` 전용 로그인 화면을 확인했다.
- 비로그인 관리자 상태·고객 목록·계정 발급 API는 모두 HTTP 401로 보호됐다.
- 중앙 운영 관리자 인증 API로 `admin`을 **비밀번호 설정 대기(pending)** 상태로 준비했다. 준비 시각 `2026-10-02T11:05:04.971Z`. 비밀번호를 생성하거나 입력하지 않았으며, 활성화·실제 운영 관리자 로그인은 아직 완료되지 않았다.
- 사용자에게 `https://staydatalab.kr/insight-admin-accounts`를 열어 두었다. 배포로 운영 관리자 세션이 만료되어 데이터랩 로그인부터 필요하다. 로그인 후 해당 설정 주소에서 비밀번호 입력·확인 및 최종 활성화를 직접 완료해야 한다.
- 활성화 후 로그인 주소는 `https://sabun-insight-preview.onrender.com/admin`이다. `insight.sabun.co.kr` 연결 완료를 의미하지 않는다.
- 배포 전후 수집 실행·대기 0, 워커 보호 중단 없음. 기존 BG 수집 예약은 유지됐고 다음 실행은 `2026-10-03T08:00:00.000Z`(17:00 KST)다. 다른 워커 예약과 기존 일일 자동수집은 비활성 상태를 유지했다. 디스크 여유 8,603 MiB.
- 화면 증빙: `C:/Users/User/.codex/visualizations/2026/10/02/insight-admin/production-admin-login.png`, `central-live.png`, `insight-live.png`.
