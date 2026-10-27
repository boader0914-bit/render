# 저장 자료 기반 로컬 검수

운영 고객 화면 코드와 `createInsightAnalysis`에 별도로 준비한 데이터랩 통합자료 사본을 연결합니다. 사본은 저장소 밖의 절대 경로로 전달하며 이 폴더에 추가하지 않습니다.

```powershell
node customer-portal/review/readiness/connected.cjs "C:/Users/User/.codex/visualizations/2026/10/27/insight-comparison-readiness/saved-source.json" 58027
```

검수 주소는 `http://127.0.0.1:58027/#competitors`입니다. 리포트에서 전체 숙박일·숙박월·향후 30일·직접 기간을 선택할 수 있습니다. 업체 자료에는 사본에 저장된 통합관측만 연결합니다. 지역 통계·상품 기본정보 등 사본에 없는 내용은 미확인으로 남깁니다.

보호 조건:

- `RENDER` 또는 `NODE_ENV=production` 환경에서는 실행하지 않습니다.
- `127.0.0.1`에만 바인딩하고 모든 변경 요청은 HTTP 405로 거절합니다.
- 주입한 로컬 응답기만 사용하며 외부 서버를 호출하지 않습니다.
- 원본 사본은 읽기만 하고 파일·DB·디스크 캐시를 작성하지 않습니다.
- 수집·예약·보호 설정을 바꾸지 않습니다.
- 화면에 로컬 검수 및 저장 사본 기준일을 표시합니다.
