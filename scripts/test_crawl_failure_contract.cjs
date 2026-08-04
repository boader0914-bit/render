"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  classifyCollectorProcessFailure,
  createCrawlFailure,
  publicErrorPayload,
  serializeCollectorFailure,
  unsafePublicText
} = require("./crawl_failure_contract.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER_SOURCE = fs.readFileSync(path.join(ROOT, "scripts", "glamping_app_server.cjs"), "utf8");
const CRAWLER_SOURCE = fs.readFileSync(path.join(ROOT, "scripts", "gyeongnam_glamping_crawl.cjs"), "utf8");
const APP_SOURCE = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");

function assertSafeFailure(error, expectedCode) {
  assert.equal(error.code, expectedCode);
  const payload = publicErrorPayload(error);
  assert.equal(payload.code, expectedCode);
  assert.equal(typeof payload.retryable, "boolean");
  assert.match(payload.diagnosticId, /^crawl-[a-f0-9]{12}$/);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /\/opt\/render|node:internal|C:\\|\.cjs:\d+|Authorization|secret-value|\n\s*at\s/i);
}

function main() {
  const marker = serializeCollectorFailure(createCrawlFailure("NAVER_SEARCH_CONTRACT_UNAVAILABLE"));
  assert.match(marker, /^CRAWL_ERROR_V1:/);
  assertSafeFailure(classifyCollectorProcessFailure({ stderr: marker, exitCode: 1 }), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");

  assertSafeFailure(classifyCollectorProcessFailure({
    stderr: "Error: Naver main search key not found.\n    at collectNaverMain (/opt/render/project/src/scripts/gyeongnam_glamping_crawl.cjs:2616:9)\nAuthorization: secret-value",
    exitCode: 1
  }), "NAVER_SEARCH_CONTRACT_UNAVAILABLE");
  assertSafeFailure(classifyCollectorProcessFailure({ stderr: "403 captcha access denied", exitCode: 1 }), "NAVER_ACCESS_BLOCKED");
  assertSafeFailure(classifyCollectorProcessFailure({ stderr: "FetchError: ECONNRESET node:internal", exitCode: 1 }), "NAVER_TEMPORARY_UNAVAILABLE");
  assertSafeFailure(classifyCollectorProcessFailure({ stderr: "unknown\n".repeat(70000), exitCode: 1 }), "COLLECTION_FAILED");
  assertSafeFailure(classifyCollectorProcessFailure({ spawnError: new Error("spawn C:\\private\\collector.exe ENOENT") }), "COLLECTOR_START_FAILED");

  const generic = publicErrorPayload(new Error("Error: boom\n at fn (/opt/render/project/src/private.cjs:1:1)"));
  assert.equal(generic.code, "INTERNAL_ERROR");
  assert.doesNotMatch(generic.error, /boom|opt\/render|private\.cjs/);
  const validation = new Error("검색어를 입력해 주세요.");
  validation.statusCode = 400;
  assert.equal(publicErrorPayload(validation).error, "검색어를 입력해 주세요.");
  assert.equal(unsafePublicText("/opt/render/project/src/private.cjs:7"), true);
  assert.equal(unsafePublicText("안전한 오류 안내"), false);

  assert.match(CRAWLER_SOURCE, /console\.error\(serializeCollectorFailure\(error\)\)/);
  assert.doesNotMatch(CRAWLER_SOURCE, /console\.error\(error\)/);
  assert.match(SERVER_SOURCE, /classifyCollectorProcessFailure\(\{ stderr, stdout, exitCode: code \}\)/);
  assert.doesNotMatch(SERVER_SOURCE, /new Error\(stderr \|\| stdout/);
  assert.match(SERVER_SOURCE, /const publicFailure = publicErrorPayload\(error\)/);
  assert.match(SERVER_SOURCE, /stderr = \(stderr \+ chunk\.toString\("utf8"\)\)\.slice\(-64 \* 1024\)/);
  assert.match(APP_SOURCE, /safeCollectionFailureMessage\(error/);
  assert.match(APP_SOURCE, /COLLECTION_FAILURE_MESSAGES\[code\]/, "collection failures use a local message allowlist");
  assert.match(APP_SOURCE, /error\.diagnosticId = typeof data\.diagnosticId/);
  assert.doesNotMatch(APP_SOURCE, /crawlStatus\.textContent = `수집 실패: \$\{error\.message\}`/);

  console.log("Crawl failure security contract tests passed.");
}

main();
