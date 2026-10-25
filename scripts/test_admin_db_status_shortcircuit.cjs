"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const declaration = source.match(/^function adminDbStatusMatches\([^]*?^}/m)?.[0];
assert.ok(declaration, "actual status filter must exist");

// Keep the previous eager implementation as an independent behavior oracle.
function previousStatusMatches(row = {}, status = "all", queueProfile) {
  if (!status || status === "all") return true;
  const company = row.company || {};
  const metrics = row.metrics || {};
  const review = metrics.adminReview || company.adminReview || {};
  const reviewStatus = String(review.status || "");
  const workKey = metrics.workType?.key || "";
  const salesCategory = String(company.salesTarget?.category || "");
  const contactStatus = String(company.salesContact?.status || "");
  const lowConfidence = Boolean(metrics.lowConfidence || metrics.confidenceScore <= 2);
  const channelReviewNeeded = Number(metrics.channels?.reviewNeeded || 0) > 0;
  const unreviewed = !metrics.adminReview && !company.adminReview;
  const recrawl = workKey === "recrawl" || reviewStatus === "recrawl_needed";
  const manual = workKey === "manual" || reviewStatus === "manual_needed" || lowConfidence;
  const excluded = reviewStatus === "exclude" || salesCategory === "exclude" || contactStatus === "excluded";
  const decisionQueueActive = queueProfile(company).inQueue;
  const contactReady = (reviewStatus === "contact_ready" || salesCategory === "contact") && !decisionQueueActive && !excluded;
  if (status === "decision_queue") return decisionQueueActive;
  if (status === "needs_work") return lowConfidence || unreviewed || recrawl || manual
    || workKey === "missingRevenue" || workKey === "missingReservation" || channelReviewNeeded || decisionQueueActive;
  if (status === "low_confidence") return lowConfidence;
  if (status === "unreviewed") return unreviewed;
  if (status === "recrawl") return recrawl;
  if (status === "manual") return manual;
  if (status === "contact_ready") return contactReady;
  if (status === "reviewed") return Boolean(reviewStatus) && !excluded;
  if (status === "excluded") return excluded;
  return true;
}

function fixture(queueProfile) {
  return vm.runInNewContext(`${declaration}\nadminDbStatusMatches`, { companyDecisionQueueProfile: queueProfile });
}

test("all status results equal the previous implementation over seeded combinations", () => {
  let seed = 0x5731b0a9;
  const pick = values => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[seed % values.length];
  };
  const statuses = ["all", "decision_queue", "needs_work", "low_confidence", "unreviewed", "recrawl", "manual",
    "contact_ready", "reviewed", "excluded", "unknown", "", null, undefined];
  const reviews = [undefined, null, {}, { status: "contact_ready" }, { status: "exclude" }, { status: "manual_needed" },
    { status: "recrawl_needed" }, { status: "confirmed" }, { status: "hold" }];
  const queueProfile = company => ({ inQueue: Boolean(company.testInQueue) });
  const actual = fixture(queueProfile);
  for (let index = 0; index < 2048; index++) {
    const row = {
      company: { adminReview: pick(reviews), salesTarget: { category: pick([undefined, "", "contact", "exclude"]) },
        salesContact: { status: pick([undefined, "", "excluded", "contacted"]) }, testInQueue: pick([true, false]) },
      metrics: { adminReview: pick(reviews), lowConfidence: pick([undefined, null, false, true]),
        confidenceScore: pick([undefined, null, 0, 1, 2, 3, 4, "2", "invalid"]),
        workType: { key: pick([undefined, "", "recrawl", "manual", "missingRevenue", "missingReservation", "ready"]) },
        channels: { reviewNeeded: pick([undefined, null, 0, 1, 2, "1", "invalid"]) } }
    };
    const before = JSON.stringify(row);
    for (const status of statuses) assert.equal(actual(row, status), previousStatusMatches(row, status, queueProfile),
      `seeded case ${index}, status ${String(status)}`);
    assert.equal(JSON.stringify(row), before, "filtering must not modify company data");
  }
  for (const row of [{}, { company: null, metrics: null }, { metrics: {} }]) {
    for (const status of statuses) assert.equal(actual(row, status), previousStatusMatches(row, status, queueProfile));
  }
});

test("unrelated statuses and decisive local fields skip the unused queue profile", () => {
  const calls = [];
  const actual = fixture(company => { calls.push(company); return { inQueue: false }; });
  const base = { company: { adminReview: { status: "confirmed" } }, metrics: { confidenceScore: 4 } };
  for (const status of ["all", "low_confidence", "unreviewed", "recrawl", "manual", "reviewed", "excluded", "unknown", "", null]) {
    actual(base, status);
  }
  assert.equal(calls.length, 0, "non-queue status filters should not construct the profile");
  for (const row of [
    { ...base, metrics: { lowConfidence: true } },
    { ...base, metrics: { confidenceScore: 2 } },
    { company: {}, metrics: { confidenceScore: 4 } },
    { ...base, metrics: { confidenceScore: 4, workType: { key: "recrawl" } } },
    { ...base, metrics: { confidenceScore: 4, workType: { key: "manual" } } },
    { ...base, metrics: { confidenceScore: 4, workType: { key: "missingRevenue" } } },
    { ...base, metrics: { confidenceScore: 4, workType: { key: "missingReservation" } } },
    { ...base, metrics: { confidenceScore: 4, channels: { reviewNeeded: 1 } } }
  ]) assert.equal(actual(row, "needs_work"), true);
  assert.equal(calls.length, 0, "already true work predicates should short-circuit");
  for (const company of [
    { adminReview: { status: "confirmed" } },
    { adminReview: { status: "contact_ready" }, salesTarget: { category: "exclude" } },
    { adminReview: { status: "contact_ready" }, salesContact: { status: "excluded" } },
    { adminReview: { status: "exclude" }, salesTarget: { category: "contact" } }
  ]) assert.equal(actual({ company }, "contact_ready"), false);
  assert.equal(calls.length, 0, "non-candidates and excluded contact candidates need no queue profile");
  actual(base, "decision_queue");
  actual(base, "needs_work");
  actual({ company: { adminReview: { status: "contact_ready" } } }, "contact_ready");
  assert.equal(calls.length, 3, "each necessary evaluation computes its own current profile once");
});

test("queue-dependent results are evaluated again after the same company changes", () => {
  let inQueue = false, calls = 0;
  const actual = fixture(() => { calls++; return { inQueue }; });
  const row = { company: { adminReview: { status: "contact_ready" } }, metrics: { confidenceScore: 4 } };
  assert.equal(actual(row, "decision_queue"), false);
  assert.equal(actual(row, "needs_work"), false);
  assert.equal(actual(row, "contact_ready"), true);
  inQueue = true;
  assert.equal(actual(row, "decision_queue"), true);
  assert.equal(actual(row, "needs_work"), true);
  assert.equal(actual(row, "contact_ready"), false);
  assert.equal(calls, 6, "there is no persistent memoization across changes");
});
