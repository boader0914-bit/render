const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "web", "data", "region_master.json");
const TOURISM_MAP_PATH = path.join(ROOT, "web", "data", "tourism_region_map.json");
const LOCATION_DICTIONARY_PATH = path.join(ROOT, "web", "data", "location_dictionary.json");
const OFFICIAL_DOWNLOAD_URL = "https://www.code.go.kr/etc/codeFullDown.do";
const OFFICIAL_REFERENCE_URL = "https://www.code.go.kr/stdcode/regCodeL.do?menuNo=101010100010";

const PROVINCE_SHORT_NAMES = {
  "서울특별시": "서울",
  "전남광주통합특별시": "전남광주",
  "부산광역시": "부산",
  "대구광역시": "대구",
  "인천광역시": "인천",
  "광주광역시": "광주",
  "대전광역시": "대전",
  "울산광역시": "울산",
  "세종특별자치시": "세종",
  "경기도": "경기",
  "강원특별자치도": "강원",
  "강원도": "강원",
  "충청북도": "충북",
  "충청남도": "충남",
  "전북특별자치도": "전북",
  "전라북도": "전북",
  "전라남도": "전남",
  "경상북도": "경북",
  "경상남도": "경남",
  "제주특별자치도": "제주"
};

const PROVIDER_PROVINCE_TO_OFFICIAL = {
  서울: "서울특별시",
  부산: "부산광역시",
  대구: "대구광역시",
  인천: "인천광역시",
  광주: "전남광주통합특별시",
  대전: "대전광역시",
  울산: "울산광역시",
  세종: "세종특별자치시",
  경기: "경기도",
  강원: "강원특별자치도",
  충북: "충청북도",
  충남: "충청남도",
  전북: "전북특별자치도",
  전남: "전남광주통합특별시",
  경북: "경상북도",
  경남: "경상남도",
  제주: "제주특별자치도"
};

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function kstDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function cliValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("공식 ZIP의 중앙 디렉터리를 찾지 못했습니다.");
}

function unzipFirstTextFile(buffer) {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("공식 다운로드 응답이 ZIP 형식이 아닙니다.");
  }
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (!entryCount || buffer.readUInt32LE(directoryOffset) !== 0x02014b50) {
    throw new Error("공식 ZIP에 읽을 수 있는 파일이 없습니다.");
  }
  const compressionMethod = buffer.readUInt16LE(directoryOffset + 10);
  const compressedSize = buffer.readUInt32LE(directoryOffset + 20);
  const uncompressedSize = buffer.readUInt32LE(directoryOffset + 24);
  const localOffset = buffer.readUInt32LE(directoryOffset + 42);
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("공식 ZIP의 파일 시작 위치가 올바르지 않습니다.");
  }
  const localNameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
  const payload = compressionMethod === 0
    ? compressed
    : compressionMethod === 8
      ? zlib.inflateRawSync(compressed)
      : null;
  if (!payload) throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${compressionMethod}`);
  if (payload.length !== uncompressedSize) {
    throw new Error(`공식 ZIP 압축 해제 크기가 다릅니다: ${payload.length}/${uncompressedSize}`);
  }
  return new TextDecoder("euc-kr").decode(payload);
}

async function downloadOfficialRows() {
  const response = await fetch(OFFICIAL_DOWNLOAD_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ codeseId: "법정동코드" })
  });
  if (!response.ok) throw new Error(`공식 행정표준코드 다운로드 실패: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = unzipFirstTextFile(buffer);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const header = String(lines.shift() || "").split("\t");
  if (header.join("|") !== "법정동코드|법정동명|폐지여부") {
    throw new Error(`공식 파일 열 구성이 예상과 다릅니다: ${header.join("|")}`);
  }
  const rows = lines.map((line, index) => {
    const [officialCode, fullName, officialStatus] = line.split("\t").map((value) => String(value || "").trim());
    if (!/^\d{10}$/.test(officialCode) || !fullName || !new Set(["존재", "폐지"]).has(officialStatus)) {
      throw new Error(`공식 파일 ${index + 2}행을 해석할 수 없습니다.`);
    }
    return { officialCode, fullName, officialStatus };
  });
  if (rows.length < 50_000) throw new Error(`공식 행정표준코드 행수가 비정상적으로 적습니다: ${rows.length}`);
  return rows;
}

function isStructuralRow(row) {
  const tokens = row.fullName.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) return true;
  return tokens.length <= 3 && row.officialCode.endsWith("00000");
}

function broadUnitType(name) {
  if (name.includes("통합특별시")) return "integrated_special_city";
  if (name.endsWith("특별자치시")) return "special_autonomous_city";
  if (name.endsWith("특별시")) return "special_city";
  if (name.endsWith("광역시")) return "metropolitan_city";
  if (name.endsWith("특별자치도")) return "special_autonomous_province";
  return "province";
}

function localUnitType(tokens, activeProvinceName) {
  const name = tokens.at(-1) || "";
  if (tokens.length === 3) return "general_district";
  if (activeProvinceName === "제주특별자치도" && name.endsWith("시")) return "administrative_city";
  if (name.endsWith("군")) return "county";
  if (name.endsWith("구")) return "autonomous_district";
  return "city";
}

function regionId(officialCode) {
  return `kr_admin_${officialCode}`;
}

function shortName(name) {
  return String(name || "").replace(/특별자치시$|특별자치도$|통합특별시$|특별시$|광역시$|도$|시$|군$|구$/u, "") || name;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function officialProvinceNameForProvider(region = {}) {
  return PROVIDER_PROVINCE_TO_OFFICIAL[String(region.sido || "").trim()]
    || PROVIDER_PROVINCE_TO_OFFICIAL[PROVINCE_SHORT_NAMES[String(region.sidoFull || "").trim()]]
    || String(region.sidoFull || "").trim();
}

function attachExistingMappings(units, tourismMap, dictionary) {
  const activeLocals = units.filter((unit) => unit.active && unit.level === "local" && unit.unitType !== "general_district");
  const tourismRegions = Array.isArray(tourismMap?.regions) ? tourismMap.regions : [];
  const cards = Array.isArray(dictionary?.cards) ? dictionary.cards : [];
  const aliases = Array.isArray(dictionary?.aliases) ? dictionary.aliases : [];
  const mappedTourismKeys = new Set();
  const ambiguousTourismKeys = [];

  tourismRegions.forEach((region) => {
    const officialProvinceName = officialProvinceNameForProvider(region);
    const candidates = activeLocals.filter((unit) => unit.sidoFull === officialProvinceName && unit.name === region.sigungu);
    if (candidates.length !== 1) {
      ambiguousTourismKeys.push({ regionKey: region.regionKey, candidates: candidates.map((unit) => unit.officialCode) });
      return;
    }
    const unit = candidates[0];
    unit.regionKey = region.regionKey;
    unit.providerMappings = {
      ...(unit.providerMappings || {}),
      kto: {
        regionKey: region.regionKey,
        sido: region.sido,
        sidoFull: region.sidoFull,
        ktoSggCd: region.ktoSggCd,
        status: region.codeStatus || "ready"
      }
    };
    mappedTourismKeys.add(region.regionKey);
  });

  const mappedCardKeys = new Set();
  cards.forEach((card) => {
    let unit = activeLocals.find((entry) => entry.regionKey === card.regionKey);
    if (!unit) {
      const alias = aliases.find((entry) => entry.regionKey === card.regionKey);
      const provinceFull = Object.entries(PROVINCE_SHORT_NAMES).find(([, label]) => label === alias?.sido)?.[0] || "";
      unit = activeLocals.find((entry) => entry.sidoFull === provinceFull && entry.name === alias?.sigungu);
    }
    if (!unit) return;
    unit.regionKey = card.regionKey;
    unit.locationCardKey = card.regionKey;
    mappedCardKeys.add(card.regionKey);
  });

  return {
    tourismRegionCount: tourismRegions.length,
    tourismMappedCount: mappedTourismKeys.size,
    tourismPending: tourismRegions.filter((region) => !mappedTourismKeys.has(region.regionKey)).map((region) => region.regionKey),
    tourismAmbiguous: ambiguousTourismKeys,
    locationCardCount: cards.length,
    locationCardMappedCount: mappedCardKeys.size,
    locationCardPending: cards.filter((card) => !mappedCardKeys.has(card.regionKey)).map((card) => card.regionKey)
  };
}

function buildUnits(rows, asOf, previousMaster, tourismMap, dictionary) {
  const previousByCode = new Map((previousMaster?.units || []).map((unit) => [unit.officialCode, unit]));
  const structural = rows.filter(isStructuralRow);
  const units = structural.map((row) => {
    const tokens = row.fullName.split(/\s+/).filter(Boolean);
    const previous = previousByCode.get(row.officialCode) || {};
    const active = row.officialStatus === "존재";
    const broad = tokens.length === 1;
    const sidoFull = tokens[0];
    const name = tokens.at(-1);
    const type = broad ? broadUnitType(name) : localUnitType(tokens, sidoFull);
    const level = broad ? "broad" : type === "general_district" ? "address" : "local";
    const aliases = unique([
      ...(previous.aliases || []),
      name,
      shortName(name),
      row.fullName,
      `${PROVINCE_SHORT_NAMES[sidoFull] || sidoFull} ${shortName(name)}`
    ]);
    return {
      regionId: regionId(row.officialCode),
      regionKey: previous.regionKey || regionId(row.officialCode),
      parentRegionId: null,
      parentRegionKey: null,
      provinceRegionId: broad ? regionId(row.officialCode) : null,
      provinceRegionKey: broad ? (previous.regionKey || regionId(row.officialCode)) : null,
      level,
      unitType: type,
      officialUnitLabel: type === "general_district" ? "일반구" : type === "administrative_city" ? "행정시" : type === "autonomous_district" ? "자치구" : broad ? name.match(/통합특별시|특별자치시|특별시|광역시|특별자치도|도$/u)?.[0] || "광역" : name.match(/시|군$/u)?.[0] || "지역",
      name,
      shortName: shortName(name),
      fullName: row.fullName,
      sido: PROVINCE_SHORT_NAMES[sidoFull] || sidoFull,
      sidoFull,
      sigungu: broad ? "" : name,
      officialCode: row.officialCode,
      code5: row.officialCode.slice(0, 5),
      active,
      status: active ? "active" : "retired",
      selectable: active && type !== "general_district",
      activeFrom: previous.activeFrom || null,
      activeTo: active ? null : (previous.activeTo || null),
      firstObservedAt: previous.firstObservedAt || asOf,
      lastObservedAt: asOf,
      aliases,
      providerMappings: previous.providerMappings || undefined,
      locationCardKey: previous.locationCardKey || undefined
    };
  });

  const byFullName = new Map();
  units.forEach((unit) => {
    const list = byFullName.get(unit.fullName) || [];
    list.push(unit);
    byFullName.set(unit.fullName, list);
  });
  const broadByName = new Map(units.filter((unit) => unit.level === "broad").map((unit) => [unit.fullName, unit]));
  units.forEach((unit) => {
    if (unit.level === "broad") return;
    const province = broadByName.get(unit.sidoFull)
      || (byFullName.get(unit.sidoFull) || []).find((entry) => entry.active === unit.active)
      || (byFullName.get(unit.sidoFull) || [])[0];
    if (province) {
      unit.provinceRegionId = province.regionId;
      unit.provinceRegionKey = province.regionKey;
    }
    let parent = province;
    if (unit.unitType === "general_district") {
      const cityName = unit.fullName.split(/\s+/).slice(0, 2).join(" ");
      parent = (byFullName.get(cityName) || []).find((entry) => entry.active === unit.active)
        || (byFullName.get(cityName) || [])[0]
        || province;
    }
    unit.parentRegionId = parent?.regionId || null;
    unit.parentRegionKey = parent?.regionKey || null;
  });

  const linkSummary = attachExistingMappings(units, tourismMap, dictionary);
  const byId = new Map(units.map((unit) => [unit.regionId, unit]));
  units.forEach((unit) => {
    if (!unit.parentRegionId) return;
    const parent = byId.get(unit.parentRegionId);
    unit.parentRegionKey = parent?.regionKey || unit.parentRegionKey;
    const province = byId.get(unit.provinceRegionId);
    unit.provinceRegionKey = province?.regionKey || unit.provinceRegionKey;
  });

  units.sort((a, b) => a.officialCode.localeCompare(b.officialCode) || a.fullName.localeCompare(b.fullName, "ko"));
  return { units, linkSummary };
}

function validateMaster(master) {
  const units = master.units || [];
  const active = units.filter((unit) => unit.active);
  const activeBroad = active.filter((unit) => unit.level === "broad");
  const activeLocal = active.filter((unit) => unit.level === "local");
  const activeGeneral = active.filter((unit) => unit.unitType === "general_district");
  const analysisCount = activeLocal.length;
  const uniqueCodes = new Set(active.map((unit) => unit.officialCode));
  if (uniqueCodes.size !== active.length) throw new Error("활성 행정구역 코드가 중복되었습니다.");
  if (activeBroad.length < 15 || activeLocal.length < 220 || activeGeneral.length < 30) {
    throw new Error(`행정구역 구조 건수가 비정상입니다: 광역 ${activeBroad.length}, 기초 ${activeLocal.length}, 일반구 ${activeGeneral.length}`);
  }
  if (master.links.tourismMappedCount !== master.links.tourismRegionCount) {
    throw new Error(`관광 지역표 연결 누락: ${master.links.tourismPending.join(", ")}`);
  }
  if (master.links.locationCardMappedCount !== master.links.locationCardCount) {
    throw new Error(`입지카드 연결 누락: ${master.links.locationCardPending.join(", ")}`);
  }
  master.summary = {
    storedUnitCount: units.length,
    activeUnitCount: active.length,
    activeBroadCount: activeBroad.length,
    activeAnalysisRegionCount: analysisCount,
    activeLocalGovernmentCount: activeLocal.length,
    activeGeneralDistrictCount: activeGeneral.length,
    retiredStructuralUnitCount: units.filter((unit) => !unit.active).length
  };
}

async function main() {
  const asOf = cliValue("as-of") || kstDate();
  const rows = await downloadOfficialRows();
  const previousMaster = readJson(OUTPUT_PATH, { units: [] });
  const tourismMap = readJson(TOURISM_MAP_PATH, { regions: [] });
  const dictionary = readJson(LOCATION_DICTIONARY_PATH, { cards: [], aliases: [] });
  const { units, linkSummary } = buildUnits(rows, asOf, previousMaster, tourismMap, dictionary);
  const master = {
    version: "administrative-region-master-v1",
    generatedAt: new Date().toISOString(),
    asOf,
    source: {
      name: "행정안전부 행정표준코드관리시스템 법정동코드 전체자료",
      referenceUrl: OFFICIAL_REFERENCE_URL,
      downloadUrl: OFFICIAL_DOWNLOAD_URL,
      statusField: "폐지여부",
      activeValue: "존재",
      sourceRowCount: rows.length,
      activeSourceRowCount: rows.filter((row) => row.officialStatus === "존재").length,
      retiredSourceRowCount: rows.filter((row) => row.officialStatus === "폐지").length,
      fetchedAt: new Date().toISOString()
    },
    policy: {
      officialIdentity: "법정동코드 10자리",
      selectableLevels: ["broad", "local"],
      addressOnlyUnitType: "general_district",
      missingObservationDisplay: "관측 없음",
      providerCodesAreSeparate: true,
      notes: [
        "행정구역 원장은 행정구역 식별과 검색에만 사용합니다.",
        "관광·숙박·검색·매출 관측값은 이 파일에 합성하거나 0으로 저장하지 않습니다.",
        "일반구는 주소 매칭용이며 지역 분석값은 상위 시에 귀속합니다.",
        "특별자치구는 현행 공식 단위가 아니므로 자치구로 분류합니다."
      ]
    },
    links: linkSummary,
    summary: {},
    units
  };
  validateMaster(master);
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(master, null, 2)}\n`, "utf8");
  console.log(`region master written: ${path.relative(ROOT, OUTPUT_PATH)}`);
  console.log(JSON.stringify(master.summary, null, 2));
  console.log(JSON.stringify(master.links, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
