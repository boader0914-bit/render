"use strict";

function assertFixtureMode(env = process.env) {
  if (env.LODGING_E2E_FIXTURE_MODE !== "1") throw new Error("E2E fixture mode is disabled");
  if (String(env.NODE_ENV || "").toLowerCase() !== "test") throw new Error("E2E fixture mode is allowed only when NODE_ENV=test");
  if (env.RENDER || env.RENDER_SERVICE_ID || env.V2_PREVIEW_DATA_ROOT) throw new Error("E2E fixture mode is blocked in Render and Preview environments");
  return true;
}

function collectorEnvFromPlan(plan = {}) {
  const intent = plan.resolvedIntent || {};
  return {
    SEARCH_MODE: plan.resolvedSearchMode || "",
    PRODUCT_MODE: plan.productMode || "",
    SEARCH_INTENT: intent.intent || "",
    SEARCH_INTENT_CONFIDENCE: String(intent.confidence || 0),
    LODGING_CATEGORY_KEY: intent.lodgingCategoryKey || "",
    SEARCH_REGION_KEY: intent.region?.key || "",
    SEARCH_REGION_QUERY: intent.region?.query || "",
    SEARCH_COMPANY_NAME: intent.companyName || "",
    SEARCH_PLATFORM_KEY: intent.platformKey || "",
    SEARCH_CANDIDATE_MODE: plan.selectedSearchCandidate?.mode || "",
    SEARCH_CANDIDATE_QUERY: plan.selectedSearchCandidate?.query || ""
  };
}

module.exports = { assertFixtureMode, collectorEnvFromPlan };
