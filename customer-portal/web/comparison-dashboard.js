(function (root, factory) {
  'use strict';
  const commonJS = typeof module === 'object' && module.exports;
  const api = factory(commonJS ? require('./comparison-readiness.js') : root.InsightComparisonReadiness,
    commonJS ? require('./customer-operating-actions.js') : root.InsightCustomerOperatingActions);
  if (commonJS) module.exports = api;
  else root.InsightComparisonDashboard = api;
})(typeof window !== 'undefined' ? window : globalThis, function (readiness, operating) {
  'use strict';
  // A projection of the customer's already-authorized saved report. It never
  // requests, collects, stores, repairs or changes the source report or policy.
  const VERSION = 'customer-comparison-dashboard-v1', DAY = 86400000;
  const DAY_FILTERS = Object.freeze(['all', 'weekday', 'friday', 'saturday', 'sunday']);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const text = (value, fallback = '') => typeof value === 'string' && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value) ? value : fallback;
  const date = value => typeof value === 'string' && /^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  const unique = values => [...new Set(values)];
  const sum = (rows, key) => {
    if (!rows.length || rows.some(row => !count(row[key]))) return null;
    const value = rows.reduce((total, row) => total + row[key], 0);
    return count(value) ? value : null;
  };
  const rate = (sold, supply) => count(sold) && count(supply) && supply > 0 ? sold / supply : null;
  const kst = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10) : null;
  const allowsDay = (value, filter) => {
    const day = new Date(value + 'T00:00:00Z').getUTCDay();
    return filter === 'all' || filter === 'weekday' && day >= 1 && day <= 4
      || filter === 'friday' && day === 5 || filter === 'saturday' && day === 6 || filter === 'sunday' && day === 0;
  };
  function normalizeFilters(report, filters = {}) {
    const source = report?.period || {}, input = filters && typeof filters === 'object' && !Array.isArray(filters) ? filters : {};
    const start = input.start === undefined ? source.start : input.start, end = input.end === undefined ? source.end : input.end;
    const dayFilter = input.dayFilter === undefined ? 'all' : input.dayFilter;
    let reason = null;
    if (!date(source.start) || !date(source.end) || source.start > source.end
      || (Date.parse(source.end) - Date.parse(source.start)) / DAY >= 3660) reason = '저장 자료의 숙박기간을 확인해 주세요.';
    else if (!date(start) || !date(end) || start > end) reason = '시작일과 종료일을 올바르게 선택해 주세요.';
    else if (start < source.start || end > source.end) reason = '저장 자료가 있는 숙박기간 안에서 선택해 주세요.';
    else if (!DAY_FILTERS.includes(dayFilter)) reason = '표시할 요일을 다시 선택해 주세요.';
    const dates = reason ? [] : Array.from({length: (Date.parse(end) - Date.parse(start)) / DAY + 1}, (_, i) =>
      new Date(Date.parse(start + 'T00:00:00Z') + i * DAY).toISOString().slice(0, 10)).filter(value => allowsDay(value, dayFilter));
    return {valid: reason === null, start: date(start) ? start : null, end: date(end) ? end : null,
      dayFilter: DAY_FILTERS.includes(dayFilter) ? dayFilter : null, dates, reason};
  }
  const metric = (id, label, value, unit, status, detail, reason = null) => ({id, label, value, unit, status, detail, reason});
  function unavailableMetrics(reason) {
    return [metric('own_rate', '내 매장 추정예약률', null, '%', 'unavailable', '', reason),
      metric('peer_rate', '같은 지역·업종 표본예약률', null, '%', 'unavailable', '', reason),
      metric('product_price', '숙박상품 표시가격', null, '원', 'unavailable', '', '이 비교 자료에는 상품별 판매가격이 없습니다.'),
      metric('public_change', '공개예약 순변화', null, '실', 'unavailable', '', '이전 동일 조건 관측의 예약 순변화는 연결 전입니다.')];
  }
  function judgmentsFor(own, peers, daily, minimumDays = 7) {
    const matched = daily.filter(row => finite(row.ownRate) && finite(row.peerRate));
    const ownSupply = sum(matched, 'ownSupply'), ownSold = sum(matched, 'ownSold'), commonOwnRate = rate(ownSold, ownSupply);
    const gapPp = finite(commonOwnRate) && finite(peers.rate) ? (commonOwnRate - peers.rate) * 100 : null;
    const actionable = matched.length >= minimumDays && matched.every(row => row.actionable);
    const available = gapPp !== null;
    return [{id: 'reservation_level', label: '예약 수준', status: available && actionable ? 'ready' : 'hold',
      title: available ? '같은 조건의 예약 수준을 비교합니다.' : '공통 관측 자료를 먼저 확인합니다.',
      evidence: [own ? own.name + ' 유효 관측 ' + own.summary.days + '일' : '내 매장 관측 미확인',
        '같은 지역·업종 유효 표본 ' + peers.companies + '곳 · 공통 숙박일 ' + matched.length + '일',
        '내 매장과 표본의 같은 날짜·관측 기준으로 공급 가중 계산합니다.',
        ...(available ? ['공통 날짜의 내 매장 예약률 ' + (commonOwnRate * 100).toFixed(1) + '% · 표본 ' + (peers.rate * 100).toFixed(1) + '%'] : [])],
      nextAction: available ? '차이가 큰 숙박일의 상품·판매 조건과 관측 근거를 함께 확인하세요.' : '미확인 날짜와 동일지역·업종의 비교 제외 사유를 먼저 확인하세요.',
      reason: !available ? '비교 가능한 동일지역·업종의 공통 관측이 부족합니다.' : matched.length < minimumDays
        ? '선택 범위의 공통 숙박일이 최소 ' + minimumDays + '일보다 적어 수치 참고만 표시합니다.'
        : !actionable ? '중앙 비교의 행동 판단 보류를 유지합니다. 숫자 차이만으로 할인을 확정하지 않습니다.' : null,
      commonOwnRate, peerRate: peers.rate, gapPp, minimumDays, actionable, executionAllowed: false},
    {id: 'price_conditions', label: '가격 조건', status: 'hold', title: '같은 상품 조건의 가격 확인이 필요합니다.',
      evidence: ['이 비교 자료에는 숙박상품별 판매가격이 없습니다.', '예약 매출을 예약수량으로 나눈 값을 상품가격으로 대체하지 않습니다.'],
      nextAction: '업체 기본자료의 상품·인원·포함 혜택을 확인하고 쿠폰 계산에는 직접 입력한 가격 가정을 사용하세요.',
      reason: '상품별 판매가격과 동일 조건의 비교 근거가 연결 전입니다.', actionable: false, executionAllowed: false},
    {id: 'reservation_change', label: '예약 변화', status: 'hold', title: '다음 동일 조건 관측과 비교합니다.',
      evidence: ['현재 관측 한 회차의 예약 수준이며 신규 예약수나 예약 리드타임을 뜻하지 않습니다.', '이전 동일 숙박일·상품의 관측 증감은 연결 전입니다.'],
      nextAction: '같은 숙박일의 다음 저장 관측이 확보되면 공개예약 변화와 타채널 추정을 나눠 확인하세요.',
      reason: '이전 동일 조건 관측이 없어 순변화를 계산하지 않습니다.', actionable: false, executionAllowed: false}];
  }
  function empty(report, normalized, reason, contextValid = false) {
    const source = report?.period || {}, sourcePeriod = {start: date(source.start) ? source.start : null,
      end: date(source.end) ? source.end : null, days: count(source.days) ? source.days : 0, asOf: date(report?.asOf || source.start) ? report.asOf || source.start : null};
    const peers = {companyIds: [], companies: 0, expectedCompanies: 0, days: 0, sold: null, supply: null,
      publicBookings: null, phoneBookings: null, reservationRate: null, rate: null, coverage: null};
    return {version: VERSION, status: 'unavailable', contextValid, sourcePeriod,
      period: {start: normalized.start, end: normalized.end, days: 0, selectedDays: 0, baseStart: sourcePeriod.start, baseEnd: sourcePeriod.end, asOf: sourcePeriod.asOf},
      dates: [], filters: {start: normalized.start, end: normalized.end, dayFilter: normalized.dayFilter}, own: null, peers,
      metrics: unavailableMetrics(reason), judgments: judgmentsFor(null, peers, []), companies: [], daily: [],
      quality: {status: 'unavailable', issues: [{code: contextValid ? 'INVALID_FILTER' : 'CONTEXT_MISMATCH', label: reason}],
        missingDates: [], partialDays: 0, storedReferenceDays: 0, actionable: false, limits: [reason]}, executionAllowed: false};
  }
  function pointMap(company, p) {
    const series = company.reservationSeries, rows = new Map();
    if (series?.companyId !== company.companyId || series.period?.start !== p.start || series.period?.end !== p.end
      || series.asOf !== p.asOf || !Array.isArray(series.points)) return rows;
    for (const row of series.points) if (date(row?.date) && row.date >= p.start && row.date <= p.end) rows.set(row.date, rows.has(row.date) ? null : row);
    return rows;
  }
  function validPoint(row, company, ready, p, current) {
    if (ready?.coverageKnown !== true || ready.capacity?.conflict || ready.missingDays.includes(row?.date)
      || !row || row.quantityStatus !== 'ready' || row.missing !== false || row.inventoryConflict === true || row.capacityConflict === true
      || !count(company.rooms) || company.rooms < 1 || ![row.total, row.sold, row.publicBookings, row.phoneBookings].every(count)
      || row.total !== company.rooms || row.sold > row.total || row.sold !== row.publicBookings + row.phoneBookings
      || Array.isArray(row.codes) && row.codes.length || !finite(row.reservationRate) || Math.abs(row.reservationRate - row.sold / row.total) > 1e-10
      || !date(row.collectedDate) || row.collectedDate > p.asOf || current && Date.parse(p.asOf) - Date.parse(row.collectedDate) > 7 * DAY) return false;
    return row.collectedAt === null || kst(row.collectedAt) === row.collectedDate;
  }
  function summary(points) {
    const rows = points.filter(row => row.status === 'ready'), sold = sum(rows, 'sold'), supply = sum(rows, 'supply');
    const publicBookings = sum(rows, 'publicBookings'), phoneBookings = sum(rows, 'phoneBookings');
    return {days: rows.length, missingDays: points.length - rows.length, sold, supply, publicBookings, phoneBookings,
      reservationRate: rate(sold, supply), rate: rate(sold, supply), publicRate: rate(publicBookings, supply), inferredRate: rate(phoneBookings, supply)};
  }
  function project(report, selection, catalog = [], filters = {}) {
    const normalized = normalizeFilters(report, filters);
    if (!operating?.computeOperatingPlan || !readiness?.build) return empty(report, normalized, '저장 자료의 비교 검증 모듈을 확인하지 못했습니다.');
    // Keep the full report/selection for policy validation; filters never turn a
    // short or otherwise held sample into an eligible central comparison.
    const plan = operating.computeOperatingPlan(report, selection, catalog);
    if (!plan.contextValid) return empty(report, normalized, plan.limits?.[0] || '등록한 매장·기간의 자료를 확인해 주세요.');
    if (!normalized.valid) return empty(report, normalized, normalized.reason, true);
    const p = plan.period, selectedDates = new Set(normalized.dates), ready = readiness.build(report, selection);
    const sourcePeriod = {start: p.start, end: p.end, days: p.days, asOf: p.asOf};
    const selectedIds = [selection.ownCompanyId, ...selection.comparisonIds], raw = new Map(report.companies.filter(row => selectedIds.includes(row.companyId)).map(row => [row.companyId, row]));
    const pairMap = new Map(Object.values(plan.groups).flat().map(row => [row.companyId, row]));
    const readyMap = new Map(ready.companies.map(row => [row.companyId, row]));
    const companies = selectedIds.map(companyId => {
      const c = raw.get(companyId), q = readyMap.get(companyId), pair = pairMap.get(companyId), rows = pointMap(c, p);
      const points = normalized.dates.map(stayDate => {
        const row = rows.get(stayDate), valid = validPoint(row, c, q, p, selection.stayMode === 'upcoming30');
        const issues = q.issues.filter(value => !value.date || value.date === stayDate).map(value => ({code: value.code, label: value.label, scope: value.scope}));
        const partial = q.partialRevenue.rows.find(value => value.date === stayDate), stored = q.storedReference.rows.find(value => value.date === stayDate);
        return {date: stayDate, status: valid ? 'ready' : 'unavailable', sold: valid ? row.sold : null, supply: valid ? row.total : null,
          publicBookings: valid ? row.publicBookings : null, phoneBookings: valid ? row.phoneBookings : null,
          reservationRate: valid ? row.reservationRate : null, rate: valid ? row.reservationRate : null,
          collectedDate: valid ? row.collectedDate : null, collectedAt: valid ? row.collectedAt : null,
          reasons: valid ? [] : unique(issues.map(value => value.label).concat('정상 0실과 구별한 미확인 자료입니다.')),
          partialRevenue: partial ? {...partial} : null, storedReference: stored ? {...stored} : null};
      });
      const partialRows = points.flatMap(row => row.partialRevenue ? [row.partialRevenue] : []), storedRows = points.flatMap(row => row.storedReference ? [row.storedReference] : []);
      return {companyId, name: text(c.name, c.kind === 'own' ? '내 매장' : '등록 경쟁업체'), kind: c.kind,
        rooms: count(c.rooms) && c.rooms > 0 ? c.rooms : null, regionLabel: text(c.regionLabel, '지역 확인 필요'),
        regionRelation: c.kind === 'own' ? 'own' : pair?.regionRelation || 'unknown', industryRelation: c.kind === 'own' ? 'own' : pair?.industryRelation || 'unknown',
        comparable: pair?.comparable === true, actionable: pair?.actionable === true, capacity: {...q.capacity},
        summary: summary(points), points, partialRevenue: {days: partialRows.length, amount: sum(partialRows, 'amount'), rows: partialRows},
        storedReference: {days: storedRows.length, rows: storedRows},
        reasons: unique([...(pair?.reasons || []), ...q.issues.filter(value => !value.date || selectedDates.has(value.date)).map(value => value.label)])};
    });
    const own = companies[0], pointMaps = new Map(companies.map(row => [row.companyId, new Map(row.points.map(point => [point.date, point]))]));
    const eligible = plan.groups.same.filter(row => row.operatingPeerEligible), planDates = new Map(plan.days.map(row => [row.date, row]));
    const minimumDays = Math.max(7, ...ready.comparisons.filter(row => eligible.some(pair => pair.companyId === row.companyId)).map(row => count(row.minimumDays) ? row.minimumDays : 7));
    const filteredEligibility = new Map(eligible.map(pair => {
      const commonCount = normalized.dates.filter(stayDate => pointMaps.get(own.companyId).get(stayDate).status === 'ready'
        && pointMaps.get(pair.companyId).get(stayDate).status === 'ready'
        && planDates.get(stayDate).peers.observations.some(row => row.companyId === pair.companyId)).length;
      const pairMinimum = ready.comparisons.find(row => row.companyId === pair.companyId)?.minimumDays;
      return [pair.companyId, commonCount >= (count(pairMinimum) ? Math.max(7, pairMinimum) : 7)];
    }));
    const daily = normalized.dates.map(stayDate => {
      const ownPoint = pointMaps.get(own.companyId).get(stayDate), day = planDates.get(stayDate);
      const provenIds = new Set(day.peers.observations.map(row => row.companyId));
      const peers = ownPoint.status === 'ready' ? eligible.filter(pair => pair.comparable && provenIds.has(pair.companyId))
        .flatMap(pair => {const point = pointMaps.get(pair.companyId)?.get(stayDate); return point?.status === 'ready' ? [{...point, companyId: pair.companyId}] : [];}) : [];
      const peerSupply = sum(peers, 'supply'), peerSold = sum(peers, 'sold'), peerPublic = sum(peers, 'publicBookings'), peerInferred = sum(peers, 'phoneBookings');
      const peerRate = rate(peerSold, peerSupply), ownRate = ownPoint.rate;
      return {date: stayDate, ownRate, peerRate, ownPublicRate: rate(ownPoint.publicBookings, ownPoint.supply), ownInferredRate: rate(ownPoint.phoneBookings, ownPoint.supply),
        peerPublicRate: rate(peerPublic, peerSupply), peerInferredRate: rate(peerInferred, peerSupply),
        ownSold: ownPoint.sold, ownSupply: ownPoint.supply, peerSold, peerSupply, peerPublicBookings: peerPublic, peerPhoneBookings: peerInferred,
        peerCompanyIds: peers.map(row => row.companyId), peerCompanyCount: peers.length,
        gapPp: finite(ownRate) && finite(peerRate) ? (ownRate - peerRate) * 100 : null,
        status: finite(ownRate) && finite(peerRate) ? peers.every(row => filteredEligibility.get(row.companyId)) ? 'ready' : 'reference' : 'unavailable',
        comparable: finite(ownRate) && finite(peerRate) && peers.every(row => filteredEligibility.get(row.companyId)),
        actionable: day.policyActionable === true && peers.length > 0 && peers.length === day.peers.validCompanies && peers.every(row => filteredEligibility.get(row.companyId)),
        reasons: unique([...ownPoint.reasons, ...day.reviewReasons, ...(peers.length ? [] : ['같은 지역·업종의 공통 관측을 확인하지 못했습니다.'])])};
    });
    const matched = daily.filter(row => finite(row.ownRate) && finite(row.peerRate)), peerIds = unique(matched.flatMap(row => row.peerCompanyIds));
    const peerSupply = sum(matched, 'peerSupply'), peerSold = sum(matched, 'peerSold');
    const peers = {companyIds: peerIds, companies: peerIds.length, expectedCompanies: eligible.length, days: matched.length,
      sold: peerSold, supply: peerSupply, publicBookings: sum(matched, 'peerPublicBookings'), phoneBookings: sum(matched, 'peerPhoneBookings'),
      reservationRate: rate(peerSold, peerSupply), rate: rate(peerSold, peerSupply),
      coverage: normalized.dates.length && eligible.length ? matched.reduce((total, row) => total + row.peerCompanyCount, 0) / (normalized.dates.length * eligible.length) : null};
    const judgments = judgmentsFor(own, peers, daily, minimumDays), issues = ready.issues.map(value => ({code: value.code, label: value.label}));
    for (const company of companies) for (const value of readyMap.get(company.companyId).issues) if (!value.date || selectedDates.has(value.date)) issues.push({companyId: company.companyId, code: value.code, label: value.label, ...(value.date ? {date: value.date} : {})});
    const uniqueIssues = [...new Map(issues.map(value => [JSON.stringify(value), value])).values()];
    const missingDates = daily.filter(row => row.ownRate === null).map(row => row.date), partialDays = companies.reduce((total, row) => total + row.partialRevenue.days, 0), storedReferenceDays = companies.reduce((total, row) => total + row.storedReference.days, 0);
    const status = !own.summary.days ? 'unavailable' : missingDates.length || uniqueIssues.length || judgments[0].status === 'hold' ? 'partial' : 'ready';
    const metrics = [metric('own_rate', '내 매장 추정예약률', own.summary.rate, '%', own.summary.rate === null ? 'unavailable' : own.summary.missingDays ? 'partial' : 'ready',
      '선택 ' + normalized.dates.length + '일 중 유효 ' + own.summary.days + '일 · 공개예약 + 타채널 추정', own.summary.rate === null ? '유효한 객실 기준과 예약 수량을 확인하지 못했습니다.' : null),
    metric('peer_rate', '같은 지역·업종 표본예약률', peers.rate, '%', peers.rate === null ? 'unavailable' : peers.coverage < 1 || !judgments[0].actionable ? 'partial' : 'ready',
      '공통 숙박일 ' + peers.days + '일 · 유효 ' + peers.companies + '/' + peers.expectedCompanies + '곳 · 객실 공급 가중 · 내 매장 제외',
      peers.rate === null ? '동일지역·업종의 유효 공통 관측이 없습니다.' : '등록한 경쟁업체의 유효 표본이며 지역 전체 평균이 아닙니다.'),
    ...unavailableMetrics(null).slice(2)];
    return {version: VERSION, status, contextValid: true, sourcePeriod,
      period: {start: normalized.start, end: normalized.end, days: normalized.dates.length, selectedDays: normalized.dates.length, baseStart: p.start, baseEnd: p.end, asOf: p.asOf},
      filters: {start: normalized.start, end: normalized.end, dayFilter: normalized.dayFilter}, dates: normalized.dates.slice(), own, peers, metrics, judgments, companies, daily,
      quality: {status, issues: uniqueIssues, missingDates, partialDays, storedReferenceDays,
        actionable: judgments[0].actionable, preview: ready.source.preview, refreshing: ready.source.refreshing, refreshFailed: ready.source.refreshFailed,
        limits: unique([...plan.limits, '내 매장 예약률은 개별 유효 관측 소계이고 표본 비교는 같은 숙박일의 공통 관측만 사용합니다.',
          '기간·요일 필터는 표시 범위만 바꾸며 중앙의 최소 표본·관측 시차·행동 판단 보류를 해제하지 않습니다.',
          '부분 금액과 오래된 참고 자료는 정상 예약수량·예약률에 합산하지 않습니다.'])}, executionAllowed: false};
  }
  return Object.freeze({VERSION, DAY_FILTERS, normalizeFilters, project});
});
