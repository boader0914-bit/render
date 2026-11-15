# 조회 안정화 첫 개발 묶음

기준 운영 커밋은 `d052b02e0b147ccd1cfc796c8638ed94bfdc8c3f`다. 이 변경은 원인 계측, 키워드 월별 화면의 실패 처리, 목록 조회의 반복 읽기 축소만 포함한다. 운영 배포와 실제 수집은 별도 작업이다.

## 원인 계측

- 분석 스케줄러의 기존 실행권 안에서 업무 종류·진단 번호·프로세스 번호와 단계별 시간·메모리를 연결한다. 실행권·메모리 입장·수집 보호 정책은 바꾸지 않는다.
- 단계 시작과 종료에 `heapUsed`, `heapTotal`, `rss`, `external`, `arrayBuffers`, V8 힙 한계를 기록한다. 최고값은 체크포인트에서 관측한 최고값이며 연속 측정한 할당 피크가 아니다. `arrayBuffers`는 `external`에 이미 포함되므로 다시 합산하지 않는다.
- 숫자 메타데이터만 허용한다. 원본 행·고객 정보·입력·결과·오류 메시지·환경변수·인증값은 저장하지 않는다.
- 완료 기록 최대64개, 보유 단계 최대32개, 활성 추적 최대64개다. 단계 보유 한도 뒤에도 경계 샘플은 관측하되 추가 단계 배열을 보관하지 않는다.
- 로그는 프로세스당60초에 최대60이벤트다. 별도 타이머·파일·힙 덤프·강제 GC는 없다. observer·샘플러의 실패가 본래 결과나 오류를 바꾸지 않는다.
- 관리자 GET `/api/keyword-monthly/refresh-status`의 `phaseDiagnostics`로 프로세스 내 진단을 읽는다. 로그 식별자는 `analytical_phase_diagnostic`이다. 이 조회가 수집·재계산을 시작하지 않는다.
- 완료된 비동기 문맥을 상속한 다음 업무는 새 기록을 만든다. 문맥에 남은 완료 기록 참조를 해제한다.

## 조회 실패와 저장 화면

- HTTP 상태와 Content-Type을 JSON 파싱 전에 확인한다. HTML502, JSON503, 잘못된 JSON, 네트워크 오류,20초 기본 제한시간을 통제된 안내로 표시한다.
- 같은 키워드·숙박월·관측 마감의 마지막 정상 결과와 목록을 유지하며, 최신 조회 실패라는 사실을 표시한다. 수량·금액을0으로 바꾸지 않는다.
- 마지막 정상 payload 참조1개만 유지한다. 조건별 대형 결과 캐시를 추가하지 않는다.
- 다른 기간·키워드의 수치를 현재 결과처럼 사용하지 않는다. 정상 응답이 missing/stale 상태를 확인했다면 과거 값을 정상 결과로 되살리지 않는다.
- 현재401/403·로그인 리다이렉트는 비공개 결과와 선택 상태를 지운다. 오래된 오류나 응답은 새 선택을 덮지 못한다.
- 동일 조건의 진행 요청은 공유하며 명시 마감과 자동 마감, 화면 안의 상품·업체 선택을 구별한다.
- 목록을 처음 읽다가 실패해도 수동 재조회 버튼을 사용할 수 있다. HTTP 실패 이후 자동 반복은 하지 않는다. 화면 숨김 때문에 취소한 조회만 복귀 시 한 번 재개한다.

## 목록 조회 경량화

- 동일 pointer 세대의 동시 목록 조회가 하나의 읽기 작업을 공유한다.
- 파티션의 index는 최초와 최종 검증에 각각 한 번 읽는다. 기존4회에서2회로 줄이며 경로·링크·파일 상태·SHA·세대 변경 검사를 유지한다.
- 같은 SHA의 검증된 index에서 목록에 필요한 작은 메타데이터만 캐시한다. 전체 관측 그래프·projection·월 snapshot은 캐시하지 않는다.
- 최대64항목, 원본 index 직렬화 바이트 합계8MiB로 제한한다. 이는 실제 V8 객체 힙8MiB를 보장하는 수치가 아니다. 진행 중 목록 세대는 최대4개다.
- 파일 바이트와 SHA는 재조회에서도 확인한다. 캐시가 변조·교체·손상을 가리지 않는다. 최종 index 확인 중 pointer가 변경돼도 결과를 채택하지 않는다.
- freshness와 기본 마감은 현재 날짜로 다시 평가하지만 저장 원본의 `materializedAt`, `dataThrough`, 최신성 검증 상태는 유지한다.
- 저장 형식·계산식·관측 행·지원 마감·게시 포인터 형식은 바꾸지 않는다.

## 보존과 검증

서버 파일 자체를 계산 캐시 지문에 포함하는 경로가 있어 이번 진단 연결은 `glamping_app_server.cjs`를 수정하지 않는다. 원본·발행본 저장소, 객실 검수, 월 집계 산식, 증분 게시, 수집·인사이트 정기예약 구현은 기준 커밋과 동일한지 보존 시험으로 확인한다.

외부 공급자를 호출하지 않는 집중 검증 명령:

```powershell
node --test --test-concurrency=1 scripts/test_analytical_phase_diagnostics.cjs scripts/test_analytical_phase_runtime.cjs scripts/test_query_stability_preservation.cjs scripts/test_keyword_monthly_analysis_ui.cjs scripts/test_keyword_monthly_analysis.cjs scripts/test_keyword_monthly_bundle.cjs scripts/test_keyword_monthly_compressed_projection.cjs scripts/test_keyword_monthly_http.cjs scripts/test_keyword_monthly_app_integration.cjs scripts/test_keyword_monthly_readonly_outputs.cjs scripts/test_keyword_monthly_refresh_integration.cjs scripts/test_keyword_monthly_incremental_refresh.cjs scripts/test_keyword_monthly_publish_months.cjs scripts/test_analytical_work_scheduler.cjs scripts/test_analytical_serial_lifetime.cjs scripts/test_background_memory_integration.cjs scripts/test_company_integrated_read_db.cjs scripts/test_insight_recurring_collection.cjs
```

`scripts/preview_query_stability.cjs`는 가상 자료만 사용하고127.0.0.1에만 바인딩하는 로컬 브라우저 검수다. 실제 계정·쿠키·자료 디렉터리·수집기·공급자와 연결하지 않는다. 정상/HTML502/JSON503/잘못된 JSON/401을 선택해 자료 유지와 초기화를 확인할 수 있다. 운영 서버나 외부 사용자에게 공개하지 않는다.

2026년11월15일 Node24.22.1의 최종 집중 검증은341개 통과·실패0·건너뜀0이다. package.json의 check에 포함된79개 구문 검사와 행정구역 검사는 직접 Node 실행으로 통과했다. npm 명령이 없는 환경이라 동일 명령을 순서대로 실행했다. 공통 `test_surface_contrast.cjs`는 기준 d052에서도 VM의 window 미정의로 실패하는 기존 문제가 있어 별도 기록하고 이 변경에서는 수정하지 않았다. 집중 검증 통과를 전체 프로젝트 검증 통과로 표현하지 않는다.

이번 묶음은 메모리 부족의 작업별 원인을 관측할 준비와 실패 완충을 제공한다. 무거운 상세 계산의 사전 저장·메모리 입장 제어는 다음 묶음이다. 이 변경만으로 운영 OOM 재발 해소나2초 목표 달성을 주장하지 않는다. 운영 배포 후 실제 부하의 진단·저장 표시 시간·최신 세대 채택을 별도로 확인해야 한다. 인사이트 정기수집은 중지 상태를 유지한다.
