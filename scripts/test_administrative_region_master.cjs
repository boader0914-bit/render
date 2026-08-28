const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const master = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "region_master.json"), "utf8"));
const tourism = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "tourism_region_map.json"), "utf8"));
const dictionary = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "location_dictionary.json"), "utf8"));

const units = Array.isArray(master.units) ? master.units : [];
const active = units.filter((unit) => unit.active);
const activeBroad = active.filter((unit) => unit.level === "broad");
const activeLocal = active.filter((unit) => unit.level === "local");
const activeGeneralDistricts = active.filter((unit) => unit.unitType === "general_district");
const byId = new Map(units.map((unit) => [unit.regionId, unit]));

assert.equal(master.version, "administrative-region-master-v1");
assert.match(master.asOf, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(master.source.sourceRowCount >= 50_000, "공식 전체자료가 충분히 포함되어야 합니다.");
assert.equal(master.source.sourceRowCount, master.source.activeSourceRowCount + master.source.retiredSourceRowCount);
assert.equal(master.policy.missingObservationDisplay, "관측 없음");
assert.equal(master.policy.providerCodesAreSeparate, true);

assert.equal(new Set(units.map((unit) => unit.regionId)).size, units.length, "regionId는 이력 전체에서 고유해야 합니다.");
assert.equal(new Set(active.map((unit) => unit.regionKey)).size, active.length, "활성 regionKey는 고유해야 합니다.");
assert.equal(new Set(active.map((unit) => unit.officialCode)).size, active.length, "활성 법정동코드는 고유해야 합니다.");
assert.ok(units.every((unit) => /^\d{10}$/.test(unit.officialCode)), "법정동코드는 10자리여야 합니다.");
assert.ok(units.every((unit) => ["active", "retired"].includes(unit.status)), "상태는 active 또는 retired여야 합니다.");
assert.ok(units.every((unit) => unit.active === (unit.status === "active")), "active와 status가 일치해야 합니다.");
assert.ok(units.every((unit) => unit.unitType !== "special_autonomous_district"), "특별자치구는 공식 단위가 아닙니다.");

units.filter((unit) => unit.level !== "broad").forEach((unit) => {
  assert.ok(unit.parentRegionId, `${unit.fullName}의 상위지역이 필요합니다.`);
  assert.ok(byId.has(unit.parentRegionId), `${unit.fullName}의 상위지역이 원장에 없습니다.`);
  assert.ok(byId.has(unit.provinceRegionId), `${unit.fullName}의 광역지역이 원장에 없습니다.`);
  assert.notEqual(unit.parentRegionId, unit.regionId, `${unit.fullName}이 자기 자신을 부모로 참조합니다.`);
  if (unit.active) {
    assert.equal(byId.get(unit.parentRegionId).active, true, `${unit.fullName}의 활성 부모가 폐지 상태입니다.`);
  }
});
activeGeneralDistricts.forEach((unit) => {
  assert.equal(unit.selectable, false, `${unit.fullName} 일반구는 기본 분석단위로 선택하면 안 됩니다.`);
  assert.equal(byId.get(unit.parentRegionId)?.unitType, "city", `${unit.fullName} 일반구는 상위 시에 연결해야 합니다.`);
});

assert.equal(master.summary.storedUnitCount, units.length);
assert.equal(master.summary.activeUnitCount, active.length);
assert.equal(master.summary.activeBroadCount, activeBroad.length);
assert.equal(master.summary.activeAnalysisRegionCount, activeLocal.length);
assert.equal(master.summary.activeGeneralDistrictCount, activeGeneralDistricts.length);
if (master.asOf === "2026-08-27") {
  assert.equal(activeBroad.length, 16, "2026-08-27 광역단위는 16개입니다.");
  assert.equal(activeLocal.length, 229, "2026-08-27 시·군·자치구·행정시는 229개입니다.");
  assert.equal(activeGeneralDistricts.length, 39, "2026-08-27 일반구는 공식 전체자료 기준 39개입니다.");
}

const linkedTourism = active.filter((unit) => unit.providerMappings?.kto);
assert.equal(linkedTourism.length, tourism.regions.length, "기존 관광 지역표가 모두 원장에 연결되어야 합니다.");
tourism.regions.forEach((region) => {
  const unit = linkedTourism.find((entry) => entry.providerMappings.kto.regionKey === region.regionKey);
  assert.ok(unit, `${region.regionKey} 관광 지역 연결이 없습니다.`);
  assert.equal(unit.providerMappings.kto.ktoSggCd, region.ktoSggCd);
  assert.equal(unit.providerMappings.kto.status, region.codeStatus || "ready");
});
assert.equal(master.links.tourismMappedCount, tourism.regions.length);
assert.deepEqual(master.links.tourismPending, []);

assert.equal(tourism.version, "tourism-region-map-v0.2");
assert.equal(tourism.summary.analysisRegionCount, activeLocal.length);
assert.equal(tourism.summary.regionCount, tourism.regions.length);
assert.equal(tourism.regions.length, 229, "현행 분석지역 229곳을 관광 지역표에 보존해야 합니다.");
assert.equal(new Set(tourism.regions.map((region) => region.regionKey)).size, tourism.regions.length, "관광 regionKey는 고유해야 합니다.");
assert.equal(new Set(tourism.regions.map((region) => region.officialCode)).size, tourism.regions.length, "관광 공식코드는 고유해야 합니다.");
tourism.regions.forEach((region) => {
  assert.match(region.officialCode, /^\d{10}$/);
  assert.match(region.ktoSggCd, /^\d{5}$/);
  assert.equal(region.ktoSggCd, region.officialCode.slice(0, 5), `${region.regionKey}는 법정동코드 앞 5자리와 일치해야 합니다.`);
  const unit = activeLocal.find((entry) => entry.officialCode === region.officialCode);
  assert.ok(unit, `${region.regionKey}가 현행 분석지역과 연결되지 않았습니다.`);
  assert.notEqual(unit.unitType, "general_district", `${region.regionKey} 일반구를 관광 분석단위로 자동 활성화하면 안 됩니다.`);
});

const readyTourism = tourism.regions.filter((region) => !region.codeStatus);
const pendingTourism = tourism.regions.filter((region) => region.codeStatus);
assert.equal(readyTourism.length, tourism.summary.readyCount);
assert.equal(pendingTourism.length, tourism.summary.pendingCount);
assert.equal(readyTourism.length, 198, "즉시 수집 가능한 지역 수가 달라졌습니다.");
assert.equal(pendingTourism.length, 31, "행정구역 개편 후 코드 확인이 필요한 지역 수가 달라졌습니다.");
assert.equal(master.links.tourismReadyCount, readyTourism.length);
assert.equal(master.links.tourismCodePendingCount, pendingTourism.length);
assert.ok(pendingTourism.every((region) => region.codeStatus === "administrative-reform-pending"));
assert.ok(pendingTourism.every((region) => region.codeStatusReason), "보류 지역에는 사유가 필요합니다.");
assert.equal(pendingTourism.filter((region) => region.sidoFull === "전남광주통합특별시").length, 27);
assert.deepEqual(
  pendingTourism.filter((region) => region.sidoFull === "인천광역시").map((region) => region.sigungu).sort((a, b) => a.localeCompare(b, "ko")),
  ["검단구", "서해구", "영종구", "제물포구"].sort((a, b) => a.localeCompare(b, "ko"))
);
assert.equal(tourism.regions.find((region) => region.regionKey === "kr_gangwon_chuncheon")?.ktoSggCd, "51110", "강원특별자치도 현행 코드를 사용해야 합니다.");
assert.equal(tourism.regions.find((region) => region.regionKey === "kr_jeonbuk_muju")?.ktoSggCd, "52730", "전북특별자치도 현행 코드를 사용해야 합니다.");
assert.equal(tourism.regions.find((region) => region.regionKey === "kr_gangwon_chuncheon")?.codeStatus, undefined);
assert.equal(tourism.regions.find((region) => region.regionKey === "kr_jeonbuk_muju")?.codeStatus, undefined);

const linkedCards = active.filter((unit) => unit.locationCardKey);
assert.equal(linkedCards.length, dictionary.cards.length, "기존 입지카드가 모두 원장에 연결되어야 합니다.");
dictionary.cards.forEach((card) => {
  const unit = linkedCards.find((entry) => entry.locationCardKey === card.regionKey);
  assert.ok(unit, `${card.regionKey} 입지카드 연결이 없습니다.`);
  assert.ok(unit.fullName && unit.sigungu, `${card.regionKey} 입지카드는 공식 행정구역명을 가져야 합니다.`);
});
assert.equal(master.links.locationCardMappedCount, dictionary.cards.length);
assert.deepEqual(master.links.locationCardPending, []);

const namhaeUnit = activeLocal.find((unit) => unit.regionKey === "kr_gyeongnam_namhae");
const namhaeCard = dictionary.cards.find((card) => card.regionKey === "kr_gyeongnam_namhae");
assert.ok(namhaeUnit, "남해군 공식 행정구역 원장이 필요합니다.");
assert.ok(namhaeCard, "남해군 저장형 입지카드가 필요합니다.");
assert.equal(namhaeUnit.fullName, "경상남도 남해군");
assert.equal(namhaeUnit.sigungu, "남해군");
assert.equal(namhaeUnit.locationCardKey, namhaeCard.regionKey);
assert.equal(namhaeCard.searchKeyword, "남해 글램핑");
assert.notEqual(namhaeCard.searchKeyword, namhaeUnit.fullName, "업종 키워드를 공식 행정구역명으로 사용하면 안 됩니다.");

const incheonActive = activeLocal.filter((unit) => unit.sidoFull === "인천광역시");
const incheonNames = new Set(incheonActive.map((unit) => unit.name));
["제물포구", "영종구", "서해구", "검단구", "강화군", "옹진군"].forEach((name) => assert.ok(incheonNames.has(name), `인천 ${name}이 활성이어야 합니다.`));
["중구", "동구", "서구"].forEach((name) => assert.ok(!incheonNames.has(name), `과거 인천 ${name}은 활성 목록에서 제외해야 합니다.`));

const integratedProvince = activeBroad.find((unit) => unit.fullName === "전남광주통합특별시");
assert.ok(integratedProvince, "전남광주통합특별시가 활성 광역단위여야 합니다.");
assert.equal(activeLocal.filter((unit) => unit.sidoFull === "전남광주통합특별시").length, 27);
assert.ok(units.some((unit) => unit.fullName === "광주광역시" && !unit.active), "과거 광주광역시를 폐지 이력으로 보존해야 합니다.");
assert.ok(units.some((unit) => unit.fullName === "전라남도" && !unit.active), "과거 전라남도를 폐지 이력으로 보존해야 합니다.");

const sejong = activeBroad.find((unit) => unit.fullName === "세종특별자치시");
assert.ok(sejong?.selectable, "세종특별자치시는 광역 분석단위로 선택할 수 있어야 합니다.");
assert.equal(activeLocal.filter((unit) => unit.sidoFull === "세종특별자치시").length, 0, "세종 하위 시군구를 가상 생성하면 안 됩니다.");
assert.equal(activeLocal.filter((unit) => unit.unitType === "administrative_city").length, 2, "제주·서귀포 행정시 2곳이 필요합니다.");

const forbiddenMetricKeys = /visitor|sales|revenue|reservation|forecast|score|rate|count$/i;
active.forEach((unit) => {
  Object.keys(unit).forEach((key) => {
    assert.ok(!forbiddenMetricKeys.test(key), `${unit.fullName} 원장에 관측 지표 ${key}를 저장하면 안 됩니다.`);
  });
});

const duplicateGoseong = activeLocal.filter((unit) => unit.name === "고성군");
assert.equal(duplicateGoseong.length, 2, "강원·경남 고성군을 각각 보존해야 합니다.");
assert.equal(new Set(duplicateGoseong.map((unit) => unit.sidoFull)).size, 2);
assert.equal(new Set(duplicateGoseong.map((unit) => unit.regionKey)).size, 2);

console.log(`administrative region master ok: 광역 ${activeBroad.length}, 분석지역 ${activeLocal.length}, 일반구 ${activeGeneralDistricts.length}, 이력 ${units.length}`);
