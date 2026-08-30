const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appPath = process.argv[2] || path.join(__dirname, "..", "web", "app.js");
const source = fs.readFileSync(appPath, "utf8");
const names = [
  "companyKey", "adminDbProvinceIdentity", "adminDbLocalityKey",
  "adminDbCompanyAddressRegion", "adminDbFallbackRegionLabels",
  "adminDbClassifyCompany", "adminRegionCompanyMatches"
];
const declarations = names.map((name) =>
  source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0] || ""
);
const provinceOrder = source.match(/^const ADMIN_DB_PROVINCE_ORDER = \[[^]*?^\];/m)?.[0];
assert.ok(provinceOrder, "the app's province aliases must be available");
const api = vm.runInNewContext([
  provinceOrder, ...declarations,
  "({ classify: adminDbClassifyCompany, matches: adminRegionCompanyMatches })"
].join("\n"));

function region(provinceKey, provinceLabel, localityLabel) {
  return {
    provinceKey, provinceLabel, localityLabel, regionLabel: localityLabel,
    regionKey: `${provinceKey}:${localityLabel}`, level: "local"
  };
}

const gyeongnam = region("gyeongnam", "경남", "고성");
const gangwon = region("gangwon", "강원", "고성");
const sancheong = region("gyeongnam", "경남", "산청");
const bothGoseong = [gangwon, gyeongnam];
const actualCompanies = [
  { primaryName: "라파엘펜션&글램핑", addresses: ["경남 고성군 회화면"], regions: ["고성"] },
  { primaryName: "블루비치 글램핑 펜션", addresses: ["경남 고성군 삼산면"], regions: ["고성"] }
];
for (const company of actualCompanies) {
  const before = JSON.stringify(company);
  for (const regions of [bothGoseong, [...bothGoseong].reverse()]) {
    const classified = api.classify(company, regions);
    assert.equal(classified.provinceKey, "gyeongnam", `${company.primaryName}: address province wins over list order`);
    assert.equal(classified.regionKey, "gyeongnam:고성");
  }
  assert.equal(api.matches(gangwon, company), false, "a Gyeongnam company must not join the Gangwon bucket");
  assert.equal(JSON.stringify(company), before, "classification must preserve the stored company record");
}

const gangwonCompany = {
  addresses: ["강원특별자치도 고성군 토성면"], regions: ["고성"],
  keywords: [{ keyword: "경남글램핑", searchRegion: "경남" }]
};
assert.equal(api.classify(gangwonCompany, bothGoseong).provinceKey, "gangwon", "a search keyword must not override the address");
assert.equal(api.matches(gyeongnam, gangwonCompany), false);
assert.equal(api.classify({ addresses: ["강원도 고성군"], regions: ["고성"] }, bothGoseong).provinceKey, "gangwon");
assert.equal(api.classify({ addresses: ["경상남도 고성군"], regions: ["고성"] }, bothGoseong).provinceKey, "gyeongnam");

// If an old summary still contains only the wrong bucket, the UI must use the address.
const staleSummary = api.classify(actualCompanies[0], [gangwon]);
assert.equal(staleSummary.provinceKey, "gyeongnam");
assert.equal(staleSummary.regionKey, "gyeongnam:고성");
assert.equal(staleSummary.region, null);
assert.equal(api.classify(actualCompanies[0], []).provinceKey, "gyeongnam");
assert.equal(api.classify({ regions: ["경남 고성군"] }, bothGoseong).provinceKey, "gyeongnam");

for (const regions of [bothGoseong, [...bothGoseong].reverse()]) {
  const ambiguous = api.classify({ regions: ["고성"], keywords: [{ searchRegion: "경남" }] }, regions);
  assert.equal(ambiguous.provinceKey, "unknown", "a bare duplicate locality cannot choose a province");
  assert.equal(ambiguous.region, null);
}
assert.equal(api.classify({ regions: ["산청"] }, [sancheong]).provinceKey, "gyeongnam", "a unique existing locality still matches");
assert.equal(api.classify({}, []).provinceKey, "unknown");

const gwangjuCity = region("gyeonggi", "경기", "광주");
const gwangjuMetro = { provinceKey: "gwangju", provinceLabel: "광주", regionKey: "gwangju", regionLabel: "광주", level: "province" };
assert.equal(api.classify({ regions: ["광주"] }, [gwangjuMetro, gwangjuCity]).provinceKey, "unknown");
assert.equal(api.classify({ addresses: ["경기도 광주시 퇴촌면"], regions: ["광주"] }, [gwangjuMetro, gwangjuCity]).provinceKey, "gyeonggi");
const gwangjuNorth = region("gwangju", "광주", "북구");
assert.equal(api.classify({ addresses: ["광주광역시 북구"], regions: ["북구"] }, [gwangjuCity, gwangjuMetro, gwangjuNorth]).regionKey, "gwangju:북구");

const seoulJung = region("seoul", "서울", "중구");
const daejeonJung = region("daejeon", "대전", "중");
assert.equal(api.classify({ addresses: ["대전광역시 중구"], regions: ["중"] }, [seoulJung, daejeonJung]).provinceKey, "daejeon");

const changwonCompany = { addresses: ["경남 창원시 고성로 1"], regions: ["창원"] };
assert.equal(api.matches(gyeongnam, changwonCompany), false, "a street name must not become the county");
assert.equal(api.classify(changwonCompany, [gyeongnam, region("gyeongnam", "경남", "창원")]).regionKey, "gyeongnam:창원");

const broadGyeongnam = { provinceKey: "gyeongnam", provinceLabel: "경남", regionKey: "gyeongnam", regionLabel: "경남", level: "province" };
assert.equal(api.classify(actualCompanies[0], [broadGyeongnam, gyeongnam]).regionKey, "gyeongnam:고성", "prefer the locality to its province summary");
assert.equal(api.classify(actualCompanies[0], [broadGyeongnam]).regionKey, "gyeongnam:고성", "a province summary must not erase the address's county");
assert.equal(api.classify({ addresses: ["경남 고성군"], regions: ["강원 고성"] }, bothGoseong).provinceKey, "gyeongnam", "the source address wins over stale labels");
assert.equal(api.classify({ addresses: ["경남", "경남 고성군 회화면"], regions: ["산청"] }, [sancheong, gyeongnam]).regionKey, "gyeongnam:고성", "prefer a complete address to a province-only observation");
assert.equal(api.classify({ addresses: ["경남고성군 회화면"], regions: ["강원 고성"] }, bothGoseong).regionKey, "gyeongnam:고성", "joined province and county names retain the province");
assert.equal(api.classify({ addresses: ["경상남도고성군회화면"], regions: ["강원 고성"] }, bothGoseong).regionKey, "gyeongnam:고성");
assert.equal(api.classify({ addresses: ["부산시 강서구 대저1동"], regions: ["강서"] }, [region("seoul", "서울", "강서")]).provinceKey, "busan", "a province abbreviation must not reuse a stale same-named district");

const broadGangwon = { provinceKey: "gangwon", provinceLabel: "강원", regionKey: "gangwon", regionLabel: "강원", level: "province" };
for (const address of ["강원특별자치도 양구군 국토정중앙면", "강원 양구", "강원양구군국토정중앙면"]) {
  for (const regions of [[], [broadGangwon], [region("gangwon", "강원", "양구")]]) {
    const classified = api.classify({ addresses: [address], regions: ["양구"] }, regions);
    assert.equal(classified.regionKey, "gangwon:양구", "a syllable in a county's name must not be stripped as an administrative suffix");
  }
  assert.equal(api.matches(region("gangwon", "강원", "양구군"), { addresses: [address] }), true);
}
assert.equal(api.classify({ addresses: ["경남창원시마산합포구 구산면"] }, []).regionKey, "gyeongnam:창원", "a joined city and its district must retain the city bucket");
assert.equal(api.classify({ addresses: ["경기도수원시팔달구 매산로"] }, []).regionKey, "gyeonggi:수원");

console.log("company DB region labels ok: actual Goseong records, province aliases, duplicate localities, stale summaries, address preservation");
