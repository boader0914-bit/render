# insight.sabun.co.kr 연결 준비 상태

2026-10-01 사용자 요청: `insight.sabun.co.kr` 하위 도메인 생성.

## 현재 확인

- Cloudflare 권한 DNS와 공개 DNS 조회에서 `insight.sabun.co.kr`은 이름 없음으로 응답했다. 아직 생성됐다고 보고할 수 없다.
- `sabun.co.kr`의 권한 DNS는 `miles.ns.cloudflare.com`, `jasmine.ns.cloudflare.com`이다.
- `https://sabun-insight-preview.onrender.com/api/health`는 HTTP 200, `mode=preview`, `hosted=true`, 빌드 `33cc7468...`를 응답했다. 기존 공개 검수 서비스다.
- 기록상의 Render 대상은 `sabun-insight-preview`, `srv-dathlifavr4c73dj3jt0`. 현재 서비스 설정/사용자 도메인 목록은 관리자 화면에 접근하지 못해 재검증하지 못했다.
- 현재 이 작업에서 브라우저가 연결되지 않아 DNS 및 Render 설정을 저장하지 않았다. 사용자가 PC에서 이 작업을 열고 Cloudflare·Render 로그인 완료를 알려주면 이어서 처리한다.

## 저장할 설정과 순서

1. Render 대상 서비스와 현재 URL을 확인하고 Custom Domains에 `insight.sabun.co.kr`을 등록한다.
2. Cloudflare의 `sabun.co.kr` DNS에 다음 레코드를 추가한다. 같은 이름이 이미 생겼다면 중복 추가하지 않고 기존 내용을 먼저 확인한다.

| 항목 | 값 |
| --- | --- |
| Type | CNAME |
| Name | insight |
| Target | sabun-insight-preview.onrender.com |
| Proxy status | DNS only |
| TTL | Auto |

3. Render에서 도메인 검증과 인증서 발급 상태를 확인한다.
4. 새 주소의 DNS·HTTPS·실제 페이지·health를 확인하고 완료를 보고한다.

루트 도메인, `www`, `ops`의 DNS·SSL 설정은 이 작업 범위에 포함되지 않는다. 새 고객 연결 코드 `fc8b9f4`는 로컬 개발 커밋이며, 위 도메인 연결은 해당 코드의 운영 배포를 뜻하지 않는다. 현재 목표 화면은 가상 자료를 쓰는 기존 공개 검수본이다. 실제 고객 데이터 연결/가입 공개는 별도 배포 검수를 거친다.

근거: [Render 사용자 도메인 안내](https://render.com/docs/custom-domains), [Cloudflare DNS 연결 안내](https://render.com/docs/configure-cloudflare-dns).
