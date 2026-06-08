# Render 배포 안내

이 앱은 Render의 Web Service로 배포한다. 모바일에서 와이파이 없이 보려면 임시 터널보다 Render 같은 고정 배포가 맞다.

현재 기본 `render.yaml`은 먼저 모바일 확인을 성공시키기 위한 무료 Web Service 설정이다. 수집 결과를 장기간 보존해야 하면 `render.persistent.yaml` 내용을 `render.yaml`에 적용해서 유료 Web Service와 Persistent Disk로 전환한다.

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

저장공간 설정:
- `HOST`: `0.0.0.0`
- `DATA_DIR`: `/tmp/glamping-data`
- `OUTPUTS_DIR`: `/tmp/glamping-data/outputs`
- `CONFIG_DIR`: `/tmp/glamping-data/config`

## 4. 배포 후 확인

1. Render가 제공하는 `https://...onrender.com` 주소를 연다.
2. PIN을 입력한다.
3. 새 수집 섹션에서 키워드를 넣고 실행한다.
4. 무료 배포에서는 결과가 `/tmp/glamping-data/outputs`에 저장된다.

## 5. 중요 판단

무료 Web Service는 모바일 확인과 데모에는 좋지만, 재배포/재시작/슬립 이후 저장 파일이 사라질 수 있다. 수집 결과와 API 설정을 안정적으로 유지하려면 Persistent Disk가 필요하다. Render 공식 문서 기준으로 Persistent Disk는 유료 Web Service에서 사용할 수 있다. 유료 전환 시 `render.persistent.yaml`을 참고한다.
