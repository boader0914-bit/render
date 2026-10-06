'use strict';

// Insight read projection only. Source snapshots, collection windows and DataLab
// stay unchanged. "Confirmed" describes usable saved evidence, not publication.
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const usableStatus = status => ['observed', 'ready', 'complete'].includes(status);
const shift = (month, offset) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5) - 1 + offset, 1)).toISOString().slice(0, 7);
const monthsEnding = (end, count) => Array.from({ length: count }, (_, i) => shift(end, i + 1 - count));
function difference(current, previous, unit) {
  if (!numeric(current) || !numeric(previous)) return { value: null, kind: 'unavailable' };
  if (['지수', '상대지수'].includes(unit)) return { value: current - previous, kind: 'index_difference' };
  return previous === 0 ? { value: null, kind: 'zero_baseline' } : { value: (current - previous) / previous * 100, kind: 'percent' };
}
function sourcePeriod(source, cutoff) {
  if (!Array.isArray(source.series) || !monthPattern.test(cutoff) || !source.metrics?.length) return source;
  const keys = source.metrics.map(metric => metric.key), grouped = new Map();
  for (const point of source.series) {
    if (!monthPattern.test(point.month) || point.month > cutoff) continue;
    grouped.set(point.month, [...(grouped.get(point.month) || []), point]);
  }
  const valid = new Map();
  for (const [month, points] of grouped) {
    const p = points[0];
    if (points.length !== 1 || !usableStatus(p.status)) continue;
    if (keys.every(key => {
      const rows = (p.rows || []).filter(row => row.key === key);
      return rows.length === 1 && numeric(rows[0].value) && (!rows[0].status || usableStatus(rows[0].status));
    })) valid.set(month, p);
  }
  const latest = [...valid.keys()].sort().at(-1) || null, end = latest || cutoff;
  const count = [12, 11].find(size => monthsEnding(end, size).every(month => valid.has(month))) || 12;
  const months = monthsEnding(end, count), observed = months.filter(month => valid.has(month));
  const ready = observed.length === count && count >= 11;
  const period = { status: ready ? 'confirmed' : 'insufficient', start: months[0], end, months: count,
    observedMonths: observed.length, latestConfirmedMonth: latest, requestedEnd: cutoff,
    excludedRecentMonths: latest ? monthsEnding(cutoff, 24).filter(month => month > latest) : [] };
  const valueAt = (month, key) => valid.get(month)?.rows.find(row => row.key === key)?.value ?? null;
  const metrics = source.metrics.map(metric => {
    const points = observed.map(month => ({ month, value: valueAt(month, metric.key) })), last = points.at(-1) || null;
    return { ...metric, observedMonths: points.length, latest: last,
      mom: difference(last?.value, last ? valueAt(shift(last.month, -1), metric.key) : null, metric.unit),
      yoy: difference(last?.value, last ? valueAt(shift(last.month, -12), metric.key) : null, metric.unit),
      peak: points.length ? points.reduce((a, b) => b.value > a.value ? b : a) : null,
      low: points.length ? points.reduce((a, b) => b.value < a.value ? b : a) : null };
  });
  // Preserve each source value in the upstream response. The display series only
  // exposes a month when all required metrics of that source are normal.
  const series = [...grouped.keys()].sort().map(month => {
    const point = grouped.get(month)[0], normal = valid.has(month);
    return { ...point, status: normal ? 'observed' : grouped.get(month).length > 1 ? 'error' : point.status,
      rows: keys.map(key => {
        const row = (point.rows || []).find(row => row.key === key) || { key };
        return { ...row, value: normal ? row.value : null, status: normal ? 'observed' : 'missing' };
      }) };
  });
  return { ...source, series, metrics, confirmedPeriod: period, period: `${period.start} ~ ${period.end}`,
    status: ready ? 'ready' : observed.length ? 'partial' : 'missing',
    rows: metrics.map(metric => ({ key: metric.key, label: metric.label, unit: metric.unit, value: metric.latest?.value ?? null, status: metric.latest ? 'observed' : 'missing' })) };
}
function regionPeriod(region) {
  if (!region?.window || !Array.isArray(region.sources)) return region;
  const warnings = (region.warnings || []).filter(note => !note.startsWith('최근 12개월을 표시하고'));
  return { ...region, periodPolicy: 'latest_confirmed_11_or_12', sources: region.sources.map(source => sourcePeriod(source, region.window.end)),
    warnings: ['지표별 마지막 정상 확보월까지 연속 12개월을 기준으로 하며, 12개월이 없으면 연속 11개월을 사용합니다. 그보다 부족한 자료는 참고로 구분합니다.',
      '미확인 월은 기준 기간과 집계에서 제외합니다. 지표별 기준월이 다를 수 있으며 전년 비교는 같은 월의 저장 자료가 있을 때만 계산합니다.', ...warnings] };
}
function projectResponse(route, data) {
  if (/\/(?:regions\/[a-zA-Z0-9_-]+\/analysis)$/.test(route)) return regionPeriod(data);
  if (/\/reports\/briefing$/.test(route) && Array.isArray(data?.regions)) return { ...data, regions: data.regions.map(regionPeriod),
    ...(Array.isArray(data.actions) ? { actions: data.actions.map(action => ['region', 'region_flow'].includes(action.key)
      ? { ...action, ...Object.fromEntries(['reason', 'check'].map(key => [key, typeof action[key] === 'string'
        ? action[key].replaceAll('최근 12개월', '확인된 월까지 최근 11~12개월').replaceAll('12개월 확보 범위', '11~12개월 확보 범위') : action[key]])) } : action) } : {}) };
  return data;
}
module.exports = { sourcePeriod, regionPeriod, projectResponse };
