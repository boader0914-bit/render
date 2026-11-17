# Saved history reader: ordered I/O prefetch

범위는 `keyword_monthly_incremental_history.cjs`의 읽기 단계뿐이다. q API, 환경변수, 수집/provider 동시성, 재시도·메모리·입력 보호 기준을 바꾸지 않는다. refs 없는 `{month}` 전체 월 조회와 기존 refs 조회에 모두 적용한다.

- reader마다 압축 payload lease를 고정 2개만 둔다. 여러 read 호출이 겹쳐도 이 reader가 읽거나 보유한 압축 payload는 최대 2개다. 비동기 파일 읽기만 겹치며 SHA·후검증·gunzip·JSON parse·counter 증가는 원래 segment index 순서다. 최종 physical ordinal sort와 소비 순서는 그대로다.
- 앞/뒤 `H.checked`, leaf size·SHA, 8MiB gzip/raw 상한, partition/month/header·tuple ordinal/count 검증과 query 시작/끝의 `assertCurrent`를 유지한다. refs metadata 필터와 runId의 행 단계 필터도 그대로다.
- 오류를 관측하면 새 task를 추가하지 않는다. lease 대기와 pre-check 뒤에도 오류 위치를 다시 확인해 뒤 파일 읽기를 시작하지 않는다. 이미 시작한 읽기는 모두 settle·release한 뒤 원래 index가 앞선 오류를 반환한다. consumer 오류도 다음 batch를 시작하지 않는다.
- 성공 시 기존 stats와 동일하다. `segmentReads/segmentBytes`는 원래대로 검증·decode를 끝낸 segment 계수다. 실패한 선행 읽기 시도 횟수나 HTTP 호출 수로 바꾸지 않는다.

메모리: 유효 압축 payload는 장당 최대 8MiB이므로 소유한 압축 버퍼는 최대 16MiB다. 순차 reader의 8MiB에 비해 압축 lookahead 한 개, 최대 8MiB가 추가된다. raw decode 상한 8MiB와 batch의 행 보존 방식은 기존과 같다. 처리한 압축 버퍼의 참조를 제거한 뒤 lease를 돌려준다. 대기 task는 segment metadata만 보유하며 payload cache를 만들지 않는다. 이것은 RSS/GC/Node 내부 할당의 절대 peak 보장이 아니다. 기존 운영 memory admission을 완화하지 않는다.

검증에는 30dd serial source fixture를 사용한다. 테스트 코드 텍스트에 한해서 checkout의 CRLF를 LF로 바꾼 뒤 Git의 고정 SHA `3a938ea65f26ca2c803dbff40d839434fb90263c6022361ed8e226bafb674ea7`를 대조해 Linux/Windows checkout 차이를 처리한다. 운영 reader·데이터 JSON·raw history line에는 정규화를 적용하지 않는다. 모든 데이터 파일은 합성 임시 파일이다. refs 없는 두 월·unscoped·refs·partition/run 필터의 row/header/raw line·전체 stats와, 실제 `normalizePair → incremental catalog → monthly_report_sources.loadSources → history reader`의 normalized 전체 값 및 금융 snapshot/core 전체 필드를 대조한다. 실제 연결 fixture에서 readRows 인자는 정확 `{month}`이고 refs가 없음을 명시 검사한다.

이 변경은 읽는 파일 수를 줄이는 refs 최적화와 다르다. 파일 읽기 대기 시간을 겹치는 후보이므로 실제 전체 월 A/B와 후속 자연 집계의 시간·메모리 검수가 필요하다. 전체 99범위 집계 시간이나 503 빈도 개선을 합성 시험만으로 주장하지 않는다. 새 source fingerprint에 따른 넓은 재계산도 생략하지 않는다.
