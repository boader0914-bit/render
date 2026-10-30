// UI-only state helpers. A blank scenario input remains unknown, never zero.
export function scenarioNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const priority = { limited_coupon_review: 0, sales_conditions_review: 1, maintain_price: 2, hold: 3 };
export function actionRows(days, filter = 'all') {
  return (Array.isArray(days) ? days : []).filter(day => filter === 'all' || day.action === filter)
    .slice().sort((a, b) => (priority[a.action] ?? 4) - (priority[b.action] ?? 4) || (a.leadDays ?? Infinity) - (b.leadDays ?? Infinity) || String(a.date).localeCompare(String(b.date)));
}

export function selectedActionDay(rows, selectedDate) {
  return rows.find(day => day.date === selectedDate) || rows[0] || null;
}

export function scenarioProduct(products, selectedId) {
  const priced = (Array.isArray(products) ? products : []).filter(product => Number.isFinite(product.price) && product.price > 0);
  return priced.find(product => String(product.id) === String(selectedId)) || priced[0] || null;
}
