# 50km·100km 인구·산업 배후시장 자료 준비

공식 안내 확인일: **2026-10-21, 한국시간**. 이 문서는 현재 개발한 오프라인 준비 도구와 집계 기준을 설명한다. 실제 SGIS 자료의 신청·다운로드·로그인·API 키 발급·운영 반입은 수행하지 않았다. 아래 예시 수치와 열 이름은 모두 **모의 예시**이며 실제 관측자료가 아니다.

## 1. 공식 자료 선택

| 자료 | 확인한 제공 범위 | 적용 |
|---|---|---|
| [SGIS 소지역 자료목록](https://sgis.mods.go.kr/view/pss/openDataIntrcn) | 인구·가구·주택과 사업체·종사자 격자 CSV는 2024년까지 안내. 2025년 격자경계는 100m·500m·1km·10km·100km SHP, EPSG:5179. 경계 기준일은 6월30일. | 인구와 산업을 같은 공간 단위로 준비할 우선 자료. 실제 확보한 파일과 코드집을 기준으로 열·항목 코드를 지정한다. |
| [SGIS 최신 센서스 API 안내](https://sgis.mods.go.kr/developer/html/newOpenApi/api/dataApi/census.html) | 인구·사업체 조회는 행정구역코드와 통계연도 기준. | 행정구역 기초 비교용. 시군구 합계를 반경 합계로 바꾸지 않는다. |
| [SGIS 연도 API](https://sgis.mods.go.kr/developer/html/newOpenApi/api/dataApi/personal.html), [격자경계 API](https://sgis.mods.go.kr/developer/html/newOpenApi/api/dataApi/admGrid.html) | 최신 인구·사업체·경계연도를 각각 확인 가능. 격자 API는 경계 제공. | 통계값을 포함하는 50km·100km 반경 API로 해석하지 않는다. 문서의 오래된 응답 예시연도를 최신 제공연도로 고정하지 않는다. |
| [국토지리정보원 격자 인구](https://www.data.go.kr/data/15059921/fileData.do) | 연령별 인구와 여러 격자 해상도의 SHP. 무료·공공누리1유형, 다운로드 로그인·대용량 전송 프로그램 안내. | 인구 대안. 파일별 좌표계와 시점 검증이 필요하며 SGIS용 도구에 다른 기관 자료를 그대로 넣지 않는다. |
| [KOSIS 통계자료 API](https://kosis.kr/openapi/devGuide/devGuide_0201List.do) | 통계표·분류·항목·시점별 자료 제공. | 지역 행정통계와 기준값 비교. 공간 원본 없이 시군구 인구를 면적비례로 나눠 반경 인구라고 표기하지 않는다. |

2024년 통계·2025년 경계는 **확인일에 안내된 제공 범위**다. 앞으로 신규 자료를 확보할 때는 목록과 파일 내부 메타데이터를 다시 확인한다. `sourceYear`와 `boundaryYear`는 서로 다른 개념이므로 별도로 기록한다. 통계연도가 다르거나 산업분류 차수가 다른 행을 한 묶음에 합치지 않는다.

[SGIS 자료신청 안내](https://sgis.mods.go.kr/html/attachFiles/%EA%B0%9C%EC%A0%95%ED%8C%90%20SGIS%20%EC%86%8C%EC%A7%80%EC%97%AD%20%ED%86%B5%EA%B3%84%20%EC%9D%B4%EC%9A%A9%EB%A7%A4%EB%89%B4%EC%96%BC.pdf)는 출처 표시·결과물 제출 동의와 승인 후 다운로드 기간을 설명한다. 신청 시점의 실제 조건을 확인한 뒤 사람이 자료를 확보한다. 다운로드 계정과 OpenAPI 키는 별개다. 준비 도구는 API 키를 사용하지 않는다.

## 2. 산출 기준과 표시 한계

- 기본: **1km 격자의 중심점**을 기준으로 직선거리 합계를 계산한다. 지원 반입 해상도는 100m·250m·500m·1km이며 실제 제공 자료의 해상도를 사용한다. 250m는 다른 제공 자료와의 스키마 호환 범위이며 현재 SGIS 목록의 제공 해상도를 뜻하지 않는다.
- 구간은 `0 ≤ 거리 ≤ 50km`, `50km < 거리 ≤ 100km`, 그리고 두 구간의 합인 누적100km다. 세 항목을 다시 더하지 않는다.
- 숙소의 확인된 좌표 또는 관리자가 명시한 지역 대표점을 사용한다. 청사 위치나 지역 중심을 개별 숙소 위치로 자동 대체하지 않는다. 반경은 주행거리·주행시간이 아니다.
- 격자 경계에 걸친 인구의 실제 위치는 알 수 없다. 중심점 포함 방식의 경계 근사와 격자 해상도를 표시한다. 면적비례 배분은 기본값으로 사용하지 않는다.
- 전체 공간범위를 확보하지 못했다면 부분자료다. 파일에 없는 격자·지표를0으로 채우지 않는다. `completeFrame`은 제공기관의 보증이 아닌 **관리자의 전체 프레임 확보 선언**이다. 기본값은 `false`다.
- 인구와 종사자는 서로 중복될 수 있는 별도 지표다. 둘을 더해 고유 고객 수라고 표시하지 않는다. 사업체 수·종사자 수는 숙박 수요나 실제 고객 방문 수 자체가 아니다.

### 비밀보호와 실제0의 구분

[SGIS 생활권역 공식 유의사항](https://sgis.mods.go.kr/view/catchmentArea/main)은 공개된 인구0이 실제0~4, 사업체·종사자0이 실제0~2 중 하나일 수 있으며 위치를 알 수 없는 일부 자료가 제외된다고 설명한다. 따라서 이 도구는 SGIS의0을 항상 `protected_zero`로 보존한다. 숫자가 양수여도 비밀보호가 적용된 공개값일 수 있으므로 결과는 **공식 격자 기반 공개 합계**다.

| 입력 | 반입 상태 | 저장값 |
|---|---|---:|
| 양의 정수 | `observed_public` | 공개된 수치 |
| `0` | `protected_zero` | 0, 실제0으로 확정하지 않음 |
| `N/A` | `suppressed` | null |
| 빈 셀 또는 선택 지표행 없음 | `not_acquired` | null |
| 음수·NaN·소수·해석되지 않은 기호 | 오류 | 반입하지 않음 |

집계구의 N/A 규칙과 격자의 비밀보호 변형은 같은 방식이 아니다. [SGIS 행정구역 배포본 설명](https://www.data.go.kr/data/15129688/fileData.do)도 N/A를 단순 결측과 구분한다. 실제 코드집에서 다른 비공개 기호를 발견했다면 규칙을 검토해 도구를 수정해야 한다. `-` 등 알 수 없는 기호를 임의로0이나 N/A로 추측하지 않는다.

## 3. 원본을 보존하는 GUI 준비 순서

1. 사람이 SGIS에서 통계 CSV, 공식 격자 경계 묶음, 코드집·이용안내·제공조건을 함께 확보한다. 통계연도·경계연도·산업분류 차수·기준 항목을 기록한다.
2. 원본 ZIP 또는 원본 SHP를 별도로 보존한다. SHP는 `.dbf`, `.prj`, `.shx`, `.cpg` 등 함께 제공된 보조 파일도 보존한다. 가능하면 **제공받은 ZIP 묶음 전체**를 원본 해시 대상으로 사용한다.
3. QGIS에서 공식 경계를 열어 실제 `.prj` 좌표계를 확인한다. EPSG:5179 자료를 경위도로 단순 재명명하면 안 된다.
4. 경계 레이어를 새 파일로 내보낼 때 **GeoJSON, EPSG:4326(WGS84)**를 선택한다. 도형은 단일 링의 네 모서리 격자 폴리곤을 유지하거나, 격자 중심점을 생성해 Point로 내보낸다. 원본 격자 식별자 필드를 유지한다. 중심점 Point라면 mapping에 그 사실을 명시한다.
5. 통계 CSV가 UTF-8이 아니면 UTF-8 복사본을 별도로 만든다. 원본은 수정하지 않는다. 인코딩 변환 복사본을 쓰는 경우 `sourceTransform`을 `utf8_conversion`으로 기록한다.
6. 코드집을 확인해 아래 mapping JSON의 **실제 열 이름·실제 항목 코드**를 기입한다. 미확인 코드를 예시에서 복사해 실제 코드인 것처럼 쓰지 않는다. 총량과 산업별 행이 함께 있다면 선택한 항목코드를 명시한다.
7. 오프라인 도구로 새 산출 파일을 만든다. 반입 전에 행 수·선택 행·미선택 행·시점·범위·누락 상태·원본 해시를 검토한다. 선택한 지표가 한 건도 없거나 통계행의 경계가 없으면 생성은 실패한다.
8. 생성한 정규화 파일을 관리자의 자료 반입 경로로 넣고 중심점 확인 후 계산한다. 기존 결과를 보존하면서 새 원본 버전에 해당하는 산출값을 저장한다. 화면을 여는 행위는 외부 자료 수집이나 재계산을 시작하지 않는다.

## 4. 명시적 열·항목 매핑

아래 `SYNTHETIC_*`는 **가상의 열/코드**다. 실제 SGIS 항목을 뜻하지 않는다. 총량의 산업분류 항목 역시 실제 코드집에서 확인해야 한다.

### Wide CSV: 한 행에 세 지표가 있는 경우

```json
{
  "version": "catchment-grid-mapping-v1",
  "dataset": {
    "id": "sgis-confirmed-bundle-v1",
    "provider": "SGIS",
    "sourceUrl": "https://sgis.mods.go.kr/view/pss/openDataIntrcn",
    "sourceYear": 2024,
    "boundaryYear": 2025,
    "gridSizeM": 1000,
    "industryClassification": "SYNTHETIC_CLASSIFICATION_REPLACE_FROM_CODEBOOK",
    "coverageBBox": [126, 35, 129, 38],
    "completeFrame": false,
    "sourceTransform": "none"
  },
  "geometry": {
    "gridIdField": "SYNTHETIC_GRID_ID",
    "crs": "EPSG:4326",
    "pointRole": "grid_centroid"
  },
  "csv": {
    "format": "wide",
    "idColumn": "SYNTHETIC_GRID_ID",
    "yearColumn": "SYNTHETIC_YEAR",
    "metricColumns": {
      "population": "SYNTHETIC_POPULATION",
      "establishments": "SYNTHETIC_ESTABLISHMENTS",
      "workers": "SYNTHETIC_WORKERS"
    }
  }
}
```

### Long CSV: 항목코드별로 행이 나뉜 경우

위 mapping의 `csv`만 다음과 같이 바꾼다. 세 지표 코드는 서로 달라야 한다. 선택하지 않은 코드행도 격자와 연도는 검증하며 `unselectedRows`에 집계한다. 통계행의 경계가 없으면 조용히 제외하지 않고 실패한다. 일부 지역만 준비하려면 사람이 원본 보존 후 통계와 경계를 **같은 명시 범위의 별도 복사본**으로 준비하고 완전범위 선언을 하지 않는다.

```json
{
  "format": "long",
  "idColumn": "SYNTHETIC_GRID_ID",
  "yearColumn": "SYNTHETIC_YEAR",
  "metricColumn": "SYNTHETIC_METRIC_CODE",
  "valueColumn": "SYNTHETIC_VALUE",
  "metricCodes": {
    "population": "SYNTHETIC_P",
    "establishments": "SYNTHETIC_B",
    "workers": "SYNTHETIC_W"
  }
}
```

CSV 구분자는 기본 쉼표다. 실제 탭 구분이면 `delimiter`를 `"\t"`로 명시한다. UTF-8 BOM·큰따옴표·따옴표 안 쉼표/줄바꿈·이스케이프 따옴표를 처리한다. `"1,000"`처럼 숫자 문자열 자체에 자릿수 구분자가 있으면 도구가 추측해 고치지 않고 실패한다. 코드집과 파일 형식을 확인해 별도 변환 단계를 마련한다.

`coverageBBox`는 `[최소경도, 최소위도, 최대경도, 최대위도]`다. 예시 범위는 실제 확보범위가 아니다. 생략하면 도구는 격자 중심점의 최소·최대 범위를 기록하고 완전범위를 선언하지 않는다. 단일 행/열의 점만 있으면 폭·높이를 추측하지 않으므로 명시 범위가 필요하다. `completeFrame:true`는 모든 격자(미확보/비공개 셀 포함)를 확보했다고 관리자가 확인한 경우에만 허용한다.

## 5. 실행과 해시

PowerShell에서 저장소 폴더를 기준으로 실행한다. 각 경로는 예시이며 실제 파일 위치로 바꾼다.

```powershell
node scripts/prepare_catchment_grid.cjs --csv "C:\data\sgis-statistics-utf8.csv" --geojson "C:\data\sgis-grid-wgs84.geojson" --mapping "C:\data\confirmed-mapping.json" --boundary-source "C:\data\official-boundaries.zip" --out "C:\data\catchment-prepared-v1.json"
```

| 필드 | 실제 해시 대상 |
|---|---|
| `sourceSha256` | 도구에 입력한 통계 CSV 바이트. UTF-8 복사본이면 그 복사본의 해시이며 제공기관 원본 해시라고 위장하지 않는다. |
| `boundarySha256` | `--boundary-source`로 지정한 공식 원본 ZIP/SHP 바이트. `boundaryHashKind: original_file` 기록. |
| `derivedGeometrySha256` | QGIS 등으로 변환한 GeoJSON 바이트. 공식 원본 경계 해시와 분리한다. |
| `mappingSha256` | 코드집 확인 후 작성한 mapping JSON 바이트. |

도구는 네트워크를 사용하지 않으며 입력 파일을 고치지 않는다. 출력은 `wx`로 생성해 **기존 파일을 덮어쓰지 않는다**. 출력이 이미 있으면 먼저 파일과 해시를 확인하고 새 버전 파일명으로 준비한다. 통계·경계·mapping은 각각128MiB 이하, 반입 묶음은 **50,000셀·8MiB 이하**다. 조용히 자르지 않는다. 큰 자료는 향후 스트리밍 색인/저장 확장 또는 명시된 여러 자료프레임 지원이 필요하다.

현재 도구는 중심점 Point 또는 단일 링·네 모서리의 볼록 격자 Polygon만 처리한다. 구멍·복합 도형·자기 교차·잘못된 좌표·뒤집힌 축·EPSG:5179 직접 입력·중복 격자·중복 지표·혼합 연도·음수/NaN을 거부한다. 도형을 재투영했다는 선언만으로 위치가 정확함을 입증할 수 없으므로 실제 반입 전 지도 표본 대조도 필요하다.

## 6. 저장·재사용 검수

저장키는 중심점·격자 해상도·통계/경계연도·분류·원본/변환/매핑 해시·계산 버전을 구분한다. 같은 입력은 산출값을 재사용하고, 중심점 또는 자료 버전이 바뀌면 관련 산출값을 새로 계산한다. 조회는 저장 결과만 읽는다. 과거 정상 결과는 새 자료 준비·계산 실패로 지우지 않는다.

최초 실제 자료 확보 뒤 확인할 항목:

1. 원본 CSV·SHP 코드집의 지표/격자 키, 좌표변환 전후 위치 표본, 통계/경계연도 대조.
2. 세 구간 셀 수·중복 없는 합계·누적100km가 두 구간의 합인지 검증.
3. 비공개·공개 비밀보호0·미확보를 합계·화면에서 구분하는지 확인.
4. 서버 재시작 후 저장 결과 재사용, 동일 입력의 재계산 방지, 새로운 자료에서 변경된 결과만 저장되는지 확인.
5. 실제 운영 서버에서 저장 조회 및 화면 표시2초 목표 측정. 모의자료 단위시험이나 로컬 속도를 운영 실제자료 성능으로 보고하지 않는다.

이 개발 단계에서는 **실제 반경 인구·산업 값이 확보됐다고 주장하지 않는다**. 현재 자료가 없는 화면은 준비 필요 상태이며, 임의의 시군구 합계나 모의값으로 채우지 않는다.
