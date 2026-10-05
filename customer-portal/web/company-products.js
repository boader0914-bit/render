(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InsightCompanyProducts = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const integer = value => numeric(value) && Number.isInteger(value);
  const number = value => value.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  const kinds = { lodging: '숙박', dayuse: '데이유즈', unknown: '구분 확인 전' };
  const groups = [['weekday', '평일 (월~목)'], ['friday', '금요일'], ['saturday', '토요일'], ['sunday', '일요일']];

  function dateWeekday(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
    return date.getUTCDay();
  }

  function summarize(result) {
    const rows = Array.isArray(result?.products) ? result.products : [];
    const products = rows.filter(product => product && typeof product === 'object').map((product, index) => {
      const days = (Array.isArray(product.days) ? product.days : []).filter(day => day && day.status === 'observed' && dateWeekday(day.date) !== null);
      const quantities = days.map(day => day.total).filter(integer);
      const priceDays = days.filter(day => numeric(day.price));
      const prices = Object.fromEntries(groups.map(([key]) => {
        const values = priceDays.filter(day => {
          const weekday = dateWeekday(day.date);
          return key === 'weekday' ? weekday >= 1 && weekday <= 4 : weekday === { friday: 5, saturday: 6, sunday: 0 }[key];
        });
        return [key, values.length ? { min: Math.min(...values.map(day => day.price)), max: Math.max(...values.map(day => day.price)), days: new Set(values.map(day => day.date)).size } : null];
      }));
      const productType = Object.hasOwn(kinds, product.productType) ? product.productType : 'unknown';
      return {
        key: String(product.key || 'product-' + index),
        name: String(product.name || '상품명 확인 전'),
        productType,
        typeLabel: kinds[productType],
        maxRooms: quantities.length ? Math.max(...quantities) : null,
        observedDays: new Set(days.map(day => day.date)).size,
        prices
      };
    });
    return { products, productCount: products.length };
  }

  function priceText(price) {
    if (!price) return '미확인';
    return price.min === price.max ? number(price.min) + '원' : number(price.min) + ' ~ ' + number(price.max) + '원';
  }

  function render(result) {
    const model = summarize(result);
    if (!model.products.length) return '<div class="company-products-overview"><p class="cp-empty">저장된 상품 자료가 없습니다.</p></div>';
    return '<div class="company-products-overview"><p class="cp-price-note">요일별 관측 판매가격 · 공휴일 요금 구분 없음</p><div class="cp-table-wrap"><table class="cp-table"><caption class="sr-only">상품별 최대 공개 객실 수와 요일별 관측 판매가격</caption><thead><tr><th scope="col">상품명</th><th scope="col">구분</th><th scope="col">최대 공개 객실 수</th>' + groups.map(([, label]) => '<th scope="col">' + label + '</th>').join('') + '</tr></thead><tbody>' + model.products.map(product => '<tr><th scope="row" class="cp-name" data-label="상품명">' + esc(product.name) + '</th><td class="cp-type" data-label="구분">' + esc(product.typeLabel) + '</td><td data-label="최대 공개 객실 수">' + (product.maxRooms === null ? '미확인' : number(product.maxRooms) + '실') + '</td>' + groups.map(([key, label]) => '<td data-label="' + label + '">' + priceText(product.prices[key]) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></div>';
  }

  return { render, summarize };
});
