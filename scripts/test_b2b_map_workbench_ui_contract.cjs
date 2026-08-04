"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.fetch = (url) => {
  throw new Error(`External requests are forbidden in B2B map workbench tests: ${url}`);
};

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");
const server = fs.readFileSync(path.join(root, "scripts", "glamping_app_server.cjs"), "utf8");
const runtimeSecurity = fs.readFileSync(path.join(root, "scripts", "runtime_security.cjs"), "utf8");
const geocodingContract = fs.readFileSync(path.join(root, "scripts", "lodging_geocoding_contract.cjs"), "utf8");
const { __test: serverTest } = require(path.join(root, "scripts", "glamping_app_server.cjs"));

function balancedRange(source, startIndex) {
  const open = source.indexOf("{", startIndex);
  assert.notEqual(open, -1, "expected opening brace");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return { open, close: index, body: source.slice(open + 1, index) };
  }
  assert.fail("expected balanced block");
}

function functionRange(source, name) {
  const matcher = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = matcher.exec(source);
  assert.ok(match, `missing function ${name}`);
  const parameterOpen = source.indexOf("(", match.index);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let parameterClose = -1;
  for (let index = parameterOpen; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0) {
      parameterClose = index;
      break;
    }
  }
  assert.notEqual(parameterClose, -1, `missing parameter close for ${name}`);
  return { match, range: balancedRange(source, parameterClose) };
}

function functionSource(source, name) {
  const { match, range } = functionRange(source, name);
  return source.slice(match.index, range.close + 1);
}

function functionBlock(source, name) {
  return functionRange(source, name).range.body;
}

function constantSource(source, name) {
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `missing constant ${name}`);
  const range = balancedRange(source, start);
  const semicolon = source.indexOf(";", range.close);
  assert.notEqual(semicolon, -1, `missing terminator for ${name}`);
  return source.slice(start, semicolon + 1);
}

function openingTagById(id) {
  const match = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, "i"));
  assert.ok(match, `missing #${id}`);
  return match[0];
}

const geocodingPermissionContext = vm.createContext({
  state: { session: { role: "b2b" } },
  isAdminUserViewMode: () => false
});
vm.runInContext(functionSource(app, "canUseB2BMapTransientGeocoding"), geocodingPermissionContext);
assert.equal(vm.runInContext("canUseB2BMapTransientGeocoding()", geocodingPermissionContext), true, "B2B can explicitly request transient map coordinates");
geocodingPermissionContext.state.session.role = "admin";
assert.equal(vm.runInContext("canUseB2BMapTransientGeocoding()", geocodingPermissionContext), false, "ordinary admin mode cannot request B2B transient coordinates");
geocodingPermissionContext.isAdminUserViewMode = () => true;
assert.equal(vm.runInContext("canUseB2BMapTransientGeocoding()", geocodingPermissionContext), true, "Admin User View can use the approved Preview-only client path");

assert.equal(serverTest.isAdminPreviewMapGeocodingRequest("admin", {
  requestContext: "admin-user-view",
  explicitConsent: true
}, true), true, "Preview admin request requires explicit User View consent");
assert.equal(serverTest.isAdminPreviewMapGeocodingRequest("admin", {
  requestContext: "admin-user-view",
  explicitConsent: true
}, false), false, "non-Preview runtime must reject the admin exception");
assert.equal(serverTest.isAdminPreviewMapGeocodingRequest("admin", {
  requestContext: "admin-user-view",
  explicitConsent: false
}, true), false, "missing consent must fail closed");
assert.equal(serverTest.isAdminPreviewMapGeocodingRequest("unknown", {
  requestContext: "admin-user-view",
  explicitConsent: true
}, true), false, "unknown roles must fail closed");
assert.equal(serverTest.validAdminPreviewMapGeocodingIndexes([]), false, "empty admin batches are rejected");
assert.equal(serverTest.validAdminPreviewMapGeocodingIndexes([0, 0]), false, "duplicate admin indexes are rejected");
assert.equal(serverTest.validAdminPreviewMapGeocodingIndexes(Array.from({ length: 19 }, (_, index) => index)), false, "admin batches cannot exceed 18");
assert.equal(serverTest.validAdminPreviewMapGeocodingIndexes([0, 1, 17]), true, "unique admin indexes within the limit are accepted");
assert.equal(serverTest.isAdminPreviewMapGeocodingItemEligible({ rankingSource: "overall", overallRank: 1 }, "naver_overall"), true);
assert.equal(serverTest.isAdminPreviewMapGeocodingItemEligible({ rankingSource: "naver_overall", overallRank: 20 }, "naver_overall"), true);
assert.equal(serverTest.isAdminPreviewMapGeocodingItemEligible({ rankingSource: "naver_overall", overallRank: 21 }, "naver_overall"), false, "rank 21 is never an admin Preview marker candidate");
assert.equal(serverTest.isAdminPreviewMapGeocodingItemEligible({ rankingSource: "regional", overallRank: 1 }, "naver_regional"), false, "regional ranks cannot be promoted to organic map ranks");
assert.equal(serverTest.isSameOriginMapGeocodingRequest({ headers: { host: "preview.example", origin: "https://preview.example", "sec-fetch-site": "same-origin" } }), true);
assert.equal(serverTest.isSameOriginMapGeocodingRequest({ headers: { host: "preview.example", origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), false, "cross-site provider-cost requests are rejected");
assert.equal(serverTest.isSameOriginMapGeocodingRequest({ headers: { host: "preview.example", origin: "not-a-url" } }), false, "malformed origins fail closed");

const expectedStatuses = [
  "verified",
  "resolved",
  "approximate",
  "ambiguous",
  "not_found",
  "invalid",
  "pending",
  "error",
];
const mappableStatuses = new Set(["verified", "resolved", "approximate"]);

const coordinateContext = {};
vm.createContext(coordinateContext);
vm.runInContext(
  `${constantSource(app, "B2B_LOCATION_STATUS_META")} this.B2B_LOCATION_STATUS_META = B2B_LOCATION_STATUS_META;`,
  coordinateContext,
);
for (const name of [
  "coordinatePairsFromValue",
  "coordinateFromValue",
  "explicitLocationContract",
  "normalizedLocationStatus",
  "coordinateStatusFromValue",
]) {
  vm.runInContext(functionSource(app, name), coordinateContext);
}

assert.deepEqual(Object.keys(coordinateContext.B2B_LOCATION_STATUS_META).sort(), [...expectedStatuses].sort());
for (const status of expectedStatuses) {
  const meta = coordinateContext.B2B_LOCATION_STATUS_META[status];
  assert.ok(meta.label, `${status} must expose a text label`);
  assert.ok(meta.icon, `${status} must expose a non-color status cue`);
  assert.equal(meta.mappable, mappableStatuses.has(status), `${status} mappable contract mismatch`);
  const profile = coordinateContext.coordinateStatusFromValue({
    companyProfile: {
      location: {
        status,
        lat: 37.5665,
        lon: 126.978,
        precision: status === "approximate" ? "street" : status === "resolved" ? "parcel" : "rooftop",
        source: "provider",
        resolvedAddress: "서울특별시 중구 세종대로 110",
        geocodedAt: "2026-08-03T00:00:00.000Z",
      },
    },
  });
  assert.equal(profile.status, status);
  assert.equal(Boolean(profile.coordinate), mappableStatuses.has(status), `${status} coordinate visibility mismatch`);
  assert.ok(profile.label, `${status} must retain a visible label`);
}

assert.equal(coordinateContext.normalizedLocationStatus("exact"), "verified");
assert.equal(coordinateContext.normalizedLocationStatus("missing"), "not_found");
assert.equal(coordinateContext.normalizedLocationStatus("future_status"), "pending");
assert.equal(coordinateContext.coordinateStatusFromValue({ longitude: 127.1, latitude: 37.5 }).status, "ambiguous");
assert.equal(coordinateContext.coordinateStatusFromValue({ companyProfile: { location: { status: "resolved", longitude: 127.1, latitude: 37.5, precision: "parcel", source: "provider" } } }).status, "resolved");
assert.equal(coordinateContext.coordinateStatusFromValue({ companyProfile: { location: { status: "resolved", longitude: 127.1, latitude: 37.5, precision: "street", source: "provider" } } }).status, "approximate");
for (const precision of ["locality", "region", "unknown"]) {
  const profile = coordinateContext.coordinateStatusFromValue({ companyProfile: { location: { status: "resolved", longitude: 127.1, latitude: 37.5, precision, source: "provider" } } });
  assert.equal(profile.status, "ambiguous", `${precision} must remain a list-only location`);
  assert.equal(profile.coordinate, null, `${precision} must not create a company marker coordinate`);
}
assert.equal(coordinateContext.coordinateStatusFromValue({ longitude: "127.1", latitude: "37.5" }).status, "invalid");
assert.equal(coordinateContext.coordinateStatusFromValue({ longitude: 140, latitude: 37.5 }).status, "invalid");
assert.equal(coordinateContext.coordinateStatusFromValue({ companyProfile: { location: { status: "verified" } } }).status, "invalid");
assert.equal(coordinateContext.coordinateStatusFromValue({ companyProfile: { location: { status: "pending" } } }).status, "pending");
assert.equal(coordinateContext.coordinateStatusFromValue({}).status, "not_found");

const filterContext = { state: { b2bMapFilters: { locationStatus: "all", boundary: "all" } } };
vm.createContext(filterContext);
vm.runInContext(functionSource(app, "b2bMapFilteredRows"), filterContext);
vm.runInContext(functionSource(app, "b2bMapLocationCounts"), filterContext);
const filterRows = expectedStatuses.map((coordinateStatus, index) => ({
  key: coordinateStatus,
  coordinateStatus,
  bucket: index % 2 ? "adjacent" : "local",
  categoryKeys: index % 2 ? ["pension"] : ["glamping"],
  platformNames: index % 2 ? ["네이버"] : ["NOL"],
}));
const originalRowsJson = JSON.stringify(filterRows);

filterContext.state.b2bMapFilters = { locationStatus: "located", boundary: "all" };
assert.equal(filterContext.b2bMapFilteredRows(filterRows).map((row) => row.key).join(","), "verified,resolved");
filterContext.state.b2bMapFilters = { locationStatus: "approximate", boundary: "all" };
assert.equal(filterContext.b2bMapFilteredRows(filterRows).map((row) => row.key).join(","), "approximate");
filterContext.state.b2bMapFilters = { locationStatus: "unresolved", boundary: "all" };
assert.equal(
  filterContext.b2bMapFilteredRows(filterRows).map((row) => row.key).join(","),
  "ambiguous,not_found,invalid,pending,error",
);
filterContext.state.b2bMapFilters = { locationStatus: "unresolved", boundary: "adjacent" };
assert.equal(
  filterContext.b2bMapFilteredRows(filterRows).map((row) => row.key).join(","),
  "ambiguous,invalid,error",
);
assert.equal(JSON.stringify(filterRows), originalRowsJson, "map filters must not mutate the source rows");
filterContext.state.b2bMapFilters = { locationStatus: "all", boundary: "local", category: "glamping", platform: "NOL" };
assert.equal(filterContext.b2bMapFilteredRows(filterRows).length, 4, "boundary, category, and platform filters must share one row model");

const counts = filterContext.b2bMapLocationCounts(filterRows);
assert.equal(counts.mappable, 3);
assert.equal(counts.unresolved, 5);
for (const status of expectedStatuses) assert.equal(counts[status], 1, `${status} count mismatch`);

const duplicateContext = {};
vm.createContext(duplicateContext);
vm.runInContext(functionSource(app, "mapDuplicateLayout"), duplicateContext);
const duplicateRows = duplicateContext.mapDuplicateLayout([
  { key: "a", coordinate: { lon: 127.123456, lat: 37.123456 } },
  { key: "b", coordinate: { lon: 127.1234561, lat: 37.1234561 } },
  { key: "c", coordinate: { lon: 128.1, lat: 36.1 } },
  { key: "missing", coordinate: null },
]);
assert.equal(duplicateRows[0].duplicateCount, 2);
assert.equal(duplicateRows[1].duplicateCount, 2);
assert.equal(duplicateRows[0].duplicateIndex, 0);
assert.equal(duplicateRows[1].duplicateIndex, 1);
assert.notEqual(duplicateRows[0].duplicateOffsetX, duplicateRows[1].duplicateOffsetX);
assert.equal(duplicateRows[2].duplicateCount, 1);
assert.equal(duplicateRows[2].duplicateOffsetX, 0);
assert.equal(duplicateRows[3].duplicateCount, 0);
assert.equal(duplicateRows[3].duplicateIndex, -1);

const regionMarkerContext = {
  coordinateFromValue: (region) => region.coordinate || null,
  optionalNumber: (value) => value === null || value === undefined || value === "" ? Number.NaN : Number(value),
};
vm.createContext(regionMarkerContext);
for (const name of ["project", "svgLabelLines", "svgLabelBox", "svgLabelBoxesOverlap", "regionMapMarkerModels"]) {
  vm.runInContext(functionSource(app, name), regionMarkerContext);
}
const denseRegionModels = regionMarkerContext.regionMapMarkerModels([
  { name: "창원시 의창구", placeCount: 40, coordinate: { lon: 127.48, lat: 36.52 } },
  { name: "창원시 성산구", placeCount: 30, coordinate: { lon: 127.49, lat: 36.51 } },
  { name: "창원시 마산합포구", placeCount: 20, coordinate: { lon: 127.50, lat: 36.50 } },
  { name: "창원시 진해구", placeCount: 10, coordinate: { lon: 127.51, lat: 36.49 } },
], { minLon: 127, maxLon: 128, minLat: 36, maxLat: 37 });
assert.equal(denseRegionModels.length, 4);
for (const model of denseRegionModels) {
  assert.ok(model.radius >= 8 && model.radius <= 10, "region spots must remain compact");
  assert.ok(model.labelLines.length <= 2, "region labels must use at most two lines");
}
const visibleRegionBoxes = denseRegionModels.filter((model) => model.labelVisible).map((model) => (
  regionMarkerContext.svgLabelBox(model.labelX, model.labelY, model.textAnchor, model.labelLines)
));
for (let left = 0; left < visibleRegionBoxes.length; left += 1) {
  for (let right = left + 1; right < visibleRegionBoxes.length; right += 1) {
    assert.equal(regionMarkerContext.svgLabelBoxesOverlap(visibleRegionBoxes[left], visibleRegionBoxes[right]), false, "visible region labels must not collide");
  }
}

const companyMarkerContext = {};
vm.createContext(companyMarkerContext);
for (const name of ["project", "svgLabelLines", "svgLabelBox", "svgLabelBoxesOverlap", "mapDuplicateLayout", "companyMapMarkerModels"]) {
  vm.runInContext(functionSource(app, name), companyMarkerContext);
}
const denseCompanyModels = companyMarkerContext.companyMapMarkerModels(
  Array.from({ length: 8 }, (_, index) => ({
    rank: index + 1,
    coordinate: { lon: 127.48 + index * 0.004, lat: 36.52 - index * 0.003 },
    item: { name: `${index + 1}위 아주 긴 업체명 지도 충돌 검수` },
    duplicateOffsetX: 0,
    duplicateOffsetY: 0,
  })),
  { minLon: 127, maxLon: 128, minLat: 36, maxLat: 37 },
);
assert.equal(denseCompanyModels.length, 8);
assert.equal(denseCompanyModels[0].labelVisible, true, "the highest rank must receive first label priority");
assert.ok(denseCompanyModels.filter((model) => model.labelVisible).length <= 5, "only non-colliding top-five labels may be visible");
assert.equal(denseCompanyModels.some((model) => model.rank > 5 && model.labelLines.length), false, "ranks below the top five must remain marker-only");
const visibleCompanyBoxes = denseCompanyModels.filter((model) => model.labelVisible).map((model) => (
  companyMarkerContext.svgLabelBox(
    model.x + model.labelX,
    model.y + model.labelY,
    model.labelAnchor,
    model.labelLines,
  )
));
for (let left = 0; left < visibleCompanyBoxes.length; left += 1) {
  for (let right = left + 1; right < visibleCompanyBoxes.length; right += 1) {
    assert.equal(
      companyMarkerContext.svgLabelBoxesOverlap(visibleCompanyBoxes[left], visibleCompanyBoxes[right], 6),
      false,
      "visible company labels must not collide",
    );
  }
}

const markerHitContext = {};
vm.createContext(markerHitContext);
vm.runInContext(functionSource(app, "companyMapHitRadius"), markerHitContext);
const halfScaleSvg = {
  getBoundingClientRect: () => ({ width: 360, height: 310 }),
  viewBox: { baseVal: { width: 720, height: 620 } },
};
const mobileHitRadius = markerHitContext.companyMapHitRadius(halfScaleSvg);
assert.equal(mobileHitRadius, 45);
assert.equal(mobileHitRadius * 2 * 0.5, 45, "mobile SVG hit target must retain a rounding margin above 44 CSS pixels");
assert.equal(markerHitContext.companyMapHitRadius({
  getBoundingClientRect: () => ({ width: 720, height: 620 }),
  viewBox: { baseVal: { width: 720, height: 620 } },
}), 22.5);
assert.match(functionBlock(app, "syncCompanyMapHitTargets"), /querySelectorAll\?\.\("\.company-map-hit"\)/);
assert.match(functionBlock(app, "observeCompanyMapHitTargets"), /new ResizeObserver/);
assert.match(functionBlock(app, "observeCompanyMapHitTargets"), /addEventListener\("resize", scheduleSync/);
assert.match(functionBlock(app, "observeCompanyMapHitTargets"), /syncCompanyMapHitTargets\(\)/);
assert.match(functionBlock(app, "init"), /observeCompanyMapHitTargets\(\)/);

const categoryContext = {};
vm.createContext(categoryContext);
vm.runInContext(`${constantSource(app, "LODGING_CATEGORY_PROFILES")} this.LODGING_CATEGORY_PROFILES = LODGING_CATEGORY_PROFILES;`, categoryContext);
vm.runInContext(functionSource(app, "compactSearchText"), categoryContext);
vm.runInContext(functionSource(app, "knownLodgingCategoryKey"), categoryContext);
assert.equal(categoryContext.knownLodgingCategoryKey("펜션"), "pension");
assert.equal(categoryContext.knownLodgingCategoryKey("future-unknown-category"), "");

const rankContext = {
  companyKey: (value) => String(value || "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, ""),
};
vm.createContext(rankContext);
for (const name of ["b2bMapExplicitOverallRank", "b2bMapCompanyIdentityKey", "b2bMapOverallRows"]) {
  vm.runInContext(functionSource(app, name), rankContext);
}
const rankFixtures = [
  { placeId: "no-source", overallRank: 1 },
  { placeId: "regional", overallRank: 1, regionalRank: 1, rankingSource: "regional" },
  { placeId: "ad", overallRank: 1, adRank: 1, rankingSource: "ad" },
  { placeId: "rank-only", rank: 1, rankingSource: "overall" },
  { placeId: "over", overallRank: 21, rankingSource: "overall" },
  { placeId: "b", overallRank: 4, rank: 1, rankingSource: "overall" },
  { placeId: "a", overallRank: 8, rankingSource: "overall" },
  { placeId: "a", overallRank: 2, rank: 99, rankingSource: "overall" },
  { placeId: "c", overallRank: "4", rankingSource: "naver_overall" },
  { placeId: "decimal", overallRank: 2.5, rankingSource: "overall" },
];
const rankFixtureSnapshot = JSON.stringify(rankFixtures);
const mapRows = rankContext.b2bMapOverallRows(rankFixtures, "", 20);
const markerRows = mapRows.filter((row) => row.mapRankEligible);
assert.equal(markerRows.map((row) => `${row.rank}:${row.identityKey}`).join(","), "2:place:a,4:place:b,4:place:c");
assert.equal(markerRows[0].sourceIndex, 7, "duplicate companies must retain the current run's best explicit rank row");
assert.equal(mapRows.find((row) => row.identityKey === "place:rank-only").rank, null, "generic rank must never become a map rank");
assert.equal(mapRows.find((row) => row.identityKey === "place:regional").rank, null, "regional rank must remain list-only");
assert.equal(mapRows.find((row) => row.identityKey === "place:ad").rank, null, "ad rank must remain list-only");
assert.equal(JSON.stringify(rankFixtures), rankFixtureSnapshot, "map rank projection must not mutate API data");
assert.equal(rankContext.b2bMapExplicitOverallRank({ overallRank: 3 }, "naver_overall"), 3, "the current run's overall source may authorize an item without a duplicate source label");
assert.equal(rankContext.b2bMapExplicitOverallRank({ overallRank: 3, rankingSource: "regional" }, "naver_overall"), null, "an explicit non-overall item source must fail closed");
const topTwenty = rankContext.b2bMapOverallRows(
  Array.from({ length: 25 }, (_, index) => ({ placeId: `p-${index + 1}`, overallRank: index + 1, rankingSource: "overall" })),
  "naver_overall",
  20,
).filter((row) => row.mapRankEligible);
assert.equal(topTwenty.length, 20);
assert.equal(topTwenty[0].rank, 1);
assert.equal(topTwenty.at(-1).rank, 20);

const pointRowsBlock = functionBlock(app, "companyMapPointRows");
assert.match(pointRowsBlock, /b2bMapOverallRows\(sourceItems, state\.data\?\.ranking\?\.source, 20\)/);
assert.match(pointRowsBlock, /rank:\s*mapRow\.rank/);
assert.match(pointRowsBlock, /mapRankEligible:\s*mapRow\.mapRankEligible/);
assert.match(pointRowsBlock, /providerIndex:\s*row\.sourceIndex/);
assert.doesNotMatch(pointRowsBlock, /b2bRankBoardModel\(\)\.rows|sourceItems\.indexOf|index\s*\+\s*1/);
assert.match(pointRowsBlock, /coordinateStatusFromValue\(row\.item\)/);
assert.match(pointRowsBlock, /categoryKeys/);
assert.match(pointRowsBlock, /explicitPrimaryCategory[\s\S]*?knownLodgingCategoryKey\(explicitPrimaryCategory\)/);
assert.match(pointRowsBlock, /categoryTags\.map\(knownLodgingCategoryKey\)/);
assert.match(pointRowsBlock, /primaryCategoryKey \? lodgingCategoryProfile\(primaryCategoryKey\)\.label : "유형 미확인"/);
assert.doesNotMatch(pointRowsBlock, /categoryTags[\s\S]*?map\(normalizeLodgingCategoryKey\)/);
assert.match(pointRowsBlock, /platformNames/);
assert.match(pointRowsBlock, /coordinate:\s*coordinateProfile\.coordinate/);
assert.doesNotMatch(pointRowsBlock, /regionForCompanyMapItem|regionCoordinate|regions\s*\[\s*0\s*\]|fallback/i);
assert.equal(
  [...app.matchAll(/\bregionForCompanyMapItem\s*\(/g)].length,
  1,
  "the legacy region matcher may remain defined temporarily but must never place a company marker",
);

const renderMapBlock = functionBlock(app, "renderMap");
assert.match(renderMapBlock, /const companyPoints = b2bMapFilteredRows\(allCompanyPoints\)/);
assert.match(renderMapBlock, /renderB2BMapCompanyList\(companyPoints\)/);
assert.match(renderMapBlock, /renderB2BMapViewControls\(allCompanyPoints, companyPoints\)/);
assert.match(renderMapBlock, /const markerCompanyPoints = companyPoints\.filter\(\(row\) => row\.mapRankEligible && row\.coordinate\)/);
assert.match(renderMapBlock, /companyMapMarkerModels\(markerCompanyPoints, bounds\)/);
assert.match(renderMapBlock, /regionMapMarkerModels\(/);
assert.doesNotMatch(renderMapBlock, /<circle r="17"/);
assert.doesNotMatch(renderMapBlock, /finiteNumber\(row\.rank,\s*row\.index\s*\+\s*1\)/);
assert.doesNotMatch(renderMapBlock, /name\.slice\(0,\s*10\)/);
assert.match(renderMapBlock, /네이버 메인 유기순위/);
assert.match(renderMapBlock, /rank <= 3 \? "top" : rank <= 10 \? "mid" : "base"/);
assert.match(renderMapBlock, /row\.labelVisible/);
assert.match(renderMapBlock, /text-anchor="\$\{row\.labelAnchor\}"/);
assert.match(renderMapBlock, /company-map-dot-approximate/);
assert.match(renderMapBlock, /company-map-duplicate/);
assert.match(renderMapBlock, /companyMapHitRadius\(\)/);
assert.match(renderMapBlock, /company-map-duplicate-leader/);
assert.match(renderMapBlock, /company-map-duplicate-anchor/);
assert.match(renderMapBlock, /data-b2b-map-select/);
assert.match(renderMapBlock, /tabindex="0" role="button" aria-pressed=/);
assert.match(renderMapBlock, /company-map-hit" r="\$\{companyMarkerHitRadius\.toFixed\(1\)\}"/);
assert.doesNotMatch(renderMapBlock, /regionForCompanyMapItem|fallbackCompanyCoordinate|estimated/i);

const mapLegendBlock = functionBlock(app, "renderMapControls");
assert.match(mapLegendBlock, /네이버 순위 업체/);
assert.match(mapLegendBlock, /map-legend-disclosure/);
assert.match(mapLegendBlock, /map-legend-grid/);
assert.equal((mapLegendBlock.match(/\["(?:search|company|approximate|missing)"/g) || []).length, 4, "the primary map legend must remain compact");

const mapControlsBlock = functionBlock(app, "renderB2BMapViewControls");
assert.match(mapControlsBlock, /role="group" aria-label=/);
assert.match(mapControlsBlock, /id="b2bMapLocationStatus"/);
assert.match(mapControlsBlock, /id="b2bMapBoundary"/);
assert.match(mapControlsBlock, /id="b2bMapCategory"/);
assert.match(mapControlsBlock, /id="b2bMapPlatform"/);
assert.match(mapControlsBlock, /locationStatus === "located"/);
assert.match(mapControlsBlock, /locationStatus === "approximate"/);
assert.match(mapControlsBlock, /locationStatus === "unresolved"/);
assert.match(mapControlsBlock, /counts\.verified \+ counts\.resolved/);
assert.match(mapControlsBlock, /counts\.approximate/);
assert.match(mapControlsBlock, /counts\.unresolved/);
assert.match(mapControlsBlock, /row\.mapRankEligible && row\.coordinate/);
assert.match(mapControlsBlock, /네이버 메인 유기순위/);
assert.match(mapControlsBlock, /지도 상위 20위/);
assert.match(mapControlsBlock, /data-b2b-map-geocode/);
assert.match(mapControlsBlock, /좌표는 저장·캐시하지 않고 이번 화면에서만 사용/);
assert.match(mapControlsBlock, /지역 중심.*업체 위치로 대체하지 않습니다/);
assert.match(mapControlsBlock, /const geocodingAllowed = canUseB2BMapTransientGeocoding\(\)/);
assert.match(mapControlsBlock, /const adminPreviewAttempted = adminPreviewLookup[\s\S]*state\.b2bMapAdminPreviewGeocodingAttemptedRunId === state\.activeRunId/);
assert.match(mapControlsBlock, /geocodingBusy \|\| adminPreviewAttempted \|\| !geocodingAllowed \|\| !lookupCandidates\.length/);
assert.match(mapControlsBlock, /관리자 Preview 전용입니다/);
assert.match(mapControlsBlock, /외부 조회 ·/);
assert.match(mapControlsBlock, /네이버 위치 확인 완료/);
assert.match(mapControlsBlock, /aria-describedby="b2bMapGeocodeHelp"/);

const transientLookupBlock = functionBlock(app, "loadNaverMapLocationsForDisplay");
assert.match(transientLookupBlock, /canUseB2BMapTransientGeocoding\(\)/);
assert.match(transientLookupBlock, /adminPreviewLookup \? 18 : 25/);
assert.match(transientLookupBlock, /await requestPreviewGeocodeConfirmation\(itemIndexes\.length\)/);
assert.doesNotMatch(transientLookupBlock, /window\.confirm\(/);
assert.match(transientLookupBlock, /state\.b2bMapAdminPreviewGeocodingAttemptedRunId = state\.activeRunId/);
assert.match(transientLookupBlock, /requestContext: adminPreviewLookup \? "admin-user-view" : "b2b-map"/);
assert.match(transientLookupBlock, /explicitConsent: true/);
assert.match(transientLookupBlock, /fetchJson\("\/api\/b2b-map\/geocode"/);
assert.match(transientLookupBlock, /method:\s*"POST"/);
assert.match(transientLookupBlock, /cache:\s*"no-store"/);
assert.match(transientLookupBlock, /JSON\.stringify\(\{[\s\S]*runId: state\.activeRunId,[\s\S]*itemIndexes/);
assert.doesNotMatch(transientLookupBlock, /localStorage|sessionStorage|indexedDB|caches\./i);
assert.doesNotMatch(transientLookupBlock, /address\s*:/i, "the browser must not submit a raw address to the provider endpoint");
assert.match(transientLookupBlock, /result\?\.usage !== "single-display"/);
assert.match(transientLookupBlock, /result\?\.cacheable !== false/);
assert.match(transientLookupBlock, /result\?\.persistable !== false/);
assert.match(transientLookupBlock, /state\.b2bMapTransientLocations = next/);
assert.match(transientLookupBlock, /row\.mapRankEligible/);
assert.doesNotMatch(transientLookupBlock, /providerKey|providerCalls|providerCall/);
assert.match(transientLookupBlock, /coordinateStatusFromValue/);
assert.match(transientLookupBlock, /NAVER_GEOCODING_RATE_LIMITED/);
assert.match(transientLookupBlock, /NAVER_GEOCODING_TRANSPORT_ERROR/);
assert.doesNotMatch(transientLookupBlock, /error\?\.message/, "provider or proxy diagnostics must not be rendered in the map UI");
assert.match(functionBlock(app, "loadRun"), /state\.b2bMapTransientLocations = \{\}/);
assert.match(functionBlock(app, "loadB2BHistoryRun"), /state\.b2bMapTransientLocations = \{\}/);

const previewGeocodeConfirmationBlock = functionBlock(app, "requestPreviewGeocodeConfirmation");
assert.match(previewGeocodeConfirmationBlock, /previewGeocodeConfirmCount\.textContent/);
assert.match(previewGeocodeConfirmationBlock, /openAccessibleOverlay\(els\.previewGeocodeConfirm/);
assert.match(previewGeocodeConfirmationBlock, /data-preview-geocode-choice='cancel'/);
assert.match(functionBlock(app, "closePreviewGeocodeConfirmation"), /closeAccessibleOverlay\(els\.previewGeocodeConfirm, \{ restoreFocus: false \}\)/);
assert.match(functionBlock(app, "handleAccessibleOverlayKeydown"), /overlay === els\.previewGeocodeConfirm[\s\S]*closePreviewGeocodeConfirmation\(false\)/);
assert.match(html, /id="previewGeocodeConfirm" hidden/);
assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="previewGeocodeConfirmTitle" aria-describedby="previewGeocodeConfirmDescription"/);
assert.match(html, /data-preview-geocode-choice="cancel"/);
assert.match(html, /data-preview-geocode-choice="confirm"/);
assert.match(html, /id="b2bMapStatus" role="status" aria-live="polite" tabindex="-1"/);
assert.match(transientLookupBlock, /data-b2b-map-geocode.*not\(\[disabled\]\).*focus/);
assert.match(transientLookupBlock, /els\.b2bMapStatus\?\.focus/);

const listBlock = functionBlock(app, "renderB2BMapCompanyList");
assert.match(listBlock, /role="list" aria-labelledby=/);
assert.match(listBlock, /role="listitem"/);
assert.match(listBlock, /data-location-status="\$\{escapeHtml\(row\.coordinateStatus\)\}"/);
assert.match(listBlock, /data-b2b-map-company-key/);
assert.match(listBlock, /data-b2b-map-select/);
assert.match(listBlock, /aria-pressed=/);
assert.match(listBlock, /row\.coordinateAddress \|\| itemLocationLine\(row\.item\)/);
assert.match(listBlock, /row\.coordinateIcon/);
assert.match(listBlock, /row\.coordinateLabel/);
assert.match(listBlock, /네이버 메인 순위 미수집/);
assert.match(listBlock, /data-open-company="\$\{row\.itemIndex\}" data-b2b-map-company-key/);

assert.match(functionBlock(app, "syncB2BMapSelectionDom"), /aria-pressed/);
assert.match(functionBlock(app, "syncB2BMapSelectionDom"), /aria-current/);
assert.match(functionBlock(app, "selectB2BMapCompany"), /trigger\?\.focus\?\./);
assert.match(functionBlock(app, "selectB2BMapCompany"), /returnFocusKey:[\s\S]*returnFocusSurface:/);
assert.match(functionBlock(app, "closeSheet"), /document\.querySelectorAll\("\[data-b2b-map-select\]"\)/);
assert.match(functionBlock(app, "closeSheet"), /returnFocusSurface === "marker"/);
assert.match(functionBlock(app, "closeSheet"), /preferred \|\| matching\[0\]/);
assert.match(functionBlock(app, "loadRuns"), /!isAdminRole\(\) && !isAdminUserViewMode\(\)/);
assert.match(functionBlock(app, "init"), /else if \(isAdminUserViewMode\(\)\)[\s\S]*await loadRuns\(false\)/);
const bindEventsBlock = functionBlock(app, "bindEvents");
assert.match(bindEventsBlock, /data-b2b-map-view/);
assert.match(bindEventsBlock, /data-b2b-map-geocode/);
assert.match(bindEventsBlock, /data-b2b-map-select/);
assert.match(bindEventsBlock, /#b2bMapLocationStatus/);
assert.match(bindEventsBlock, /#b2bMapBoundary/);
assert.match(bindEventsBlock, /#b2bMapCategory/);
assert.match(bindEventsBlock, /#b2bMapPlatform/);
assert.match(bindEventsBlock, /renderMap\(\)\.then/);
assert.match(bindEventsBlock, /\.company-map-marker\[data-b2b-map-select\]/);
assert.match(bindEventsBlock, /event\.key === "Enter" \|\| event\.key === " "/);

const locationPanelBlock = functionBlock(app, "renderB2BLocationPanel");
assert.match(locationPanelBlock, /coordinateStatusFromValue\(item\)/);
assert.match(locationPanelBlock, /data-location-status="\$\{escapeHtml\(profile\.status\)\}"/);
assert.match(locationPanelBlock, /aria-labelledby="b2bSheetLocationTitle"/);
assert.match(locationPanelBlock, /aria-hidden="true"/);
assert.match(locationPanelBlock, /profile\.displayAddress \|\| itemLocationLine\(item\)/);
assert.match(locationPanelBlock, /profile\.precision/);
assert.match(locationPanelBlock, /profile\.source/);
assert.match(locationPanelBlock, /profile\.geocodedAt/);
assert.match(locationPanelBlock, /임의 위치를 표시하지 않습니다/);
assert.doesNotMatch(locationPanelBlock, /kakao|naver|google|mapbox/i);
assert.match(functionBlock(app, "renderSheet"), /renderB2BLocationPanel\(item\)/);

assert.match(openingTagById("mapPanel"), /aria-label=/);
assert.match(openingTagById("clusterMap"), /role="group"[^>]*aria-label=/);
assert.match(openingTagById("b2bMapStatus"), /role="status"[^>]*aria-live="polite"/);
assert.match(openingTagById("b2bMapCompanyList"), /aria-label=/);

assert.match(app, /const LOCAL_MAP_URL = "\/assets\/korea_municipalities\.geojson"/);
const loadLocalMapBlock = functionBlock(app, "loadLocalMap");
assert.match(loadLocalMapBlock, /fetch\(LOCAL_MAP_URL\)/);
assert.doesNotMatch(loadLocalMapBlock, /https?:\/\//i);
for (const block of [pointRowsBlock, renderMapBlock, mapControlsBlock, listBlock, locationPanelBlock]) {
  assert.doesNotMatch(block, /https?:\/\//i, "map UI must not call an external provider URL");
}

assert.match(server, /locationCandidateFromObservation\s*\(/);
assert.match(server, /location:\s*publicCompanyLocationSummary\(company\)/);
assert.match(server, /req\.method === "POST" && reqUrl\.pathname === "\/api\/b2b-map\/geocode"/);
assert.match(server, /const ADMIN_PREVIEW_MAP_GEOCODING_MAX = 18/);
assert.match(server, /const adminPreviewMapGeocodingAttempts = new Set\(\)/);
assert.match(server, /const sessionRole = String\(session\?\.role \|\| ""\)\.trim\(\)\.toLowerCase\(\)/);
assert.match(server, /\[USER_ROLES\.admin, USER_ROLES\.b2b\]\.includes\(sessionRole\)/);
assert.match(server, /const adminPreviewRequest = isAdminPreviewMapGeocodingRequest\(sessionRole, payload\)/);
assert.match(server, /payload\?\.requestContext === "admin-user-view"/);
assert.match(server, /payload\?\.explicitConsent === true/);
assert.match(server, /!validAdminPreviewMapGeocodingIndexes\(payload\.itemIndexes\)/);
assert.match(server, /application\\\/json/);
assert.match(server, /!isSameOriginMapGeocodingRequest\(req\)/);
assert.match(server, /memberMatchesSession\(entry, session\)/);
assert.match(server, /Pragma:\s*"no-cache"/);
assert.match(server, /"X-Naver-Maps-Usage":\s*"single-display"/);
assert.match(server, /"X-Naver-Maps-Requester":\s*adminPreviewRequest \? "admin-user-view" : "b2b"/);
assert.match(server, /previewAdminConditionalApis:[\s\S]*\/api\/b2b-map\/geocode[\s\S]*once-per-runtime-run/);
const serverLoadRunBlock = functionBlock(server, "loadRun");
assert.match(serverLoadRunBlock, /options\.skipTraffic === true\s*\? null\s*:\s*await enrichRegionsWithTraffic\(/);
const geocodeRouteStart = server.indexOf('if (req.method === "POST" && reqUrl.pathname === "/api/b2b-map/geocode")');
assert.notEqual(geocodeRouteStart, -1, "missing B2B map geocoding route");
const geocodeRouteEnd = server.indexOf('if (req.method === "GET" && reqUrl.pathname.startsWith("/api/member/runs/"))', geocodeRouteStart);
assert.notEqual(geocodeRouteEnd, -1, "missing route boundary after B2B map geocoding");
const geocodeRouteBlock = server.slice(geocodeRouteStart, geocodeRouteEnd);
assert.match(geocodeRouteBlock, /loadRun\(runId,\s*\{[\s\S]*?skipTraffic:\s*true/);
assert.match(geocodeRouteBlock, /const allowed = adminPreviewRequest[\s\S]*\? \(await listRuns\(\)\)\.some[\s\S]*: \(await readB2BSearchHistoryStore\(\)\)\.entries/);
assert.match(geocodeRouteBlock, /\(await listRuns\(\)\)\.some\(\(run\) => run\.id === runId\)/);
assert.match(geocodeRouteBlock, /isAdminPreviewMapGeocodingItemEligible\(item, rankingSource\)/);
assert.match(geocodeRouteBlock, /adminPreviewMapGeocodingAttempts\.has\(attemptKey\)/);
assert.match(geocodeRouteBlock, /adminPreviewMapGeocodingAttempts\.add\(attemptKey\)/);
assert.doesNotMatch(geocodeRouteBlock, /enrichRegionsWithTraffic|collectSearchAdMetric|collectDatalabTrend/);
assert.match(server, /request context such as NOL's `userLocation`[\s\S]*must never become an accommodation point/);
assert.match(geocodingContract, /const LOCATION_STATUSES = new Set\(\[[\s\S]*?"verified"[\s\S]*?"resolved"[\s\S]*?"approximate"[\s\S]*?"ambiguous"[\s\S]*?"not_found"[\s\S]*?"invalid"[\s\S]*?"pending"[\s\S]*?"error"/);
assert.match(geocodingContract, /const MAPPABLE_LOCATION_STATUSES = new Set\(\["verified", "resolved", "approximate"\]\)/);
assert.match(geocodingContract, /function publicCompanyLocationSummary/);

const { publicCompanyLocationSummary } = require(path.join(root, "scripts", "lodging_geocoding_contract.cjs"));
const { projectB2BPublicPayload } = require(path.join(root, "scripts", "runtime_security.cjs"));
const publicLocation = publicCompanyLocationSummary({
  manualCorrection: {
    active: true,
    location: {
      status: "verified",
      latitude: 37.5665,
      longitude: 126.978,
      precision: "rooftop",
      source: "manual",
      confidence: 1,
      geocodedAt: "2026-08-03T00:00:00.000Z"
    }
  },
  addresses: ["서울특별시 중구 세종대로 110"],
  location: {
    status: "verified",
    latitude: 37.5665,
    longitude: 126.978,
    precision: "rooftop",
    source: "manual",
    providerKey: "fixture-provider",
    confidence: 0.99,
    geocodedAt: "2026-08-03T00:00:00.000Z",
  },
});
assert.equal(publicLocation.status, "verified");
assert.equal(publicLocation.lat, 37.5665);
assert.equal(publicLocation.lon, 126.978);
assert.equal(publicLocation.crs, "EPSG:4326");
const projected = projectB2BPublicPayload({
  availability: {
    items: [{
      name: "Fixture Stay",
      location: {
        ...publicLocation,
        providerKey: "must-not-leak",
        addressFingerprint: "must-not-leak",
        rawResponse: "must-not-leak",
        apiKey: "must-not-leak",
      },
    }],
  },
});
const projectedLocation = projected.availability.items[0].location;
for (const field of ["status", "statusLabel", "lat", "lon", "precision", "source", "confidence", "resolvedAddress", "displayAddress", "geocodedAt"]) {
  assert.ok(Object.hasOwn(projectedLocation, field), `${field} must survive the B2B public projection`);
}
for (const field of ["providerKey", "addressFingerprint", "rawResponse", "apiKey"]) {
  assert.equal(Object.hasOwn(projectedLocation, field), false, `${field} must stay private`);
}
assert.match(runtimeSecurity, /B2B_PUBLIC_LOCATION_FIELDS[\s\S]*?"precision"[\s\S]*?"resolvedAddress"[\s\S]*?"displayAddress"[\s\S]*?"geocodedAt"/);
assert.doesNotMatch(runtimeSecurity, /B2B_PUBLIC_NESTED_FIELDS[\s\S]*?"providerKey"/);

const stage6Start = css.indexOf("/* Stage 6 B2B competition, map, demand, and account workbenches */");
const stage6End = css.indexOf("/* Dark transparent card contract v7", stage6Start);
assert.ok(stage6Start >= 0 && stage6End > stage6Start, "map CSS must remain inside the bounded Stage 6 contract");
const stage6Css = css.slice(stage6Start, stage6End);
for (const selector of [
  ".b2b-map-view-controls",
  ".b2b-map-transient-action",
  ".b2b-map-filter-fields",
  ".b2b-map-filter-summary",
  ".b2b-map-status",
  ".b2b-map-company-list",
  ".b2b-map-company-row",
  ".company-map-marker",
  ".company-map-hit",
  ".company-map-duplicate-leader",
  ".company-map-duplicate-anchor",
  ".company-map-marker.location-approximate",
  ".company-map-duplicate",
  ".b2b-sheet-location",
  ".b2b-sheet-location-details",
]) {
  assert.ok(stage6Css.includes(selector), `${selector} must have a semantic map-workbench style contract`);
}
assert.doesNotMatch(stage6Css, /#[0-9a-f]{3,8}\b/i, "map styles must use semantic theme tokens");
assert.doesNotMatch(stage6Css, /invert\s*\(|hue-rotate\s*\(/i);
assert.doesNotMatch(stage6Css, /!important/);
assert.match(stage6Css, /var\(--color-surface-default\)/);
assert.match(stage6Css, /var\(--color-surface-subtle\)/);
assert.match(stage6Css, /var\(--color-text-primary\)/);
assert.match(stage6Css, /var\(--color-text-secondary\)/);
assert.match(stage6Css, /var\(--color-border-focus\)/);
assert.match(stage6Css, /\.company-map-marker\.location-approximate \.company-map-dot\s*\{[\s\S]*?fill:\s*var\(--color-status-warning\)[\s\S]*?stroke-dasharray:/);
assert.match(stage6Css, /\.company-map-duplicate circle\s*\{[\s\S]*?fill:\s*var\(--color-surface-raised\)[\s\S]*?stroke:\s*var\(--color-border-focus\)/);
assert.match(stage6Css, /\.company-map-duplicate-leader\s*\{[\s\S]*?pointer-events:\s*none[\s\S]*?stroke:\s*var\(--color-border-strong\)/);
assert.match(stage6Css, /\.company-map-duplicate-anchor\s*\{[\s\S]*?fill:\s*var\(--color-surface-raised\)[\s\S]*?stroke:\s*var\(--color-border-focus\)/);
assert.match(stage6Css, /\.b2b-map-company-row\.is-selected\s*\{[\s\S]*?outline:\s*3px solid var\(--color-border-focus\)/);
assert.match(stage6Css, /\.company-map-marker:is\(\.is-selected, :focus-visible\) \.company-map-hit/);
assert.match(stage6Css, /\.company-map-hit\s*\{[\s\S]*?fill:\s*transparent/);
assert.match(stage6Css, /\.b2b-map-company-row > button:first-child\s*\{[\s\S]*?min-height:\s*var\(--touch-target-min\)/);
assert.match(stage6Css, /\.b2b-map-company-row > div button\s*\{[\s\S]*?min-height:\s*var\(--touch-target-min\)/);
assert.match(stage6Css, /\.b2b-sheet-location-details :is\(dt, dd\)\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
assert.match(
  stage6Css,
  /@media \(max-width:\s*720px\)[\s\S]*?\.b2b-map-filter-fields,[\s\S]*?\.b2b-sheet-location-details\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/,
);
assert.match(stage6Css, /@media \(max-width:\s*390px\)/);
assert.match(stage6Css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /\.map-layer-row\s*\{[^}]*display:\s*grid[^}]*repeat\(4, minmax\(0, 1fr\)\)/s);
assert.match(css, /\.map-layer-row span,[\s\S]*?\.map-legend span\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s);
assert.match(css, /\.map-legend-disclosure > summary\s*\{[^}]*min-height:\s*44px/s);
assert.match(css, /\.map-legend-grid\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/s);
assert.match(stage6Css, /\.region-map-spot circle\s*\{[^}]*var\(--color-surface-raised\)/s);
assert.match(stage6Css, /\.company-map-marker\.rank-top \.company-map-halo\s*\{[^}]*stroke-width:\s*3/s);

console.log("B2B map workbench UI contract tests passed.");
