const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validateRequestPacing, effectiveRequestPacing, lowLoadRequestPacing } = require("./daily_keyword_collection_scheduler.cjs");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const declaration = source.match(/^function scheduledCrawlerPacingEnv\([^]*?^}/m)?.[0];
assert.ok(declaration);
const context = vm.createContext({ validateRequestPacing, effectiveRequestPacing });
vm.runInContext(declaration, context);
const envFor = (payload, day) => JSON.parse(JSON.stringify(context.scheduledCrawlerPacingEnv(payload, day)));
const profile = lowLoadRequestPacing("2026-09-22");
assert.deepEqual(envFor({ scheduledCollection: true, requestPacing: profile }, "2026-09-21"), { NAVER_REQUEST_PACING_ENABLED: "0" });
assert.deepEqual(envFor({ scheduledCollection: false, requestPacing: profile }, "2026-09-22"), { NAVER_REQUEST_PACING_ENABLED: "0" });
assert.deepEqual(envFor({ scheduledCollection: true }, "2026-09-22"), { NAVER_REQUEST_PACING_ENABLED: "0" });
const active = envFor({ scheduledCollection: true, requestPacing: profile }, "2026-09-22");
assert.deepEqual(active, {
  NAVER_REQUEST_PACING_ENABLED: "1", NAVER_REQUEST_MIN_INTERVAL_MS: "200",
  NAVER_REQUEST_MAX_CONCURRENCY: "2", NAVER_REQUEST_PACING_START_DATE: "2026-09-22",
  NAVER_BOOKING_DETAIL_CONCURRENCY: "1", NAVER_SCHEDULE_CONCURRENCY: "2",
  NAVER_OTA_OBSERVATION_CONCURRENCY: "1"
});
assert.deepEqual(envFor({ scheduledCollection: true, requestPacing: profile }, "2026-09-23"), active);
assert.deepEqual({ NAVER_REQUEST_PACING_ENABLED: "1", ...envFor({}, "2026-09-22") }, { NAVER_REQUEST_PACING_ENABLED: "0" }, "Unselected profiles cannot leak in from the server environment");
assert.throws(() => envFor({ scheduledCollection: true, requestPacing: { ...profile, minIntervalMs: 0 } }, "2026-09-22"), /invalid_daily_collection_request_pacing/);
assert.match(source, /SCHEDULED_COLLECTION: payload\.scheduledCollection === true \? "1" : "0",\s*\.\.\.scheduledCrawlerPacingEnv\(payload, plan\.checkIn\)/);
console.log("Daily pacing child environment: date activation, manual isolation, explicit overrides and validation passed");
