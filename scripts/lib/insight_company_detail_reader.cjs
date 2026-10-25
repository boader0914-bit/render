"use strict";

const { createCompanyDetailStore } = require("./company_detail_store.cjs");
const VERSION = "insight-scoped-company-detail-v1";

// Insight must not load every company's inventory and observation history to
// display one linked company. Reuse the verified streaming saved-data reader,
// but keep its strict identity and cache separate from the admin detail view.
function createInsightCompanyDetailReader({ dataDir, outputsDir, projectionVersion, summarize,
  identityForCompany, runIdsForCompany, runWork, dayKey, integrationConnected = true,
  fileSystem, masterReader, historyReader, maxMemoryBytes } = {}) {
  if (typeof projectionVersion !== "string" || !projectionVersion || typeof summarize !== "function" || typeof identityForCompany !== "function"
    || typeof runWork !== "function" || typeof integrationConnected !== "boolean") {
    throw new TypeError("Insight company detail reader requires scoped projection and analytical ownership");
  }
  const identities = new WeakMap();
  const store = createCompanyDetailStore({ dataDir, outputsDir,
    projectionVersion: `${projectionVersion}:${VERSION}:${integrationConnected ? "integrated" : "legacy"}`,
    cacheNamespace: `insight_detail_read_models_v1_${integrationConnected ? "integrated" : "legacy"}`,
    dayKey, fileSystem, masterReader, historyReader, maxMemoryBytes, runIdsForCompany,
    matchesObservation: (row, company) => {
      if (!identities.has(company)) identities.set(company, identityForCompany(company).companyIds);
      const id = String(row.companyKey || row.companyId || "").trim().toLowerCase();
      return identities.get(company).has(id);
    },
    build: (companyId, detailSources) => summarize(companyId, { strictIdentity: true,
      includeObservationFlow: !integrationConnected, detailSources })
  });
  // Join the store's same-company flight only AFTER acquiring the shared lease.
  // Joining a queued outer promise before admission can deadlock a nested caller
  // that already owns the lease. Existing saved-detail reuse avoids a second
  // source build for separately admitted requests to that same company.
  const read = companyId => runWork(async () => (await store.get(companyId)).data,
    { priority: "foreground", kind: "insight-company-detail" });
  // Internal adapter capability: the customer connection can own the complete
  // monthly/detail/evidence read without changing the app's calculator wiring.
  Object.defineProperty(read, "runWork", { value: runWork });
  return read;
}

module.exports = { createInsightCompanyDetailReader, VERSION };
