"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const {
  apolloHtml,
  createApolloFixture
} = require("./naver_collector_fixture_factory.cjs");

const auditFile = String(process.env.NAVER_LIMITED_FIXTURE_AUDIT_FILE || "").trim();
const mode = String(process.env.NAVER_LIMITED_FIXTURE_MODE || "success").trim();
let callCount = 0;

const originalModuleLoad = Module._load;
Module._load = function limitedActivationFixtureModuleLoad(request, parent, isMain) {
  if (
    request === "./workbook_export.cjs"
    && String(parent?.filename || "").endsWith("gyeongnam_glamping_crawl.cjs")
  ) {
    return {
      buildWorkbook: async (filePath) => {
        await fs.promises.writeFile(filePath, "synthetic fixture workbook", "utf8");
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

function writeAudit(url) {
  if (!auditFile) throw new Error("fixture audit file is required");
  fs.writeFileSync(auditFile, JSON.stringify({
    callCount,
    hostname: url.hostname,
    pathname: url.pathname,
    method: "GET"
  }), "utf8");
}

function fixtureBody(query) {
  const items = Array.from({ length: 50 }, (_, index) => ({
    id: `fixture-place-${String(index + 1).padStart(2, "0")}`,
    name: index === 0 ? '=HYPERLINK("https://fixture.invalid","Synthetic")' : `Synthetic Lodge ${index + 1}`,
    category: "Synthetic lodging",
    roadAddress: index === 0 ? "@SUM(1,1)" : `Synthetic road ${index + 1}`,
    placeReviewCount: index + 1,
    placeReviewScore: 4.5,
    hasBooking: false
  }));
  return apolloHtml(createApolloFixture({
    query,
    display: 50,
    items,
    total: 50
  }).state);
}

globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof URL ? input : new URL(String(input));
  callCount += 1;
  writeAudit(url);
  if (callCount > 1) throw new Error("fixture provider call budget exceeded");
  if (
    url.hostname !== "pcmap.place.naver.com"
    || url.pathname !== "/accommodation/list"
    || String(init.method || "GET").toUpperCase() !== "GET"
    || init.redirect !== "manual"
  ) {
    throw new Error("unexpected fixture transport target");
  }
  if (mode === "http_403") {
    return new Response("", { status: 403, headers: { "content-type": "text/html" } });
  }
  if (mode === "http_429") {
    return new Response("", { status: 429, headers: { "retry-after": "900" } });
  }
  if (mode === "challenge") {
    return new Response("<html><h1>보안 확인</h1><p>자동입력 방지</p></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
  if (mode === "malformed") {
    return new Response("<html><script>window.__APOLLO_STATE__ = {broken};</script></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
  return new Response(fixtureBody(url.searchParams.get("query") || ""), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
};
