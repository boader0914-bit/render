"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const fetchJsonSource = appSource.match(/^async function fetchJson\(url, options\) \{[^]*?^\}/m)?.[0];
assert.ok(fetchJsonSource, "test the actual application response reader");

function fixture(status, body) {
  const redirects = [], statuses = [], requests = [];
  const context = vm.createContext({
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { status, ok: status >= 200 && status < 300, text: async () => body };
    },
    location: { replace: url => redirects.push(url) },
    setStatus: value => statuses.push(value)
  });
  const fetchJson = vm.runInContext(`(${fetchJsonSource})`, context);
  return { fetchJson, redirects, statuses, requests };
}

test("HTML and non-JSON error responses remain short and never leak response bodies", async () => {
  const html = `<html><style>@font-face{src:url(data:font/woff2;base64,${"A".repeat(100000)})}</style><body>upstream failure</body></html>`;
  for (const [status, body] of [[502, html], [503, "Service unavailable"], [500, "{broken"]]) {
    const { fetchJson } = fixture(status, body);
    await assert.rejects(fetchJson("/api/monthly-reports/preview"), error => {
      assert.equal(error.status, status);
      assert.equal(error.code, "INVALID_JSON_RESPONSE");
      assert.equal(error.message, `서버 요청에 실패했습니다. (HTTP ${status})`);
      assert.ok(error.message.length < 80);
      assert.doesNotMatch(error.message, /<html|base64|Service unavailable|broken/);
      return true;
    });
  }
});

test("HTTP 200 malformed responses are errors, while valid JSON and empty successes stay compatible", async () => {
  for (const body of ["<html>proxy page</html>", "not json", "{broken"]) {
    await assert.rejects(fixture(200, body).fetchJson("/api/monthly-reports/preview"), error => {
      assert.equal(error.status, 200);
      assert.equal(error.code, "INVALID_JSON_RESPONSE");
      assert.equal(error.message, "서버 응답 형식이 올바르지 않습니다. (HTTP 200)");
      return true;
    });
  }
  for (const [status, body, expected] of [[200, '{"count":0,"items":[]}', { count: 0, items: [] }], [200, "", {}], [204, "", {}], [200, " \n", {}], [200, "null", null], [200, "[]", []]]) {
    const value = await fixture(status, body).fetchJson("/api/example");
    assert.deepEqual(JSON.parse(JSON.stringify(value)), expected);
  }
});

test("JSON error messages and codes survive, with authentication and permission handling intact", async () => {
  for (const body of ['{"error":"자료 확인이 필요합니다.","errorCode":"SOURCE_CHANGED"}', '{"error":"자료 확인이 필요합니다.","code":"SOURCE_CHANGED"}']) {
    await assert.rejects(fixture(409, body).fetchJson("/api/example"), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "SOURCE_CHANGED");
      assert.equal(error.message, "자료 확인이 필요합니다.");
      return true;
    });
  }
  const unauthorized = fixture(401, "<html>login</html>");
  await assert.rejects(unauthorized.fetchJson("/api/example"));
  assert.deepEqual(unauthorized.redirects, ["/login"]);
  const logout = fixture(401, '{"error":"로그인 필요"}');
  await assert.rejects(logout.fetchJson("/api/logout"));
  assert.deepEqual(logout.redirects, []);
  const forbidden = fixture(403, '{"error":"관리자만 가능합니다.","code":"FORBIDDEN"}');
  await assert.rejects(forbidden.fetchJson("/api/example"), error => error.status === 403 && error.code === "FORBIDDEN" && error.message === "관리자만 가능합니다.");
  assert.deepEqual(forbidden.statuses, ["권한 없음"]);
  await assert.rejects(fixture(500, "null").fetchJson("/api/example"), error => error.status === 500 && error.message === "서버 요청에 실패했습니다. (HTTP 500)");
});
