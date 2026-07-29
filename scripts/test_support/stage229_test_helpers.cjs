"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const stage227 = require("../test_stage227_helpers.cjs");

const ROOT = stage227.ROOT;
const SIGNAL_FIXTURE_PATH = path.join(ROOT, "test", "fixtures", "stage229", "signal_contract_v1.json");
const CASE_FIXTURE_PATH = path.join(ROOT, "test", "fixtures", "stage229", "location_forecast_cases_v1.json");
const NETWORK_PRELOAD_PATH = path.join(__dirname, "stage229_network_deny_preload.cjs");

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function stage229Fixtures() {
  return {
    signal: readJson(SIGNAL_FIXTURE_PATH),
    cases: readJson(CASE_FIXTURE_PATH)
  };
}

function observationsFor(testCase, companyId = testCase.tenantCompanyId) {
  const rows = [];
  let serial = 0;
  testCase.stockSeries.forEach((series, seriesIndex) => {
    const productKey = `stage229-product-${seriesIndex + 1}`;
    for (const point of series.points) {
      const common = {
        companyId,
        productKey,
        targetDate: series.stayDate,
        observedAt: point.observedAt,
        synthetic: true
      };
      rows.push({
        ...common,
        observationId: `obs_stage229_${companyId.replace(/[^a-z0-9]/gi, "")}_${++serial}`,
        kind: "product.total-stock",
        value: 10
      });
      rows.push({
        ...common,
        observationId: `obs_stage229_${companyId.replace(/[^a-z0-9]/gi, "")}_${++serial}`,
        kind: "product.available-stock",
        value: point.availableUnits
      });
    }
  });
  rows.push({
    observationId: `obs_stage229_${companyId.replace(/[^a-z0-9]/gi, "")}_${++serial}`,
    companyId,
    productKey: "stage229-product-1",
    targetDate: `${testCase.forecastInputMonth}-29`,
    observedAt: "2026-07-28T23:05:00.000Z",
    kind: "product.price",
    value: 150000,
    synthetic: true
  });
  rows.push({
    observationId: `obs_stage229_${companyId.replace(/[^a-z0-9]/gi, "")}_${++serial}`,
    companyId,
    productKey: "stage229-product-1",
    targetDate: `${testCase.forecastInputMonth}-29`,
    observedAt: "2026-07-28T23:10:00.000Z",
    channel: "fixture-ota",
    kind: "ota.exposure",
    value: true,
    synthetic: true
  });
  return rows;
}

function session(role, tenantCompanyId = "", suffix = role) {
  return {
    accountId: `account_stage229_${suffix}`,
    account: { accountId: `account_stage229_${suffix}`, role: role === "admin" ? "admin" : "b2b" },
    memberships: tenantCompanyId ? [{ companyId: tenantCompanyId, status: "active" }] : [],
    authenticatedAt: "2026-07-29T00:00:00.000Z",
    reauthenticatedAt: "2026-07-29T00:00:00.000Z"
  };
}

function error(message, code, statusCode) {
  const reason = new Error(message);
  reason.code = code;
  reason.statusCode = statusCode;
  return reason;
}

function createMockFreshLayer(options = {}) {
  const { cases } = stage229Fixtures();
  const readyCase = cases.cases.find((row) => row.id === "minimum-ready-boundary");
  const insufficientCase = cases.cases.find((row) => row.id === "cold-start-insufficient");
  const definitions = options.definitions || [
    {
      companyId: "cmp_place_stage229_tenant",
      tenantCompanyId: "tenant_stage229_one",
      companyName: "Stage 229 내 숙소",
      region: "Stage 229 합성 지역",
      testCase: readyCase
    },
    {
      companyId: "cmp_place_stage229_cohort_a",
      tenantCompanyId: "tenant_stage229_cohort_a",
      companyName: "Stage 229 익명 표본 A",
      region: "Stage 229 합성 지역",
      testCase: readyCase
    },
    {
      companyId: "cmp_place_stage229_cohort_b",
      tenantCompanyId: "tenant_stage229_cohort_b",
      companyName: "Stage 229 익명 표본 B",
      region: "Stage 229 합성 지역",
      testCase: readyCase
    },
    {
      companyId: "cmp_place_stage229_cohort_c",
      tenantCompanyId: "tenant_stage229_cohort_c",
      companyName: "Stage 229 익명 표본 C",
      region: "Stage 229 합성 지역",
      testCase: readyCase
    },
    {
      companyId: "cmp_place_stage229_other_tenant",
      tenantCompanyId: "tenant_stage229_two",
      companyName: "Stage 229 다른 tenant 숙소",
      region: "Stage 229 격리 지역",
      testCase: insufficientCase
    }
  ];
  const companies = new Map();
  const observations = new Map();
  for (const definition of definitions) {
    companies.set(definition.companyId, {
      companyId: definition.companyId,
      companyName: definition.companyName,
      name: definition.companyName,
      region: definition.region,
      regionLabel: definition.region,
      category: "glamping",
      tenantCompanyIds: [definition.tenantCompanyId],
      synthetic: true
    });
    observations.set(definition.companyId, observationsFor(definition.testCase, definition.companyId));
  }
  const clone = (value) => structuredClone(value);
  const tenantFor = (companyId) => companies.get(companyId)?.tenantCompanyIds?.[0] || "";
  const freshRepository = {
    async getCompany(companyId) {
      const company = companies.get(companyId);
      if (!company) throw error("fresh company not found", "FRESH_COMPANY_NOT_FOUND", 404);
      return clone(company);
    },
    async listCompanies() {
      return clone([...companies.values()]);
    },
    async listObservations(filter = {}) {
      return clone(observations.get(filter.companyId) || []);
    },
    async listRuns() {
      return clone(options.runs || []);
    }
  };
  const authService = {
    assertCompanyAccess(currentSession, requestedTenantCompanyId) {
      const own = currentSession?.memberships?.[0]?.companyId || "";
      if (!own || own !== requestedTenantCompanyId) {
        throw error("tenant access denied", "INSIGHTS_TENANT_FORBIDDEN", 403);
      }
      return true;
    },
    assertRecentReauthentication(currentSession) {
      if (!currentSession?.reauthenticatedAt) throw error("step-up required", "AUTH_REAUTHENTICATION_REQUIRED", 403);
      return true;
    }
  };
  const freshService = {
    async getCompany(currentSession, companyId, requestedTenantCompanyId) {
      const company = await freshRepository.getCompany(companyId);
      if (currentSession?.account?.role !== "admin") {
        authService.assertCompanyAccess(currentSession, requestedTenantCompanyId);
        if (tenantFor(companyId) !== requestedTenantCompanyId) {
          throw error("company ownership denied", "INSIGHTS_TENANT_FORBIDDEN", 403);
        }
      }
      return company;
    },
    async listCompanies(currentSession, requestedTenantCompanyId) {
      const rows = [...companies.values()];
      if (currentSession?.account?.role === "admin") return clone(rows);
      authService.assertCompanyAccess(currentSession, requestedTenantCompanyId);
      return clone(rows.filter((company) => company.tenantCompanyIds.includes(requestedTenantCompanyId)));
    }
  };
  return {
    companies,
    observations,
    freshRepository,
    freshService,
    authService,
    tenantFor,
    readyCase,
    insufficientCase
  };
}

function networkGuardEnvironment(logPath, extraEnv = {}) {
  const preload = NETWORK_PRELOAD_PATH.replaceAll("\\", "/");
  const existing = String(process.env.NODE_OPTIONS || "").trim();
  return {
    NODE_OPTIONS: `${existing}${existing ? " " : ""}--require=${preload}`,
    STAGE229_NETWORK_GUARD_LOG: logPath,
    ...extraEnv
  };
}

function networkAttempts(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function assertZeroNetworkAttempts(logPath) {
  assert.deepEqual(networkAttempts(logPath), [], "the Stage 229 child server attempted outbound network access");
}

function assertBusinessSafe(value, options = {}) {
  const allowedCompanyIds = new Set(options.allowedCompanyIds || []);
  const forbiddenKeys = /^(?:sourceUrl|sourceKey|rawEvidenceId|evidenceId|evidenceSnapshotId|snapshotId|signalId|observationIds|contentHash|requestKey|requestSignature|internal|formula|weights?|tenantCompanyId|actor|actorRole|stack|rawPayload)$/i;
  const forbiddenCompanyIds = new Set(options.forbiddenCompanyIds || []);
  const seen = new Set();
  function visit(current, keyPath = "response") {
    if (current && typeof current === "object") {
      if (seen.has(current)) return;
      seen.add(current);
      if (Array.isArray(current)) {
        current.forEach((entry, index) => visit(entry, `${keyPath}[${index}]`));
        return;
      }
      for (const [key, entry] of Object.entries(current)) {
        assert.doesNotMatch(key, forbiddenKeys, `business response exposed internal key ${keyPath}.${key}`);
        visit(entry, `${keyPath}.${key}`);
      }
      return;
    }
    if (typeof current !== "string") return;
    assert.doesNotMatch(current, /(?:[A-Za-z]:[\\/](?:Users|Program Files|Windows|legacy)|^\/(?:tmp|var|home)\/|\\\\)/i, `business response exposed a path at ${keyPath}`);
    assert.doesNotMatch(current, /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{16,}|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[A-Z0-9]{16}|\bAIza[A-Za-z0-9_-]{20,}|\bxox[baprs]-|\brnd_[A-Za-z0-9_-]{16,})/, `business response exposed a credential at ${keyPath}`);
    for (const companyId of forbiddenCompanyIds) {
      assert.equal(current.includes(companyId), false, `business response exposed another company id at ${keyPath}`);
    }
    const companyIdMatches = current.match(/cmp_[A-Za-z0-9._:-]+/g) || [];
    for (const companyId of companyIdMatches) {
      assert.ok(allowedCompanyIds.has(companyId), `business response exposed unexpected company id ${companyId} at ${keyPath}`);
    }
  }
  visit(value);
}

function temporaryDirectory(prefix = "stage229-validation-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = {
  ...stage227,
  ROOT,
  SIGNAL_FIXTURE_PATH,
  CASE_FIXTURE_PATH,
  NETWORK_PRELOAD_PATH,
  assertBusinessSafe,
  assertZeroNetworkAttempts,
  createMockFreshLayer,
  networkAttempts,
  networkGuardEnvironment,
  observationsFor,
  readJson,
  session,
  stage229Fixtures,
  temporaryDirectory
};
