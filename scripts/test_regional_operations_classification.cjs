"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Evaluate only pure declarations. Never require/start the server or read runtime data.
// An optional source path lets the same regressions be checked against a deployed snapshot.
const serverPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "glamping_app_server.cjs");
const source = fs.readFileSync(serverPath, "utf8").replace(/\r\n/g, "\n");
function sourceFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, `Missing pure server declaration: ${name}`);
  return source.slice(start, end + 2);
}
const regionStart = source.indexOf("const ADMIN_REGION_GROUPS =");
const regionEnd = source.indexOf("function topicParticle(", regionStart);
assert.ok(regionStart >= 0 && regionEnd > regionStart, "Missing administrative region definitions");
const functionNames = [
  "compactKeyword", "topicParticle", "regionBoundaryInfo", "uniqueTexts", "boundedUnique", "stableHash",
  "naverCouponDisplayNames", "naverCouponSignalFromItem", "adminRegionClassification",
  "regionOpsEntityKey", "regionOpsItemName", "firstPositiveNumber", "regionOpsRevenueValue",
  "regionOpsReservationRate", "regionOpsHasReservationSample", "regionOpsInventoryFlags",
  "regionOpsConfidenceGrade", "regionOpsActualRegionText", "regionOpsSearchRegionText",
  "createRegionalOpsBucket", "regionalOpsMaintenanceProfile", "regionalOpsStatus",
  "finalizeRegionalOpsBucket", "buildRegionalOperationsFromItems", "addressRegionFromAddress",
  "summarizeCompanyMasterRegionalOperations", "applyAdminRegionReviewsToOperations", "regionReviewKey", "adminRegionReviewMeta"
];
// Older deployed snapshots have no address-selection helper; keep baseline regression checks runnable.
if (source.includes("function regionOpsAddress(")) functionNames.push("regionOpsAddress");
const helpers = vm.runInNewContext([
  source.slice(regionStart, regionEnd),
  ...functionNames.map(sourceFunction),
  "({ adminRegionClassification, regionBoundaryInfo, buildRegionalOperationsFromItems, summarizeCompanyMasterRegionalOperations })"
].join("\n"), { crypto }, { timeout: 1000 });

let passed = 0;
const failures = [];
function check(label, verify) {
  try {
    verify();
    passed += 1;
  } catch (error) {
    failures.push({ label, message: error.message });
  }
}

const classificationCases = [
  { label: "경남 고성 약칭 주소", value: "고성", address: "경남 고성군 회화면 시험로 1", key: "gyeongnam:고성", level: "local" },
  { label: "경남 고성 정식 주소", value: "고성", address: "경상남도 고성군 동해면 시험로 2", key: "gyeongnam:고성", level: "local" },
  { label: "붙은 주소가 오래된 강원 지역값보다 우선", value: "강원고성", address: "경남고성군 회화면 시험로 2", key: "gyeongnam:고성", level: "local" },
  { label: "붙은 정식 주소", value: "고성", address: "경상남도고성군 동해면 시험로 2", key: "gyeongnam:고성", level: "local" },
  { label: "강원 고성 현행 주소", value: "고성", address: "강원특별자치도 고성군 토성면 시험로 3", key: "gangwon:고성", level: "local" },
  { label: "강원 고성 종전 주소", value: "고성", address: "강원도 고성군 죽왕면 시험로 4", key: "gangwon:고성", level: "local" },
  { label: "시도를 포함한 지역명", value: "경남 고성군", key: "gyeongnam:고성", level: "local" },
  { label: "원주소가 오래된 지역값보다 우선", value: "산청", address: "강원 고성군 토성면 시험로 5", key: "gangwon:고성", level: "local" },
  { label: "원주소가 검색 시도보다 우선", value: "경남", address: "강원 고성군 토성면 시험로 6", key: "gangwon:고성", level: "local" },
  { label: "경기도 광주시", value: "광주", address: "경기도 광주시 시험로 7", key: "gyeonggi:광주", level: "local" },
  { label: "광주광역시", value: "광주", address: "광주광역시", key: "gwangju", level: "province" },
  { label: "광주광역시 북구", value: "북", address: "광주광역시 북구 시험로 8", key: "gwangju:북", level: "local" },
  { label: "광주 북구 약칭 주소", value: "북", address: "광주 북구 시험로 9", key: "gwangju:북", level: "local" },
  { label: "대전 중구", value: "중", address: "대전광역시 중구 시험로 10", key: "daejeon:중", level: "local" },
  { label: "서울 중구", value: "중구", address: "서울특별시 중구 시험로 11", key: "seoul:중", level: "local" },
  { label: "부산시 별칭의 강서구", value: "강서", address: "부산시 강서구 대저1동 시험로 12", key: "busan:강서", level: "local" },
  { label: "고유 지명 산청 유지", value: "산청", key: "gyeongnam:산청", level: "local" },
  { label: "고유 지명 산청군 유지", value: "산청군", key: "gyeongnam:산청", level: "local" },
  { label: "고유 지명 남해 유지", value: "남해", key: "gyeongnam:남해", level: "local" },
  { label: "양구의 이름 자체 구 보존", value: "양구", key: "gangwon:양구", level: "local" },
  { label: "양구군의 군 접미사만 제거", value: "양구군", key: "gangwon:양구", level: "local" },
  { label: "양구군 전체 주소", value: "양구", address: "강원특별자치도 양구군 국토정중앙면", key: "gangwon:양구", level: "local" },
  { label: "양구군 붙은 주소", value: "양구", address: "강원도양구군 국토정중앙면", key: "gangwon:양구", level: "local" },
  { label: "양구 canonical 명칭의 붙은 주소", value: "양구", address: "강원양구 국토정중앙면", key: "gangwon:양구", level: "local" },
  { label: "공주 명칭 유지", value: "공주", key: "chungnam:공주", level: "local" },
  { label: "공주시 명칭 유지", value: "공주시", key: "chungnam:공주", level: "local" },
  { label: "공주시 전체 주소", value: "공주", address: "충청남도 공주시 웅진동", key: "chungnam:공주", level: "local" },
  { label: "공주시 붙은 주소", value: "공주", address: "충남공주시 웅진동", key: "chungnam:공주", level: "local" },
  { label: "군위의 이름 자체 군 보존", value: "군위", key: "daegu:군위", level: "local" },
  { label: "군위군의 후행 군만 제거", value: "군위군", key: "daegu:군위", level: "local" },
  { label: "군위군 전체 주소", value: "군위", address: "대구광역시 군위군 군위읍", key: "daegu:군위", level: "local" },
  { label: "군위군 붙은 주소", value: "군위", address: "대구군위군 군위읍", key: "daegu:군위", level: "local" },
  { label: "광역 경남 유지", value: "경남", key: "gyeongnam", level: "province" }
];
for (const row of classificationCases) {
  check(row.label, () => {
    const result = helpers.adminRegionClassification(row.value, row.address || "");
    assert.equal(result.regionKey, row.key);
    assert.equal(result.level, row.level);
  });
}
for (const value of ["고성", "고성군", "중", "중구", "강서구", "광주", "광주시", ""]) {
  check(`시도 없는 동명/빈 지역은 미확인: ${value || "빈 값"}`, () => {
    const result = helpers.adminRegionClassification(value);
    assert.equal(result.level, "unknown");
    assert.equal(result.provinceKey, "unknown");
  });
}

const boundaryCases = [
  { label: "경남 검색의 경남 고성", search: "경남", region: "고성", address: "경남 고성군 회화면 시험로 1", status: "within" },
  { label: "경남 검색의 강원 고성은 권역 밖", search: "경남", region: "고성", address: "강원특별자치도 고성군 토성면 시험로 2", status: "outside" },
  { label: "강원 검색의 경남 고성도 권역 밖", search: "강원", region: "고성", address: "경상남도 고성군 시험로 3", status: "outside" },
  { label: "고성군끼리도 시도가 다르면 권역 밖", search: "경남 고성군", region: "고성", address: "강원도 고성군 시험로 4", status: "outside" },
  { label: "같은 고성군", search: "경남 고성군", region: "고성", address: "경남 고성군 시험로 5", status: "same" },
  { label: "경남 검색만으로 고성을 확정하지 않음", search: "경남", region: "고성", status: "unknown" },
  { label: "경기 검색의 경기 광주", search: "경기", region: "광주", address: "경기도 광주시 시험로 6", status: "within" },
  { label: "광역 광주와 경기 광주 구분", search: "광주광역시", region: "광주", address: "경기도 광주시 시험로 7", status: "outside" },
  { label: "고유 산청 권역 유지", search: "경남", region: "산청", status: "within" },
  { label: "고유 남해 권역 유지", search: "경남", region: "남해", status: "within" },
  { label: "다른 시군은 권역 밖", search: "산청", region: "남해", status: "outside" },
  { label: "상위 권역만 확인", search: "산청", region: "경남", status: "parent" },
  { label: "강원 검색의 양구군", search: "강원", region: "양구군", address: "강원특별자치도 양구군 국토정중앙면", status: "within" },
  { label: "경남 검색의 양구는 권역 밖", search: "경남", region: "양구", address: "강원특별자치도 양구군 국토정중앙면", status: "outside" },
  { label: "양구 검색과 양구군은 동일 지역", search: "양구", region: "양구군", address: "강원특별자치도 양구군 국토정중앙면", status: "same" },
  { label: "검색 지역이 없으면 경계 미확인", search: "", region: "고성", address: "경남 고성군 시험로 8", status: "unknown" }
];
for (const row of boundaryCases) {
  check(row.label, () => {
    const result = helpers.regionBoundaryInfo(row.search, row.region, row.address || "");
    assert.equal(result.status, row.status);
    assert.equal(result.outside, row.status === "outside");
  });
}

check("회사 지역 집계에서 두 고성 분리, 원주소 우선, 미확인 유지 및 입력 불변", () => {
  const items = [
    { companyId: "fixture_south_1", name: "남쪽 고성 예시 1", region: "고성", address: "경남 고성군 회화면 시험로 1" },
    { companyId: "fixture_south_2", name: "남쪽 고성 예시 2", region: "고성", address: "경상남도 고성군 동해면 시험로 2" },
    { companyId: "fixture_north", name: "북쪽 고성 예시", region: "고성", addressRegion: "산청", address: "강원특별자치도 고성군 토성면 시험로 3", regionBoundaryStatus: "within", outsideSearchRegion: false },
    { companyId: "fixture_unknown", name: "소재지 미확인 예시", region: "고성" },
    { companyId: "fixture_sancheong", name: "산청 예시", region: "산청", address: "경남 산청군 시험로 4" },
    { companyId: "fixture_namhae", name: "남해 예시", region: "남해" }
  ];
  const before = JSON.stringify(items);
  const operations = helpers.buildRegionalOperationsFromItems({
    basis: "company_master",
    items,
    run: { province: "gyeongnam", provinceLabel: "경남", keyword: "경남 글램핑" }
  });
  const byRegion = new Map(operations.regions.map((region) => [region.regionKey, region]));
  assert.equal(operations.summary.companyCount, 6);
  assert.equal(byRegion.get("gyeongnam:고성")?.companyCount, 2);
  assert.equal(byRegion.get("gangwon:고성")?.companyCount, 1);
  assert.equal(byRegion.get("gangwon:고성")?.outsideExposureCount, 1, "Discard stale within-region flags");
  assert.equal(byRegion.get("gangwon:고성")?.sampleCompanies[0]?.addressRegion, "고성", "Use the address before stale addressRegion");
  assert.equal(byRegion.get("gyeongnam:산청")?.companyCount, 1);
  assert.equal(byRegion.get("gyeongnam:남해")?.companyCount, 1);
  const unresolved = operations.regions.filter((region) => region.level === "unknown");
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].companyCount, 1);
  assert.equal(unresolved[0].provinceKey, "unknown");
  assert.equal(JSON.stringify(items), before, "Classification must not rewrite stored addresses or regions");
});

check("광주 미확인 지역은 광주광역시 집계에 합쳐지지 않음", () => {
  const operations = helpers.buildRegionalOperationsFromItems({
    items: [
      { companyId: "fixture_city", name: "경기 광주시 예시", region: "광주", address: "경기도 광주시 시험로 1" },
      { companyId: "fixture_metro", name: "광역 광주 예시", region: "광주", address: "광주광역시" },
      { companyId: "fixture_unresolved", name: "광주 미확인 예시", region: "광주" }
    ]
  });
  assert.equal(operations.regions.length, 3);
  assert.equal(operations.regions.find((region) => region.regionKey === "gyeonggi:광주")?.companyCount, 1);
  assert.equal(operations.regions.find((region) => region.regionKey === "gwangju")?.companyCount, 1);
  assert.equal(operations.regions.find((region) => region.level === "unknown")?.companyCount, 1);
});

check("회사 요약의 시도-only 주소 뒤에서 같은 시도의 상세주소 선택", () => {
  const companies = [
    { companyId: "fixture_broad_first", primaryName: "주소 보강 예시", regions: ["고성"], addresses: ["경남", "경남 고성군 회화면 시험로 1"] },
    { companyId: "fixture_other_province", primaryName: "다른 시도 혼입 예시", regions: ["고성"], addresses: ["경남", "강원도 고성군 토성면 시험로 2", "경상남도고성군 동해면 시험로 3"] },
    { companyId: "fixture_busan", primaryName: "부산 주소 보강 예시", regions: ["강서"], addresses: ["부산시", "부산시 강서구 대저1동 시험로 4"] }
  ];
  const before = JSON.stringify(companies);
  const operations = helpers.summarizeCompanyMasterRegionalOperations(companies);
  assert.equal(operations.regions.find((region) => region.regionKey === "gyeongnam:고성")?.companyCount, 2);
  assert.equal(operations.regions.find((region) => region.regionKey === "busan:강서")?.companyCount, 1);
  assert.equal(operations.regions.some((region) => region.provinceKey === "gangwon"), false);
  assert.equal(JSON.stringify(companies), before, "Do not reorder or replace persisted address arrays");
});

check("시도-only 주소를 다른 시도 주소로 보강하지 않음", () => {
  const operations = helpers.summarizeCompanyMasterRegionalOperations([
    { companyId: "fixture_broad_conflict", primaryName: "시도 충돌 예시", regions: ["고성"], addresses: ["경남", "강원 고성군 토성면 시험로 1"] }
  ]);
  assert.equal(operations.regions.length, 1);
  assert.equal(operations.regions[0].regionKey, "gyeongnam");
});

check("붙은 주소는 집계와 경계 및 소재지 표시에도 우선 적용", () => {
  const operations = helpers.buildRegionalOperationsFromItems({
    items: [{ companyId: "fixture_joined", name: "붙은 주소 예시", region: "강원고성", addressRegion: "강원 고성군", address: "경남고성군 회화면 시험로 1" }],
    run: { province: "gyeongnam", provinceLabel: "경남" }
  });
  assert.equal(operations.regions[0]?.regionKey, "gyeongnam:고성");
  assert.equal(operations.regions[0]?.sampleCompanies[0]?.addressRegion, "고성");
  assert.equal(operations.regions[0]?.sampleCompanies[0]?.boundaryStatus, "within");
});

check("회사 집계에서도 양구 canonical key와 소재지 표시 보존", () => {
  const operations = helpers.summarizeCompanyMasterRegionalOperations([
    { companyId: "fixture_yanggu_short", primaryName: "양구 예시", regions: ["양구"], addresses: ["강원특별자치도", "강원특별자치도 양구군 국토정중앙면"] },
    { companyId: "fixture_yanggu_county", primaryName: "양구군 예시", regions: ["양구군"], addresses: ["강원도양구군 국토정중앙면"] }
  ]);
  assert.equal(operations.regions.length, 1);
  assert.equal(operations.regions[0].regionKey, "gangwon:양구");
  assert.equal(operations.regions[0].localityKey, "양구");
  assert.equal(operations.regions[0].companyCount, 2);
  assert.ok(operations.regions[0].sampleCompanies.every((company) => company.addressRegion === "양구"));
});

for (const failure of failures) console.error(`FAIL ${failure.label}: ${failure.message}`);
console.log(`regional operations classification: ${passed} passed, ${failures.length} failed (pure functions; no server/network/runtime data)`);
if (failures.length) process.exitCode = 1;
