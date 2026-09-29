# SABUN Insight 무료 실물 페이지 배포

- 확인일: 2026-09-29 KST
- URL: https://sabun-insight-preview.onrender.com
- Render: `sabun-insight-preview`, `srv-dathlifavr4c73dj3jt0`
- 유형: Web Service / Node / Singapore / Free (0.1 CPU, 512 MB)
- 배포: `dep-dathlinavr4c73dj3ksg`, 10:56:26 시작, 29.2초 후 Live
- 실행 커밋: `33cc7468cf64d0cd3b1251ebce3d51ede41a0016`
- 브랜치: `codex/insight-render-preview`
- 시작: `node customer-portal/server.cjs --preview`
- 자동배포: Off, 별도 DB·디스크 없음

## 확인 결과

- 로컬 및 Render 빌드에서 테스트 21개 통과.
- `/api/health` HTTP 200, 위 커밋 일치, hosted=true, fictional / temporary-session 명시.
- HTML HTTP 200, noindex 응답, JS/CSS와 세 글꼴 HTTP 200 확인.
- 실제 HTTPS 브라우저에서 고객별 예시 한도 3→4 저장 후 재진입 4 확인, 다시 3으로 복원.
- 운영 중/준비 중 회원 전환, 월간 리포트 목록과 상세 정상 동작.
- PC 화면 및 모바일 390×844의 라이트/다크 화면 확인. 모바일 가로 넘침 없음.
- 브라우저 console error/warn 없음.
- 스크린샷: `C:/Users/User/.codex/visualizations/2026/09/29/sabun-insight-render/`의 desktop-live.png, mobile-dark.png, render-live.png.

## 범위와 남은 연결

이번 배포는 가상 자료를 사용한 온라인 검수본이다. 실제 회원가입, 고객 인증, 운영 DB 및 리포트 배정은 아직 연결하지 않았다. 방문자의 예시 설정은 임시 메모리에 분리되며 서버 휴면·재시작 또는 세션 만료 시 초기화될 수 있다.

`insight.sabun.co.kr`의 DNS는 아직 연결되지 않았다. 권한 DNS는 Cloudflare이며, Render 사용자 도메인 등록과 Cloudflare DNS 연결·TLS 확인이 남아 있다. 이번에는 위 onrender.com HTTPS 주소로 접속한다. Render 설정의 Custom Domains 부분은 점검 당시 Loading 상태여서 등록을 완료하지 않았다.

무료 웹서비스는 15분 무접속 후 휴면하며, 다시 접속하면 약 1분 기동 지연이 생길 수 있다. 워크스페이스 월 750 무료시간 및 포함 트래픽·빌드 사용량을 공유하며, 서비스 컴퓨트 요금은 $0 플랜이다.

기존 STAYDATALAB 웹 및 수집워커 서비스는 이번 배포에서 수정하지 않았다. 실제 수집은 실행하지 않았다.
