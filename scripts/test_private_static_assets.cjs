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
  const trace = htmlResponse.headers.get("x-document-trace"); assert.match(trace, /^[a-f0-9]{24}$/);
  const serverTiming = htmlResponse.headers.get("server-timing");
  for (const phase of ["html_read", "html_versions", "header_ready"]) assert.match(serverTiming, new RegExp(phase + ";dur=\\d+(?:\\.\\d+)?"));
  const statusResponse = await fetch(f.base + "/api/analytical-work", { headers: { cookie } }); assert.equal(statusResponse.status, 200);
  const documentResponses = (await statusResponse.json()).documentResponses, document = documentResponses.recent.find(row => row.traceId === trace);
  assert.ok(document); assert.equal(document.route, "admin"); assert.ok(document.assets.assetCount > 0);
  for (const field of ["digestReads", "digestHits", "digestBytes", "digestQueueMs", "digestWorkMs"]) assert.ok(Number.isFinite(document.assets[field]) && document.assets[field] >= 0);
  assert.equal(Object.hasOwn(document.assets, "gzipBuilds"), false);
  const raw = await fs.readFile(path.resolve(__dirname, "../web/app.js")); assert.equal(url(app).searchParams.get("v"), hash(raw));
  const first = await fetch(f.base + app, { headers: { cookie, "accept-encoding": "gzip" } }); assert.equal(first.status, 200); assert.equal(first.headers.get("cache-control"), "private, max-age=31536000, immutable"); assert.equal(first.headers.get("content-encoding"), "gzip"); assert.deepEqual(Buffer.from(await first.arrayBuffer()), raw);
  const second = await fetch(f.base + app, { headers: { cookie, "if-none-match": first.headers.get("etag"), "accept-encoding": "gzip" } }); assert.equal(second.status, 304); assert.equal((await second.arrayBuffer()).byteLength, 0);
  for (const pathname of ["/api/health", "/api/company-master/bootstrap", "/missing-file.js", "/outputs/missing.json"]) { const response = await fetch(f.base + pathname, { headers: { cookie } }); assert.equal(response.headers.get("cache-control"), "no-store", pathname); await response.arrayBuffer(); }
});

function staticDeferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function staticPrompt(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("synthetic static operation remained blocked")), 3000); })]); }
  finally { clearTimeout(timer); }
}
const STATIC_TIMING_KEYS = ["assetCount", "versionedAssetCount", "digestReads", "digestHits", "digestBytes", "digestQueueMs",
  "digestWorkMs", "digestReadMs", "digestHashMs", "digestSharedFlights", "digestSharedWaitMs", "versionHtmlMs", "failed"];
test("cold HTML prepares 44 exact digests without gzip and reports only request-specific numbers", async t => {
  let gzipCalls = 0;
  const f = await fixture(t, { gzipImpl: async raw => { gzipCalls++; return require("node:zlib").gzipSync(raw); } });
  const tags = []; let expectedBytes = 0;
  for (let i = 0; i < 44; i++) { const body = "synthetic asset " + String(i) + "\n"; expectedBytes += Buffer.byteLength(body); await fs.writeFile(path.join(f.root, "asset" + String(i) + ".js"), body); tags.push('<script src="/asset' + String(i) + '.js"></script>'); }
  const timings = [], html = await f.cache.versionHtml(tags.join(""), { onTiming: value => timings.push(value) });
  assert.equal((html.match(/\?v=[a-f0-9]{64}/g) || []).length, 44); assert.equal(gzipCalls, 0);
  assert.equal(f.cache.status().reads, 0); assert.equal(f.cache.status().digestReads, 44);
  assert.equal(f.cache.status().bytes, 0); assert.equal(f.cache.status().entries, 44);
  assert.equal(f.cache.status().maximumActiveDigestLoads, 1); assert.equal(f.cache.status().digestChunkBytes, 65536);
  assert.equal(timings.length, 1); assert.ok(Object.isFrozen(timings[0]));
  assert.deepEqual(Object.keys(timings[0]).sort(), [...STATIC_TIMING_KEYS].sort());
  assert.ok(Object.values(timings[0]).every(value => Number.isFinite(value) && value >= 0));
  assert.equal(timings[0].assetCount, 44); assert.equal(timings[0].digestReads, 44); assert.equal(timings[0].digestBytes, expectedBytes);
  let warm; assert.equal(await f.cache.versionHtml(tags.join(""), { onTiming: value => { warm = value; } }), html);
  assert.equal(warm.digestReads, 0); assert.equal(warm.digestBytes, 0); assert.equal(warm.digestHits, 44);
  const actual = await f.cache.response(url("/asset0.js")); assert.equal(actual.body.toString(), "synthetic asset 0\n");
  assert.equal(f.cache.status().reads, 1, "cold HTML digest and later body delivery have separate reads"); assert.equal(gzipCalls, 0);
  assert.equal(await f.cache.versionHtml(tags.join(""), { onTiming() { throw Error("diagnostic failure"); } }), html);
  assert.equal(await f.cache.versionHtml(tags.join(""), { async onTiming() { throw Error("async diagnostic failure"); } }), html);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cache.status().maxFileBytes, 8 * 1024 * 1024); assert.equal(f.cache.status().maxCacheBytes, 16 * 1024 * 1024); assert.equal(f.cache.status().maxEntries, 64);
});
test("HTML for the same and another asset finishes while lazy gzip remains blocked", async t => {
  const entered = staticDeferred(), release = staticDeferred(); let calls = 0;
  const f = await fixture(t, { gzipImpl: async raw => { calls++; entered.resolve(); await release.promise; return require("node:zlib").gzipSync(raw); } });
  const request = f.cache.response(url("/app.js"), { headers: { "accept-encoding": "gzip" } });
  await entered.promise;
  try {
    const html = await staticPrompt(f.cache.versionHtml('<script src="/app.js"></script><link href="/styles.css">'));
    assert.match(html, /app\.js\?v=[a-f0-9]{64}/); assert.match(html, /styles\.css\?v=[a-f0-9]{64}/);
    assert.equal(calls, 1); assert.equal(f.cache.status().activeLoads, 1); assert.equal(f.cache.status().maximumActiveDigestLoads, 1);
  } finally { release.resolve(); }
  const response = await request; assert.deepEqual(gunzipSync(response.body), await fs.readFile(path.join(f.root, "app.js")));
  assert.equal(f.cache.status().maximumActiveLoads, 1); assert.equal(f.cache.status().queuedLoads, 0);
});
test("a digest stream retries changed bytes and never versions a mixed or previous body", async t => {
  const f = await fixture(t), original = Buffer.alloc(70000, "a"), changed = Buffer.alloc(75000, "b");
  await fs.writeFile(path.join(f.root, "app.js"), original); let changedOnce = false, maximumReadLength = 0;
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args); if (!args[0].endsWith("app.js")) return handle;
    return { stat: (...values) => handle.stat(...values), close: () => handle.close(), read: async (...values) => {
      maximumReadLength = Math.max(maximumReadLength, values[2]); const part = await handle.read(...values);
      if (!changedOnce && part.bytesRead) { changedOnce = true; await fs.writeFile(path.join(f.root, "app.js"), changed); }
      return part;
    } };
  } };
  const cache = createPrivateStaticAssets({ directory: f.root, fileSystem: io }); let timing;
  const html = await cache.versionHtml('<script src="/app.js"></script>', { onTiming: value => { timing = value; } });
  assert.ok(html.includes(hash(changed))); assert.ok(!html.includes(hash(original))); assert.equal(timing.digestReads, 2);
  assert.ok(maximumReadLength <= 65536); assert.equal(cache.status().reads, 0);
});
test("a change during gzip cannot overwrite the fresh HTML digest or publish old bytes", async t => {
  const entered = staticDeferred(), release = staticDeferred(); let calls = 0;
  const f = await fixture(t, { gzipImpl: async raw => { if (++calls === 1) { entered.resolve(); await release.promise; } return require("node:zlib").gzipSync(raw); } });
  const request = f.cache.response(url("/app.js"), { headers: { "accept-encoding": "gzip" } }); await entered.promise;
  const replacement = Buffer.from("changed exact asset\n".repeat(1500));
  try {
    await fs.writeFile(path.join(f.root, "app.js"), replacement);
    const html = await staticPrompt(f.cache.versionHtml('<script src="/app.js"></script>')); assert.ok(html.includes(hash(replacement)));
  } finally { release.resolve(); }
  const response = await request;
  assert.deepEqual(gunzipSync(response.body), replacement); assert.equal(response.headers.ETag, 'W/"' + hash(replacement) + '"');
  assert.equal(calls, 2); assert.equal(f.cache.status().reads, 2); assert.ok((await f.cache.versionHtml('<script src="/app.js"></script>')).includes(hash(replacement)));
});
test("eviction and deletion during gzip keep bounds and cannot resurrect retained bytes", async t => {
  const entered = staticDeferred(), release = staticDeferred();
  const f = await fixture(t, { maxEntries: 2, gzipImpl: async raw => { entered.resolve(); await release.promise; return require("node:zlib").gzipSync(raw); } });
  const request = f.cache.response(url("/app.js"), { headers: { "accept-encoding": "gzip" } }); await entered.promise;
  try {
    await fs.writeFile(path.join(f.root, "another.css"), "synthetic eviction asset");
    const style = await staticPrompt(f.cache.versionHtml('<link href="/styles.css"><link href="/another.css">')); assert.match(style, /styles\.css\?v=[a-f0-9]{64}/);
    assert.equal(f.cache.status().entries, 2); assert.ok(f.cache.status().evictions > 0);
    await fs.unlink(path.join(f.root, "app.js"));
    assert.equal(await staticPrompt(f.cache.versionHtml('<script src="/app.js"></script>')), '<script src="/app.js"></script>');
  } finally { release.resolve(); }
  assert.equal(await request, null); assert.equal(await f.cache.response(url("/app.js")), null);
  assert.ok(f.cache.status().bytes <= f.cache.status().maxCacheBytes); assert.equal(f.cache.status().queuedLoads, 0);
});
test("shared digest flights attribute reads only to their owner and joining wait to the joining request", async t => {
  const f = await fixture(t), entered = staticDeferred(), release = staticDeferred(), joinedStat = staticDeferred(); let blocking = false;
  const io = { ...fs, lstat: async (...args) => { const value = await fs.lstat(...args); if (blocking && args[0].endsWith("app.js")) joinedStat.resolve(); return value; },
    open: async (...args) => { const handle = await fs.open(...args); if (!args[0].endsWith("app.js")) return handle;
      return { stat: (...values) => handle.stat(...values), close: () => handle.close(), read: async (...values) => {
        if (!blocking) { blocking = true; entered.resolve(); await release.promise; } return handle.read(...values);
      } };
    } };
  const cache = createPrivateStaticAssets({ directory: f.root, fileSystem: io }), timings = [];
  const first = cache.versionHtml('<script src="/app.js"></script>', { onTiming: value => { timings[0] = value; } }); await entered.promise;
  const second = cache.versionHtml('<script src="/app.js"></script>', { onTiming: value => { timings[1] = value; } });
  await joinedStat.promise; await new Promise(resolve => setImmediate(resolve)); release.resolve();
  const values = await Promise.all([first, second]); assert.equal(values[0], values[1]);
  assert.equal(timings[0].digestReads, 1); assert.equal(timings[1].digestReads, 0); assert.equal(timings[1].digestBytes, 0);
  assert.equal(timings[1].digestSharedFlights, 1); assert.ok(timings[1].digestSharedWaitMs >= 0); assert.equal(cache.status().digestReads, 1);
});
test("lazy gzip retains negotiated 304 and HEAD headers after digest-only HTML", async t => {
  const f = await fixture(t), raw = await fs.readFile(path.join(f.root, "app.js")), digest = hash(raw);
  await f.cache.versionHtml('<script src="/app.js"></script>'); assert.equal(f.cache.status().gzipBuilds, 0);
  const target = url("/app.js?v=" + digest), headers = { "accept-encoding": "gzip" };
  const conditional = await f.cache.response(target, { headers: { ...headers, "if-none-match": 'W/"' + digest + '"' } });
  assert.equal(conditional.status, 304); assert.equal(conditional.body, null); assert.equal(conditional.headers["Content-Encoding"], "gzip"); assert.equal(conditional.headers["Content-Length"], undefined);
  const head = await f.cache.response(target, { method: "HEAD", headers }); assert.equal(head.status, 200); assert.equal(head.body, null);
  assert.equal(head.headers["Content-Encoding"], "gzip"); assert.equal(head.headers.Vary, "Accept-Encoding"); assert.equal(head.headers["Cache-Control"], "private, max-age=31536000, immutable");
  const get = await f.cache.response(target, { headers }); assert.equal(head.headers["Content-Length"], get.body.length); assert.deepEqual(gunzipSync(get.body), raw);
  assert.equal(f.cache.status().gzipBuilds, 1); assert.equal(f.cache.status().reads, 1);
});

test("non-beneficial lazy gzip is attempted once and retains the exact identity variant", async t => {
  let builds = 0;
  const f = await fixture(t, { gzipImpl: async raw => { builds++; return Buffer.alloc(raw.length + 1); } });
  const raw = await fs.readFile(path.join(f.root, "app.js"));
  await f.cache.versionHtml('<script src="/app.js"></script>');
  for (let i = 0; i < 2; i++) {
    const value = await f.cache.response(url("/app.js"), { headers: { "accept-encoding": "gzip" } });
    assert.deepEqual(value.body, raw); assert.equal(value.headers["Content-Encoding"], undefined); assert.equal(value.headers.Vary, "Accept-Encoding");
  }
  assert.equal(builds, 1); assert.equal(f.cache.status().reads, 1);
});
test("digest and body queues share the original path admission bound and failure timing stays numeric", async t => {
  const entered = staticDeferred(), release = staticDeferred();
  const f = await fixture(t, { maxEntries: 1, gzipImpl: async raw => { entered.resolve(); await release.promise; return require("node:zlib").gzipSync(raw); } });
  const request = f.cache.response(url("/app.js"), { headers: { "accept-encoding": "gzip" } }); await entered.promise; let timing;
  try {
    await assert.rejects(f.cache.versionHtml('<link href="/styles.css">', { onTiming: value => { timing = value; } }), { code: "STATIC_ASSET_BUSY" });
    assert.equal(timing.failed, 1); assert.equal(timing.assetCount, 1); assert.equal(timing.digestReads, 0);
    assert.ok(Object.values(timing).every(value => Number.isFinite(value) && value >= 0));
    assert.equal(Object.hasOwn(timing, "gzipBuilds"), false); assert.equal(f.cache.status().queuedLoads, 1);
  } finally { release.resolve(); }
  await request;
  assert.match(await f.cache.versionHtml('<link href="/styles.css">'), /styles\.css\?v=[a-f0-9]{64}/);
  assert.equal(f.cache.status().entries, 1); assert.equal(f.cache.status().queuedLoads, 0);
});
