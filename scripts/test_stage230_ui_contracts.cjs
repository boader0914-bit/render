"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./test_support/stage230_test_helpers.cjs");

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

const app = read("apps/web/src/App.tsx");
const index = read("apps/web/index.html");
const runtimeFlags = read("apps/web/src/runtimeFlags.ts");
const registry = read("apps/web/src/routeRegistry.ts");
const client = read("apps/web/src/strategy/stage230Client.ts");
const hook = read("apps/web/src/strategy/useStage230Workspace.ts");
const pages = read("apps/web/src/strategy/Stage230Pages.tsx");
const css = read("apps/web/src/app.css");
const reportPage = read("apps/web/src/reporting/Stage229Pages.tsx");

const routes = {
  "business-strategy": "/app/strategy",
  "business-execution": "/app/execution",
  "business-retrospective": "/app/retrospective"
};
for (const [routeId, routePath] of Object.entries(routes)) {
  assert.match(
    registry,
    new RegExp(`id:\\s*["']${routeId}["'][\\s\\S]{0,240}?path:\\s*["']${routePath.replaceAll("/", "\\/")}["']`),
    `${routeId} must remain in the single route registry`
  );
  assert.ok(client.includes(`"${routeId}"`), `${routeId} must be part of the Stage 230 client contract`);
}
assert.equal((registry.match(/role:\s*"business"/g) || []).length, 9, "Stage 230 must reuse the existing nine-item business navigation");
assert.equal((registry.match(/role:\s*"admin"/g) || []).length, 13, "Stage 230 must preserve the existing thirteen-item admin navigation");
for (const routeId of ["admin-strategy", "admin-execution", "admin-retrospective"]) {
  assert.ok(client.includes(`"${routeId}"`), `missing admin composite view ${routeId}`);
}
assert.match(client, /export function isStage230Route[\s\S]*?STAGE230_ROUTE_IDS/);
assert.match(app, /isStage230Route\(route\.id\)/);
assert.match(app, /route\.id === "admin-stage-review" \? adminStage230Route\(window\.location\.search\)/);
assert.match(app, /<Stage230RoutePage[\s\S]*?routeId=\{stage230Active\}/);

const flagContract = [
  ["STRATEGY_META_NAME", "lodging-v2-strategy-enabled", "strategyEnabled", "__V2_STRATEGY_ENABLED__"],
  ["EXECUTION_META_NAME", "lodging-v2-execution-enabled", "executionEnabled", "__V2_EXECUTION_ENABLED__"],
  ["RETROSPECTIVE_META_NAME", "lodging-v2-retrospective-enabled", "retrospectiveEnabled", "__V2_RETROSPECTIVE_ENABLED__"]
];
for (const [constant, meta, reader, marker] of flagContract) {
  assert.match(runtimeFlags, new RegExp(`${constant}\\s*=\\s*["']${meta}["']`));
  assert.match(runtimeFlags, new RegExp(`function ${reader}\\([\\s\\S]{0,160}?explicitRuntimeFlag\\(source, ${constant}\\)`));
  assert.ok(index.includes(`name="${meta}" content="${marker}"`), `missing ${meta} boot meta`);
}
assert.match(runtimeFlags, /trim\(\)\.toLowerCase\(\) === "true"/, "runtime flags require explicit true");
assert.doesNotMatch(runtimeFlags, /function strategyEnabled[\s\S]{0,180}?businessReportEnabled\(/, "strategy UI truth must not be inferred from the report flag");
assert.doesNotMatch(runtimeFlags, /function executionEnabled[\s\S]{0,180}?strategyEnabled\(/, "execution UI truth must not be inferred in the browser");
assert.doesNotMatch(runtimeFlags, /function retrospectiveEnabled[\s\S]{0,180}?executionEnabled\(/, "retrospective UI truth must not be inferred in the browser");
for (const reader of ["strategyEnabled", "executionEnabled", "retrospectiveEnabled"]) assert.ok(app.includes(`${reader}()`));

assert.match(client, /\/api\/integration\/strategy\/workspace\?/);
for (const endpoint of [
  "/api/integration/strategy/strategies/generate",
  "/api/integration/strategy/plans",
  "/api/integration/strategy/retrospectives"
]) assert.ok(client.includes(endpoint), `missing additive Stage 230 client endpoint ${endpoint}`);
assert.match(client, /plans\/\$\{encodeURIComponent\(id\(planId\)\)\}\/items/);
assert.match(client, /items\/\$\{encodeURIComponent\(id\(itemId\)\)\}\/kpis/);
assert.match(client, /retrospectives\/\$\{encodeURIComponent\(id\(retrospectiveId\)\)\}\/candidates/);
assert.doesNotMatch(`${client}\n${hook}\n${pages}`, /\/api\/(?:business\/report|business\/strategy|admin\/master-db|outputs)/, "Stage 230 UI must use only additive APIs");
assert.doesNotMatch(`${client}\n${hook}\n${pages}`, /\b(?:localStorage|sessionStorage|indexedDB)\b/, "Stage 230 must not create a browser-side operational store");

for (const state of ["not-published-report", "insufficient-confidence", "empty", "ready"]) {
  assert.ok(client.includes(`"${state}"`), `missing Stage 230 state ${state}`);
}
for (const label of ["공개된 월간 리포트가 필요합니다", "전략을 만들기에 신뢰도가 부족합니다", "아직 생성된 항목이 없습니다"]) assert.ok(pages.includes(label));
for (const testId of [
  "stage230-surface",
  "stage230-state",
  "stage230-metrics",
  "stage230-report-link",
  "stage230-strategy-card",
  "stage230-checklist",
  "stage230-kpi",
  "stage230-lineage",
  "stage230-board",
  "stage230-retrospective",
  "stage230-candidates"
]) assert.ok(pages.includes(`"${testId}"`), `missing stable UI contract ${testId}`);
for (const testId of ["stage230-admin-tabs", "stage230-admin-target"]) {
  assert.ok(pages.includes(`"${testId}"`), `missing admin Stage 230 contract ${testId}`);
}
assert.match(client, /function adminStage230Route[\s\S]*?admin-execution[\s\S]*?admin-retrospective[\s\S]*?admin-strategy/);
assert.match(client, /stage230AdminTargetReady[\s\S]*?filters\.companyId[\s\S]*?filters\.tenantCompanyId/);
assert.match(pages, /관리자 요청은 tenantCompanyId와 companyId를 명시/);
assert.match(pages, /\/admin\/stage-review\?\$\{query\.toString\(\)\}/);
assert.match(pages, /tenantCompanyId와 companyId가 모두 없으면 Stage 230 API를 호출하지 않고 fail closed/);

for (const domain of ["price", "channel", "product", "content", "leadtime"]) {
  assert.match(client, new RegExp(`["']${domain}["']`), `missing strategy domain ${domain}`);
}
for (const type of ["carryover", "repeat", "new"]) assert.match(client, new RegExp(`["']${type}["']`));
assert.match(pages, /상태[\s\S]*?담당자[\s\S]*?목표일/);
assert.match(pages, /value="overdue">지연/);
assert.match(pages, /value="this-week">이번 주/);
assert.match(pages, /KPI 미입력은 달성으로 간주하지 않으며/);
assert.match(pages, /이월·반복·신규 후보를 idempotent하게/);
assert.match(pages, /lineage/);
assert.match(pages, /role=\{value\.startsWith\("완료"\) \? "status" : "alert"\}/);
assert.match(client, /reportPath:\s*"\/app\/report"/);
assert.match(
  pages,
  /data-testid="stage230-report-link" href=\{admin \? "\/admin\/location" : workspace\.reportGate\.reportPath\}/,
  "report evidence link must remain role-safe for both the admin composite and business surface"
);
assert.match(reportPage, /href="\/app\/strategy"/, "published report must navigate to the Stage 230 strategy surface");

assert.match(css, /\.v2-stage230-[\w-]+[^\{]*:focus-visible[\s\S]*?outline:\s*2px/);
assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*?v2-stage230/);
for (const line of css.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith("{") && !line.startsWith("@"))) {
  assert.ok(
    line.startsWith(":root") || line.startsWith("body[data-v2-ui") || line.startsWith("[data-v2-ui-root]"),
    `Stage 230 app CSS leaked outside the V3 root: ${line}`
  );
}

const inspected = `${client}\n${hook}\n${pages}`;
assert.doesNotMatch(inspected, /\b(?:mapMarker|rankingSeries|connectorAdapter|quotaScheduler|realProvider)\b/i, "Stage 231 concepts must remain deferred");
assert.doesNotMatch(inspected, /https?:\/\/(?!example\.invalid)/i, "Stage 230 UI must not embed an external endpoint");

console.log("Stage 230 routes, independent flags, workflow, report navigation, accessibility and Stage 231 deferral UI contracts passed");
