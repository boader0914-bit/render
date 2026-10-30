(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InsightComparisonSavedMetrics = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  // Read-only projection of an already-authorized company response. This module
  // never fetches, repairs or changes the source or any collection policy.
  const DAY = 86400000;
  const reasonLabels = Object.freeze({
    SOURCE_CONTEXT_MISMATCH: '선택한 업체·관측 기준과 저장 자료가 일치하지 않습니다.',
    PRICE_NOT_CONNECTED: '저장된 업체 상품가격을 아직 불러오지 못했습니다.',
    PRICE_MISSING: '선택한 숙박일에 정상 응답한 숙박상품 가격이 없습니다.',
    PRICE_PARTIAL: '가격이 확인된 상품·숙박일만 표시합니다. 빈 날짜는 0원으로 계산하지 않습니다.',
    PRICE_DUPLICATE_CONFLICT: '같은 상품·숙박일의 가격이 서로 달라 해당 가격을 제외했습니다.',
    PICKUP_NOT_CONNECTED: '저장된 통합관측의 증감 근거를 아직 불러오지 못했습니다.',
    PICKUP_NO_PREVIOUS_OBSERVATION: '같은 숙박일의 비교 가능한 이전 관측이 없습니다.',
    PICKUP_OUTSIDE_SELECTED_DATES: '저장된 예약 증감의 숙박일이 선택 기간·요일에 포함되지 않습니다.',
    PICKUP_INVALID_EVIDENCE: '관측 시각·수량 또는 중복 근거가 일치하지 않아 해당 증감을 제외했습니다.',
    PICKUP_REFERENCE_ONLY: '같은 관측 구간의 공개예약 수량 변화입니다. 신규 예약·취소 확정 수량과 구별합니다.',
    PICKUP_PUBLIC_ONLY_REFERENCE: '저장된 상품별 원본에서 같은 상품·숙박일의 공개예약만 비교한 참고값입니다. 타채널·전화예약 수량은 계산하지 않습니다.',
    PICKUP_RECENT_SUBSET: '제공된 최근 관측 근거만 사용합니다. 월 전체 또는 선택 기간 전체의 증감이 아닙니다.'
  });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const signed = value => Number.isSafeInteger(value);
  const count = value => signed(value) && value >= 0;
  const text = (value, length = 300) => typeof value === 'string' && value.length > 0 && value.length <= length && !/[\u0000-\u001f\u007f]/.test(value);
  const reference = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(value);
  const date = value => typeof value === 'string' && /^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value)
    && date(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const kst = value => new Date(value + 9 * 3600000).toISOString().slice(0, 10);
  const unique = values => [...new Set(values)];
  const reason = codes => ({reasonCode: codes[0] || null, reason: codes.length ? reasonLabels[codes[0]] : null, reasonCodes: unique(codes)});
  const blankPrice = code => ({value: null, min: null, max: null, products: 0, days: 0, rowCount: 0, rows: [], status: 'unavailable', ...reason([code]), source: null});
  const blankPickup = code => ({value: null, publicChange: null, inferredChange: null, days: 0, intervalCount: 0, rows: [], status: 'unavailable', ...reason([code]), source: null, limitations: []});
  const median = values => {
    const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
    return ordered.length ? ordered.length % 2 ? ordered[middle] : ordered[middle - 1] / 2 + ordered[middle] / 2 : null;
  };
  function prices(payload, options, selected) {
    const result = payload.result;
    if (!object(result)) return blankPrice('PRICE_NOT_CONNECTED');
    const observedAt = instant(result.collectedAt), range = result.range;
    if (result.companyId !== options.companyId || !reference(result.runId) || observedAt === null || kst(observedAt) > options.asOf
      || !object(range) || !date(range.start) || !date(range.end) || range.start > range.end || !count(range.days) || range.days < 1
      || (Date.parse(range.end) - Date.parse(range.start)) / DAY + 1 !== range.days
      || options.expectedRunId !== undefined && options.expectedRunId !== result.runId
      || options.expectedCollectedAt !== undefined && instant(options.expectedCollectedAt) !== observedAt) return blankPrice('SOURCE_CONTEXT_MISMATCH');
    if (!Array.isArray(result.products) || !['complete', 'partial'].includes(result.quality?.status)) return blankPrice('PRICE_MISSING');
    const rows = new Map(), conflicts = new Set(), productIds = new Set();
    let incomplete = result.truncated === true || result.quality.status !== 'complete', duplicateConflict = false;
    for (const product of result.products) {
      if (!object(product) || product.productType !== 'lodging') continue;
      const productId = text(product.bizItemId, 180) ? 'id:' + product.bizItemId : text(product.key, 180) ? 'key:' + product.key : null;
      if (!productId) { incomplete = true; continue; }
      productIds.add(productId);
      if (!Array.isArray(product.days)) { incomplete = true; continue; }
      for (const row of product.days) {
        if (!object(row) || !date(row.date) || !selected.has(row.date)) continue;
        const key = productId + '\u0000' + row.date;
        if (row.date < range.start || row.date > range.end || kst(observedAt) > row.date || row.status !== 'observed' || row.errorCode != null
          || !finite(row.price) || row.price < 0) { incomplete = true; rows.delete(key); conflicts.add(key); continue; }
        if (conflicts.has(key)) continue;
        const existing = rows.get(key);
        if (existing && existing.price !== row.price) { rows.delete(key); conflicts.add(key); duplicateConflict = true; continue; }
        if (!existing) rows.set(key, {date: row.date, productId, productName: text(product.name) ? product.name : '숙박상품', price: row.price});
      }
    }
    const entries = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.productId.localeCompare(b.productId));
    const codes = [ ...(duplicateConflict ? ['PRICE_DUPLICATE_CONFLICT'] : []), ...(incomplete || entries.length < productIds.size * selected.size ? ['PRICE_PARTIAL'] : []) ];
    if (!entries.length) return {...blankPrice(duplicateConflict ? 'PRICE_DUPLICATE_CONFLICT' : 'PRICE_MISSING'), source: {runId: result.runId, collectedAt: new Date(observedAt).toISOString()}};
    return {value: median(entries.map(row => row.price)), min: entries.reduce((value, row) => Math.min(value, row.price), Infinity), max: entries.reduce((value, row) => Math.max(value, row.price), -Infinity),
      products: unique(entries.map(row => row.productId)).length, days: unique(entries.map(row => row.date)).length, rowCount: entries.length,
      rows: entries, status: codes.length ? 'partial' : 'ready', ...reason(codes), source: {runId: result.runId, collectedAt: new Date(observedAt).toISOString()}};
  }
  function pickup(payload, options, selected) {
    const detail = payload.companyDetail, integrated = detail?.integrated, snapshot = integrated?.snapshot, source = snapshot?.analysis?.pickup;
    if (!object(integrated) || !object(snapshot) || !object(source) || !Array.isArray(source.intervals)) return blankPickup('PICKUP_NOT_CONNECTED');
    const period = snapshot.period, month = integrated.selectedMonth;
    if (detail.companyId !== options.companyId || integrated.companyId !== options.companyId || detail.legacyObservationView
      || integrated.status !== 'ready' || !text(integrated.calculationVersion, 180) || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month || '')
      || !object(period) || !date(period.start) || !date(period.end) || !date(period.cutoffDate) || period.start > period.end
      || period.cutoffDate > period.end || !period.start.startsWith(month + '-') || !period.end.startsWith(month + '-')) return blankPickup('SOURCE_CONTEXT_MISMATCH');
    if (!['ready', 'no_increase', 'insufficient'].includes(source.status)
      || source.status === 'insufficient' && source.intervals.length > 0) return blankPickup('PICKUP_INVALID_EVIDENCE');
    if (!source.intervals.length) return blankPickup('PICKUP_NO_PREVIOUS_OBSERVATION');
    const byKey = new Map(), conflicts = new Set();
    let selectedCandidates = 0, invalid = false;
    for (const row of source.intervals.slice(0, 240)) {
      if (!object(row) || !date(row.date) || !selected.has(row.date)) continue;
      selectedCandidates++;
      const previous = instant(row.previousCollectedAt), current = instant(row.collectedAt);
      if (row.date < period.start || row.date > period.end || !row.date.startsWith(month + '-') || previous === null || current === null || previous >= current
        || kst(current) > options.asOf || kst(current) > period.cutoffDate || kst(current) > row.date || kst(previous) > row.date
        || ![row.publicChange, row.blockedChange, row.netChange].every(signed) || row.netChange !== row.publicChange + row.blockedChange) { invalid = true; continue; }
      const key = JSON.stringify([row.date, previous, current]);
      if (conflicts.has(key)) continue;
      const value = {date: row.date, previousCollectedAt: new Date(previous).toISOString(), collectedAt: new Date(current).toISOString(),
        publicChange: row.publicChange, blockedChange: row.blockedChange, netChange: row.netChange};
      const existing = byKey.get(key);
      if (existing && ['publicChange', 'blockedChange', 'netChange'].some(field => existing[field] !== value[field])) { byKey.delete(key); conflicts.add(key); invalid = true; }
      else if (!existing) byKey.set(key, value);
    }
    const groups = new Map();
    for (const row of byKey.values()) {
      const key = row.previousCollectedAt + '\u0000' + row.collectedAt;
      const group = groups.get(key) || {previous: Date.parse(row.previousCollectedAt), current: Date.parse(row.collectedAt), rows: []};
      group.rows.push(row); groups.set(key, group);
    }
    // Never combine changes measured across different observation intervals.
    const ordered = [...groups.values()].sort((a, b) => b.current - a.current || b.rows.length - a.rows.length || b.previous - a.previous), latest = ordered[0];
    if (!latest) return blankPickup(!selectedCandidates ? 'PICKUP_OUTSIDE_SELECTED_DATES' : 'PICKUP_INVALID_EVIDENCE');
    const entries = latest.rows.sort((a, b) => a.date.localeCompare(b.date));
    const publicChange = entries.reduce((total, row) => total + row.publicChange, 0), inferredChange = entries.reduce((total, row) => total + row.blockedChange, 0);
    if (!signed(publicChange) || !signed(inferredChange) || source.status === 'no_increase' && entries.some(row => row.publicChange > 0)) return blankPickup('PICKUP_INVALID_EVIDENCE');
    const subset = source.intervals.length > 240 || count(source.comparableIntervals) && source.comparableIntervals > source.intervals.length;
    const codes = ['PICKUP_REFERENCE_ONLY', ...(subset ? ['PICKUP_RECENT_SUBSET'] : []), ...(invalid ? ['PICKUP_INVALID_EVIDENCE'] : [])];
    const limitations = [reasonLabels.PICKUP_REFERENCE_ONLY, '업체 통합자료에 저장된 계산 근거를 사용합니다. 관측 구간별 수집번호·객실 기준의 추가 검증 전에는 참고값으로 표시합니다.',
      ...(entries.length < selected.size ? ['선택 ' + selected.size + '일 중 같은 관측 구간으로 비교 가능한 ' + entries.length + '일만 반영했습니다.'] : []),
      ...(ordered.length > 1 ? ['관측 시각이 다른 ' + (ordered.length - 1) + '개 구간은 합산하지 않았습니다.'] : []),
      ...(integrated.roomBasis?.reviewRequired === true ? ['객실 총량 검토가 필요합니다. 예약률의 우열이나 쿠폰 실행 판단에는 사용하지 않습니다.'] : []),
      ...(subset ? [reasonLabels.PICKUP_RECENT_SUBSET] : []), ...(invalid ? [reasonLabels.PICKUP_INVALID_EVIDENCE] : [])];
    return {value: publicChange, publicChange, inferredChange, days: entries.length, intervalCount: entries.length, rows: entries,
      status: 'reference', ...reason(codes), source: {calculationVersion: integrated.calculationVersion,
        previousObservedAt: entries[0].previousCollectedAt, currentObservedAt: entries[0].collectedAt}, limitations};
  }
  function combinedPrice(payloads, options, selected) {
    const candidates = payloads.filter(payload => object(payload.result) && instant(payload.result.collectedAt) !== null
      && kst(instant(payload.result.collectedAt)) <= options.asOf);
    if (!candidates.length) return prices(payloads[0] || {}, options, selected);
    const ordered = candidates.sort((a, b) => instant(b.result.collectedAt) - instant(a.result.collectedAt));
    const latest = ordered[0].result, same = ordered.filter(payload => payload.result.runId === latest.runId && instant(payload.result.collectedAt) === instant(latest.collectedAt));
    if (ordered.some(payload => instant(payload.result.collectedAt) === instant(latest.collectedAt) && payload.result.runId !== latest.runId)
      || same.some(payload => JSON.stringify(payload.result.range) !== JSON.stringify(latest.range))) return blankPrice('SOURCE_CONTEXT_MISMATCH');
    const result = {...latest, products: same.flatMap(payload => Array.isArray(payload.result.products) ? payload.result.products : []),
      truncated: same.some(payload => payload.result.truncated === true), quality: {status: same.every(payload => payload.result.quality?.status === 'complete') ? 'complete'
        : same.every(payload => ['complete', 'partial'].includes(payload.result.quality?.status)) ? 'partial' : 'invalid'}};
    return prices({result}, options, selected);
  }
  function combinedPickup(payloads, options, selected) {
    const projected = payloads.map(payload => pickup(payload, options, selected));
    const available = projected.filter(row => row.status === 'reference');
    if (!available.length) {
      const codes = projected.map(row => row.reasonCode);
      return blankPickup(codes.includes('PICKUP_INVALID_EVIDENCE') ? 'PICKUP_INVALID_EVIDENCE'
        : codes.includes('SOURCE_CONTEXT_MISMATCH') ? 'SOURCE_CONTEXT_MISMATCH'
        : codes.includes('PICKUP_OUTSIDE_SELECTED_DATES') ? 'PICKUP_OUTSIDE_SELECTED_DATES'
        : codes.includes('PICKUP_NO_PREVIOUS_OBSERVATION') ? 'PICKUP_NO_PREVIOUS_OBSERVATION' : 'PICKUP_NOT_CONNECTED');
    }
    const versions = unique(available.map(row => row.source.calculationVersion));
    if (versions.length !== 1) return blankPickup('SOURCE_CONTEXT_MISMATCH');
    const ordered = available.sort((a, b) => Date.parse(b.source.currentObservedAt) - Date.parse(a.source.currentObservedAt)
      || Date.parse(b.source.previousObservedAt) - Date.parse(a.source.previousObservedAt));
    const latest = ordered[0], same = ordered.filter(row => row.source.currentObservedAt === latest.source.currentObservedAt
      && row.source.previousObservedAt === latest.source.previousObservedAt);
    const byDate = new Map(), conflicts = new Set();
    for (const row of same.flatMap(row => row.rows)) {
      if (conflicts.has(row.date)) continue;
      const old = byDate.get(row.date);
      if (old && ['publicChange', 'blockedChange', 'netChange'].some(field => old[field] !== row[field])) { byDate.delete(row.date); conflicts.add(row.date); }
      else if (!old) byDate.set(row.date, row);
    }
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) return blankPickup('PICKUP_INVALID_EVIDENCE');
    const publicChange = rows.reduce((total, row) => total + row.publicChange, 0), inferredChange = rows.reduce((total, row) => total + row.blockedChange, 0);
    if (!signed(publicChange) || !signed(inferredChange)) return blankPickup('PICKUP_INVALID_EVIDENCE');
    const expectedMonths = unique([...selected].map(value => value.slice(0, 7))), providedMonths = unique(payloads.map(payload => payload.companyDetail?.integrated?.selectedMonth));
    const missingMonth = expectedMonths.some(month => !providedMonths.includes(month));
    const reasonCodes = unique(['PICKUP_REFERENCE_ONLY', ...same.flatMap(row => row.reasonCodes), ...(conflicts.size ? ['PICKUP_INVALID_EVIDENCE'] : []), ...(missingMonth ? ['PICKUP_RECENT_SUBSET'] : [])]);
    return {...latest, value: publicChange, publicChange, inferredChange, days: rows.length, intervalCount: rows.length, rows,
      ...reason(reasonCodes), limitations: unique([reasonLabels.PICKUP_REFERENCE_ONLY,
        '업체 통합자료에 저장된 계산 근거를 사용합니다. 관측 구간별 수집번호·객실 기준의 추가 검증 전에는 참고값으로 표시합니다.',
        ...(rows.length < selected.size ? ['선택 ' + selected.size + '일 중 같은 관측 구간으로 비교 가능한 ' + rows.length + '일만 반영했습니다.'] : []),
        ...same.flatMap(row => row.limitations).filter(value => !/^선택 \d+일/.test(value)),
        ...(ordered.length > same.length ? ['다른 관측 구간의 수량은 합산하지 않았습니다.'] : []),
        ...(missingMonth ? ['일부 선택 월의 저장된 통합 증감 근거가 없어 확인된 월만 표시합니다.'] : []),
        ...(conflicts.size ? [reasonLabels.PICKUP_INVALID_EVIDENCE] : [])])};
  }
  function publicOnlyPickup(payloads, options, selected) {
    const ledgers = payloads.map(payload => payload.publicBookingPickup).filter(value => value !== undefined && value !== null);
    if (!ledgers.length) return null;
    const hash = value => typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value);
    const groups = new Map();
    let invalid = false, contextMismatch = false, matchingRows = 0, noPrevious = false;
    for (const ledger of ledgers) {
      if (!object(ledger) || ledger.companyId !== options.companyId) { contextMismatch = true; continue; }
      if (ledger.status === 'unavailable' && Array.isArray(ledger.rows) && ledger.rows.length === 0) {
        noPrevious = ledger.reasonCode === 'PICKUP_NO_PREVIOUS_OBSERVATION' || noPrevious;
        continue;
      }
      const source = ledger.source, previous = instant(source?.previousObservedAt), current = instant(source?.currentObservedAt);
      if (ledger.status !== 'reference' || ledger.calculationVersion !== 'public-booking-pickup-v1' || !object(source)
        || !reference(source.previousRunId) || !reference(source.currentRunId) || source.previousRunId === source.currentRunId
        || previous === null || current === null || previous >= current || kst(current) > options.asOf
        || !object(source.sourceDigests) || !hash(source.sourceDigests.previous) || !hash(source.sourceDigests.current)
        || source.ledgerDigest !== undefined && !hash(source.ledgerDigest)
        || !Array.isArray(ledger.rows) || ledger.rows.length < 1 || ledger.rows.length > 3660) { invalid = true; continue; }
      const canonical = {previousRunId: source.previousRunId, currentRunId: source.currentRunId,
        previousObservedAt: new Date(previous).toISOString(), currentObservedAt: new Date(current).toISOString(),
        sourceDigests: {previous: source.sourceDigests.previous.toLowerCase(), current: source.sourceDigests.current.toLowerCase()},
        ...(source.ledgerDigest ? {ledgerDigest: source.ledgerDigest.toLowerCase()} : {})};
      const key = JSON.stringify([canonical.previousRunId, canonical.currentRunId, previous, current, ledger.calculationVersion]);
      let group = groups.get(key);
      if (!group) { group = {previous, current, source: canonical, rows: new Map(), conflicts: new Set(), invalid: false}; groups.set(key, group); }
      if (JSON.stringify(group.source.sourceDigests) !== JSON.stringify(canonical.sourceDigests)) { group.invalid = true; invalid = true; continue; }
      for (const row of ledger.rows) {
        if (!object(row) || !date(row.date) || !selected.has(row.date)) continue;
        matchingRows++;
        const ids = Array.isArray(row.matchedProductIds) ? row.matchedProductIds : null;
        if (kst(current) > row.date || kst(previous) > row.date || !count(row.previousPublic) || !count(row.currentPublic)
          || !signed(row.publicChange) || row.publicChange !== row.currentPublic - row.previousPublic
          || !count(row.productCount) || row.productCount < 1 || row.productCount > 10000 || !ids
          || ids.length !== row.productCount || ids.some(id => !text(id, 180)) || unique(ids).length !== ids.length) {
          group.rows.delete(row.date); group.conflicts.add(row.date); invalid = true; continue;
        }
        if (group.conflicts.has(row.date)) continue;
        const out = {date: row.date, previousCollectedAt: canonical.previousObservedAt, collectedAt: canonical.currentObservedAt,
          previousPublic: row.previousPublic, currentPublic: row.currentPublic, publicChange: row.publicChange,
          productCount: row.productCount, matchedProductIds: [...ids].sort()};
        const old = group.rows.get(row.date);
        if (old && JSON.stringify(old) !== JSON.stringify(out)) { group.rows.delete(row.date); group.conflicts.add(row.date); invalid = true; }
        else if (!old) group.rows.set(row.date, out);
      }
    }
    const candidates = [...groups.values()].filter(group => !group.invalid && group.rows.size > 0)
      .sort((a, b) => b.current - a.current || b.previous - a.previous || a.source.currentRunId.localeCompare(b.source.currentRunId));
    const latest = candidates[0];
    if (!latest) return blankPickup(contextMismatch ? 'SOURCE_CONTEXT_MISMATCH' : invalid ? 'PICKUP_INVALID_EVIDENCE'
      : noPrevious ? 'PICKUP_NO_PREVIOUS_OBSERVATION' : !matchingRows ? 'PICKUP_OUTSIDE_SELECTED_DATES' : 'PICKUP_INVALID_EVIDENCE');
    // Equal observation times with different source runs are ambiguous. Do not
    // select one by input order or merge their quantities.
    if (candidates.some(group => group !== latest && group.current === latest.current && group.previous === latest.previous)) return blankPickup('PICKUP_INVALID_EVIDENCE');
    const rows = [...latest.rows.values()].sort((a, b) => a.date.localeCompare(b.date));
    const publicChange = rows.reduce((total, row) => total + row.publicChange, 0);
    if (!signed(publicChange)) return blankPickup('PICKUP_INVALID_EVIDENCE');
    return {value: publicChange, publicChange, inferredChange: null, days: rows.length, intervalCount: rows.length, rows,
      status: 'reference', ...reason(['PICKUP_PUBLIC_ONLY_REFERENCE', ...(invalid ? ['PICKUP_INVALID_EVIDENCE'] : [])]),
      source: {calculationVersion: 'public-booking-pickup-v1', ...latest.source},
      limitations: [reasonLabels.PICKUP_PUBLIC_ONLY_REFERENCE, '숙박상품의 공개예약만 비교합니다. 전체 예약수량·예약률·타채널 추정·전화예약·매출은 이 값으로 보완하지 않습니다.',
        ...(rows.length < selected.size ? ['선택 ' + selected.size + '일 중 원본에서 같은 상품으로 비교 가능한 ' + rows.length + '일만 반영했습니다.'] : []),
        ...(candidates.length > 1 ? ['이전의 다른 관측 구간은 합산하지 않았습니다.'] : []),
        ...(invalid ? [reasonLabels.PICKUP_INVALID_EVIDENCE] : [])]};
  }
  function selectedPickup(payloads, options, selected) {
    const integrated = combinedPickup(payloads, options, selected), publicOnly = publicOnlyPickup(payloads, options, selected);
    if (!publicOnly) return integrated;
    if (publicOnly.status !== 'reference') return integrated.status === 'reference' ? integrated : publicOnly;
    if (integrated.status !== 'reference') return publicOnly;
    const publicCurrent = Date.parse(publicOnly.source.currentObservedAt), integratedCurrent = Date.parse(integrated.source.currentObservedAt);
    const publicPrevious = Date.parse(publicOnly.source.previousObservedAt), integratedPrevious = Date.parse(integrated.source.previousObservedAt);
    return publicCurrent > integratedCurrent || publicCurrent === integratedCurrent && publicPrevious >= integratedPrevious ? publicOnly : integrated;
  }
  function projectCompany(payload, options = {}) {
    const payloads = Array.isArray(payload) ? payload : [payload];
    const validOptions = text(options.companyId, 180) && date(options.asOf) && Array.isArray(options.dates)
      && options.dates.length <= 3660 && options.dates.every(date) && unique(options.dates).length === options.dates.length;
    if (validOptions && (payload === null || payload === undefined || payloads.length === 0)) {
      return {companyId: options.companyId, price: blankPrice('PRICE_NOT_CONNECTED'), pickup: blankPickup('PICKUP_NOT_CONNECTED')};
    }
    const valid = validOptions && payloads.length > 0 && payloads.length <= 120 && payloads.every(object);
    if (!valid) return {companyId: text(options.companyId, 180) ? options.companyId : null, price: blankPrice('SOURCE_CONTEXT_MISMATCH'), pickup: blankPickup('SOURCE_CONTEXT_MISMATCH')};
    const ids = payloads.flatMap(payload => [payload.result?.companyId, payload.companyDetail?.companyId, payload.companyDetail?.basics?.companyId]).filter(value => value !== undefined && value !== null);
    if (ids.some(value => value !== options.companyId)) return {companyId: options.companyId, price: blankPrice('SOURCE_CONTEXT_MISMATCH'), pickup: blankPickup('SOURCE_CONTEXT_MISMATCH')};
    const selected = new Set(options.dates);
    return {companyId: options.companyId, price: combinedPrice(payloads, options, selected), pickup: selectedPickup(payloads, options, selected)};
  }
  return {projectCompany, reasonLabels};
});
