# 운영 판단 카드 로컬 검토

저장된 초안 JSON을 읽는 내부 검토 화면이다. 실제 고객 서비스, 수집기, 가격·쿠폰 실행, DB·일정 저장과 연결하지 않는다. 모든 문구는 DOM `textContent`로 표시한다.

저장소 루트에서 실행:

```powershell
node customer-portal/review/judgment-cards/server.cjs
```

표시된 `http://127.0.0.1:<port>` 주소를 연다. 두 번째 인자로 지정 포트를 줄 수 있다. 호스트는 항상 127.0.0.1이며 GET/HEAD와 정확한 정적 경로만 제공한다. POST는 405, 허용하지 않은 경로는 404다.

자료: `customer-portal/knowledge/operating-judgment-cards.v1.json`. 서버는 `validate-operating-judgment-cards.cjs`의 검증을 통과한 자료만 제공한다. 브라우저에서도 초안·미승인·미정 값과 실행 금지 정책을 확인하며, 맞지 않거나 자료를 읽을 수 없으면 오류를 표시한다. 할인율·시점·목표의 미정 값을 0으로 바꾸지 않는다. 필터·검색·접기·테마 변경은 브라우저 화면에서만 동작하고 저장되지 않는다.
