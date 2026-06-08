# Glamping Cluster App

글램핑 키워드 기반 네이버/야놀자 NOL/떠나요/ONDA 수집 테스트와 클러스터 분석을 위한 웹 앱입니다.

## Render 배포

이 저장소는 Render Blueprint 배포용 `render.yaml`을 포함합니다. 기본 설정은 모바일 확인을 빠르게 하기 위한 무료 Web Service입니다.

1. Render Dashboard에서 `New +`를 선택합니다.
2. `Blueprint`를 선택합니다.
3. 이 GitHub 저장소를 연결합니다.
4. 환경변수 입력 화면에서 `APP_PIN`을 입력합니다.
5. 검색량/클릭률 수집이 필요하면 네이버 API 키도 입력합니다.

필수 환경변수:
- `APP_PIN`

선택 환경변수:
- `NAVER_CLIENT_ID`
- `NAVER_CLIENT_SECRET`
- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`

무료 배포 저장공간:
- 수집 결과: `/tmp/glamping-data/outputs`
- 앱 설정: `/tmp/glamping-data/config`

주의:
- 무료 Web Service는 일정 시간 사용이 없으면 잠들 수 있습니다.
- 무료 Web Service는 재시작/재배포/슬립 이후 저장 파일이 사라질 수 있습니다.
- 결과를 계속 보존하려면 `render.persistent.yaml` 내용을 `render.yaml`로 바꿔 유료 Web Service와 Persistent Disk를 사용하세요.

자세한 절차는 `RENDER_DEPLOY.md`를 확인하세요.
