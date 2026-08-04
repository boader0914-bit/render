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
        precision: status === "approximate" ? "locality" : "rooftop",
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
assert.equal(coordinateContext.coordinateStatusFromValue({ longitude: 127.1, latitude: 37.5 }).status, "resolved");
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

const pointRowsBlock = functionBlock(app, "companyMapPointRows");
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
assert.match(renderMapBlock, /mapDuplicateLayout\(companyPoints\.filter\(\(row\) => row\.coordinate\)\)/);
assert.match(renderMapBlock, /company-map-dot-approximate/);
assert.match(renderMapBlock, /company-map-duplicate/);
assert.match(renderMapBlock, /companyMapHitRadius\(\)/);
assert.match(renderMapBlock, /company-map-duplicate-leader/);
assert.match(renderMapBlock, /company-map-duplicate-anchor/);
assert.match(renderMapBlock, /data-b2b-map-select/);
assert.match(renderMapBlock, /tabindex="0" role="button" aria-pressed=/);
assert.match(renderMapBlock, /company-map-hit" r="\$\{companyMarkerHitRadius\.toFixed\(1\)\}"/);
assert.match(renderMapBlock, /if \(centerRegion && region === centerRegion\) return ""/);
assert.doesNotMatch(renderMapBlock, /regionForCompanyMapItem|fallbackCompanyCoordinate|estimated/i);

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
assert.match(mapControlsBlock, /data-b2b-map-geocode/);
assert.match(mapControlsBlock, /좌표는 저장·캐시하지 않고 이번 화면에서만 사용/);
assert.match(mapControlsBlock, /지역 중심.*업체 위치로 대체하지 않습니다/);
assert.match(mapControlsBlock, /const geocodingReadOnly = isAdminRole\(\) \|\| isAdminUserViewMode\(\)/);
assert.match(mapControlsBlock, /geocodingBusy \|\| geocodingReadOnly \|\| !lookupCandidates\.length/);
assert.match(mapControlsBlock, /관리자 미리보기에서는 위치 조회를 실행할 수 없습니다/);
assert.match(mapControlsBlock, /aria-describedby="b2bMapGeocodeHelp"/);

const transientLookupBlock = functionBlock(app, "loadNaverMapLocationsForDisplay");
assert.match(transientLookupBlock, /isAdminRole\(\) \|\| isAdminUserViewMode\(\)/);
assert.match(transientLookupBlock, /fetchJson\("\/api\/b2b-map\/geocode"/);
assert.match(transientLookupBlock, /method:\s*"POST"/);
assert.match(transientLookupBlock, /cache:\s*"no-store"/);
assert.match(transientLookupBlock, /JSON\.stringify\(\{ runId: state\.activeRunId, itemIndexes \}\)/);
assert.doesNotMatch(transientLookupBlock, /localStorage|sessionStorage|indexedDB|caches\./i);
assert.doesNotMatch(transientLookupBlock, /address\s*:/i, "the browser must not submit a raw address to the provider endpoint");
assert.match(transientLookupBlock, /result\?\.usage !== "single-display"/);
assert.match(transientLookupBlock, /result\?\.cacheable !== false/);
assert.match(transientLookupBlock, /result\?\.persistable !== false/);
assert.match(transientLookupBlock, /state\.b2bMapTransientLocations = next/);
assert.match(functionBlock(app, "loadRun"), /state\.b2bMapTransientLocations = \{\}/);
assert.match(functionBlock(app, "loadB2BHistoryRun"), /state\.b2bMapTransientLocations = \{\}/);

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
assert.match(server, /normalizeUserRole\(session\.role\) !== USER_ROLES\.b2b/);
assert.match(server, /memberMatchesSession\(entry, session\)/);
assert.match(server, /Pragma:\s*"no-cache"/);
assert.match(server, /"X-Naver-Maps-Usage":\s*"single-display"/);
const serverLoadRunBlock = functionBlock(server, "loadRun");
assert.match(serverLoadRunBlock, /options\.skipTraffic === true\s*\? null\s*:\s*await enrichRegionsWithTraffic\(/);
const geocodeRouteStart = server.indexOf('if (req.method === "POST" && reqUrl.pathname === "/api/b2b-map/geocode")');
assert.notEqual(geocodeRouteStart, -1, "missing B2B map geocoding route");
const geocodeRouteEnd = server.indexOf('if (req.method === "GET" && reqUrl.pathname.startsWith("/api/member/runs/"))', geocodeRouteStart);
assert.notEqual(geocodeRouteEnd, -1, "missing route boundary after B2B map geocoding");
const geocodeRouteBlock = server.slice(geocodeRouteStart, geocodeRouteEnd);
assert.match(geocodeRouteBlock, /loadRun\(runId,\s*\{[\s\S]*?skipTraffic:\s*true/);
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

console.log("B2B map workbench UI contract tests passed.");
