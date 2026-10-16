"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

function makeCompanyBootstrapMaster(count = 535, { evidenceRows = 100 } = {}) {
  const master = { schemaVersion: 1, updatedAt: "2026-10-16T01:00:00.000Z", companies: {}, sourceIndex: {}, duplicateResolutions: {} };
  for (let index = 0; index < count; index += 1) {
    const companyId = `cmp_place_bootstrap_${index}`;
    const keywords = {};
    for (const keyword of ["경남글램핑", "산청글램핑"]) keywords[keyword] = {
      keyword, keywordKey: keyword, runCount: 3, bestRank: index % 20 + 1, latestRank: index % 20 + 1,
      lastSeenAt: "2026-10-16T00:00:00.000Z", latestRunId: `bootstrap_${index}_latest`,
      keywordLayer: keyword === "경남글램핑" ? "regional" : "local",
      runs: [1, 2, 3].map(day => ({ runId: `bootstrap_${index}_${day}`, rank: index % 20 + 1, collectedAt: `2026-10-${String(day + 12).padStart(2, "0")}T00:00:00.000Z` }))
    };
    const snapshot = offset => {
      const productSnapshot = { schemaVersion: 1, inventoryEvidenceVersion: 4, runId: `bootstrap_${index}_${offset}`,
        collectedAt: "2026-10-16T00:00:00.000Z", capacityBasis: { count: 16, source: index === 0 ? "db_correction" : "observed_maximum", currentObservedMaximum: 16 },
        dateRange: { start: "2026-10-16", end: "2026-11-15" },
        products: Array.from({ length: 16 }, (_, room) => ({ name: `객실 ${room + 1}`, kind: "lodging", stock: 1, price: 160000 })),
        daily: Array.from({ length: 31 }, (_, day) => ({ date: new Date(Date.UTC(2026, 9, 16 + day)).toISOString().slice(0, 10), productType: "lodging", total: 16, rawTotal: 16, available: 10, publicBookings: 2, phoneBookings: 4, missing: false, estimatedRevenue: 960000 })),
        summary: { productCount: 16, lodgingProductCount: 16, dayUseProductCount: 0, dailyCount: 31 } };
      return { runId: productSnapshot.runId, collectedAt: productSnapshot.collectedAt, inventoryEvidenceVersion: 4,
        confidenceGrade: "C", structureLabel: "객실 수량 확인", structureFlags: ["grouped_range"],
        productTypeSummary: "글램핑", inventoryProductSummary: "숙박 16종", rooms: [{ name: "반려견 바비큐 수영장 세미나" }],
        stockBasis: { lodgingMaxTotal: 16 },
        salesSignal: { checkIn: "2026-10-16", dayUsePresence: "absent", dayUseMissing: true, structureWeak: true,
          lodgingBasisTotal: 16, lodging: { days: 31, totalSupply: 496, totalSold: 186, publicBookings: 62, averageRate: .375, fridayRate: .4, saturdayRate: .7, sundayRate: .3, weekdayRate: .2, minTotal: 16, maxTotal: 16 }, dayUse: { days: 0, totalSupply: 0, totalSold: 0, averageRate: null } },
        revenue: { lodging: { revenue: 29760000, adjustedRevenue: 29760000, missingPriceEstimatedRevenue: 0, revenuePrecisionRate: 1,
          pricedSoldOut: 186, missingPriceSoldOut: 0, avgSoldUnitPrice: 160000, byDayType: "평일 96개 160000원 | 금요일 30개 160000원 | 토요일 30개 160000원 | 일요일 30개 160000원", offlineDetail: "타채널 124개", basis: "range",
          phonePriceEstimates: Array.from({ length: evidenceRows }, (_, row) => ({ date: "2026-10-16", productId: `room-${row}`, productName: "가격 산출 근거 모의 데이터", amount: 160000, source: "observed_unit_price", detail: "보존 원문이며 초기 목록에서 다운로드하지 않아야 함" })) },
          dayUse: { revenue: 0, adjustedRevenue: 0, missingPriceEstimatedRevenue: 0, pricedSoldOut: 0, missingPriceSoldOut: 0, byDayType: "", offlineDetail: "", basis: "range" } }, productSnapshot };
    };
    const latest = snapshot(3), previousLatest = snapshot(2);
    const company = { companyId, primaryName: `[모의] 산청 ${String(index + 1).padStart(3, "0")} 글램핑`, aliases: [`모의 업체 ${index + 1}`],
      placeIds: [`bootstrap_${index}`], bookingBusinessIds: [`booking_${index}`], addresses: ["경상남도 산청군 모의면 모의리"], regions: ["산청"], lodgingTypes: ["glamping"],
      firstSeenAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-10-16T00:00:00.000Z", runIds: [latest.runId, previousLatest.runId], lastRunId: latest.runId,
      collectionSources: ["admin_search"], sourceRoles: ["admin"], keywords, inventory: { latest, previousLatest, snapshots: [latest, previousLatest, snapshot(1)] },
      adminReview: index < Math.min(23, count) ? { status: "confirmed", updatedAt: "2026-10-17T00:00:00.000Z" } : null,
      naverChannelObservation: { status: "observed_on_naver", naverBookingObserved: true }, channelExposures: { yeogi: { status: "directly_verified", observedAt: "2026-10-16T00:00:00.000Z" } } };
    if (index === 0) { company.manualCorrection = { lodgingBasisTotal: 16, note: "모의 관리자 검수값", updatedAt: "2026-10-15T00:00:00.000Z" }; company.manualCorrectionRevision = 7; }
    master.companies[companyId] = company;
    master.sourceIndex[`place:bootstrap_${index}`] = companyId;
  }
  return master;
}

async function seedCompanyBootstrapFixture(root, options = {}) {
  const master = makeCompanyBootstrapMaster(options.count ?? 535, options);
  await fs.mkdir(path.join(root, "company_master"), { recursive: true });
  await fs.mkdir(path.join(root, "history"), { recursive: true });
  await fs.writeFile(path.join(root, "company_master", "companies.json"), JSON.stringify(master));
  await fs.writeFile(path.join(root, "history", "observations.jsonl"), "");
  return { master, companyId: Object.keys(master.companies)[0], totalCompanies: Object.keys(master.companies).length };
}

module.exports = { makeCompanyBootstrapMaster, seedCompanyBootstrapFixture };
