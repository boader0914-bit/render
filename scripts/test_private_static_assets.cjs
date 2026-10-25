"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), { gunzipSync } = require("node:zlib");
const { createPrivateStaticAssets, eligible, acceptsGzip } = require("./lib/private_static_assets.cjs");
const { startCompanyBootstrapFixture } = require("./fixtures/company_bootstrap_api_harness.cjs");
const hash = body => crypto.createHash("sha256").update(body).digest("hex"), url = value => new URL(value, "https://example.test");
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-static-assets-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("private-static-assets-")); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, "app.js"), 'console.log("한글");\n'.repeat(1000)); await fs.writeFile(path.join(root, "styles.css"), "body { color: green; }\n".repeat(100));
  return { root, cache: createPrivateStaticAssets({ directory: root, ...options }) };
}
test("exact content-versioned JS/CSS use private immutable gzip or identity with a semantic ETag and Vary", async t => {
  const f = await fixture(t), raw = await fs.readFile(path.join(f.root, "app.js")), digest = hash(raw), target = url("/app.js?v=" + digest);
  const plain = await f.cache.response(target); assert.equal(plain.status, 200); assert.deepEqual(plain.body, raw); assert.equal(plain.headers["Content-Encoding"], undefined);
  assert.equal(plain.headers["Cache-Control"], "private, max-age=31536000, immutable"); assert.equal(plain.headers.Vary, "Accept-Encoding"); assert.equal(plain.headers.ETag, `W/"${digest}"`);
  const compressed = await f.cache.response(target, { headers: { "accept-encoding": "br, gzip;q=0.8" } }); assert.equal(compressed.headers["Content-Encoding"], "gzip"); assert.deepEqual(gunzipSync(compressed.body), raw);
  assert.equal(compressed.headers["Content-Length"], compressed.body.length); assert.ok(compressed.body.length < raw.length / 5); assert.equal(compressed.headers.ETag, plain.headers.ETag);
  for (const encoding of ["identity", "gzip;q=0", "gzip;q=0, *;q=1", "gzip;q=oops"]) assert.equal((await f.cache.response(target, { headers: { "accept-encoding": encoding } })).headers["Content-Encoding"], undefined);
  assert.equal(f.cache.status().reads, 1); assert.equal(f.cache.status().gzipBuilds, 1);
});
test("conditional reads return an empty 304 while stale, duplicate and extra-query URLs require revalidation", async t => {
  const f = await fixture(t), raw = await fs.readFile(path.join(f.root, "app.js")), digest = hash(raw);
  for (const value of ["/app.js", "/app.js?v=old", `/app.js?v=${digest}&v=${digest}`, `/app.js?v=${digest}&extra=1`]) {
    const first = await f.cache.response(url(value)); assert.equal(first.headers["Cache-Control"], "private, no-cache");
    const checked = await f.cache.response(url(value), { headers: { "if-none-match": `"other", "${digest}"`, "accept-encoding": "gzip" } });
    assert.equal(checked.status, 304); assert.equal(checked.body, null); assert.equal(checked.headers["Content-Length"], undefined); assert.equal(checked.headers.Vary, "Accept-Encoding");
  }
  assert.equal((await f.cache.response(url("/app.js"), { headers: { "if-none-match": "*" } })).status, 304);
  const head = await f.cache.response(url("/app.js?v=" + digest), { method: "HEAD", headers: { "accept-encoding": "gzip" } }); assert.equal(head.status, 200); assert.equal(head.body, null); assert.equal(head.headers["Content-Encoding"], "gzip");
});
test("HTML injection versions every exact local script/style and changed file bytes immediately change its version", async t => {
  const f = await fixture(t), html = '<link href="/styles.css?v=old"><script src="/app.js"></script><script src="/company-integrated.js"></script><script src="/sw.js"></script><script src="https://external.test/app.js"></script><a href="/api/results"></a>';
  await fs.writeFile(path.join(f.root, "company-integrated.js"), "old-module");
  const initial = await f.cache.versionHtml(html), digest = hash(await fs.readFile(path.join(f.root, "app.js")));
  assert.ok(initial.includes(`/app.js?v=${digest}`)); assert.match(initial, /styles\.css\?v=[a-f0-9]{64}/); assert.ok(initial.includes('src="/sw.js"')); assert.ok(initial.includes('src="https://external.test/app.js"')); assert.ok(initial.includes('href="/api/results"'));
  const moduleVersion = initial.match(/company-integrated\.js\?v=([a-f0-9]{64})/)[1]; await fs.writeFile(path.join(f.root, "company-integrated.js"), "new-module-release");
  const moduleChanged = await f.cache.versionHtml(html); assert.ok(moduleChanged.includes(digest)); assert.ok(!moduleChanged.includes(moduleVersion), "every referenced script changes its own version, including company-integrated.js");
  await fs.writeFile(path.join(f.root, "app.js"), "new-release-bytes"); const changed = await f.cache.versionHtml(html);
  assert.ok(!changed.includes(digest)); const stale = await f.cache.response(url("/app.js?v=" + digest)); assert.equal(stale.headers["Cache-Control"], "private, no-cache"); assert.equal(stale.body.toString(), "new-release-bytes");
  await fs.unlink(path.join(f.root, "app.js")); assert.equal(await f.cache.response(url("/app.js?v=" + digest)), null, "a deleted file cannot fall back to retained asset bytes");
});
test("API, outputs, HTML, service workers, nested paths and traversal cannot enter the asset cache", async t => {
  const f = await fixture(t); for (const pathname of ["/api/results.js", "/outputs/results.css", "/index.html", "/sw.js", "/nested/app.js", "/../app.js", "/%2e%2e/app.js", "/app.js/extra", "/app.js%00"]) { assert.equal(eligible(pathname), false, pathname); assert.equal(await f.cache.response({ pathname, searchParams: new URLSearchParams() }), null); }
  assert.equal(await f.cache.response(url("/app.js"), { method: "POST" }), null); assert.equal(f.cache.status().reads, 0);
});
test("symlink assets and symlink cache roots cannot expose another owner's files", async t => {
  const f = await fixture(t), outside = path.join(f.root, "private.txt"); await fs.writeFile(outside, "not-public");
  try { await fs.symlink(outside, path.join(f.root, "secret.js")); assert.equal(await f.cache.response(url("/secret.js")), null); }
  catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; t.diagnostic("file symlink creation unavailable; exercising exact lstat rejection with adapter"); }
  await fs.writeFile(path.join(f.root, "mock-linked.js"), "not-public");
  const guarded = createPrivateStaticAssets({ directory: f.root, fileSystem: { ...fs, lstat: async (...args) => { const stat = await fs.lstat(...args); return args[0].endsWith("mock-linked.js") ? Object.assign(stat, { isSymbolicLink: () => true }) : stat; } } });
  assert.equal(await guarded.response(url("/mock-linked.js")), null);
  const linked = path.join(f.root, "linked"); await fs.symlink(f.root, linked, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createPrivateStaticAssets({ directory: linked }).response(url("/app.js")), { code: "STATIC_ASSET_ROOT_INVALID" });
});
test("asynchronous cold builds are coalesced and serialized within the bounded byte and entry budgets", async t => {
  const f = await fixture(t, { maxFileBytes: 40000, maxCacheBytes: 40000, maxEntries: 2 });
  const values = await Promise.all(Array.from({ length: 12 }, () => f.cache.response(url("/app.js")))); assert.ok(values.every(value => value.body.equals(values[0].body))); assert.equal(f.cache.status().reads, 1);
  for (let index = 0; index < 6; index++) await fs.writeFile(path.join(f.root, `file${index}.js`), crypto.randomBytes(4000).toString("hex"));
  for (let index = 0; index < 6; index += 2) await Promise.all([f.cache.response(url(`/file${index}.js`)), f.cache.response(url(`/file${index + 1}.js`))]);
  const status = f.cache.status(); assert.ok(status.entries <= 2); assert.ok(status.bytes <= 40000); assert.equal(status.maximumActiveLoads, 1); assert.equal(status.queuedLoads, 0); assert.ok(status.evictions > 0);
});
test("gzip failure retains the exact identity response and invalid options or oversized assets fail boundedly", async t => {
  const f = await fixture(t, { gzipImpl: async () => { throw Error("compression unavailable"); } }); const value = await f.cache.response(url("/app.js"), { headers: { "accept-encoding": "gzip" } });
  assert.deepEqual(value.body, await fs.readFile(path.join(f.root, "app.js"))); assert.equal(value.headers["Content-Encoding"], undefined);
  const tiny = createPrivateStaticAssets({ directory: f.root, maxFileBytes: 100, maxCacheBytes: 100 }); assert.equal(await tiny.response(url("/app.js")), null); assert.equal(tiny.status().reads, 0);
  for (const options of [{ maxFileBytes: 0 }, { maxCacheBytes: 1 }, { maxEntries: 257 }, { gzipImpl: null }]) assert.throws(() => createPrivateStaticAssets({ directory: f.root, ...options }), TypeError);
  assert.equal(acceptsGzip("*;q=0.5"), true); assert.equal(acceptsGzip("GZIP;q=1.000"), true);
  const unreadable = createPrivateStaticAssets({ directory: f.root, fileSystem: { ...fs, open: async () => { throw Object.assign(Error("private filesystem path"), { code: "EACCES" }); } } });
  await assert.rejects(unreadable.response(url("/app.js")), error => error.code === "STATIC_ASSET_UNAVAILABLE" && !error.message.includes("private filesystem"));
});
test("actual local server preserves asset authentication and no-store for HTML, APIs and errors", { timeout: 30000 }, async t => {
  const f = await startCompanyBootstrapFixture(); t.after(() => f.stop());
  const anonymous = await fetch(f.base + "/app.js"); assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get("cache-control"), "no-store"); await anonymous.arrayBuffer();
  const cookie = await f.login(), htmlResponse = await fetch(f.base + "/admin", { headers: { cookie } }), html = await htmlResponse.text();
  assert.equal(htmlResponse.headers.get("cache-control"), "no-store"); const app = html.match(/src="(\/app\.js\?v=[a-f0-9]{64})"/)?.[1]; assert.ok(app);
  const raw = await fs.readFile(path.resolve(__dirname, "../web/app.js")); assert.equal(url(app).searchParams.get("v"), hash(raw));
  const first = await fetch(f.base + app, { headers: { cookie, "accept-encoding": "gzip" } }); assert.equal(first.status, 200); assert.equal(first.headers.get("cache-control"), "private, max-age=31536000, immutable"); assert.equal(first.headers.get("content-encoding"), "gzip"); assert.deepEqual(Buffer.from(await first.arrayBuffer()), raw);
  const second = await fetch(f.base + app, { headers: { cookie, "if-none-match": first.headers.get("etag"), "accept-encoding": "gzip" } }); assert.equal(second.status, 304); assert.equal((await second.arrayBuffer()).byteLength, 0);
  for (const pathname of ["/api/health", "/api/company-master/bootstrap", "/missing-file.js", "/outputs/missing.json"]) { const response = await fetch(f.base + pathname, { headers: { cookie } }); assert.equal(response.headers.get("cache-control"), "no-store", pathname); await response.arrayBuffer(); }
});
