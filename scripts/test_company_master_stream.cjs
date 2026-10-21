"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { readCompanyMasterProjection } = require("./lib/company_master_stream.cjs");

const saved = {
  schemaVersion: 1,
  companies: {
    a: { companyId: "a", primaryName: '월명 { " \\ 글램핑', capacity: 16,
      inventory: { products: [{ name: "큰 원문", note: "x".repeat(8192) }] }, sold: 0, revenue: null, missing: true },
    b: { companyId: "b", primaryName: "대조 업체", capacity: 8, keywords: { broad: { runs: [{ runId: "r", rank: 2 }] } } }
  },
  sourceIndex: { "place:a": "a" },
  trailing: { values: [true, false, null, -1.5e3, { quoted: "\\uD55C" }] }
};
const original = "\uFEFF" + JSON.stringify(saved);
const streamFor = (text, size = 64) => () => Readable.from(Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size)));

test("streaming projection keeps exact selected fields across arbitrary boundaries without retaining raw inventory", async () => {
  for (const size of [1, 2, 7, 64, 16384]) {
    const result = await readCompanyMasterProjection("unused", { stream: streamFor(original, size),
      projectCompany: (value, key) => ({ key, companyId: value.companyId, capacity: value.capacity,
        ...(key === "a" ? { sold: value.sold, revenue: value.revenue, missing: value.missing } : {}) }) });
    assert.equal(Object.getPrototypeOf(result.companies), null);
    assert.deepEqual({ ...result.companies }, {
      a: { key: "a", companyId: "a", capacity: 16, sold: 0, revenue: null, missing: true },
      b: { key: "b", companyId: "b", capacity: 8 }
    });
    assert.equal(result.companies.a.inventory, undefined);
    assert.equal(JSON.stringify(saved), original.slice(1), "streaming never edits the original evidence");
  }
});

test("async consumption and projection are ordered and awaited once per company, with checkpoints during the read", async () => {
  const events = []; let activeCallbacks = 0, maximumCallbacks = 0, checkpoints = 0;
  const result = await readCompanyMasterProjection("unused", { stream: streamFor(original, 79),
    checkpoint: async () => { checkpoints++; await Promise.resolve(); },
    onCompany: async (value, key) => {
      activeCallbacks++; maximumCallbacks = Math.max(maximumCallbacks, activeCallbacks); events.push("consume:" + key);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(value.companyId, key); activeCallbacks--;
    },
    projectCompany: async (value, key) => {
      assert.equal(activeCallbacks, 0, "consumer finishes before the projection and next company");
      events.push("project:" + key); await Promise.resolve();
      return key === "a" ? { capacity: value.capacity } : undefined;
    } });
  assert.equal(maximumCallbacks, 1);
  assert.deepEqual(events, ["consume:a", "project:a", "consume:b", "project:b"]);
  assert.deepEqual({ ...result.companies }, { a: { capacity: 16 } });
  assert.ok(checkpoints > 4, "both long payload chunks and completed companies yield cooperatively");
});

test("consume-only mode retains no company payload and still validates the document through its last byte", async () => {
  const ids = [];
  const result = await readCompanyMasterProjection("unused", { stream: streamFor(original), projectCompany: null,
    onCompany: async (value, key) => { ids.push([key, value.capacity]); } });
  assert.deepEqual(ids, [["a", 16], ["b", 8]]); assert.deepEqual(Object.keys(result.companies), []);
  let consumed = 0;
  await assert.rejects(readCompanyMasterProjection("unused", { stream: streamFor(original + "garbage"), projectCompany: null,
    onCompany: () => { consumed++; } }), { code: "COMPANY_MASTER_INVALID" });
  assert.ok(consumed > 0, "callbacks are provisional until complete document validation succeeds");
});

test("optional root metadata keeps unknown fields exactly while omitting company inventory bodies", async () => {
  const text = "\uFEFF" + JSON.stringify({ before: { escaped: '} , " companies \\ 문자', values: [null, false, 0] },
    companies: saved.companies, after: { nested: ["자료", { active: true }] }, sourceIndex: { "place:a": "a" } });
  for (const size of [1, 3, 79, 16384]) {
    const result = await readCompanyMasterProjection("unused", { stream: streamFor(text, size), projectCompany: null, includeRootMetadata: true });
    const expected = JSON.parse(text.slice(1)); expected.companies = {};
    assert.deepEqual(result.metadata, expected); assert.deepEqual(Object.keys(result.companies), []);
    assert.equal(JSON.stringify(result.metadata).includes("큰 원문"), false);
  }
  assert.equal((await readCompanyMasterProjection("unused", { stream: streamFor(text), projectCompany: null })).metadata, undefined,
    "existing readers do not retain root fields unless requested");
});

test("complete JSON structure, duplicate company keys and duplicate companies declarations fail closed", async () => {
  const invalid = ['{"companies":{"a":', '{"companies":null}', '{"companies":[]}', '{"companies":{"a":{}}',
    '{"companies":{"a":{}}}garbage', '{"companies" {"a":{}}}', '{"companies":{"a":{} "b":{}}}',
    '{"companies":{"a":{},}}', '{"companies":{"a":{}} ,"extra":truth}', '{"companies":{"a":{}} ,"extra":[1,]}',
    '{"companies":{"a":{}} ,"extra":"bad\\escape"}', '{"companies":{"a":{},"a":{}}}',
    '{"companies":{"a":{},"\\u0061":{}}}', '{"companies":{"a":{}} ,"companies":null}',
    '{"companies":null,"companies":{"a":{}}}', '{"companies":{"a":null}}', '{"companies":{"a":"text"}}',
    '{"companies":{"a":7}}', '{\u00a0"companies":{"a":{}}}', '{"companies":{"a":{}}}\u2028', '{}'];
  for (const text of invalid) {
    await assert.rejects(readCompanyMasterProjection("unused", { stream: streamFor(text, 1), projectCompany: null }),
      { code: "COMPANY_MASTER_INVALID" }, text);
  }
});

test("special company keys are ordinary records and neither project nor consume failures become partial success", async () => {
  const text = '{"companies":{"__proto__":{"companyId":"__proto__"},"constructor":{"companyId":"constructor"}}}';
  const result = await readCompanyMasterProjection("unused", { stream: streamFor(text, 5) });
  assert.equal(Object.getPrototypeOf(result.companies), null);
  assert.deepEqual(result.companies.__proto__, { companyId: "__proto__" });
  assert.deepEqual(result.companies.constructor, { companyId: "constructor" });
  for (const callback of ["projectCompany", "onCompany", "checkpoint"]) {
    let input;
    await assert.rejects(readCompanyMasterProjection("unused", { stream: () => (input = streamFor(original)()),
      [callback]: async () => { throw new Error("read model unavailable"); } }), { code: "COMPANY_MASTER_INVALID" });
    assert.equal(input.destroyed, true);
  }
});

test("invalid callback contracts are rejected rather than silently disabling complete-source checks", async () => {
  for (const options of [{ projectCompany: true }, { onCompany: "callback" }, { checkpoint: null }, { stream: false }, { includeRootMetadata: "yes" }]) {
    await assert.rejects(readCompanyMasterProjection("unused", options), TypeError);
  }
});
