"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "scripts", "glamping_app_server.cjs"), "utf8");
const intentScript = fs.readFileSync(path.join(root, "scripts", "lodging_search_intent.cjs"), "utf8");

assert.match(
  html,
  /<script src="\/lodging-search-intent\.js"><\/script>[\s\S]*<script src="\/app\.js\?v=v2-20260810-worker-application-date-range-v51"><\/script>/,
);
assert.doesNotMatch(html, /id="searchModeInput"/);
assert.match(html, /id="crawlSearchIntentHint"/);
assert.match(html, /id="b2bSearchIntentHint"/);
assert.match(app, /searchIntentMode:\s*"auto"/);
assert.match(app, /clientIntentPreview:\s*clientIntentPreview/);
assert.match(app, /preview\.intentSupported === false/);
assert.match(app, /function top20MaximumProviderCalls\(value = \{\}\)/u);
assert.doesNotMatch(app, /최대 201요청/u);
assert.match(server, /estimateBasis:[\s\S]*boundedInventory: top20BoundedInventory/);
assert.match(server, /resolveSearchIntentContract/);
assert.match(server, /assertSupportedSearchIntent/);
assert.match(server, /requestedSearchIntentMode:/);
assert.match(server, /resolvedIntent:/);

const browserContext = { globalThis: {} };
vm.createContext(browserContext);
vm.runInContext(intentScript, browserContext);
assert.equal(typeof browserContext.globalThis.LodgingSearchIntent?.resolveLodgingSearchIntent, "function");

console.log("Lodging search UI contract checks passed");
