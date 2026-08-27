# Render 배포 안내

이 앱은 Render의 Web Service로 배포한다. 모바일에서 와이파이 없이 보려면 임시 터널보다 Render 같은 고정 배포가 맞다.

현재 기본 `render.yaml`은 Starter Web Service와 `/var/data` Persistent Disk를 사용한다.

## 1. GitHub에 프로젝트 올리기

Render는 보통 GitHub 저장소를 연결해서 배포한다.

주의:
- `config/*.local.json`은 올리지 않는다. PIN, API 키가 들어갈 수 있다.
- `tools/`, `logs/`, `node_modules/`는 올리지 않는다.
- 기존 수집 결과까지 배포 직후 보고 싶으면 `outputs/`는 같이 올릴 수 있다. 다만 새 수집 결과는 Render의 저장공간(`/var/data`)에 저장된다.

## 2. Render에서 만들기

추천 방식:
1. Render Dashboard에서 `New +` 선택
2. `Blueprint` 선택
3. GitHub 저장소 연결
4. 프로젝트 루트의 `render.yaml` 선택
5. 생성 화면에서 비밀값 입력

수동 Web Service로 만들 경우:
- Runtime: `Node`
- Region: `Singapore`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`
- Instance Type: `Free`

## 3. 환경변수

필수:
- `APP_PIN`: 앱 접속 PIN. 예: 원하는 숫자 6자리

검색량/클릭률까지 쓰려면 입력:
- `NAVER_CLIENT_ID`
- `NAVER_CLIENT_SECRET`
- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`

현재 연결된 지역별 방문자수 API를 쓰려면 Secret으로 입력:
- `DATA_GO_KR_VISITOR_SERVICE_KEY`

기존 호환용 공통 Secret:
- `DATA_GO_KR_SERVICE_KEY`

기존 Web Service는 Blueprint 동기화만으로 새 비밀값 입력창이 열리지 않는다.
Render Dashboard에서 해당 서비스의 `Environment`를 열고
`DATA_GO_KR_VISITOR_SERVICE_KEY`를 직접 추가한 뒤 `Save and deploy` 한다.
Key 칸에는 위 변수명을, Value 칸에는 지역별 방문자수 승인키 문자열만 넣는다.
따옴표·변수명·Endpoint URL은 Value에 넣지 않는다. 기존에
`DATA_GO_KR_SERVICE_KEY`로 정상 연결되어 있다면 그대로 유지해도 된다. 실제 키는
`render.yaml`, `.env`, Endpoint URL, 앱 설정 파일에 기록하지 않는다.

현재는 지역별 방문자수만 연결되어 있다. 다른 공공데이터 승인키는 해당 API
수집기를 구현·검증할 때 전용 Secret을 하나씩 추가한다.

기본 `render.yaml` 저장공간 설정:
- `HOST`: `0.0.0.0`
- `DATA_DIR`: `/var/data`
- `OUTPUTS_DIR`: `/var/data/outputs`
- `CONFIG_DIR`: `/var/data/config`

## 4. 배포 후 확인

1. Render가 제공하는 `https://...onrender.com` 주소를 연다.
2. PIN을 입력한다.
3. 새 수집 섹션에서 키워드를 넣고 실행한다.
4. 기본 배포에서는 결과가 `/var/data/outputs`에 저장된다.

## 5. 중요 판단

수집 결과와 설정을 장기간 보존하려면 현재 기본 설정처럼 Persistent Disk를
사용해야 한다. 임시 `/tmp` 경로를 쓰는 설정은 재배포·재시작 후 파일이 사라질 수 있다.
