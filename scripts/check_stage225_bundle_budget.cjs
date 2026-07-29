const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "apps", "web", "dist");
const BUDGET = Object.freeze({
  eagerRawBytes: 650_000,
  eagerGzipBytes: 180 * 1024,
  cssGzipBytes: 40 * 1024,
  applicationChunkRawBytes: 500_000,
  routeChunkRawBytes: 250_000,
  routeChunkGzipBytes: 60 * 1024
});

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(fullPath) : [fullPath];
  });
}

assert.ok(fs.existsSync(path.join(DIST, "index.html")), "apps/web production build is missing");
const assets = filesUnder(DIST)
  .filter((file) => /\.(?:js|css)$/.test(file) && !file.endsWith(".map"))
  .map((file) => {
    const content = fs.readFileSync(file);
    return {
      file: path.relative(DIST, file).replace(/\\/g, "/"),
      rawBytes: content.length,
      gzipBytes: zlib.gzipSync(content, { level: 9 }).length,
      type: path.extname(file).slice(1)
    };
  });

const totals = assets.reduce((sum, asset) => ({
  rawBytes: sum.rawBytes + asset.rawBytes,
  gzipBytes: sum.gzipBytes + asset.gzipBytes,
  cssGzipBytes: sum.cssGzipBytes + (asset.type === "css" ? asset.gzipBytes : 0)
}), { rawBytes: 0, gzipBytes: 0, cssGzipBytes: 0 });

assert.ok(totals.rawBytes <= BUDGET.eagerRawBytes, `eager raw ${totals.rawBytes} exceeds ${BUDGET.eagerRawBytes}`);
assert.ok(totals.gzipBytes <= BUDGET.eagerGzipBytes, `eager gzip ${totals.gzipBytes} exceeds ${BUDGET.eagerGzipBytes}`);
assert.ok(totals.cssGzipBytes <= BUDGET.cssGzipBytes, `CSS gzip ${totals.cssGzipBytes} exceeds ${BUDGET.cssGzipBytes}`);
for (const asset of assets.filter((item) => item.type === "js")) {
  assert.ok(asset.rawBytes <= BUDGET.applicationChunkRawBytes, `${asset.file} raw size exceeds application chunk budget`);
  if (/route|page/i.test(asset.file)) {
    assert.ok(asset.rawBytes <= BUDGET.routeChunkRawBytes, `${asset.file} raw size exceeds route budget`);
    assert.ok(asset.gzipBytes <= BUDGET.routeChunkGzipBytes, `${asset.file} gzip size exceeds route budget`);
  }
}

console.log(JSON.stringify({ stage: 225, budget: BUDGET, totals, assets }, null, 2));
console.log("Stage 225 bundle budget checks passed");
