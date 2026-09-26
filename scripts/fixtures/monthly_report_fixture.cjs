"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

async function seedMonthlyReportFixture(root) {
  const regionKey = "kr_gyeonggi_pocheon";
  const runIds = ["pocheon_glamping_20260801_090000", "pocheon_glamping_20260815_090000", "gyeonggi_glamping_20260815_090000"];
  const runs = runIds.map((id, index) => ({ id, keyword: index === 2 ? "경기글램핑" : "포천글램핑", searchMode: "keyword", collectionMode: "precision", collectionPurpose: "revenue_detail",
    checkIn: index ? "2026-08-15" : "2026-08-01", checkOut: "2026-09-01", completedAt: index ? "2026-08-15T00:00:00.000Z" : "2026-08-01T00:00:00.000Z",
    collectionQuality: { status: "complete" }, counts: { overall: 2 }, files: ["manifest.json"] }));
  const companies = {
    cmp_place_monthly_a: { companyId: "cmp_place_monthly_a", primaryName: "[모의] 숲빛 글램핑", addresses: ["경기도 포천시 모의 주소"], regions: ["포천"],
      placeIds: ["monthly_a"], manualCorrection: { lodgingBasisTotal: 10 }, keywords: {}, inventory: {} },
    cmp_place_monthly_b: { companyId: "cmp_place_monthly_b", primaryName: "[모의] 호수 글램핑", addresses: ["경기도 포천시 모의 주소"], regions: ["포천"],
      placeIds: ["monthly_b"], manualCorrection: { lodgingBasisTotal: 8 }, keywords: {}, inventory: {} }
  };
  const observations = [];
  for (const [index, run] of runs.entries()) {
    const dir = path.join(root, "outputs", run.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(run));
    for (const [companyIndex, company] of Object.values(companies).entries()) {
      const rank = companyIndex === 0 ? (index ? 2 : 4) : (index ? 4 : 2);
      const exposure = { runId: run.id, collectedAt: run.completedAt, rank };
      company.keywords[run.keyword] ||= { keyword: run.keyword, runs: [] };
      company.keywords[run.keyword].runs.push(exposure);
      for (let day = index ? 15 : 1; day <= 31; day++) {
        const date = `2026-08-${String(day).padStart(2, "0")}`;
        const total = company.manualCorrection.lodgingBasisTotal;
        const publicBookings = 2 + (day % 3) + (index ? 1 : 0);
        const phoneBookings = day % 7 > 4 ? 2 : 1;
        const price = day % 7 > 4 ? 220000 : 160000;
        observations.push({ observationId: `${run.id}_${company.companyId}_${date}`, companyKey: company.companyId, companyName: company.primaryName,
          runId: run.id, keyword: run.keyword, rank, region: "포천", productType: "lodging", stayDate: date, collectedAt: run.completedAt,
          inventoryEvidenceVersion: 4, total, supply: total, available: total - publicBookings - phoneBookings, sold: publicBookings + phoneBookings,
          publicBookings, phoneBookings, publicRevenue: publicBookings * price, phoneRevenue: phoneBookings * price,
          phonePricedBookings: phoneBookings, phoneMissingPriceBookings: 0, estimatedRevenue: (publicBookings + phoneBookings) * price,
          sharedDayUseExcluded: 0, unknownUnavailable: 0, partial: false, missing: false, inventoryConflict: false,
          dayUsePresence: "absent", dayUseScheduleStatus: "no_day_use_product", dayUseSharingStatus: "not_shared" });
      }
    }
  }
  await fs.mkdir(path.join(root, "company_master"), { recursive: true });
  await fs.mkdir(path.join(root, "history"), { recursive: true });
  await fs.writeFile(path.join(root, "company_master", "companies.json"), JSON.stringify({ companies }));
  await fs.writeFile(path.join(root, "history", "observations.jsonl"), observations.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { regionKey, companyId: "cmp_place_monthly_a", runIds, companies, observations };
}
module.exports = { seedMonthlyReportFixture };
