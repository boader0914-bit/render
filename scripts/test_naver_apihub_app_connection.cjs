"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { resolveDatalabConnection } = require("./lib/naver_datalab_connection.cjs");
const sourceFile = path.join(__dirname, "glamping_app_server.cjs");

function functionSource(source, name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, name);
  const rest = source.slice(match.index);
  const end = /\r?\n(?:async )?function \w+\(/.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

async function fixture(t) {
  const source = await fs.readFile(sourceFile, "utf8");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "naver-apihub-app-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configDir = path.join(directory, "config");
  const file = path.join(configDir, "traffic_api_keys.local.json");
  const state = { env: {}, calls: [], store: { keywords: {} } };
  const range = { startDate: "2025-11-01", endDate: "2026-10-31", timeUnit: "month" };
  const periods = Array.from({ length: 12 }, (_, index) => new Date(Date.UTC(2025, 10 + index, 1)).toISOString().slice(0, 10));
  const values = periods.map((period, index) => ({ period, ratio: index === 0 ? 0 : index * 7 }));
  const context = vm.createContext({
    fsp: fs, process: { env: state.env }, CONFIG_DIR: configDir, TRAFFIC_KEYS_FILE: file,
    HAS_RENDER_DISK: false, isTmpDataPath: () => false, resolveDatalabConnection,
    trafficConnectionChecks: { status: async () => ({ recordState: "missing" }) },
    compactKeyword: value => String(value || "").replace(/\s+/g, ""),
    datalabKeywordVariants: value => [value], datalabTrendRange: () => range,
    DATALAB_TREND_CACHE_POLICY: "same_keyword_same_date",
    readDatalabTrendStore: async () => state.store,
    rememberDatalabTrend: async (_keyword, trend, options) => ({ ...trend, reused: Boolean(options?.cacheHit) }),
    requestJson: async (url, options) => {
      state.calls.push({ url, options });
      return { ok: true, status: 200, data: { ...range, results: [{ title: "경남글램핑", data: values }] } };
    },
    sleep: async () => { throw new Error("Unexpected retry"); }
  });
  const fields = /const trafficKeyFields = \[[\s\S]*?\];/.exec(source);
  assert.ok(fields);
  vm.runInContext(fields[0] + "\n" + ["maskSecret", "normalizeApiKey", "readTrafficKeys", "trafficKeyStatus", "trafficSettingsStatus", "saveTrafficKeys", "normalizeDatalabTrend", "datalabTrendSnapshot", "datalabTrendCacheKey", "freshDatalabTrendFromStore", "datalabTrendCacheMeta", "collectDatalabTrend", "collectDatalabTrendCached"].map(name => functionSource(source, name)).join("\n"), context);
  return { context, state, directory, file, range };
}
const plain = value => JSON.parse(JSON.stringify(value));
const legacy = { naverClientId: "legacy-id", naverClientSecret: "legacy-secret" };
const cloud = { datalabProvider: "ncp_apihub", ncpApihubClientId: "cloud-id", ncpApihubClientSecret: "cloud-secret" };

test("existing settings survive a provider-only switch and blank fields never erase credentials", async t => {
  const f = await fixture(t);
  await f.context.saveTrafficKeys({ ...legacy, searchadApiKey: "ad-id", searchadSecretKey: "ad-secret", searchadCustomerId: "ad-customer" });
  const result = await f.context.saveTrafficKeys({ datalabProvider: "ncp_apihub", naverClientSecret: "", ncpApihubClientId: "", ncpApihubClientSecret: "" });
  const saved = JSON.parse(await fs.readFile(f.file, "utf8"));
  assert.equal(saved.naverClientSecret, legacy.naverClientSecret);
  assert.equal(saved.searchadSecretKey, "ad-secret");
  assert.equal(result.datalabProvider, "ncp_apihub");
  assert.equal(result.datalabConfigured, false);
  assert.equal(result.searchadConfigured, true);
  assert.equal(f.state.calls.length, 0);
});

test("cloud settings read back masked and environment overrides are explicit without reusing Developers keys", async t => {
  const f = await fixture(t);
  await f.context.saveTrafficKeys({ ...legacy, ...cloud });
  const status = await f.context.trafficSettingsStatus();
  assert.equal(status.datalabConfigured, true);
  assert.equal(status.fields.ncpApihubClientSecret.configured, true);
  assert.notEqual(status.fields.ncpApihubClientSecret.masked, cloud.ncpApihubClientSecret);
  assert.ok(!JSON.stringify(status).includes(cloud.ncpApihubClientSecret));
  f.state.env.NAVER_DATALAB_PROVIDER = "developers";
  f.state.env.NAVER_API_HUB_CLIENT_ID = "environment-cloud-id";
  const envStatus = await f.context.trafficSettingsStatus();
  assert.equal(envStatus.datalabProvider, "developers");
  assert.equal(envStatus.storage.datalabProviderEnvOverride, true);
  assert.equal(envStatus.storage.envFields.ncpApihubClientId, true);
  f.state.env.NAVER_DATALAB_PROVIDER = "unrecognized";
  assert.equal((await f.context.trafficSettingsStatus()).datalabConfigured, false);
  f.state.env.NAVER_DATALAB_PROVIDER = "";
  assert.equal((await f.context.trafficSettingsStatus()).datalabConfigured, false);
  delete f.state.env.NAVER_DATALAB_PROVIDER;
  const saved = JSON.parse(await fs.readFile(f.file, "utf8"));
  await fs.writeFile(f.file, JSON.stringify({ ...saved, datalabProvider: null }));
  const invalidSaved = await f.context.trafficSettingsStatus();
  assert.equal(invalidSaved.datalabProvider, "invalid");
  assert.equal(invalidSaved.datalabConfigured, false);
});

test("invalid provider, credential shapes and unknown fields are rejected before any settings write", async t => {
  const f = await fixture(t);
  for (const payload of [null, [], { datalabProvider: "https://malicious.invalid" }, { ncpApihubClientSecret: {} }, { ncpApihubClientId: "x".repeat(4097) }, { endpoint: "https://malicious.invalid" }]) {
    await assert.rejects(f.context.saveTrafficKeys(payload), error => error.code === "TRAFFIC_KEYS_INVALID_REQUEST" && error.statusCode === 400);
  }
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
  assert.equal(f.state.calls.length, 0);
});

test("the same twelve-month response preserves the demand input on both connections", async t => {
  const f = await fixture(t);
  const oldTrend = await f.context.collectDatalabTrend("경남글램핑", legacy, 0, f.range);
  const newTrend = await f.context.collectDatalabTrend("경남글램핑", { ...legacy, ...cloud }, 0, f.range);
  const comparable = value => { const result = plain(value); delete result.connectionProvider; delete result.collectedAt; return result; };
  assert.deepEqual(comparable(oldTrend), comparable(newTrend));
  assert.equal(newTrend.series.length, 12);
  assert.equal(newTrend.series[0].ratio, 0);
  assert.equal(f.state.calls[1].url, "https://naverapihub.apigw.ntruss.com/search-trend/v1/search");
  assert.deepEqual(plain(f.state.calls[0].options.body), plain(f.state.calls[1].options.body));
  assert.equal(f.state.calls[1].options.redirect, "error");
  assert.equal(f.state.calls[1].options.headers["X-Naver-Client-Id"], undefined);
  assert.equal(f.state.calls[1].options.headers["X-NCP-APIGW-API-KEY-ID"], cloud.ncpApihubClientId);
  assert.equal(f.context.datalabTrendSnapshot(newTrend).connectionProvider, "ncp_apihub");
});

test("missing cloud credentials cause zero requests and existing cached observations are never relabelled", async t => {
  const f = await fixture(t);
  const pending = await f.context.collectDatalabTrend("경남글램핑", { ...legacy, datalabProvider: "ncp_apihub" }, 0, f.range);
  assert.equal(pending.configured, false);
  assert.equal(f.state.calls.length, 0);
  const oldTrend = await f.context.collectDatalabTrend("경남글램핑", legacy, 0, f.range);
  delete oldTrend.connectionProvider;
  const snapshot = f.context.datalabTrendSnapshot(oldTrend);
  assert.equal(Object.hasOwn(snapshot, "connectionProvider"), false);
  f.state.store.keywords["경남글램핑"] = { latest: snapshot };
  const countBefore = f.state.calls.length;
  const cached = await f.context.collectDatalabTrendCached("경남글램핑", cloud);
  assert.equal(f.state.calls.length, countBefore);
  assert.equal(cached.reused, true);
  assert.equal(Object.hasOwn(cached, "connectionProvider"), false);
  assert.deepEqual(plain(cached.series), plain(oldTrend.series));
});
