# 운영 재시작과 키워드 집계 종료

운영 웹 프로세스가 SIGTERM 또는 SIGINT를 받으면 새 HTTP 연결을 받지 않고, 키워드 월별 집계 연결부의 `close()`를 호출한다. 대기 중인 집계는 분석 작업의 AbortSignal로 해제하며, 실행 중인 하위 프로세스는 기존 중단·정리 절차를 마칠 기회를 갖는다. HTTP 요청과 집계 종료를 최대 20초 기다린 뒤 종료한다. 시간초과·정리 실패는 안전한 상태 코드만 기록한다.

이 종료부는 원본, 예약 설정, 발행본, 보호 상태를 수정하거나 잠금 파일을 강제로 지우지 않는다. SIGKILL, 프로세스 충돌, 서버 손실에서는 정리가 실행된다고 보장하지 않으므로 기존 소유자 검증과 검토가 필요하다. 운영 서버 파일에 명시적으로 연결했으며, 파일 전체를 사용하는 기존 캐시 버전은 이번 변경 때 한 번 무효화될 수 있다.

2026-11-15 로그에서 저장된 업체 목록 준비는 423~606ms였고, 운영 중 HTTP health 경로는 집계 대기열이나 원본 조회를 기다리지 않는다. 재시작 직후 업체 통합 bootstrap은 32.997초였으며, 내부 원본 조회 완료 뒤 약 27.7초가 더 걸렸다. 이 벽시계 시간만으로 5초 이상의 단일 CPU 점유나 특정 메모리 오류를 확정할 수 없다.

업체 통합 bootstrap은 메타데이터 업체·대상·숙박월 사이에 이벤트 루프를 양보한다. 원본 재확인과 저장 자료의 무결성·재사용 판정은 유지한다. 로그에는 `bootstrap_targets_metadata`, `bootstrap_revision_prepare`, `bootstrap_saved_months`, `bootstrap_revision_recheck`, `bootstrap_state_publish` 단계의 시간과 수치만 남겨, 다음 운영 검수에서 남은 지연 구간을 구분한다. 원본 경로·업체명·고객 정보는 단계 로그에 넣지 않는다.

검증:

```text
node --test scripts/test_application_shutdown.cjs scripts/test_keyword_monthly_refresh_integration.cjs
node --test scripts/test_company_bootstrap_responsiveness.cjs scripts/test_company_integrated_db.cjs scripts/test_company_integrated_restart.cjs scripts/test_company_integrated_source_revision.cjs scripts/test_company_integrated_cached_revision.cjs
node --test scripts/test_company_revision_startup_readiness.cjs scripts/test_report_startup_readiness.cjs
```
