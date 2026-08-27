# Glamping Cluster App

글램핑 키워드 기반 네이버/야놀자 NOL/떠나요/ONDA 수집 테스트와 클러스터 분석을 위한 웹 앱입니다.

## Render 배포

이 저장소는 Render Blueprint 배포용 `render.yaml`을 포함합니다.

현재 실제 연결된 공공데이터는 **한국관광공사 지역별 방문자수** 하나입니다.
승인키가 API마다 다른 경우를 대비해 방문자수 키는 아래 전용 Secret으로
직접 입력할 수 있습니다.

- Key: `DATA_GO_KR_VISITOR_SERVICE_KEY`
- Value: 공공데이터포털에서 승인받은 **지역별 방문자수 인증키 문자열만** 입력

기존에 `DATA_GO_KR_SERVICE_KEY`로 연결해 둔 서비스는 그대로 작동합니다.
전용키가 있으면 전용키를 먼저 사용하고, 없을 때만 기존 공통키를 사용합니다.

1. Render Dashboard에서 `New +`를 선택합니다.
2. `Blueprint`를 선택합니다.
3. 이 GitHub 저장소를 연결합니다.
4. 환경변수 입력 화면에서 `APP_PIN`을 입력합니다.
5. 검색량/클릭률 수집이 필요하면 네이버 API 키도 입력합니다.
6. 지역별 방문자수는 `DATA_GO_KR_VISITOR_SERVICE_KEY`를 Secret으로 입력합니다.

필수 환경변수:
- `APP_PIN`

선택 환경변수:
- `DATA_GO_KR_VISITOR_SERVICE_KEY` (현재 연결된 지역별 방문자수 전용)
- `DATA_GO_KR_SERVICE_KEY`
- `NAVER_CLIENT_ID`
- `NAVER_CLIENT_SECRET`
- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`

공공데이터 서비스키는 저장소나 앱 설정 화면에 입력하지 않습니다. 기존
Render 서비스에서는 Dashboard의 해당 Web Service를 열고 `Environment`에서
`DATA_GO_KR_VISITOR_SERVICE_KEY`를 직접 추가한 뒤 `Save and deploy`를 누릅니다.
값에는 따옴표, 변수명, Endpoint URL을 붙이지 않습니다. Blueprint의 `sync: false`는
비밀값 자체를 저장하지 않으며, 새 Blueprint 생성 시 입력란만 제공합니다.

수요강도·자원수요·다양성 등 다른 승인 API는 아직 이 수집기에 연결하지 않았습니다.
키 입력칸과 수집기는 API별로 하나씩 검증한 뒤 순차 추가합니다.

지역 분석의 수요전망은 한국관광공사 `DataLabService/locgoRegnVisitrDDList`를
사용합니다. 최신 완전월을 끝으로 하는 최근 36개월을 한 번 갱신한 뒤 월별
Snapshot을 재사용하고, 이후에는 최신 완전월만 월 1회 보충합니다. 날짜와
현지인·외지인·외국인 구분이 모두 확인된 지역만 `일평균 순방문자`를 표시하며,
미관측·부분수집·오류는 0명으로 바꾸지 않습니다. 품질 기준을 충족한 경우에만
방문자 보조점수를 수요구조 종합점수에 최대 15%, 입지 보정에 10% 반영합니다.
자료가 부족하면 가중치는 0%로 두고 기존 지표만 다시 정규화합니다.

기본 `render.yaml`은 Starter Web Service와 `/var/data` Persistent Disk를 사용합니다.
다른 Render 설정 파일을 선택한 경우에는 해당 파일의 저장 경로와 요금제를
별도로 확인해야 합니다.

자세한 절차는 `RENDER_DEPLOY.md`를 확인하세요.
