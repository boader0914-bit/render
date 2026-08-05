const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createCollector, normalizeYearMonth } = require("./tourism_collector.cjs");

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tourism-collector-"));
  const webDir = path.join(tmp, "web");
  const dataDir = path.join(tmp, "data");
  await fsp.mkdir(path.join(webDir, "data"), { recursive: true });
  await fsp.copyFile(
    path.join(__dirname, "..", "web", "data", "tourism_region_map.json"),
    path.join(webDir, "data", "tourism_region_map.json")
  );

  const collector = createCollector({
    rootDir: tmp,
    webDir,
    dataDir,
    tourismDataDir: path.join(dataDir, "tourism_data")
  });

  const status = await collector.status();
  assert.equal(status.ok, true);
  assert.ok(status.regionMap.regionCount >= 40);
  assert.equal(status.serviceKeyConfigured, false);

  const match = await collector.resolveRegion({ keyword: "하동풀빌라" });
  assert.equal(match.region.regionKey, "kr_gyeongnam_hadong");
  assert.equal(match.region.ktoSggCd, "48850");

  const snapshot = await collector.collect({ keyword: "하동풀빌라", yearMonth: "202606", force: true });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.region.regionKey, "kr_gyeongnam_hadong");
  assert.equal(snapshot.yearMonth, "202606");
  assert.equal(Object.keys(snapshot.sources).length, 3);
  assert.equal(snapshot.sources.visitors.status, "skipped");
  assert.equal(snapshot.sources.visitors.reason, "missing_service_key");

  const cached = await collector.collect({ keyword: "하동풀빌라", yearMonth: "202606" });
  assert.equal(cached.cache.hit, true);

  assert.equal(normalizeYearMonth("2026.06"), "202606");
  assert.ok(fs.existsSync(path.join(dataDir, "tourism_data", "collections.jsonl")));
  await fsp.rm(tmp, { recursive: true, force: true });
  console.log("Tourism collector tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
