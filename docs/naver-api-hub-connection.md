# 검색 트렌드의 NAVER API HUB 연결

기존 수요전망의 12개월 추이, 검색량 보정 계산, 화면과 저장 자료는 유지한다. 이 변경은 검색 트렌드를 네이버 클라우드 NAVER API HUB로 연결하는 선택지를 추가한다. 월간 PC·모바일 검색수는 별도 서비스인 네이버 공식 검색광고 API를 유지한다. API HUB의 검색·검색어 트렌드·쇼핑 인사이트 목록에 검색광고 키워드 도구는 포함되지 않는다.

## 연결 설정

- `developers`: 기존 네이버 개발자센터. `naverClientId`와 `naverClientSecret`을 사용한다. 연결 방식이 저장되지 않은 기존 설치는 이 값을 유지한다.
- `ncp_apihub`: NAVER API HUB. 전용 `ncpApihubClientId`와 `ncpApihubClientSecret`을 사용한다.
- NCP 호출 주소는 `https://naverapihub.apigw.ntruss.com/search-trend/v1/search`이며 POST 요청에 `X-NCP-APIGW-API-KEY-ID`, `X-NCP-APIGW-API-KEY` 헤더를 사용한다. 다른 주소로 리디렉션하지 않는다.
- NCP 키가 없거나 오류가 발생하면 기존 개발자센터 키로 대체하지 않는다. 잘못된 명시적 연결 값은 호출하지 않는다.

설정 → API 연동 → 네이버 검색 API 연결 설정에서 연결 방식을 선택하고 해당 전용 키를 입력·저장한다. 빈 키 입력은 기존 저장 값을 유지한다. 키 저장은 외부 테스트나 수집을 시작하지 않는다. 연결 테스트는 저장된 연결에만 요청하며 기존 테스트 간격·타임아웃·응답 크기 제한을 유지한다. 이전 연결의 정상 기록을 새 연결의 정상 기록으로 취급하지 않는다.

서버 환경변수로 설정할 경우:

| 항목 | 값/의미 |
| --- | --- |
| `NAVER_DATALAB_PROVIDER` | `ncp_apihub` |
| `NAVER_API_HUB_CLIENT_ID` | NAVER API HUB Application Client ID |
| `NAVER_API_HUB_CLIENT_SECRET` | 같은 Application Client Secret |

서버 환경변수가 있으면 해당 값이 우선한다. 일반 NCP Access Key·Secret Key, Maps 키, 기존 개발자센터 키를 API HUB 전용 키로 간주하지 않는다. 키는 채팅·보고서·저장소에 기록하지 않고 관리자 입력란이나 해당 서버의 비밀 설정에 직접 입력한다.

## 검증과 운영 전환의 구분

개발 검증은 가짜 인증정보와 로컬 fixture만 사용한다. 동일한 12개월 응답에서 기간·키워드·지수와 수요전망 입력이 유지되는지, 캐시 재사용 시 추가 요청이 없는지, 인증 범위가 섞이지 않는지, 설정과 초안이 보존되는지를 확인한다. NCP의 실제 인증·권한과 응답은 새 키 입력 후 실제 연결 테스트로 별도 확인해야 한다.

기존 추이 캐시는 키워드·기간 기준으로 재사용한다. 기존 캐시를 NCP의 새 응답으로 다시 표시하거나 과거 원자료를 재작성하지 않는다. 새로 취득한 본 분석 추이는 `connectionProvider`를 선택적으로 기록하고, 과거에 기록되지 않은 제공처는 미확인으로 남긴다. 연결 테스트 성공은 분석용 새 자료 채택이나 예측 정확도 검증을 뜻하지 않는다.

정규 6회 수집 일정, 수집 간격·동시 요청·호출 한도·보호·원본·이력·월별 집계와 KOSIS 보류 설정은 이 변경 범위에 포함하지 않는다. 수동 진단 도구 `traffic_sources_probe.cjs`는 기존의 별도 도구로 남기며 이번 검증에서 실행하지 않는다.

## 공식 근거

- [NAVER API HUB 이관 가이드](https://guide.ncloud-docs.com/docs/apihub-migration)
- [검색어 트렌드 요청·응답 명세](https://api.ncloud-docs.com/docs/naver-api-hub-search-trend)
- [NAVER API HUB 제공 API](https://api.ncloud-docs.com/docs/naver-api-hub-overview)
- [네이버 검색광고 API](https://naver.github.io/searchad-apidoc/)

개발 수정·로컬 검증·운영 배포·NCP 연결 활성화·실제 자료 반영은 서로 다른 단계다. 이 문서만으로 운영 이관 완료를 선언하지 않는다.
