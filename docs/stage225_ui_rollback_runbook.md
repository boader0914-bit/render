# Stage 225 UI rollback runbook

## 목적과 권한

대상은 `glamping-datalab-v2`의 V3형 UI 선택 경계뿐이다. 운영 rollback은 Product
Owner 승인, Release Manager 실행, SRE 관찰로 수행한다. 이 문서는 배포 승인이 아니며
Stage 225에서는 staging/production 변경을 실행하지 않는다.

## 즉시 rollback

1. runtime 환경의 `V2_UI_V3_ENABLED`를 정확히 `false`로 바꾼다.
2. 재시작 없는 환경이면 새 요청에서 legacy 선택을 확인한다. 재시작이 필요한 환경이면
   아래 session 유실 절차를 먼저 공지한다.
3. 승인된 이전 V2 artifact를 재선택한다. 기준 source commit은
   `4e4e1906e2967fe58df66f8ad67f832043d2763b`이며 release manifest에 기록된 artifact
   digest와 일치해야 한다. 검증되지 않은 로컬 build를 운영에 올리지 않는다.
4. API routing을 같은 V2 artifact의 Node server로 복원하고 `/api/health`가 `200`,
   `loginRequired=true`인지 확인한다. proxy에서 `/api/**`와 `/outputs/**`를 UI CDN으로
   보내지 않는다.
5. `/sw.js`가 legacy `web/sw.js` 응답인지 확인하고 browser가 update하도록 한다.
   `glamping-datalab-v2-ui-v3-*` cache만 폐기한다. 기존 legacy worker도 activate 시
   새 UI cache를 제거한다.
6. `/login`, `/admin`, `/b2b`, `/view`, `/api/session`을 순서대로 smoke한다. `/admin`과
   `/b2b` body는 legacy `web/index.html` 선택이어야 한다.

## 사용자 cache 안전 폐기

새 UI가 열린 browser console 또는 지원 도구에서 다음 범위만 제거한다.

```javascript
const keys = await caches.keys();
await Promise.all(keys
  .filter((key) => key.startsWith("glamping-datalab-v2-ui-v3-"))
  .map((key) => caches.delete(key)));
const registration = await navigator.serviceWorker.getRegistration("/");
await registration?.update();
location.reload();
```

`glamping_datalab_session` cookie, 계정 데이터, `lodging-v2-theme` localStorage를 cache
정리 명령으로 일괄 삭제하지 않는다. 문제가 있는 사용자에게만 새 UI의
`PURGE_V2_UI_CACHES` message를 보낸다.

## session을 보존할 수 없는 경우

cookie 이름과 인증 모델은 바뀌지 않았지만 현재 session 저장소는 server process
memory다. artifact 교체나 process restart 뒤 기존 session을 보존할 수 없으면 다음과
같이 안전하게 처리한다.

1. 사용자를 `/login?reason=session-expired`로 보낸다.
2. 가능하면 `/api/logout`을 호출해 stale `glamping_datalab_session` cookie를 만료한다.
3. logout 호출이 실패해도 server의 다음 HTML 요청이 만료 cookie를 정리하도록 한다.
4. 사용자가 공식 `/login`에서 아이디 또는 이메일과 비밀번호로 다시 인증하게 한다.
5. session token을 localStorage로 복원하거나 수동 복사하지 않는다.

## 검증과 종료

- flag off에서 manifest, service worker, offline page와 icons가 `web/` 원본과 byte 동일
- 로그인 후 `/admin`, `/b2b`가 legacy HTML과 동일
- `/view`와 역할 불일치 redirect가 기존 계약과 동일
- `/api/health`, login/session/logout shape가 변경되지 않음
- V3 asset 요청과 `glamping-datalab-v2-ui-v3-*` cache가 0
- session 유실 사용자에게 안전한 재로그인 안내 완료

위 항목이 하나라도 실패하면 rollback을 완료로 표시하지 않고 Release Manager가
incident 상태를 유지한다.
