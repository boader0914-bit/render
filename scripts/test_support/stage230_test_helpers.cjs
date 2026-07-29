"use strict";

const fs = require("node:fs");
const path = require("node:path");
const stage229 = require("./stage229_test_helpers.cjs");

const ROOT = stage229.ROOT;
const WORKFLOW_FIXTURE_PATH = path.join(
  ROOT,
  "test",
  "fixtures",
  "stage230",
  "strategy_workflow_cases_v1.json"
);

function stage230Fixture() {
  return JSON.parse(fs.readFileSync(WORKFLOW_FIXTURE_PATH, "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function strategySession(role, tenantCompanyId = "", suffix = role, plan = role === "admin" ? "pro" : "basic") {
  const current = stage229.session(role, tenantCompanyId, suffix);
  current.plan = plan;
  current.entitlements = {
    plan,
    dailySearchLimit: plan === "pro" ? 100 : plan === "basic" ? 20 : 2,
    searchWindowDays: plan === "pro" ? 30 : plan === "basic" ? 14 : 7,
    monthlyExportLimit: plan === "pro" ? 30 : plan === "basic" ? 5 : 0,
    concurrentExportLimit: plan === "pro" ? 2 : plan === "basic" ? 1 : 0,
    expandedSearchAllowed: plan !== "free"
  };
  return current;
}

function stage230Error(message, code, statusCode = 400) {
  const reason = new Error(message);
  reason.code = code;
  reason.statusCode = statusCode;
  return reason;
}

function applyReportPatch(report, patch = {}) {
  const next = clone(report);
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value && typeof value === "object" && !Array.isArray(value)
      ? { ...(next[key] || {}), ...clone(value) }
      : clone(value);
  }
  return next;
}

function createMockStage230Dependencies(options = {}) {
  const fixture = stage230Fixture();
  const publishedReport = applyReportPatch(fixture.publishedReport, options.reportPatch || {});
  const reports = new Map([[publishedReport.reportId, publishedReport]]);
  const companies = new Map([
    [fixture.companyId, {
      companyId: fixture.companyId,
      companyName: "Stage 230 내 숙소",
      name: "Stage 230 내 숙소",
      region: "Stage 230 합성 지역",
      regionLabel: "Stage 230 합성 지역",
      tenantCompanyIds: [fixture.tenantCompanyId],
      synthetic: true
    }],
    ["cmp_place_stage230_other", {
      companyId: "cmp_place_stage230_other",
      companyName: "Stage 230 다른 업체",
      name: "Stage 230 다른 업체",
      region: "Stage 230 격리 지역",
      regionLabel: "Stage 230 격리 지역",
      tenantCompanyIds: ["tenant_stage230_two"],
      synthetic: true
    }]
  ]);

  function tenantForCompany(companyId) {
    return companies.get(companyId)?.tenantCompanyIds?.[0] || "";
  }

  function assertTenant(session, tenantCompanyId) {
    if (session?.account?.role === "admin") return;
    const own = session?.memberships?.some((membership) => membership.companyId === tenantCompanyId);
    if (!own) throw stage230Error("tenant access denied", "STRATEGY_TENANT_FORBIDDEN", 403);
  }

  const authService = {
    assertCompanyAccess(session, tenantCompanyId) {
      assertTenant(session, tenantCompanyId);
      const subject = [...companies.values()].find((row) => row.tenantCompanyIds.includes(tenantCompanyId));
      if (!subject) throw stage230Error("tenant is required", "STRATEGY_TENANT_REQUIRED", 422);
      return {
        company: { companyId: tenantCompanyId, name: `${subject.companyName} tenant` },
        membership: session?.memberships?.find((row) => row.companyId === tenantCompanyId) || null,
        entitlements: clone(session?.entitlements || strategySession("business", tenantCompanyId).entitlements)
      };
    }
  };

  const freshService = {
    async getCompany(session, companyId, tenantCompanyId) {
      const company = companies.get(companyId);
      if (!company) throw stage230Error("company not found", "STRATEGY_COMPANY_NOT_FOUND", 404);
      assertTenant(session, tenantCompanyId);
      if (!company.tenantCompanyIds.includes(tenantCompanyId)) {
        throw stage230Error("company ownership denied", "STRATEGY_TENANT_FORBIDDEN", 403);
      }
      return clone(company);
    },
    async listCompanies(session, tenantCompanyId) {
      assertTenant(session, tenantCompanyId);
      return clone([...companies.values()].filter((company) => company.tenantCompanyIds.includes(tenantCompanyId)));
    }
  };

  const insightsService = {
    async listMonthlyReports(session, query = {}) {
      assertTenant(session, query.tenantCompanyId);
      const visible = [...reports.values()].filter((report) => (
        (!query.companyId || report.companyId === query.companyId)
        && (!query.month || report.month === query.month)
      ));
      return { ok: true, metadata: { stage: 229 }, reports: clone(visible) };
    }
  };

  return {
    authService,
    companies,
    fixture,
    freshService,
    insightsService,
    publishedReport,
    reports,
    tenantForCompany
  };
}

function businessSafeStrategyAssert(value, options = {}) {
  stage229.assertBusinessSafe(value, options);
  const json = JSON.stringify(value);
  for (const forbidden of [
    "evidenceSnapshotId",
    "observationId",
    "signalId",
    "cohortSnapshotHash",
    "sourceUrl",
    "sourceKey",
    "internalFormula",
    "ruleWeights",
    "otherCompanyIds"
  ]) {
    if (json.includes(forbidden)) throw new Error(`business response exposed ${forbidden}`);
  }
}

module.exports = {
  ...stage229,
  WORKFLOW_FIXTURE_PATH,
  applyReportPatch,
  businessSafeStrategyAssert,
  createMockStage230Dependencies,
  stage230Error,
  stage230Fixture,
  strategySession
};
