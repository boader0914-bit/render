"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
const entryPoint = source.lastIndexOf("\nmain().catch(");
assert.ok(entryPoint > 0);

function harness(options = {}) {
  const writes = [];
  const files = new Map();
  const context = {
    process: { env: { CHECK_IN: "2026-09-24", CHECK_OUT: "2026-10-01", OUTPUTS_DIR: path.join(os.tmpdir(), "detail-registry-virtual") }, argv: ["node", "crawler", "경남글램핑"] },
    console, setTimeout, clearTimeout, URL, Response, TextDecoder,
    fetch: async () => { throw new Error("unexpected_external_request"); },
    require: name => {
      if (name === "node:fs/promises") return {
        mkdir: async () => {},
        writeFile: async (file, content) => {
          writes.push(file);
          if (options.writeFile) await options.writeFile(file, content);
          files.set(file, content);
        }
      };
      if (name === "xlsx") return {};
      return require(name);
    }
  };
  const crawler = vm.runInNewContext(`${source.slice(0, entryPoint)}\n({ jsonCell, detailJsonRelativePath, detailJsonFiles, outputDir: OUTPUT_DIR })`, context);
  return { ...crawler, writes, files };
}

const value = [{ bizItemId: "456", date: "2026-09-24", detail: "가".repeat(29000) }];
const meta = { field: "weekly_product_details", name: "월명글램핑", placeId: "123", bookingBusinessId: "456" };

test("every repeated search row retains its link but concurrent and later calls register one physical file", async () => {
  const crawler = harness();
  const rows = await Promise.all(Array.from({ length: 20 }, async (_, rank) => ({
    rank: rank + 1,
    detail: await crawler.jsonCell(value, { ...meta, name: rank ? "월명 글램핑" : meta.name })
  })));
  const repeated = await crawler.jsonCell(value, meta);
  const expected = `@json-file:${crawler.detailJsonRelativePath(meta, JSON.stringify(value))}`;
  assert.ok(rows.every(row => row.detail === expected));
  assert.equal(repeated, expected);
  assert.equal(crawler.writes.length, 1);
  assert.equal(crawler.detailJsonFiles.length, 1);
  const item = crawler.detailJsonFiles[0];
  assert.equal(item.name, meta.name);
  assert.equal(item.placeId, meta.placeId);
  assert.equal(item.bookingBusinessId, meta.bookingBusinessId);
  assert.equal(item.field, meta.field);
  assert.equal(item.itemCount, value.length);
  assert.equal(item.originalLength, JSON.stringify(value).length);
  assert.deepEqual(JSON.parse(crawler.files.get(path.join(crawler.outputDir, ...item.file.split("/")))), value);
});

test("different content, place, field and fallback name retain distinct files and unambiguous metadata", async () => {
  const crawler = harness();
  const inputs = [
    [value, meta],
    [[{ ...value[0], date: "2026-09-25" }], meta],
    [value, { ...meta, placeId: "789" }],
    [value, { ...meta, field: "dayuse_weekly_product_details" }],
    [value, { field: meta.field, name: "업체 하나" }],
    [value, { field: meta.field, name: "업체 둘" }]
  ];
  const cells = await Promise.all(inputs.map(args => crawler.jsonCell(...args)));
  assert.equal(new Set(cells).size, inputs.length);
  assert.equal(new Set(crawler.detailJsonFiles.map(item => item.file)).size, inputs.length);
  assert.equal(crawler.writes.length, inputs.length);
  for (const [index, [data, info]] of inputs.entries()) {
    const relative = cells[index].slice("@json-file:".length);
    const entry = crawler.detailJsonFiles.find(item => item.file === relative);
    assert.equal(entry.field, info.field);
    assert.equal(entry.name, info.name);
    assert.equal(entry.placeId, info.placeId || "");
    assert.deepEqual(JSON.parse(crawler.files.get(path.join(crawler.outputDir, ...relative.split("/")))), data);
  }
});

test("inline and empty values do not create sidecars", async () => {
  const crawler = harness();
  assert.equal(await crawler.jsonCell(null, meta), "");
  assert.equal(await crawler.jsonCell([], meta), "");
  assert.equal(await crawler.jsonCell([{ stock: 0 }], meta), '[{"stock":0}]');
  assert.equal(crawler.writes.length, 0);
  assert.equal(crawler.detailJsonFiles.length, 0);
});

test("sanitized identity path collisions fail instead of merging different businesses", async () => {
  const crawler = harness();
  const first = { field: meta.field, name: "업체/하나" };
  const second = { field: meta.field, name: "업체:하나" };
  assert.equal(crawler.detailJsonRelativePath(first, JSON.stringify(value)), crawler.detailJsonRelativePath(second, JSON.stringify(value)));
  await crawler.jsonCell(value, first);
  await assert.rejects(crawler.jsonCell(value, second), error => error.code === "DETAIL_JSON_PATH_CONFLICT");
  assert.equal(crawler.writes.length, 1);
  assert.equal(crawler.detailJsonFiles.length, 1);
});

test("a failed shared write leaves no manifest entry or successful row link and can be retried", async () => {
  let fail = true;
  const crawler = harness({ writeFile: async () => { if (fail) throw Object.assign(new Error("fixture_write_failed"), { code: "EIO" }); } });
  const results = await Promise.allSettled([crawler.jsonCell(value, meta), crawler.jsonCell(value, meta)]);
  assert.ok(results.every(result => result.status === "rejected" && result.reason.code === "EIO"));
  assert.equal(crawler.writes.length, 1);
  assert.equal(crawler.detailJsonFiles.length, 0);
  fail = false;
  assert.match(await crawler.jsonCell(value, meta), /^@json-file:details\//);
  assert.equal(crawler.writes.length, 2);
  assert.equal(crawler.detailJsonFiles.length, 1);
});
