"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./test_stage227_helpers.cjs");

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

const app = read("apps/web/src/App.tsx");
const index = read("apps/web/index.html");
const runtimeFlags = read("apps/web/src/runtimeFlags.ts");
const server = read("scripts/glamping_app_server.cjs");
const registry = read("apps/web/src/routeRegistry.ts");
const client = read("apps/web/src/reporting/stage229Client.ts");
const hook = read("apps/web/src/reporting/useStage229Workspace.ts");
const pages = read("apps/web/src/reporting/Stage229Pages.tsx");
const css = read("apps/web/src/app.css");
const clientTest = read("apps/web/src/reporting/stage229Client.test.ts");
const pagesTest = read("apps/web/src/reporting/Stage229Pages.test.ts");

const routes = {
  "business-report": "/app/report",
  "business-location": "/app/location",
  "admin-location": "/admin/location"
};
for (const [routeId, routePath] of Object.entries(routes)) {
  assert.match(
    registry,
    new RegExp(`id:\\s*["']${routeId}["'][\\s\\S]{0,240}?path:\\s*["']${routePath.replaceAll("/", "\\/")}["']`),
    `${routeId} must remain in the single route registry`
  );
  assert.ok(client.includes(`"${routeId}"`), `${routeId} must be part of the Stage 229 client contract`);
}
assert.match(client, /export function isStage229OnlyRoute[\s\S]*?business-report[\s\S]*?admin-location/);
assert.match(app, /if \(insightsEnabled && isStage229OnlyRoute\(routeId\)\)[\s\S]*?<Stage229RoutePage/);
assert.match(app, /case "business-location"[\s\S]*?<LocationCardPage[\s\S]*?insightsEnabled[\s\S]*?<Stage229RoutePage/);
assert.equal((app.match(/case "(?:business|admin)-[^"]+"/g) || []).length, 7, "Stage 227's seven case boundary must not be rewritten by Stage 229");

assert.match(index, /<meta name="lodging-v2-business-report-enabled" content="__V2_BUSINESS_REPORT_ENABLED__"/);
assert.match(index, /<meta name="lodging-v2-location-card-enabled" content="__V2_LOCATION_CARD_ENABLED__"/);
assert.match(runtimeFlags, /LOCATION_CARD_META_NAME\s*=\s*"lodging-v2-location-card-enabled"/);
assert.match(runtimeFlags, /BUSINESS_REPORT_META_NAME\s*=\s*"lodging-v2-business-report-enabled"/);
assert.match(runtimeFlags, /locationCardEnabled[\s\S]*?explicitRuntimeFlag/);
assert.match(runtimeFlags, /businessReportEnabled[\s\S]*?explicitRuntimeFlag/);
assert.match(runtimeFlags, /trim\(\)\.toLowerCase\(\) === "true"/, "the runtime flag must require explicit true");
assert.doesNotMatch(runtimeFlags, /locationCardEnabled[\s\S]{0,220}?businessReportEnabled\(/, "location UI truth must not be inferred from the report flag");
assert.doesNotMatch(runtimeFlags, /businessReportEnabled[\s\S]{0,220}?platformCoreEnabled\(/, "Stage 229 UI truth must not be inferred from the core flag");
assert.match(server, /"__V2_LOCATION_CARD_ENABLED__"[\s\S]{0,120}?INTEGRATION_FEATURE_FLAGS\.locationCard \? "true" : "false"/);
assert.match(server, /"__V2_BUSINESS_REPORT_ENABLED__"[\s\S]{0,120}?INTEGRATION_FEATURE_FLAGS\.businessReport \? "true" : "false"/);
assert.match(app, /const locationInsightsEnabled = locationCardEnabled\(\);[\s\S]{0,180}?const reportInsightsEnabled = businessReportEnabled\(\);/);
assert.match(app, /route\.id === "business-report"[\s\S]{0,100}?reportInsightsEnabled[\s\S]{0,120}?route\.id === "business-location" \|\| route\.id === "admin-location"[\s\S]{0,100}?locationInsightsEnabled/, "partial flag combinations must gate reports and location cards independently");

for (const testId of [
  "stage229-surface",
  "stage229-state",
  "stage229-readiness",
  "stage229-report-scopes",
  "stage229-forecast",
  "stage229-location-card",
  "stage229-location-scores",
  "stage229-lifecycle",
  "stage229-admin-actions",
  "stage229-audit",
  "stage229-report-location-link"
]) {
  assert.ok(pages.includes(`"${testId}"`), `Stage 229 surface is missing stable test id ${testId}`);
}
for (const [state, label] of [
  ["not-collected", "미수집"],
  ["collecting", "수집 중"],
  ["insufficient-data", "데이터 부족"],
  ["not-published", "미노출"],
  ["ready", "공개됨"]
]) {
  assert.ok(`${client}\n${pages}`.includes(`"${state}"`), `missing explicit state ${state}`);
  assert.ok(pages.includes(label), `missing Korean distinction label ${label}`);
}
assert.match(pages, /최소 반복 관측 전에는 예측값과 booking pace를 공개하지 않습니다/);
assert.match(pages, /과거 V2·Cluster 값으로 빈칸을 채우지 않습니다/);

for (const scope of ["national", "regional", "own", "anonymous-cohort"]) {
  assert.match(client, new RegExp(`["']${scope}["']`), `missing report scope ${scope}`);
  assert.match(pages, new RegExp(`["']${scope}["']`), `missing report rendering scope ${scope}`);
}
assert.match(client, /region:\s*"regional"/, "backend region scope must normalize to the UI regional label");
for (const score of ["tourism", "industry", "living-area", "accessibility", "interest", "ota", "leadtime"]) {
  assert.match(pages, new RegExp(`["']${score}["']`), `missing location dimension ${score}`);
}
assert.match(client, /catchment:\s*"living-area"/, "backend catchment dimension must normalize to the UI living-area label");

assert.match(client, /\/api\/integration\/insights\/workspace\?/);
assert.match(client, /view === "admin-location"[\s\S]*?query\.set\("companyId"/);
assert.match(client, /selectedCompanyId && view === "admin-location"/, "business views must never send an arbitrary companyId");
assert.match(client, /\/api\/integration\/insights\/location-cards/);
assert.match(client, /location-cards\/\$\{encodeURIComponent\(requireCardId\(cardId\)\)\}\/draft/, "draft creation and edits must use the backend /draft resource");
assert.match(client, /decision:\s*"submit"/);
assert.match(client, /decision:\s*"approve"/);
assert.match(client, /decision:\s*"request-changes"/);
assert.doesNotMatch(client, /location-cards\/\$\{encodeURIComponent\(requireCardId\(cardId\)\)\}\/(?:approve|changes-request|rollback)/, "the client must not invent unsupported card action routes");

assert.match(client, /SAFE_CTA_PATHS[\s\S]*?"\/app\/location"/);
assert.match(client, /locationCardPath[\s\S]*?=== "\/app\/location" \? "\/app\/location" : "\/app\/location"/);
assert.match(pages, /data-testid="stage229-report-location-link" href=\{report\.locationCardPath\}/);
assert.match(pagesTest, /href="\/app\/location"/);
assert.match(clientTest, /https:\/\/provider\.example\.invalid\/private[\s\S]*?toBe\("\/app\/location"\)/);

assert.match(client, /businessView && lifecycle !== "published"\) return null/);
assert.match(client, /businessView && \(state !== "ready" \|\| !publishedAt\)\) return null/);
assert.match(client, /subject:\s*businessView \? \{[\s\S]*?companyId:\s*""/);
assert.match(client, /subjects:\s*businessView \? \[\]/);
assert.match(client, /allowedActions:\s*businessView \? \[\]/);
assert.match(client, /audit:\s*businessView \? \[\]/);
assert.match(client, /RAW_PATH_PATTERN/);
assert.match(client, /SENSITIVE_TEXT_PATTERN/);
assert.doesNotMatch(`${client}\n${hook}\n${pages}`, /\b(?:localStorage|sessionStorage|indexedDB)\b/, "Stage 229 must not create a browser-side legacy data store");
assert.doesNotMatch(`${client}\n${hook}\n${pages}`, /\/api\/(?:business\/report|business\/region-card|admin\/master-db)/, "Stage 229 UI must use only the additive insights API");

assert.match(pages, /<label className="v2-insight-select">[\s\S]*?<select/);
assert.match(pages, /<label className="v2-insight-editor">[\s\S]*?<textarea/);
assert.match(pages, /aria-label="데이터 부족 사유"/);
assert.match(pages, /role=\{feedback\.startsWith\("완료"\) \? "status" : "alert"\}/);
assert.match(css, /\.v2-insight-editor textarea:focus-visible[\s\S]*?outline:\s*2px/);
assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*?\.v2-insight-scope-grid[\s\S]*?grid-template-columns:\s*1fr/);
for (const line of css.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith("{") && !line.startsWith("@"))) {
  assert.ok(
    line.startsWith(":root") || line.startsWith("body[data-v2-ui") || line.startsWith("[data-v2-ui-root]"),
    `Stage 229 app CSS leaked outside the V3 root: ${line}`
  );
}

const stage229UiSource = `${client}\n${hook}\n${pages}`;
assert.doesNotMatch(stage229UiSource, /\b(?:strategyRecommendation|executionPlan|monthlyActionPlan|kpiTarget|retrospective|nextMonthCandidate)\b/i, "Stage 230 UI concepts must remain deferred");

console.log("Stage 229 route, flag, state, business-safe, report-to-location, accessibility and responsive UI contracts passed");
