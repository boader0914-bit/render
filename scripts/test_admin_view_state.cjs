"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const AdminViewState = require("../web/admin-view-state.js");
const source = fs.readFileSync(path.join(__dirname, "../web/admin-view-state.js"), "utf8");
const initial = () => ({ applied: { keyword: "경남글램핑", month: "2026-11" }, draft: { keyword: "경남글램핑", month: "2026-11" },
  selection: null, page: 1, expanded: [], scroll: { x: 0, y: 0 } });
function rejects(code, action, limit) {
  assert.throws(action, error => error instanceof TypeError && error.code === `ADMIN_VIEW_STATE_${code}` && (!limit || error.limit === limit));
}

test("applied query, edited draft, selection and page stay independent through shallow explicit updates", () => {
  const state = AdminViewState.create(initial());
  const value = state.update({ draft: { keyword: "포천글램핑" }, selection: "cmp_selected", page: 3, expanded: ["evidence"], scroll: { x: 0, y: 700 } });
  assert.deepEqual(value.applied, initial().applied);
  assert.deepEqual(value.draft, { keyword: "포천글램핑" }, "nested objects are replaced, never silently deep-merged");
  assert.equal(value.page, 3); assert.equal(value.selection, "cmp_selected");
  assert.deepEqual(state.snapshot(), value);
});

test("initial values, patch values and every returned snapshot have no mutable references into state", () => {
  const baseline = initial(), state = AdminViewState.create(baseline);
  baseline.applied.keyword = "외부 변경"; baseline.expanded.push("outside");
  assert.equal(state.snapshot().applied.keyword, "경남글램핑"); assert.deepEqual(state.snapshot().expanded, []);
  const patch = { draft: { keyword: "대구글램핑" }, expanded: [{ key: "row" }] }, returned = state.update(patch);
  patch.draft.keyword = "외부 변경"; patch.expanded[0].key = "outside";
  returned.draft.keyword = "반환값 변경"; returned.expanded[0].key = "returned";
  const snapshot = state.snapshot(); snapshot.applied.month = "2099-01";
  assert.equal(state.snapshot().draft.keyword, "대구글램핑"); assert.equal(state.snapshot().expanded[0].key, "row");
  assert.equal(state.snapshot().applied.month, "2026-11");
});

test("replace removes omitted keys, and clear restores the isolated initial defaults without old selections", () => {
  const baseline = initial(), state = AdminViewState.create(baseline);
  state.update({ selection: "private_selection", draft: { keyword: "private_draft" }, temporary: { value: "private" } });
  const replacement = { page: 5 }, returned = state.replace(replacement);
  replacement.page = 10; returned.page = 20; assert.deepEqual(state.snapshot(), { page: 5 });
  baseline.applied.keyword = "mutated";
  const cleared = state.clear(); assert.deepEqual(cleared, initial());
  assert.doesNotMatch(JSON.stringify(cleared), /private|temporary|mutated/);
  cleared.applied.keyword = "returned mutation"; assert.deepEqual(state.clear(), initial());
});

test("invalid updates and replacements are atomic, including combined-size failures", () => {
  const state = AdminViewState.create(initial()), before = state.snapshot();
  for (const method of ["update", "replace"]) {
    for (const value of [null, [], 1, "bad", { draft: { keyword: undefined } }, { page: NaN }]) {
      assert.throws(() => state[method](value)); assert.deepEqual(state.snapshot(), before);
    }
  }
  const large = "x".repeat(60 * 1024), bounded = AdminViewState.create({ a: large, b: large, c: large });
  const saved = bounded.snapshot();
  rejects("LIMIT_EXCEEDED", () => bounded.update({ d: large, e: large }), "maxBytes");
  assert.deepEqual(bounded.snapshot(), saved);
});

test("prototype-pollution keys at any depth are rejected without changing Object.prototype", () => {
  const state = AdminViewState.create(initial()), before = state.snapshot();
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const malicious = JSON.parse(`{"selection":{"${key}":{"polluted":true}}}`);
    rejects("UNSAFE_KEY", () => state.update(malicious));
    rejects("UNSAFE_KEY", () => AdminViewState.create(malicious));
    assert.deepEqual(state.snapshot(), before);
  }
  rejects("UNSAFE_OBJECT", () => state.update({ draft: Object.create({ inherited: true }) }));
  assert.equal(Object.prototype.polluted, undefined); assert.equal({}.polluted, undefined);
});

test("getters, hidden properties, symbols and custom array properties are rejected without calling getters", () => {
  let calls = 0;
  const getter = {}; Object.defineProperty(getter, "selected", { enumerable: true, get() { calls++; return "private"; } });
  rejects("ACCESSOR_NOT_ALLOWED", () => AdminViewState.create(getter)); assert.equal(calls, 0);
  const hidden = {}; Object.defineProperty(hidden, "secret", { value: "not JSON", enumerable: false });
  rejects("UNSAFE_OBJECT", () => AdminViewState.create(hidden));
  rejects("UNSUPPORTED_VALUE", () => AdminViewState.create({ [Symbol("secret")]: "x" }));
  const decorated = [1]; decorated.note = "not JSON";
  rejects("UNSAFE_OBJECT", () => AdminViewState.create({ expanded: decorated }));
  const customArray = [1]; Object.setPrototypeOf(customArray, null);
  rejects("UNSAFE_OBJECT", () => AdminViewState.create({ expanded: customArray }));
});

test("non-JSON values, sparse arrays and cycles cannot be converted into misleading nulls or defaults", () => {
  for (const value of [undefined, () => {}, Symbol("x"), 1n, NaN, Infinity, -Infinity]) {
    rejects("UNSUPPORTED_VALUE", () => AdminViewState.create({ value }));
  }
  for (const value of [new Date(), /x/, new Map(), new Set(), new Number(1), new Uint8Array([1])]) {
    rejects("UNSAFE_OBJECT", () => AdminViewState.create({ value }));
  }
  rejects("SPARSE_ARRAY_NOT_ALLOWED", () => AdminViewState.create({ expanded: new Array(2) }));
  const cyclic = {}; cyclic.self = cyclic; rejects("CYCLE", () => AdminViewState.create(cyclic));
  const shared = { value: 1 }, copied = AdminViewState.create({ a: shared, b: shared }).snapshot();
  copied.a.value = 9; assert.equal(copied.b.value, 1, "acyclic shared references become separate JSON copies");
});

test("depth, node, property, array and string bounds reject oversized UI state", () => {
  const deep = {}; let cursor = deep;
  for (let index = 0; index < AdminViewState.limits.maxDepth + 1; index++) { cursor.next = {}; cursor = cursor.next; }
  rejects("LIMIT_EXCEEDED", () => AdminViewState.create(deep), "maxDepth");
  rejects("LIMIT_EXCEEDED", () => AdminViewState.create(Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`k${index}`, 0]))), "maxObjectKeys");
  rejects("LIMIT_EXCEEDED", () => AdminViewState.create({ expanded: Array(2049).fill(0) }), "maxArrayLength");
  rejects("LIMIT_EXCEEDED", () => AdminViewState.create({ draft: "x".repeat(65537) }), "maxStringLength");
  rejects("LIMIT_EXCEEDED", () => AdminViewState.create({ rows: Array.from({ length: 2048 }, () => ({ a: 0, b: 0 })) }), "maxNodes");
});

test("serialized-byte bound counts Korean, escapes and supplementary Unicode rather than JS character count", () => {
  for (const text of ["한".repeat(30000), "\u0000".repeat(15000), "😀".repeat(22000), "\ud800".repeat(15000)]) {
    const input = { a: text, b: text, c: text };
    assert.ok(Buffer.byteLength(JSON.stringify(input), "utf8") > AdminViewState.limits.maxBytes);
    rejects("LIMIT_EXCEEDED", () => AdminViewState.create(input), "maxBytes");
  }
  const accepted = { unicode: "한😀\ud800", quoted: '"\\\n\t', zero: -0 };
  assert.deepEqual(AdminViewState.create(accepted).snapshot(), JSON.parse(JSON.stringify(accepted)));
});

test("browser global and CommonJS expose the same explicit API without browser I/O or storage access", () => {
  const context = {};
  for (const name of ["document", "location", "localStorage", "sessionStorage", "fetch", "XMLHttpRequest", "setTimeout", "setInterval"]) {
    Object.defineProperty(context, name, { get() { throw new Error(`forbidden access ${name}`); } });
  }
  vm.runInNewContext(source, context);
  assert.equal(typeof context.AdminViewState.create, "function");
  assert.deepEqual(Object.keys(context.AdminViewState).sort(), ["create", "limits"]);
  const browser = context.AdminViewState.create(initial());
  assert.deepEqual(JSON.parse(JSON.stringify(browser.snapshot())), initial());
  assert.deepEqual(Object.keys(browser).sort(), ["clear", "replace", "snapshot", "update"]);
  browser.update({ selection: "test" }); browser.replace({ page: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(browser.clear())), initial());
  const foreign = vm.runInNewContext('({applied:{keyword:"경남글램핑"},expanded:["row"]})');
  assert.deepEqual(AdminViewState.create(foreign).snapshot(), { applied: { keyword: "경남글램핑" }, expanded: ["row"] });
});
