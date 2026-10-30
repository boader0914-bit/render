(function (root) {
  "use strict";
  // Pure calculations over the selected, deduplicated monthly snapshot. No I/O.
  const known = value => typeof value === "number" && Number.isFinite(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const mean = values => values.length && values.every(known) ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const sum = (rows, key) => { if (!rows.length || !rows.every(row => known(row[key]))) return null; const value = rows.reduce((total, row) => total + row[key], 0); return known(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null; };
  const divide = (a, b) => known(a) && b > 0 ? a / b : null;
  const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
  const date = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const id = value => typeof value === "string" && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);
  const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };
  function quantityReason(row) {
    if (!["complete", "reused"].includes(row.runQuality)) return row.runQuality === "partial" ? "partial_run" : "run_quality_unknown_or_ineligible";
    if (["partial", "missing", "error", "failed", "sharedDayUseIncomplete", "recalculationUnavailable", "inventoryConflict", "capacityConflict"].some(key => row[key] === true)
      || known(row.unknownUnavailable) && row.unknownUnavailable > 0) return "partial_or_invalid_quantity";
    if (!["supply", "sold", "publicBookings", "phoneBookings"].every(key => count(row[key]))) return "quantity_unknown";
    if (row.sold > row.supply || row.sold !== row.publicBookings + row.phoneBookings) return "quantity_conflict";
    return "";
  }
  function completePrice(row) {
    return row.revenueEligible === true && row.revenuePartial === false
      && ["estimatedRevenue", "publicRevenue", "phoneRevenue"].every(key => known(row[key]) && row[key] >= 0)
      && Math.abs(row.estimatedRevenue - row.publicRevenue - row.phoneRevenue) < 1
      && !(row.sold > 0 && row.estimatedRevenue === 0)
      && !(row.publicBookings === 0 && row.publicRevenue > 0) && !(row.phoneBookings === 0 && row.phoneRevenue > 0);
  }
  function totals(rows, days, companyCount) {
    const priced = rows.filter(completePrice), supply = sum(rows, "supply"), sold = sum(rows, "sold");
    return { companyCount, observedCompanyDays: rows.length, expectedCompanyDays: days * companyCount,
      coverageRate: divide(rows.length, days * companyCount), supply, sold, reservationRate: divide(sold, supply),
      soldPerObservedCompanyDay: divide(sold, rows.length),
      completePriceCompanyDays: priced.length, completePriceCompanyCount: new Set(priced.map(row => row.companyId)).size, completePriceAmount: sum(priced, "estimatedRevenue"),
      amountPerCompletePriceCompanyDay: divide(sum(priced, "estimatedRevenue"), priced.length) };
  }
  function companyMean(companies) {
    const take = field => companies.map(company => company[field]).filter(known);
    const rates = take("reservationRate"), quantities = take("soldPerObservedCompanyDay"), money = take("amountPerCompletePriceCompanyDay");
    return { companyCount: companies.filter(company => company.observedCompanyDays > 0).length,
      reservationRate: mean(rates), reservationRateCompanyCount: rates.length,
      soldPerObservedCompanyDay: mean(quantities), quantityCompanyCount: quantities.length,
      amountPerCompletePriceCompanyDay: mean(money), completePriceCompanyCount: money.length };
  }
  function pairedReason(selected, peer, productType) {
    if (!count(selected.observationLeadTimeDays) || !count(peer.observationLeadTimeDays)) return "observation_timing_unknown";
    if (selected.observationLeadTimeDays !== peer.observationLeadTimeDays) return "observation_timing_changed";
    if (!Number.isSafeInteger(selected.inventoryEvidenceVersion) || selected.inventoryEvidenceVersion <= 0 || !Number.isSafeInteger(peer.inventoryEvidenceVersion) || peer.inventoryEvidenceVersion <= 0) return "inventory_basis_unknown";
    if (selected.inventoryEvidenceVersion !== peer.inventoryEvidenceVersion) return "inventory_basis_changed";
    const sharing = new Set(["not_shared", "shared", "confirmed_shared", "confirmed_not_shared", "independent"]);
    if (productType === "dayuse" && (!sharing.has(selected.dayUseSharingStatus) || !sharing.has(peer.dayUseSharingStatus))) return "sharing_basis_unknown";
    if (productType === "dayuse" && selected.dayUseSharingStatus !== peer.dayUseSharingStatus) return "sharing_basis_changed";
    return "";
  }
  function paired(snapshotRows, selectedId, days, productType) {
    const selectedRows = snapshotRows.filter(row => row.companyId === selectedId), peersByDate = new Map();
    for (const row of snapshotRows) if (row.companyId !== selectedId) { const rows = peersByDate.get(row.date) || []; rows.push(row); peersByDate.set(row.date, rows); }
    const chosen = [], peers = [], selectedMoney = [], peerMoney = [], daily = [], exclusions = {};
    const usedPeerIds = new Set(), usedPricePeerIds = new Set();
    for (const row of selectedRows) {
      const candidates = peersByDate.get(row.date) || [], accepted = [];
      if (!candidates.length) bump(exclusions, "no_peer_on_selected_date");
      for (const peer of candidates) { const reason = pairedReason(row, peer, productType); if (reason) bump(exclusions, reason); else accepted.push(peer); }
      if (!accepted.length) continue;
      chosen.push(row); peers.push(...accepted); accepted.forEach(peer => usedPeerIds.add(peer.companyId));
      // The selected company is added once per date, not once per matched peer.
      const quantity = { date: row.date, peerCompanyCount: accepted.length,
        selected: totals([row], 1, 1), all: totals([row, ...accepted], 1, accepted.length + 1), peers: totals(accepted, 1, accepted.length) };
      const pricedPeers = completePrice(row) ? accepted.filter(peer => {
        if (!completePrice(peer)) return false;
        if (!row.phoneValuationPolicy || !peer.phoneValuationPolicy) { bump(exclusions, "price_policy_unknown"); return false; }
        if (row.phoneValuationPolicy !== peer.phoneValuationPolicy) { bump(exclusions, "price_policy_changed"); return false; }
        return true;
      }) : [];
      if (pricedPeers.length) { selectedMoney.push(row); peerMoney.push(...pricedPeers); pricedPeers.forEach(peer => usedPricePeerIds.add(peer.companyId)); }
      quantity.completePricePeerCount = pricedPeers.length; daily.push(quantity);
    }
    const moneyRows = rows => ({ observedCompanyDays: rows.length, amountPerCompletePriceCompanyDay: divide(sum(rows, "estimatedRevenue"), rows.length) });
    const counts = daily.map(row => row.peerCompanyCount);
    return { basis: "same_stay_date_same_lead_time_and_inventory_basis", dateCount: chosen.length, expectedSelectedDates: selectedRows.length,
      selectedDateCoverageRate: divide(chosen.length, selectedRows.length), peerCompanyCount: usedPeerIds.size,
      peerCountMin: counts.length ? Math.min(...counts) : null, peerCountMax: counts.length ? Math.max(...counts) : null,
      selected: totals(chosen, days, selectedId ? 1 : 0), all: totals([...chosen, ...peers], days, usedPeerIds.size + (chosen.length ? 1 : 0)),
      peers: totals(peers, days, usedPeerIds.size),
      completePrice: { dateCount: selectedMoney.length, peerCompanyCount: usedPricePeerIds.size,
        selected: moneyRows(selectedMoney), all: moneyRows([...selectedMoney, ...peerMoney]), peers: moneyRows(peerMoney) },
      exclusions, daily };
  }
  function buildKeywordMonthlyBenchmark(snapshot, options = {}) {
    const productType = options.productType || "lodging", month = snapshot?.request?.month;
    const unavailable = (code, detail = {}) => ({ status: "needs_verification", code, productType, selectedCompanyId: null, companies: [], monthly: null, sameDates: null, ...detail });
    if (!["lodging", "dayuse"].includes(productType) || !MONTH.test(month || "") || !Array.isArray(snapshot?.companies)
      || !Array.isArray(snapshot?.sources?.observations)) return unavailable("BENCHMARK_SNAPSHOT_EVIDENCE_MISSING");
    const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate(), roster = new Map();
    for (const company of snapshot.companies) {
      if (!id(company.companyId) || roster.has(company.companyId)) return unavailable("BENCHMARK_COMPANY_IDENTITY_CONFLICT");
      roster.set(company.companyId, { companyId: company.companyId, name: company.primaryName || company.name || company.companyName || company.companyId });
    }
    const unique = new Map(), rows = [], exclusions = {}; let identicalDuplicates = 0;
    for (const row of snapshot.sources.observations) {
      if (!row || row.productType !== productType) continue;
      if (!roster.has(row.companyId)) { bump(exclusions, "company_outside_snapshot"); continue; }
      if (!date(row.date) || !row.date.startsWith(`${month}-`)) { bump(exclusions, "date_outside_month"); continue; }
      const key = JSON.stringify([row.companyId, row.date, productType]);
      if (unique.has(key)) {
        if (JSON.stringify(unique.get(key)) !== JSON.stringify(row)) return unavailable("BENCHMARK_DUPLICATE_OBSERVATION_CONFLICT");
        identicalDuplicates++; continue;
      }
      unique.set(key, row); const reason = quantityReason(row); if (reason) bump(exclusions, reason); else rows.push(row);
    }
    const companies = [...roster.values()].map(company => ({ ...company, ...totals(rows.filter(row => row.companyId === company.companyId), days, 1) }));
    const requested = id(options.companyId) ? options.companyId : null;
    const selectedCompanyId = requested && roster.has(requested) ? requested : companies.find(company => company.observedCompanyDays)?.companyId || companies[0]?.companyId || null;
    const selected = companies.find(company => company.companyId === selectedCompanyId) || null, peerCompanies = companies.filter(company => company.companyId !== selectedCompanyId);
    const observedCompanies = companies.filter(company => company.observedCompanyDays > 0), peerRows = rows.filter(row => row.companyId !== selectedCompanyId);
    const sameDates = paired(rows, selectedCompanyId, days, productType);
    return { status: rows.length ? "available" : "missing", code: rows.length ? null : "BENCHMARK_NO_ELIGIBLE_OBSERVATIONS", productType, month,
      selectedCompanyId, selected, companies, exclusions, identicalDuplicates,
      monthly: { basis: "observed_month_snapshot", includesSelected: true, rosterCompanyCount: roster.size,
        all: totals(rows, days, observedCompanies.length), peers: totals(peerRows, days, peerCompanies.filter(company => company.observedCompanyDays > 0).length),
        equalCompany: { basis: "mean_of_each_company_month_metric_once", all: companyMean(companies), peers: companyMean(peerCompanies) } },
      sameDates,
      notes: ["전체 평균은 선택 업체를 포함합니다. 선택 제외 평균은 별도 열로 표시합니다.",
        "예약 추정률 전체 값은 예약 추정 수량 합계 ÷ 공급 합계입니다. 업체 동일가중 평균과 다릅니다.",
        "월 전체는 업체별 관측 날짜가 다를 수 있는 참고치입니다. 같은 날짜 비교는 선택 업체와 관측 선행일수·재고 기준이 맞는 자료만 사용합니다.",
        "가격이 완전한 관측일의 금액만 평균에 사용합니다. 부분 응답 금액은 넣지 않으며 실제 결제 매출이 아닙니다.",
        "관측 없는 업체·날짜는 0으로 채우지 않습니다. 표본 업체의 규모 차이와 표본 수를 함께 확인하세요."] };
  }
  const api = Object.freeze({ buildKeywordMonthlyBenchmark }); root.KeywordMonthlyBenchmark = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
