"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./test_stage227_helpers.cjs");

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const app = read("apps/web/src/App.tsx");
const registry = read("apps/web/src/routeRegistry.ts");
const pages = read("apps/web/src/core/CorePages.tsx");
const client = read("apps/web/src/core/coreClient.ts");
const hook = read("apps/web/src/core/useCoreWorkspace.ts");
const css = read("apps/web/src/app.css");

const targetRoutes = Object.freeze({
  "business-onboarding": "/app/onboarding",
  "business-activity": "/app/activity",
  "business-location": "/app/location",
  "admin-overview": "/admin/overview",
  "admin-companies": "/admin/companies",
  "admin-collection": "/admin/collection",
  "admin-settings": "/admin/settings"
});
for (const [id, routePath] of Object.entries(targetRoutes)) {
  assert.match(registry, new RegExp(`id:\\s*["']${id}["'][\\s\\S]{0,220}?path:\\s*["']${routePath.replaceAll("/", "\\/")}["']`), `${id} must stay in the single route registry`);
  assert.ok(app.includes(`"${id}"`), `${id} must be part of the Stage 227 target boundary`);
  assert.ok(app.includes(`case "${id}"`), `${id} must have an explicit role-safe page renderer`);
}
assert.equal((app.match(/case "(?:business|admin)-[^"]+"/g) || []).length, 7, "Stage 227 must implement exactly its seven target route surfaces");
for (const deferred of ["business-map", "business-strategy", "business-ranking", "admin-map", "admin-ranking"]) {
  assert.doesNotMatch(app, new RegExp(`case ["']${deferred}["']`), `${deferred} must remain deferred`);
}
assert.match(pages, /function DeferredPage[\s\S]*?Stage 227/);

const workspaceRender = app.slice(app.indexOf("function ProductWorkspace"));
const pageHeaderIndex = workspaceRender.indexOf("<PageHeader");
const metricsIndex = workspaceRender.indexOf('data-testid="core-metrics"');
const dataIndex = workspaceRender.indexOf('data-testid="core-data-section"');
assert.ok(pageHeaderIndex >= 0 && pageHeaderIndex < metricsIndex && metricsIndex < dataIndex, "every target uses the frozen PageHeader -> metrics -> data section structure");
assert.match(app, /data-testid="stage227-page"/);
assert.match(app, /data-route-id=\{route\.id\}/);
assert.match(app, /data-workspace-state=/);

for (const testId of [
  "onboarding-steps",
  "business-search-form",
  "job-progress",
  "fresh-company-results",
  "fresh-history",
  "fresh-interests",
  "location-card-form",
  "admin-recent-runs",
  "admin-connector-summary",
  "company-table",
  "company-detail",
  "admin-collection-form",
  "tourism-request-form",
  "connector-status"
]) {
  assert.ok(pages.includes(`"${testId}"`), `target surface is missing stable test id ${testId}`);
}

for (const state of ["loading", "permission", "unavailable", "error"]) {
  assert.match(app, new RegExp(`\\b${state}:|["']${state}["']`), `${state} UI state must be explicit`);
}
for (const state of ["empty", "ready", "partial"]) {
  assert.match(client, new RegExp(`["']${state}["']`), `${state} data state must be explicit`);
}
assert.match(client, /status === 403[\s\S]*?permission/);
assert.match(client, /status === 404 \|\| reason\.status === 503[\s\S]*?unavailable/);

const coreUiSource = `${client}\n${hook}\n${pages}`;
for (const oldApi of [
  "/api/b2b-search",
  "/api/member/search-history",
  "/api/member/interest-lodges",
  "/api/crawl",
  "/api/tourism-collection"
]) {
  assert.equal(coreUiSource.includes(oldApi), false, `Stage 227 UI must not call legacy API ${oldApi}`);
}
assert.doesNotMatch(coreUiSource, /(?:\/outputs\/|rawOutput|outputPath|sourcePath)/i);
assert.doesNotMatch(coreUiSource, /\blocalStorage\b/, "history and interests must not be stored in browser-local legacy state");
assert.match(client, /\/api\/integration\/core\/workspace/);
assert.match(client, /\/api\/integration\/core\/jobs/);
assert.match(client, /\/api\/integration\/core\/interests/);
assert.match(client, /\/api\/integration\/core\/location-card-requests/);
assert.match(client, /\/api\/integration\/core\/admin\/tourism-requests/);
assert.match(client, /lodging-v2-stage227-job:/, "only recoverable in-flight clientRequestId state may use sessionStorage");
assert.match(hook, /recoveredJobId\(kind\)/);
assert.match(hook, /readCoreJob\(id/);
assert.match(hook, /cancelCoreJob/);

for (const token of [".v2-core-content", ".v2-data-section", ".v2-job-card", ".v2-company-card", ".v2-connector-grid"]) {
  assert.ok(css.includes(token), `Stage 227 scoped style ${token} is required`);
}
for (const line of css.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith("{") && !line.startsWith("@"))) {
  assert.ok(
    line.startsWith(":root") || line.startsWith("body[data-v2-ui") || line.startsWith("[data-v2-ui-root]"),
    `Stage 227 app CSS leaked outside the V3 root: ${line}`
  );
}

assert.match(registry, /"\/b2b":\s*"\/app\/onboarding"/);
assert.match(registry, /"\/admin":\s*"\/admin\/overview"/);
assert.match(registry, /"\/view":\s*"role-home"/);
assert.equal((registry.match(/role: "business"/g) || []).length, 9);
assert.equal((registry.match(/role: "admin"/g) || []).length, 13);

console.log("Stage 227 target-route, page-order, state, additive-client and CSS-boundary UI contracts passed");
