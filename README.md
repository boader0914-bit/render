# Glamping Cluster App

글램핑 키워드 기반 네이버/야놀자 NOL/떠나요/ONDA 수집 테스트와 클러스터 분석을 위한 웹 앱입니다.

## Render 배포

이 저장소는 Render Blueprint 배포용 `render.yaml`을 포함합니다.

현재 연결된 공공데이터는 **한국관광공사 지역별 방문자수**와
**지역별 관광 수요 강도**입니다. 승인키가 API마다 다른 경우를 대비해
각 API 키를 아래 전용 Secret으로 직접 입력할 수 있습니다.

- Key: `DATA_GO_KR_VISITOR_SERVICE_KEY`
- Value: 공공데이터포털에서 승인받은 **지역별 방문자수 인증키 문자열만** 입력
- Key: `DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY`
- Value: 공공데이터포털에서 승인받은 **지역별 관광 수요 강도 인증키 문자열만** 입력

기존에 `DATA_GO_KR_SERVICE_KEY`로 연결해 둔 서비스는 그대로 작동합니다.
전용키가 있으면 전용키를 먼저 사용하고, 없을 때만 기존 공통키를 사용합니다.

1. Render Dashboard에서 `New +`를 선택합니다.
2. `Blueprint`를 선택합니다.
3. 이 GitHub 저장소를 연결합니다.
4. 환경변수 입력 화면에서 `APP_PIN`을 입력합니다.
5. 검색량/클릭률 수집이 필요하면 네이버 API 키도 입력합니다.
6. 지역별 방문자수는 `DATA_GO_KR_VISITOR_SERVICE_KEY`를 Secret으로 입력합니다.
7. 관광 수요 강도는 `DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY`를 Secret으로 입력합니다.

필수 환경변수:
- `APP_PIN`

선택 환경변수:
- `DATA_GO_KR_VISITOR_SERVICE_KEY` (현재 연결된 지역별 방문자수 전용)
- `DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY` (지역별 관광 수요 강도 전용)
- `DATA_GO_KR_SERVICE_KEY`
- `NAVER_CLIENT_ID`
- `NAVER_CLIENT_SECRET`
- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`

공공데이터 서비스키는 저장소나 앱 설정 화면에 입력하지 않습니다. 기존
Render 서비스에서는 Dashboard의 해당 Web Service를 열고 `Environment`에서
`DATA_GO_KR_VISITOR_SERVICE_KEY`와 `DATA_GO_KR_DEMAND_STRENGTH_SERVICE_KEY`를
직접 추가한 뒤 `Save and deploy`를 누릅니다.
값에는 따옴표, 변수명, Endpoint URL을 붙이지 않습니다. Blueprint의 `sync: false`는
비밀값 자체를 저장하지 않으며, 새 Blueprint 생성 시 입력란만 제공합니다.

자원수요·다양성 등 나머지 승인 API는 아직 이 수집기에 연결하지 않았습니다.
키 입력칸과 수집기는 API별로 하나씩 검증한 뒤 순차 추가합니다.

지역 분석의 수요전망은 한국관광공사 `DataLabService/locgoRegnVisitrDDList`를
사용합니다. 최신 완전월을 끝으로 하는 최근 36개월을 한 번 갱신한 뒤 월별
Snapshot을 재사용하고, 이후에는 최신 완전월만 월 1회 보충합니다. 날짜와
현지인·외지인·외국인 구분이 모두 확인된 지역만 `일평균 순방문자`를 표시하며,
미관측·부분수집·오류는 0명으로 바꾸지 않습니다. 품질 기준을 충족한 경우에만
방문자 보조점수를 수요구조 종합점수에 최대 15%, 입지 보정에 10% 반영합니다.
자료가 부족하면 가중치는 0%로 두고 기존 지표만 다시 정규화합니다.

관광 수요 강도는 `AreaTarDemDsService`의 월별 `관광 체류 강도`와
`관광 소비 강도`를 서로 분리해 저장·표시합니다. 일반 화면은 저장된 Snapshot만
읽고, 관리자는 선택 지역의 최근 36개월을 별도로 갱신할 수 있습니다. Persistent Disk 운영환경에서는
산청군을 먼저 적재하고, 전국 시군구의 최근 12개월을 우선한 뒤 과거 24개월을
이어 채우는 백그라운드 작업도 실행합니다. 개발계정 일일 1,000회 한도에 여유를
두기 위해 기본 예산은 800회이며, 자동 선수집과 관리자의 선택 지역 갱신이 이 예산을
함께 사용합니다. 한 지역·한 달은 체류·소비 각 1회로 제한합니다.
진행상태는 `/var/data/tourism_data/maintenance/demand_strength_backfill.json`에
기록되므로 배포나 재시작 후에도 이어집니다. 최초 36개월 적재가 끝나면 최신 완료월만
월별로 보충합니다. 같은 지역·월이 서로 다른 한국시간 날짜에 3회 연속 확보되지 않으면
`관측 없음·검토`로 남기고 다음 항목을 진행합니다. 이는 0값이 아니며 관리자가 해당
지역을 다시 갱신하면 정상 자료로 해제될 수 있습니다. 두 지수를 임의로 합산하거나
방문자수로 바꾸지 않고, 부분수집·미관측 값은 0으로 대체하지 않습니다. 실제 응답의
척도와 안정성이 검증되기 전까지 기존 수요전망 점수에는 반영하지 않습니다.

관련 환경변수:

- `TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED` (`1`이면 자동 선수집)
- `TOURISM_DEMAND_STRENGTH_DAILY_CALL_BUDGET` (기본 `800`, 서버 상한 `900`)

기본 `render.yaml`은 Starter Web Service와 `/var/data` Persistent Disk를 사용합니다.
다른 Render 설정 파일을 선택한 경우에는 해당 파일의 저장 경로와 요금제를
별도로 확인해야 합니다.

자세한 절차는 `RENDER_DEPLOY.md`를 확인하세요.
