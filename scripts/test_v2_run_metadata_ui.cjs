"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "V2 run metadata UI" });
try {
  const root = path.join(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
  const start = app.indexOf("function v2CollectorExecutionUiHtml");
  const end = app.indexOf("\nfunction renderRunResultApplySummary", start);
  assert.notEqual(start, -1, "V2 execution UI helper is required");
  assert.notEqual(end, -1, "V2 execution UI helper boundary is required");
  const executionUi = app.slice(start, end);
  for (const label of [
    "수집 아키텍처", "V2 단일 수집기", "Signed Worker → 기존 V2 Collector",
    "기존 검증 검색 방식", "Legacy/Frozen", "사용 안 함", "순위만 수집 완료",
    "Booking Detail Provider 연결 제한", "NAVER 검색 전략:"
  ]) assert.ok(executionUi.includes(label), `missing execution UI label: ${label}`);
  for (const prohibited of ["Legacy 수집", "Frozen 수집", "Legacy fallback", "구형 수집기로 실행", "V2 단일 경로 실패"]) {
    assert.equal(executionUi.includes(prohibited), false, `prohibited UI label: ${prohibited}`);
  }
  assert.match(server, /deriveV2CollectorExecutionMetadata\([\s\S]{0,600}?v2Top20Profile/u);
  assert.match(server, /result\.collectorExecution\s*=\s*projectedCollectorExecution/u);
  assert.equal(guard.blockedAttempts(), 0);
  console.log("V2 run metadata UI fixtures passed");
} finally {
  guard.restore();
}
