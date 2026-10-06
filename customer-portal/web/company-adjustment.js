(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InsightCompanyAdjustment = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  // Keep the prepared editor locked until separate storage and report precedence are agreed.
  // This is deliberately not controlled by a browser preference, URL or customer data.
  const editingEnabled = false;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const integer = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const known = row => Boolean(row && !row.missing && !row.partial && !row.inventoryConflict);
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  const count = value => value === null ? '미확인' : value.toLocaleString('ko-KR') + '실';
  const money = value => value === null ? '미확인' : value.toLocaleString('ko-KR') + '원';

  function baseline(row) {
    const valid = known(row);
    let bookings = valid && integer(row.publicBookings) && integer(row.phoneBookings) ? row.publicBookings + row.phoneBookings : null;
    if (!integer(bookings) || (integer(row?.total) && bookings > row.total) || (row?.sold != null && row.sold !== bookings)) bookings = null;
    const revenue = valid && !row.revenuePartial && integer(row.estimatedRevenue) ? row.estimatedRevenue : null;
    return { bookings, revenue };
  }

  function input(value, label) {
    if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
    const parsed = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (!integer(parsed)) throw new Error(label + '은 0 이상의 정수로 입력해 주세요.');
    return parsed;
  }

  function capacityOf(row, capacity) {
    return integer(capacity) ? capacity : integer(row?.total) ? row.total : null;
  }

  function calculate(row, inputs = {}, capacity) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('보정할 예약 또는 매출을 입력해 주세요.');
    const nextBookings = input(inputs.bookings, '예약 합계'), nextRevenue = input(inputs.revenue, '매출 합계');
    if (nextBookings === null && nextRevenue === null) throw new Error('예약 또는 매출 중 하나 이상을 입력해 주세요.');
    const limit = capacityOf(row, capacity);
    if (nextBookings !== null && limit !== null && nextBookings > limit) throw new Error('예약 합계는 객실 총량 ' + count(limit) + '을 넘을 수 없습니다.');
    const original = baseline(row);
    const bookings = nextBookings === null ? original.bookings : nextBookings;
    const revenue = nextRevenue === null ? original.revenue : nextRevenue;
    return {
      bookings, revenue,
      bookingDelta: bookings === null || original.bookings === null ? null : bookings - original.bookings,
      revenueDelta: revenue === null || original.revenue === null ? null : revenue - original.revenue,
    };
  }

  function render(row, options = {}) {
    if (options.own !== true || !validDate(row?.date)) return '';
    if (!editingEnabled) return `<section class="ca-preview ca-locked" aria-label="예약·매출 수정"><div class="ca-heading"><h3>예약·매출 수정</h3><span>${esc(row.date)}</span></div><p class="muted">수집자료 통합 후 이용할 수 있습니다.</p><button class="button small" type="button" disabled>수정 준비 중</button></section>`;
    const original = baseline(row), capacity = capacityOf(row, options.capacity);
    return `<section class="ca-preview" aria-label="매출 보정 미리보기"><div class="ca-heading"><h3>매출 보정 미리보기</h3><span>${esc(row.date)}</span></div><p class="muted">저장·리포트에는 반영되지 않습니다.</p><dl class="ca-baseline"><div><dt>원래 예약</dt><dd>${count(original.bookings)}</dd></div><div><dt>원래 매출</dt><dd>${money(original.revenue)}</dd></div></dl><form class="ca-form" data-company-adjustment-preview data-company-adjustment-date="${esc(row.date)}"><div class="ca-fields"><label class="field"><span>예약 합계 (실)</span><input type="number" name="bookings" min="0" ${capacity === null ? '' : `max="${capacity}" `}step="1" inputmode="numeric" placeholder="변경할 때만 입력"></label><label class="field"><span>매출 합계 (원)</span><input type="number" name="revenue" min="0" max="${Number.MAX_SAFE_INTEGER}" step="1" inputmode="numeric" placeholder="변경할 때만 입력"></label></div><p class="muted">빈칸은 원래 값을 유지합니다. 채널별 수량·금액은 바꾸지 않습니다.</p><div class="ca-actions"><button class="button" type="submit">계산하기</button><button class="button small" type="reset">초기화</button></div><div class="ca-output" data-adjustment-output role="status" aria-live="polite"></div></form></section>`;
  }

  return { render, calculate, isEnabled: () => editingEnabled };
});
