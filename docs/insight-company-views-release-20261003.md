# 인사이트 업체 조회·그래프 및 지역 12개월 흐름 운영 배포

2026-10-03 한국시간. 사용자 배포 승인에 따라 두 웹 서비스에 동일 코드를 반영했다.

## 배포 버전

`d157bed15242b33978d5658a2425f9a558f70b31`

- 업체 등록 후 A~D 저장 자료 조회, 별도 30일 예약·추정매출 수집 설정, 기본/그래프/캘린더/표 전환.
- 같은 숙박일 집합의 관측일별 변화, 공개 예약/방막기 추정 구분, 오류·누락을 0으로 처리하지 않는 그래프.
- 앞선 `9363f3f`의 최근 12개월 지역지표 화면 및 권한 범위 내 이력 준비 기능 포함.
- 수집워커 실행 코드는 이번 배포 대상이 아니다. 수집 실행·취소, 보호 해제, 일정·계정·요금제 변경은 하지 않았다.

## 실제 배포 결과

| 대상 | Render 서비스 | 배포 | 시작 시각(KST) | 걸린 시간 | 상태 |
|---|---|---|---|---|---|
| 데이터랩 | srv-da9q6don74is738t7id0 | dep-db06p61srm7s73eartkg | 11:46:48 | 48.1초 | Deploy succeeded · Live |
| 인사이트 | srv-dathlifavr4c73dj3jt0 | dep-db06pr2d0e5s73ab9kkg | 11:48:12 | 39.6초 | Deploy succeeded · Live |

데이터랩 health에서 새 버전을 확인한 뒤 인사이트를 배포했다. 서비스에 설정된 과거 Git 브랜치의 최신 커밋 버튼을 사용하지 않고 위 전체 SHA를 지정했다. 두 서비스 `/api/health`는 HTTP 200 및 `buildCommit=d157bed15242`이며 인사이트 `mode=connected`다.

## 검증

- 동일 커밋의 관련 로컬 자동검증 92개 통과, 실패 0. 실제 격리 DataLab 서버와 원문 fixture를 사용하는 통합검증 포함.
- 인사이트 Render 빌드 자동검증 59개 통과, 실패 0, Build successful 확인.
- GitHub Actions 실행 기록과 해당 커밋의 status/check-run은 0건으로 별도의 GitHub CI 성공 기록은 없다.
- 운영 `/company-flow.js` HTTP 200 및 신규 모듈 포함 확인.
- 비로그인 업체 결과·지역 분석·관리자 고객 결과 API는 모두 401. 등록 범위와 일일 한도는 자동검증으로 확인했다.
- 운영 고객 관리자 세션이 만료되어 사용자에게 재로그인을 요청했다. 실제 업체 데이터가 있는 신규 화면의 로그인 후 검수는 아직 완료하지 못했다. 로컬 PC/390px 및 라이트/다크 검수와 운영 자료 검수는 구분한다.

## 수집 상태 보존

11:45:07 사전 점검과 11:49:40 배포 후 점검 모두 세 워커의 activeJobId=null, queued=0, crawl.active=false, queueLength=0, halted=false, errorCode 비어 있음.

- 종전 일일 수집, web 일정, scheduled 일정은 비활성 유지.
- manual(BG worker) 일정은 활성, 다음 실행 2026-10-03 17:00 KST 유지.
- 디스크 여유 8,597MiB로 동일.
- 점검은 로그인된 Render Shell의 운영 계정 환경변수를 프로세스 메모리에서만 사용했다. 비밀번호·쿠키·토큰 값은 출력하거나 저장하지 않았다.

증빙: `C:/Users/User/.codex/visualizations/2026/10/03/insight-company-views-production/`의 `datalab-live.png`, `insight-live.png`.
