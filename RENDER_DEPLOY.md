# glamping-datalab-v2 Render 배포 안내

이 문서는 V2 정본 서비스의 배포 경계를 설명합니다. 문서의 절차는 배포 승인을
대체하지 않으며, 저장소를 Render에 연결하거나 서비스를 변경하기 전에 운영자의
명시적인 승인이 필요합니다.

## 1. Manifest 경계

| 파일 | 서비스명 | 저장공간 | 상태 |
| --- | --- | --- | --- |
| `render.v2.yaml` | `glamping-datalab-v2` | `/tmp/glamping-data` | V2 정본 |
| `render.v2.persistent.yaml` | `glamping-datalab-v2` | `/var/data` Persistent Disk | V2 정본 |
| `render.yaml` | `glamping-cluster-app` | 기존 `glamping-data` disk | legacy/reference-only, 배포 금지 |
| `render.persistent.yaml` | `glamping-cluster-app` | 기존 `glamping-data` disk | legacy/reference-only, 배포 금지 |

저장소 루트의 두 legacy manifest는 top-level `services` 대신
`x-legacy-cluster-services`에 과거 payload를 보관하므로 Render가 배포할 service를
찾을 수 없습니다. 기존 서비스명·디스크명·환경 경계를 단순 치환하는 것도
금지합니다. 플랫폼에서 루트 `render.yaml`이 꼭 필요하다면 후속 승인 단계에서
별도의 staging 사본과 리소스 식별자를 검토해야 하며, 이 문서만을 근거로 기존
파일을 덮어쓰지 않습니다.

## 2. V2 사양 선택

- 일시적 검증만 필요하면 `render.v2.yaml`을 설정 기준으로 사용합니다. 무료
  인스턴스의 `/tmp/glamping-data`는 재시작·재배포·sleep 이후 유지되지 않을 수
  있습니다.
- 지속 저장이 승인되면 `render.v2.persistent.yaml`을 설정 기준으로 사용합니다.
  이 사양의 V2 disk 이름은 `glamping-datalab-v2-data`, mount path는
  `/var/data`입니다.
- 두 사양 모두 build command는 `npm ci && npm run build:ui`, start command는 `npm start`,
  health check는 `/api/health`입니다.

선택한 사양과 실제 Render 서비스 설정이 다르면 배포를 중단하고 차이를 먼저
검토합니다.

## 3. 승인 후 설정 절차

1. 배포 대상 commit, V2 서비스와 선택한 `render.v2*.yaml`을 기록합니다.
2. 대상 서비스·disk가 Cluster 서비스 또는 Cluster disk ID가 아닌지 확인합니다.
3. 수동 Web Service를 만들거나 갱신할 때 선택한 V2 manifest의 runtime, region,
   plan, command, health check와 데이터 경로를 그대로 대조합니다.
4. 비밀값은 Render의 승인된 V2 환경에 새로 입력합니다. 로컬 파일이나 Cluster
   환경에서 값을 복사하지 않습니다.
5. 배포 전에 `npm test`와 승인된 contract·integration 검사를 통과시킵니다.
6. 배포 후 health, 인증, 역할 경계, 쓰기 대상 경로와 rollback 가능성을 확인합니다.

## 4. 환경변수

V2 manifest가 선언하는 기본 경로 변수는 다음과 같습니다.

- `HOST`
- `DATA_DIR`
- `OUTPUTS_DIR`
- `CONFIG_DIR`
- `NODE_ENV`

외부 수집이 승인된 환경에서만 다음 credential을 운영자가 별도로 설정합니다.

- `NAVER_CLIENT_ID`
- `NAVER_CLIENT_SECRET`
- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`

실제 값, Cluster secret, 로컬 key 파일은 Git에 기록하지 않습니다.

두 V2 manifest의 `V2_UI_V3_ENABLED`, `V2_INTEGRATION_AUTH_ENABLED`와
`V2_INTEGRATION_PLATFORM_CORE_ENABLED` 기본값은 모두 `false`다. Stage 226 auth를
별도 승인해 켤 때에는 최소한 신규
`V2_INTEGRATION_AUTH_STORE_PATH`, bootstrap/session/MFA key, Host/Origin allowlist를
Render secret/environment에 새로 설정한다. 기존 Cluster 또는 V2 member/session/hash
자료를 store에 restore하지 않는다. 필수값이 빠지면 production server는 listen 전에
fail closed해야 하며, 이 동작을 우회해서 배포하지 않는다.

Stage 227 platform core는 auth가 켜진 경우에만 별도로 검토할 수 있다. 이 단계의
store는 provisional memory 경계이며 실제 provider 호출·운영 수집·durable data store가
아니므로 staging/production 활성화 대상으로 승인하지 않는다. core flag를 단독으로
켜거나 합성 fixture mode를 production에 설정해서는 안 된다.

Stage 228의 `V2_INTEGRATION_FRESH_COMPANY_ENABLED`와
`V2_INTEGRATION_FRESH_OBSERVATION_ENABLED`도 두 V2 manifest에서 기본 `false`다. 현재
manifest는 의도적으로 `V2_INTEGRATION_DATA_DIR`를 선언하지 않는다. 운영 활성화에는
기존 `DATA_DIR`, `OUTPUTS_DIR`, `CONFIG_DIR`와 파일 계층·실경로가 겹치지 않는 승인된
영속 절대 경로가 필요하며, 기존 disk의 하위 디렉터리를 임의로 지정해서 우회하면 안
된다. 별도 영속 경로와 rollback artifact가 승인되기 전에는 두 flag를 켜지 않는다.

Stage 228 활성화 시 `V2_INTEGRATION_AUTH_STORE_PATH`도 기존 runtime 파일을 가리킬 수
없다. `DATA_DIR` 안에서는 새 `DATA_DIR/fresh-integration/<file>` namespace만 허용하며,
그 밖에는 legacy 경계와 겹치지 않는 별도 절대 경로만 허용한다. symlink/junction으로
history, output, config 또는 company data를 가리키면 auth bootstrap 전에 fail closed한다.

승인된 격리 환경에서도 두 flag는 함께 켜야 하며 auth와 platform core가 먼저 켜져야
한다. provider 기본값은 `synthetic`이고 `https://*.example.invalid` 이외의 endpoint,
실제 credential 또는 비용 발생 호출은 별도 사용자 승인 전 금지한다. snapshot은 새
통합 store만 포함하며 기존 V2·Cluster source store의 hash·파일·cache를 포함하지 않는다.

## 5. 통합 데이터 주의사항

배포는 기존 V2·Cluster 데이터를 통합 store로 가져올 권한을 포함하지 않습니다.
기존 수집 파일, DB, cache와 output을 복사·restore·backfill·dual-write하지 않으며,
통합 store는 빈 상태에서 승인된 신규 수집으로 채웁니다. 정적 행정구역 자산은
별도 allowlist, 출처, 버전, license와 checksum 검증을 통과한 경우만 예외입니다.

## 6. 배포 중단 조건

다음 중 하나라도 해당하면 생성·변경·배포를 중단합니다.

- 대상 manifest가 `render.yaml` 또는 `render.persistent.yaml`인 경우
- 서비스명이나 disk 식별자가 Cluster 참조 리소스를 가리키는 경우
- 승인된 commit, 승인자 또는 rollback 대상 artifact가 확인되지 않는 경우
- V2·Cluster 기존 runtime data 접근 또는 복사가 감지되는 경우
- Stage 228 경로가 누락되거나 기존 data/config/output 경로와 같거나 겹치는 경우
- Stage 228의 두 fresh flag가 불일치하거나 승인되지 않은 provider가 선택된 경우
- health, 인증, 역할 경계나 필수 회귀 검사가 실패한 경우
