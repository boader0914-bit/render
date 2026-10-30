(function (root) {
  "use strict";
  // Pure chart data from the existing selected monthly snapshot. No I/O.
  const commonJsBenchmark = typeof module !== "undefined" && module.exports ? require("./keyword-monthly-benchmark.js") : null;
  const known = value => typeof value === "number" && Number.isFinite(value);
  const divide = (value, denominator) => known(value) && denominator > 0 ? value / denominator : null;
  const sum = (rows, field) => { const value = rows.length ? rows.reduce((total, row) => total + row[field], 0) : null;
    return Number.isSafeInteger(value) && value >= 0 ? value : null; };
  const failure = code => ({ schemaVersion: 1, status: "needs_verification", code, readOnly: true, networkAttempted: false,
    selectedCompanyId: null, companies: [], monthly: null, daily: [], fairDaily: [], diagnostics: [code] });
  const datesIn = month => Array.from({ length: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate() },
    (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
  function channelSummary(base, rows, selected = false) {
    const publicBookings = sum(rows, "publicBookings"), phoneBookings = sum(rows, "phoneBookings");
    return { ...base, publicBookings, phoneBookings, publicRate: divide(publicBookings, base.supply), phoneRate: divide(phoneBookings, base.supply),
      totalRate: base.reservationRate, quantityKnown: base.observedCompanyDays > 0, rateKnown: known(base.reservationRate),
      availability: !base.observedCompanyDays ? "unknown" : !known(base.supply) ? "observed_quantity_unavailable" : base.supply > 0 ? "observed" : "observed_no_supply", selected };
  }
  function buildKeywordMonthlyDashboardModel(snapshot, options = {}) {
    const build = (root.KeywordMonthlyBenchmark || commonJsBenchmark)?.buildKeywordMonthlyBenchmark;
    if (typeof build !== "function") return failure("KEYWORD_MONTHLY_DASHBOARD_BENCHMARK_UNAVAILABLE");
    const benchmark = build(snapshot, options);
    if (benchmark.status === "needs_verification") return failure(benchmark.code);
    const dates = datesIn(benchmark.month), productType = benchmark.productType, selectedId = benchmark.selectedCompanyId;
    const byDate = new Map(dates.map(date => [date, []])), accepted = [];
    for (const row of snapshot.sources.observations) if (row?.productType === productType && byDate.has(row.date)) byDate.get(row.date).push(row);
    const daily = [];
    for (const date of dates) {
      // Per-date benchmark calls reuse its private eligibility and dedup contract.
      // Its month-denominator coverage is not used as daily coverage.
      const raw = byDate.get(date), day = build({ ...snapshot, sources: { ...snapshot.sources, observations: raw } }, { ...options, productType, companyId: selectedId });
      if (day.status === "needs_verification" || day.selectedCompanyId !== selectedId) return failure(day.code || "KEYWORD_MONTHLY_DASHBOARD_SELECTION_CHANGED");
      const unique = new Map();
      for (const row of raw) if (!unique.has(row.companyId)) unique.set(row.companyId, row);
      const rows = [];
      for (const company of day.companies) {
        if (!company.observedCompanyDays) continue;
        const row = unique.get(company.companyId);
        if (company.observedCompanyDays !== 1 || !row || row.supply !== company.supply || row.sold !== company.sold) return failure("KEYWORD_MONTHLY_DASHBOARD_ELIGIBILITY_MISMATCH");
        rows.push(row); accepted.push(row);
      }
      const selectedRows = rows.filter(row => row.companyId === selectedId), peers = rows.filter(row => row.companyId !== selectedId);
      const selected = channelSummary(day.selected || { observedCompanyDays: 0, supply: null, sold: null, reservationRate: null }, selectedRows, true);
      const whole = channelSummary(day.monthly.all, rows), peer = channelSummary(day.monthly.peers, peers);
      const rosterCount = benchmark.monthly.rosterCompanyCount, peerRosterCount = rosterCount - (selectedId ? 1 : 0);
      daily.push({ date, selectedRate: selected.totalRate, wholeRate: whole.totalRate, peerRate: peer.totalRate,
        selectedPublicRate: selected.publicRate, selectedPhoneRate: selected.phoneRate,
        wholePublicRate: whole.publicRate, wholePhoneRate: whole.phoneRate, peerPublicRate: peer.publicRate, peerPhoneRate: peer.phoneRate,
        selectedObserved: selected.quantityKnown, wholeObserved: whole.quantityKnown, peerObserved: peer.quantityKnown,
        selectedSupply: selected.supply, selectedSold: selected.sold, selectedPublicBookings: selected.publicBookings, selectedPhoneBookings: selected.phoneBookings,
        wholeSupply: whole.supply, wholeSold: whole.sold, wholePublicBookings: whole.publicBookings, wholePhoneBookings: whole.phoneBookings,
        peerSupply: peer.supply, peerSold: peer.sold, peerPublicBookings: peer.publicBookings, peerPhoneBookings: peer.phoneBookings,
        wholeCompanyCount: whole.companyCount, peerCompanyCount: peer.companyCount, rosterCompanyCount: rosterCount, peerRosterCompanyCount: peerRosterCount,
        wholeCoverageRate: divide(whole.companyCount, rosterCount), peerCoverageRate: divide(peer.companyCount, peerRosterCount),
        coverageBasis: "eligible_companies_over_roster_on_date", canCompare: selected.rateKnown && whole.rateKnown,
        canComparePeers: selected.rateKnown && peer.rateKnown,
        difference: selected.rateKnown && whole.rateKnown ? selected.totalRate - whole.totalRate : null,
        peerDifference: selected.rateKnown && peer.rateKnown ? selected.totalRate - peer.totalRate : null });
    }
    // The complete benchmark remains the authority for monthly totals and money.
    for (const company of benchmark.companies) {
      const rows = accepted.filter(row => row.companyId === company.companyId);
      if (sum(rows, "supply") !== company.supply || sum(rows, "sold") !== company.sold || rows.length !== company.observedCompanyDays) return failure("KEYWORD_MONTHLY_DASHBOARD_MONTHLY_COHORT_MISMATCH");
    }
    const companies = benchmark.companies.map((company, rosterIndex) => ({ ...channelSummary(company, accepted.filter(row => row.companyId === company.companyId), company.companyId === selectedId), rosterIndex }));
    const selected = companies.find(company => company.companyId === selectedId) || null;
    const whole = channelSummary(benchmark.monthly.all, accepted), peers = channelSummary(benchmark.monthly.peers, accepted.filter(row => row.companyId !== selectedId));
    const paired = new Map(benchmark.sameDates.daily.map(row => [row.date, row]));
    const fairDaily = dates.map(date => { const value = paired.get(date); return { date, paired: !!value, selectedRate: value?.selected.reservationRate ?? null,
      wholeRate: value?.all.reservationRate ?? null, peerRate: value?.peers.reservationRate ?? null, peerCompanyCount: value?.peerCompanyCount ?? 0,
      difference: known(value?.selected.reservationRate) && known(value?.all.reservationRate) ? value.selected.reservationRate - value.all.reservationRate : null,
      basis: "same_stay_date_same_lead_time_and_inventory_basis" }; });
    return { schemaVersion: 1, status: benchmark.status, code: benchmark.code, readOnly: true, networkAttempted: false, month: benchmark.month,
      productType, selectedCompanyId: selectedId, companies, monthly: { selected, whole, all: whole, peers, includesSelected: true,
        equalCompany: benchmark.monthly.equalCompany, rosterCompanyCount: benchmark.monthly.rosterCompanyCount }, daily, fairDaily,
      dailyBasis: "all_eligible_observations_on_each_stay_date", sameDatesSummary: benchmark.sameDates,
      identicalDuplicates: benchmark.identicalDuplicates, exclusions: benchmark.exclusions,
      notes: ["공개 예약과 방막기·타채널 추정 비율은 같은 유효 수량 표본의 공급으로 나눕니다.",
        "전체는 선택 업체를 포함한 공급 가중 비율이며 업체 동일가중 평균과 다릅니다.",
        "일별 전체의 관측 업체가 바뀔 수 있습니다. 동일 조건 비교는 별도 표본입니다.",
        "미관측은 null이며 선으로 연결하거나 0으로 채우지 않습니다. 실제 관측된 0과 구분합니다.",
        "기존 월별 금액 합계와 완전 가격 표본을 변경하거나 부분 금액을 합산하지 않습니다."] };
  }
  const api = Object.freeze({ buildKeywordMonthlyDashboardModel }); root.KeywordMonthlyDashboardModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
