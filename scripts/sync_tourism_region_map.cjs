const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MASTER_PATH = path.join(ROOT, "web", "data", "region_master.json");
const MAP_PATH = path.join(ROOT, "web", "data", "tourism_region_map.json");

const PROVINCE_KEYS = {
  "서울특별시": "seoul",
  "부산광역시": "busan",
  "대구광역시": "daegu",
  "인천광역시": "incheon",
  "대전광역시": "daejeon",
  "울산광역시": "ulsan",
  "경기도": "gyeonggi",
  "충청북도": "chungbuk",
  "충청남도": "chungnam",
  "경상북도": "gyeongbuk",
  "경상남도": "gyeongnam",
  "제주특별자치도": "jeju",
  "강원특별자치도": "gangwon",
  "전북특별자치도": "jeonbuk",
  "전남광주통합특별시": "jeonnam_gwangju"
};

const PROVIDER_CODE_PENDING = new Map([
  ["전남광주통합특별시", "통합 광역단체 출범 뒤 관광 API의 12번대 시군구 코드 반영 여부를 확인해야 합니다."]
]);

const INCHEON_REFORM_DISTRICTS = new Set(["제물포구", "영종구", "서해구", "검단구"]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function currentProvinceAliases(previous = {}) {
  return {
    ...previous,
    jeonnam_gwangju: {
      sido: "전남광주",
      sidoFull: "전남광주통합특별시",
      ktoSidoCd: "12",
      codeStatus: "administrative-reform-pending",
      aliases: [
        "전남광주",
        "전남광주통합특별시",
        "광주광역시",
        "전라남도",
        "광주",
        "전남"
      ]
    }
  };
}

function pendingState(unit, previous, previousMapVersion) {
  if (PROVIDER_CODE_PENDING.has(unit.sidoFull)) {
    return {
      status: "administrative-reform-pending",
      reason: PROVIDER_CODE_PENDING.get(unit.sidoFull)
    };
  }
  if (unit.sidoFull === "인천광역시" && INCHEON_REFORM_DISTRICTS.has(unit.name)) {
    return {
      status: "administrative-reform-pending",
      reason: "2026년 인천 자치구 개편 뒤 관광 API의 새 시군구 코드 반영 여부를 확인해야 합니다."
    };
  }
  if (previous?.codeStatus) {
    return {
      status: previous.codeStatus,
      reason: previous.codeStatusReason || "관광 API 지역코드 확인이 완료되지 않았습니다."
    };
  }
  if (previousMapVersion === "tourism-region-map-v0.2" && !previous) {
    return {
      status: "provider-code-unverified",
      reason: "행정구역 원장에 새로 추가된 지역으로 관광 API 반영 여부를 확인해야 합니다."
    };
  }
  return null;
}

function buildRegion(unit, previous, businessKeywordRules, previousMapVersion) {
  const pending = pendingState(unit, previous, previousMapVersion);
  const genericHints = unique(Object.values(businessKeywordRules || {}).flat());
  const region = {
    regionKey: unit.regionKey,
    officialRegionId: unit.regionId,
    officialCode: unit.officialCode,
    codeBasis: "official-legal-dong-code-prefix-5",
    sidoKey: PROVINCE_KEYS[unit.sidoFull],
    sido: unit.sido,
    sidoFull: unit.sidoFull,
    sigungu: unit.name,
    ktoSggCd: unit.code5,
    unit: "sigungu",
    unitType: unit.unitType,
    aliases: unique([
      ...(previous?.aliases || []),
      ...(unit.aliases || []),
      unit.name,
      unit.shortName,
      unit.fullName,
      `${unit.sido} ${unit.name}`,
      `${unit.sido} ${unit.shortName}`
    ]),
    businessKeywordHints: unique(previous?.businessKeywordHints?.length ? previous.businessKeywordHints : genericHints),
    matchPriority: Number(previous?.matchPriority || 60)
  };
  if (pending) {
    region.codeStatus = pending.status;
    region.codeStatusReason = pending.reason;
  }
  return region;
}

function validate(master, regions) {
  const activeLocals = (master.units || []).filter((unit) => unit.active && unit.level === "local" && unit.unitType !== "general_district");
  if (regions.length !== activeLocals.length) {
    throw new Error(`관광 지역 수가 분석지역 수와 다릅니다: ${regions.length}/${activeLocals.length}`);
  }
  if (new Set(regions.map((region) => region.regionKey)).size !== regions.length) {
    throw new Error("관광 regionKey가 중복되었습니다.");
  }
  if (new Set(regions.map((region) => region.officialCode)).size !== regions.length) {
    throw new Error("관광 공식 행정구역 코드가 중복되었습니다.");
  }
  regions.forEach((region) => {
    if (!/^\d{10}$/.test(region.officialCode) || !/^\d{5}$/.test(region.ktoSggCd)) {
      throw new Error(`${region.regionKey} 코드 형식이 올바르지 않습니다.`);
    }
    if (region.ktoSggCd !== region.officialCode.slice(0, 5)) {
      throw new Error(`${region.regionKey} 관광 코드가 법정동코드 앞 5자리와 다릅니다.`);
    }
    if (!region.sidoKey || !region.sidoFull || !region.sigungu) {
      throw new Error(`${region.regionKey} 지역 식별값이 누락되었습니다.`);
    }
  });
}

function main() {
  const master = readJson(MASTER_PATH);
  const previousMap = readJson(MAP_PATH);
  const previousByRegionKey = new Map((previousMap.regions || []).map((region) => [region.regionKey, region]));
  const activeLocals = (master.units || [])
    .filter((unit) => unit.active && unit.level === "local" && unit.unitType !== "general_district")
    .sort((a, b) => a.officialCode.localeCompare(b.officialCode));
  const regions = activeLocals.map((unit) => buildRegion(
    unit,
    previousByRegionKey.get(unit.regionKey),
    previousMap.businessKeywordRules,
    previousMap.version
  ));
  validate(master, regions);

  const pendingCount = regions.filter((region) => region.codeStatus).length;
  const map = {
    ...previousMap,
    version: "tourism-region-map-v0.2",
    generatedAt: new Date().toISOString(),
    codeSystem: {
      ...previousMap.codeSystem,
      primary: "MOIS legal-dong code prefix 5 / KTO DataLab signguCode",
      description: "행정구역 원장의 현행 시·군·자치구·행정시와 관광공사 지역 방문자 API를 연결하는 기준표입니다.",
      unitPriority: ["sigungu", "sido"],
      notes: [
        "ktoSggCd는 현행 법정동코드 10자리의 앞 5자리로 생성합니다.",
        "codeStatus가 없는 지역만 자동수집 대상으로 사용합니다.",
        "일반구는 주소 매칭용이므로 관광 분석지역에서 제외하고 상위 시를 사용합니다.",
        "폐지 지역과 최근 행정구역 개편 지역은 확인 없이 자동 활성화하지 않습니다.",
        "기초지자체와 광역지자체 방문자 데이터는 집계 기준이 달라 임의 합산하지 않습니다."
      ]
    },
    provinceAliases: currentProvinceAliases(previousMap.provinceAliases || {}),
    summary: {
      analysisRegionCount: activeLocals.length,
      regionCount: regions.length,
      readyCount: regions.length - pendingCount,
      pendingCount,
      excludedGeneralDistrictCount: (master.units || []).filter((unit) => unit.active && unit.unitType === "general_district").length,
      codeBasis: "official-legal-dong-code-prefix-5"
    },
    regions
  };
  fs.writeFileSync(MAP_PATH, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  console.log(`tourism region map written: ${path.relative(ROOT, MAP_PATH)}`);
  console.log(JSON.stringify(map.summary, null, 2));
}

main();
