# Stage 225 V3 UI 기반과 병행 운영 구현 기록

## 상태와 범위

- 단계: `225`
- 선행 조건: Stage 224 `blockers=[]`, migration/backfill/dual-write `0`
- 대상: `glamping-datalab-v2`
- 구현 상태: 로컬 구현 및 검증 대상, staging/production 미배포
- 데이터 영향: 기존 V2·Cluster 데이터 읽기·복사·표시 `0`; 빈 화면의 수치는 모두 `0`
- legacy 경계: `web/` 파일은 수정하지 않으며 flag off의 실응답 원본으로 유지
- Stage 226 인증 저장 모델 변경은 수행하지 않음

## 고정 참조와 선별 이식

V3 UI 참조는 이동 branch가 아니라 커밋
`2bcdc7c0843358bb3cbb8a2025ffe873d3bf5154`만 사용했다.

| 이식 대상 | 고정 참조 경로 | V2 구현 |
| --- | --- | --- |
| token, AppShell, PageHeader, StatusBadge, MetricCard, EmptyState | `packages/ui/src/index.tsx`, `packages/ui/src/styles.css` | `packages/ui/src/index.tsx`, `packages/ui/src/styles.css` |
| theme boot | `apps/web/public/theme-boot.js`, `apps/web/index.html` | key를 `lodging-v2-theme`으로 변경하고 React 전에 외부 script로 실행 |
| 인증 panel 비율 | `apps/web/src/App.tsx`, `apps/web/src/app.css` | 440px panel, 28px padding, 42px input, 44px submit |
| desktop/mobile shell | 동일 UI 파일 | 248px sidebar, 64px topbar, 760px 이하 horizontal navigation |

V3의 3,681행 `apps/web/src/App.tsx`와 7,123행 `apps/web/src/app.css`는
통째로 복사하지 않았다. V3 업무 API, fixture, `lodging-v3-theme`, fail-open session
처리도 이식하지 않았다. AppShell의 브랜드, 상태 문구, 홈 경로와 link renderer는
모두 props다. V3 고정 커밋에 없는 `/signup`은 같은 인증 panel primitive의 빈 shell로
구성했다.

## workspace와 의존성 경계

- npm workspaces: `apps/web`, `packages/ui`
- lockfile: 루트 `package-lock.json` 하나
- React/React DOM: `19.2.7`, hoist된 단일 설치
- Vite: `8.1.5`; TypeScript: `7.0.2`
- 다른 package manager와 lockfile은 허용하지 않음
- `apps/web/dist`는 생성물이며 git 추적 대상이 아님

기존 `xlsx@0.18.5`에는 npm audit high 공개 취약점 1건이 있고 registry에서
`fixAvailable=false`다. 새 UI bundle은 `xlsx`를 import하지 않으며 이 기존 위험은
Stage 225 UI 활성화 blocker가 아니라 별도 dependency 교체 과제로 유지한다.

## 단일 route/navigation registry

registry 정본은 `apps/web/src/routeRegistry.ts`다.

사업자 9개:

| 화면 | 경로 |
| --- | --- |
| 시작 안내 | `/app/onboarding` |
| 검색·관심 | `/app/activity` |
| 리포트 | `/app/report` |
| 입지카드 | `/app/location` |
| 지역 지도 | `/app/map` |
| 업체 순위 | `/app/ranking` |
| 전략 추천 | `/app/strategy` |
| 실행계획 | `/app/execution` |
| 월간 회고 | `/app/retrospective` |

관리자 13개:

| 화면 | 경로 |
| --- | --- |
| 운영 홈 | `/admin/overview` |
| 업체 DB | `/admin/companies` |
| 수집 | `/admin/collection` |
| 입지카드 | `/admin/location` |
| 전국 지도 | `/admin/map` |
| 업체 순위 | `/admin/ranking` |
| 데이터 신뢰도 | `/admin/reliability` |
| 데이터 가져오기 | `/admin/import` |
| 백업·복구 | `/admin/backup` |
| 운영 품질 | `/admin/operations-quality` |
| 계정·요금제 | `/admin/access` |
| 단계 검토 | `/admin/stage-review` |
| 설정 | `/admin/settings` |

인증 전 registry는 `/login`, `/signup`, `/activate`, `/reset-password`다.
호환 경로는 `/admin` → `/admin/overview`, `/b2b` → `/app/onboarding`, `/view` →
현재 역할 홈이다. 새 UI에서 사업자의 `/admin` 및 `/admin/*` 접근은 server `403`이다.
flag off에서는 기존 V2 redirect 계약을 그대로 유지한다.

## API, session과 fail-closed 경계

`apps/web/src/apiClient.ts` 한 곳에서 JSON/error 변환, same-origin credential,
session/login/logout과 선택적 `X-CSRF-Token` 주입을 담당한다. 현재 V2 server에 CSRF
token 발급 계약이 없으므로 token 저장 모델을 새로 만들지 않았다. 기존
`glamping_datalab_session` HttpOnly cookie와 server memory session은 변경하지 않는다.
session 조회가 실패하면 공개 상태로 열지 않고 재로그인 상태로 닫는다.

## CSS, theme와 접근성

- 첫 방문: `light`
- 사용자 선택: `dark`
- 저장 key: `lodging-v2-theme`
- React 실행 전 `/theme-boot.js`가 `data-theme` 적용
- 허용 전역: V2 token을 정의하는 `:root`와 `body[data-v2-ui="v3"]`
- 컴포넌트 selector: `[data-v2-ui-root]` 아래 및 `@layer v2-*`
- focus: 2px 이상 outline과 fallback 제공
- `color-mix`와 `backdrop-filter`는 `@supports` 안에서만 향상 적용
- 최소 폭 320px, 모바일 horizontal navigation, reduced-motion 대응

## feature flag와 RACI

| 항목 | 동결 값 |
| --- | --- |
| flag | `V2_UI_V3_ENABLED` |
| 기본값 | `false` |
| owner / Responsible | Frontend Engineer |
| approver / Accountable | Product Owner |
| Consulted | Backend Engineer, QA Engineer, Security Engineer |
| Informed | SRE, Release Manager |
| dependsOn | Stage 224 blocker=0, production UI build |
| 역할 | admin, b2b |
| rollout | local QA → internal admin → internal business → limited pilot |
| 관찰 | legacy response parity, UI error, session failure, asset load p95 |
| rollback | flag false 후 V3 cache namespace 폐기 |

canonical `render.v2.yaml`과 `render.v2.persistent.yaml`에도 값은 명시적으로
`false`다. build가 없는데 flag가 true이면 legacy로 조용히 fallback하지 않고 UI
요청만 `503`으로 fail closed하며 API health는 유지한다.

## PWA 동결 값

- name: `숙박업 데이터랩 V2`
- 기존 설치 호환 id/start URL: `/b2b`
- scope: `/`
- service worker URL: `/sw.js`
- cache key: `glamping-datalab-v2-ui-v3-stage225-v1-{shell,static}`
- `/api/**`, `/outputs/**`, navigation response: 영구 cache 금지
- 폐기 대상: `lodging-datalab-pwa-*`, `glamping-datalab-v2-ui-v3-*`만
- cookie, 계정 데이터와 `lodging-v2-theme`은 cache 폐기 대상이 아님

## bundle 예산

Stage 225에서 다음 값을 동결한다. sourcemap은 계산에서 제외한다.

| 지표 | 중단선 |
| --- | ---: |
| eager JS+CSS raw 합계 | 650,000 bytes |
| eager JS+CSS gzip 합계 | 180 KiB |
| CSS gzip 합계 | 40 KiB |
| 일반 application JS chunk raw | 500,000 bytes |
| route chunk raw / gzip | 250,000 bytes / 60 KiB |

비교 실측 기준은 legacy V2 JS 1,465,301 raw/309,389 gzip, CSS 774,260
raw/88,037 gzip, 고정 V3 eager 고유 asset 1,115,540 raw/251,404 gzip이다.
실제 Stage 225 build 값은 `npm run build:ui`의 budget 출력으로 검증한다.

## 검증 명령과 종료 gate

```powershell
npm run test:contracts
npm run test:integration-preview
npm run test:stage224
npm run typecheck:ui
npm run build:ui
npm run test:ui
npm run test:ui-contracts
npm run test:ui-server
npm run test:ui-visual
npm test
git diff --check
git diff --exit-code -- web
```

시각 검증은 login/admin/business × desktop `1440×900`/mobile `390×844` ×
light/dark의 필수 12장과 320px, 200% 확대를 검사한다. console/page/request 오류,
가로 overflow, navigation 개수, focus 이동, 입력 label, panel 비율과 WCAG AA 대비가
모두 중단 조건이다. 증적은 `artifacts/stage225/visual-qa`와
`test/results/stage225_visual_qa.json`에 생성한다.

Stage 226은 이 단계에서 수행하지 않는다.

## 종료 증적

- `npm test`: exit `0`
- production build: raw `224,814` bytes, gzip `69,558` bytes, CSS gzip `3,198` bytes
- React/React DOM `19.2.7`: root 설치 1개, 중복 0
- 필수 screenshot: 12/12 통과; 320px·200% 확대 추가 6조건 통과
- 브라우저 console/page/request 오류: 0
- flag off legacy 정적 파일과 로그인 후 HTML: byte 차이 0
- `git diff --exit-code -- web`: exit `0`
- `git diff --check`: exit `0`
- staging/production 배포: 0
- blockers: `[]`

구조화된 종료 증적은 `docs/stage225_completion_evidence.json`, 시각 상세 결과는
`test/results/stage225_visual_qa.json`에 있다.
