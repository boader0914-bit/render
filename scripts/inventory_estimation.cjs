"use strict";

// A read model only: original CSVs, provider responses and saved snapshots stay intact.
const verifiedInventory = require("./verified_room_inventory.json");
const { applyProductStockCorrections } = require("./lib/inventory_manual_corrections.cjs");
const number = (value) => value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && !value.trim()) ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const nonnegative = (value) => Math.max(0, number(value) || 0);
const shortDate = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const dayType = (date) => ["일요일", "평일", "평일", "평일", "평일", "금요일", "토요일"][new Date(`${date}T12:00:00+09:00`).getUTCDay()];
const POLICY = "maximum_capacity_phone_estimate";
const PHONE_VALUATION_POLICY = "same_product_observed_price_v1";
const SUM_FIELDS = ["total", "rawTotal", "available", "sold", "publicBookings", "phoneBookings", "explicitBlockedBookings", "explicitBlockedRevenue", "sharedDayUseExcluded", "unknownUnavailable", "publicRevenue", "phoneRevenue", "phoneFallbackRevenue", "phoneFallbackBookings", "pricedSoldOut", "missingPriceSoldOut", "phonePricedBookings", "phoneMissingPriceBookings", "inventoryShortfall", "unverifiedOccupied", "unverifiedUnavailable"];
const capacityNumber = (value) => nonnegative(value && typeof value === "object" ? value.count : value);
const correctionCapacity = (value) => {
  const count = number(value && typeof value === "object" ? value.count : value);
  return Number.isInteger(count) && count > 0 ? count : null;
};

function productKind(row) {
  const explicit = [row.saleType, row.bizItemSubType].filter(Boolean).join(" ");
  if (/숙박|night|overnight/i.test(explicit)) return "lodging";
  if (/데이|day[_\s]*use|당일|캠프닉|campnic|camp_nic/i.test(explicit)) return "dayUse";
  return /데이유즈|캠프닉|캠핑닉|피크닉|대실|당일|day\s*use/i.test(row.name || "") ? "dayUse" : "lodging";
}

function evidenceProducts(item) {
  const weekly = Array.isArray(item.weeklyProductDetails) ? item.weeklyProductDetails : [];
  const dayUse = Array.isArray(item.dayUseWeeklyProductDetails) ? item.dayUseWeeklyProductDetails.map((row) => ({ ...row, saleType: row.saleType || "데이유즈" })) : [];
  const basis = Array.isArray(item.itemDetails) ? item.itemDetails : [];
  const seen = new Set();
  return [...weekly, ...dayUse, ...basis].filter((row) => {
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || "")) return false;
    const key = `${row.date}|${productKind(row)}|${row.bizItemId || row.key || row.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reviewedProductEvidence(rows, baseline = {}) {
  const keyFor = (row) => String(row.bizItemId || row.key || row.name || "");
  const groups = new Map();
  for (const row of rows.filter((entry) => productKind(entry) === "lodging")) {
    const key = keyFor(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const guideName = (row) => String(row.name || "").replace(/\s+/g, "") === "현장예약및전화예약";
  const guideKeys = new Set([...groups].filter(([, products]) => products.every((row) => guideName(row) && !(number(row.price) > 0))).map(([key]) => key));
  const hasOtherRooms = [...groups].some(([key, products]) => !guideKeys.has(key) && products.some((row) => !row.collectionFailed && number(row.price) > 0));
  if (!hasOtherRooms) guideKeys.clear();
  const exclusionEvidence = rows.filter((row) => productKind(row) === "lodging" && guideKeys.has(keyFor(row))).map((row) => ({
    date: row.date, productKey: keyFor(row), name: row.name || "", reason: "non_room_phone_reservation_guide",
    label: "현장·전화예약 안내상품 — 객실 수와 매출에서 제외", stock: number(row.stock), bookingCount: number(row.bookingCount), price: number(row.price)
  }));
  const included = rows.filter((row) => !(productKind(row) === "lodging" && guideKeys.has(keyFor(row))));
  const rooms = [...groups].filter(([key]) => !guideKeys.has(key));
  const roomNumber = (name) => {
    const tokens = [...String(name || "").matchAll(/\b([AB])[-\s]*0?([1-9]\d?)\b/gi)];
    return tokens.length === 1 ? `${tokens[0][1].toUpperCase()}${Number(tokens[0][2])}` : null;
  };
  const roomNumbers = rooms.map(([, products]) => {
    const numbers = new Set(products.map((row) => roomNumber(row.name)));
    return numbers.size === 1 && !numbers.has(null) ? [...numbers][0] : null;
  });
  const reviewedCount = correctionCapacity(baseline.lodgingOverride);
  // A reviewed total alone cannot establish a per-product capacity. Only a
  // complete one-to-one set of explicitly numbered rooms establishes one room
  // for each product. Room-type bundles and incomplete lists do not qualify.
  const numberedRoomKeys = reviewedCount === rooms.length && rooms.length > 1 && roomNumbers.every(Boolean) && new Set(roomNumbers).size === rooms.length
    ? new Set(rooms.map(([key]) => key)) : new Set();
  const normalizationEvidence = [];
  const normalized = included.map((row) => {
    if (productKind(row) !== "lodging" || !numberedRoomKeys.has(keyFor(row)) || row.collectionFailed) return row;
    const normalizedRow = { ...row };
    const source = {}, applied = {};
    for (const field of ["stock", "bookingCount", "occupiedBookingCount"]) {
      const value = number(row[field]);
      if (value !== null && value > 1) {
        source[field] = value; applied[field] = 1; normalizedRow[field] = 1;
      }
    }
    if (!Object.keys(source).length) return row;
    normalizationEvidence.push({ date: row.date, productKey: keyFor(row), roomNumber: roomNumber(row.name),
      reason: "reviewed_numbered_room_single_capacity", label: "DB 검수 총량과 일치하는 개별 객실 — 계산 수량 1실", source, applied });
    return normalizedRow;
  });
  return { rows: normalized, exclusionEvidence, normalizationEvidence, excludedProductCount: guideKeys.size };
}

function productEvidence(row) {
  const stock = number(row.stock);
  const booked = number(row.bookingCount);
  const occupied = nonnegative(row.occupiedBookingCount);
  const open = row.open !== false && row.isBusinessDay !== false && row.isSaleDay !== false;
  const stockObserved = !row.collectionFailed && stock !== null && stock >= 0;
  const bookingObserved = !row.collectionFailed && booked !== null && booked >= 0;
  const observed = stockObserved && bookingObserved;
  const sold = bookingObserved ? booked : 0;
  const roomList = row.listType === "객실별 예약리스트";
  const rawTotal = stockObserved ? (roomList && stock > 0 ? 1 : stock) : 0;
  const total = Math.max(rawTotal, sold);
  const available = observed && open ? Math.min(total, Math.max(0, rawTotal - sold - occupied)) : 0;
  const price = number(row.price);
  const priced = price > 0 ? sold : 0;
  return {
    date: row.date, key: row.bizItemId || row.key || row.name, kind: productKind(row),
    priceFallbackAllowed: !/(?:현장|전화)\s*예약/.test(row.name || ""),
    total, rawTotal, available, sold, publicBookings: sold, observed, stockObserved, bookingObserved,
    unverifiedOccupied: occupied,
    unverifiedUnavailable: Math.max(0, total - available - sold),
    inventoryConflict: observed && sold > rawTotal,
    price, estimatedRevenue: priced * (price || 0), pricedSoldOut: priced,
    missingPriceSoldOut: Math.max(0, sold - priced),
    closed: !open
  };
}

function emptyDate(date) {
  return { date, ...Object.fromEntries(SUM_FIELDS.map((field) => [field, 0])), estimatedRevenue: 0,
    phonePriceEstimates: [], inventoryConflict: false, observedProducts: 0, productCount: 0, closedProducts: 0 };
}

function phonePriceEvidence(product, pricesByProduct) {
  if (product.price > 0) return { unitPrice: product.price, source: "same_product_same_date", sourceDate: product.date };
  if (!product.priceFallbackAllowed) return null;
  const candidates = (pricesByProduct.get(product.key) || []).filter((candidate) => candidate.date !== product.date);
  const weekday = new Date(`${product.date}T12:00:00Z`).getUTCDay();
  const sameWeekday = candidates.filter((candidate) => new Date(`${candidate.date}T12:00:00Z`).getUTCDay() === weekday);
  const pool = sameWeekday.length ? sameWeekday : candidates;
  const target = Date.parse(`${product.date}T12:00:00Z`);
  const nearest = [...pool].sort((a, b) => Math.abs(Date.parse(`${a.date}T12:00:00Z`) - target) - Math.abs(Date.parse(`${b.date}T12:00:00Z`) - target) || a.date.localeCompare(b.date))[0];
  return nearest ? {
    unitPrice: nearest.price, source: sameWeekday.length ? "same_product_same_weekday" : "same_product_nearest_date", sourceDate: nearest.date
  } : null;
}

// Product maxima locate a shortage for pricing; their sum never increases the
// company's capacity. Ambiguous quantities keep their price missing.
function phoneValuation(dateProducts, capacities, capacity, phoneBookings, excluded, pricesByProduct) {
  const result = { revenue: 0, priced: 0, explicitBookings: 0, explicitRevenue: 0, fallbackRevenue: 0, fallbackBookings: 0, estimates: [] };
  if (!phoneBookings) return result;
  let remaining = phoneBookings;
  const add = (product, quantity, explicit) => {
    const amount = Math.min(remaining, quantity);
    remaining -= amount;
    const price = phonePriceEvidence(product, pricesByProduct);
    if (explicit) result.explicitBookings += amount;
    if (!amount || !price) return;
    const revenue = amount * price.unitPrice;
    result.priced += amount;
    result.revenue += revenue;
    if (explicit) result.explicitRevenue += revenue;
    if (price.source !== "same_product_same_date") {
      result.fallbackBookings += amount;
      result.fallbackRevenue += revenue;
    }
    result.estimates.push({ productKey: product.key, quantity: amount, ...price, revenue, quantitySource: explicit ? "explicit_unavailable" : "capacity_shortfall" });
  };
  const explicitQuantity = (product) => product.observed && !product.inventoryConflict ? Math.max(0, product.rawTotal - product.available - product.publicBookings) : 0;
  const explicit = dateProducts.map((product) => ({ product, quantity: explicitQuantity(product) })).filter((candidate) => candidate.quantity > 0);
  // Shared sales are known as a company subtotal. When their room identity is
  // unknown, remove the most expensive candidate first, retaining a lower
  // revenue estimate rather than silently counting the shared room twice.
  if (excluded) explicit.sort((a, b) => (phonePriceEvidence(b.product, pricesByProduct)?.unitPrice || 0) - (phonePriceEvidence(a.product, pricesByProduct)?.unitPrice || 0) || String(a.product.key).localeCompare(String(b.product.key)));
  let sharedRemaining = excluded;
  for (const { product, quantity } of explicit) {
    const deduction = Math.min(sharedRemaining, quantity);
    sharedRemaining -= deduction;
    add(product, quantity - deduction, true);
  }
  // The per-product maxima may overlap. They must never suppress direct,
  // normally observed blocked inventory, but cannot price an ambiguous gap.
  if (!remaining || [...capacities.values()].reduce((sum, value) => sum + value, 0) > capacity) return result;
  const inferred = dateProducts.map((product) => ({ product,
    quantity: Math.max(0, (capacities.get(product.key) || 0) - product.available - product.sold - explicitQuantity(product))
  })).filter((candidate) => candidate.quantity > 0);
  if (sharedRemaining && inferred.length !== 1) return result;
  for (const { product, quantity } of inferred) {
    const deduction = Math.min(sharedRemaining, quantity);
    sharedRemaining -= deduction;
    add(product, quantity - deduction, false);
  }
  return result;
}

function summarizeEvidence(products, kind, options = {}) {
  const source = products.filter((row) => row.kind === kind);
  if (!source.length) return null;
  const productKeys = new Set(source.map((row) => row.key));
  const pricesByProduct = new Map([...productKeys].map((key) => [key, []]));
  for (const product of source) {
    // A failed or contradictory response cannot supply a fallback price, even
    // when it happens to retain a numeric price from another parsing step.
    if (product.observed && !product.inventoryConflict && product.price > 0) pricesByProduct.get(product.key).push(product);
  }
  const capacities = new Map([...productKeys].map((key) => [key, nonnegative(options.productCapacities?.[key])]));
  const dates = new Map((options.dates || []).map((date) => [date, emptyDate(date)]));
  const byDate = new Map();
  for (const product of source) {
    if (!dates.has(product.date)) dates.set(product.date, emptyDate(product.date));
    if (!byDate.has(product.date)) byDate.set(product.date, []);
    byDate.get(product.date).push(product);
    if (product.stockObserved) capacities.set(product.key, Math.max(capacities.get(product.key) || 0, product.rawTotal));
    const row = dates.get(product.date);
    for (const field of ["total", "rawTotal", "available", "sold", "publicBookings", "pricedSoldOut", "missingPriceSoldOut", "unverifiedOccupied"]) row[field] += product[field];
    row.publicRevenue += product.estimatedRevenue;
    row.inventoryConflict ||= product.inventoryConflict;
    row.productCount++;
    row.observedProducts += Number(product.observed);
    row.closedProducts += Number(product.closed);
  }
  const rows = [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
  const observedMaximum = Math.max(0, ...rows.map((row) => row.rawTotal));
  const maximumObservedCapacity = Math.max(observedMaximum, capacityNumber(options.capacity));
  const overrideCount = correctionCapacity(options.override);
  const operatingTotal = overrideCount ?? maximumObservedCapacity;
  for (const row of rows) {
    row.total = operatingTotal;
    // A reviewed DB count may be smaller than the channel observation. Keep
    // both pieces of evidence without forcing impossible quantities into sales.
    row.capacityConflict = overrideCount !== null && (row.rawTotal > operatingTotal || row.available + row.publicBookings > operatingTotal);
    row.inventoryConflict ||= row.capacityConflict;
    row.inventoryShortfall = Math.max(0, operatingTotal - row.rawTotal);
    row.missing = row.observedProducts === 0;
    row.partial = row.observedProducts < productKeys.size;
    row.closed = row.productCount > 0 && row.closedProducts === row.productCount;
    const unavailable = Math.max(0, row.total - row.available - row.publicBookings);
    const dayUse = options.dayUse?.rows.find((entry) => entry.date === row.date);
    row.sharedDayUseIncomplete = kind === "lodging" && (options.dayUseUnverified || (options.shared && (!dayUse || dayUse.partial || dayUse.inventoryConflict)));
    row.partial ||= Boolean(row.sharedDayUseIncomplete);
    const canEstimate = !row.partial && !row.inventoryConflict;
    if (kind === "lodging" && !row.capacityConflict) {
      row.sharedDayUseExcluded = options.shared && dayUse ? Math.min(unavailable, dayUse.publicBookings) : 0;
      const dateProducts = byDate.get(row.date) || [];
      const explicitUnavailable = dateProducts.filter((product) => product.observed && !product.inventoryConflict)
        .reduce((sum, product) => sum + Math.max(0, product.rawTotal - product.available - product.publicBookings), 0);
      const inferredUnavailable = canEstimate ? unavailable : Math.min(unavailable, explicitUnavailable);
      row.phoneBookings = Math.max(0, inferredUnavailable - row.sharedDayUseExcluded);
      const value = phoneValuation(byDate.get(row.date) || [], capacities, operatingTotal, row.phoneBookings, row.sharedDayUseExcluded, pricesByProduct);
      row.phoneRevenue = value.revenue;
      row.phonePricedBookings = value.priced;
      row.explicitBlockedBookings = value.explicitBookings;
      row.explicitBlockedRevenue = value.explicitRevenue;
      row.explicitBlockedDayUseUnverified = Boolean(row.sharedDayUseIncomplete && value.explicitBookings > 0);
      row.phoneFallbackRevenue = value.fallbackRevenue;
      row.phoneFallbackBookings = value.fallbackBookings;
      row.phonePriceEstimates = value.estimates;
      row.phoneMissingPriceBookings = Math.max(0, row.phoneBookings - value.priced);
      row.pricedSoldOut += value.priced;
      row.missingPriceSoldOut += row.phoneMissingPriceBookings;
    }
    row.sold = row.publicBookings + row.phoneBookings;
    row.unknownUnavailable = Math.max(0, unavailable - row.phoneBookings - row.sharedDayUseExcluded);
    row.unverifiedUnavailable = row.unknownUnavailable;
    row.estimatedRevenue = row.publicRevenue + row.phoneRevenue;
    row.rate = row.total > 0 && canEstimate ? row.sold / row.total : null;
  }
  const result = { rows, operatingTotal, observedMaximum, maximumObservedCapacity, capacitySource: overrideCount !== null ? "db_correction" : "observed_maximum", ...Object.fromEntries(SUM_FIELDS.map((field) => [field, 0])), revenue: 0 };
  for (const row of rows) {
    for (const field of SUM_FIELDS) result[field] += row[field];
    result.revenue += row.estimatedRevenue;
  }
  result.missingDays = rows.filter((row) => row.missing).length;
  result.status = rows.every((row) => row.missing) ? "missing" : rows.some((row) => row.partial || row.inventoryConflict) ? "partial" : "observed";
  result.complete = result.status === "observed";
  return result;
}

function applyKindFields(item, summary, kind) {
  if (!summary) return;
  const prefix = kind === "dayUse" ? "dayUseWeekly" : "weekly";
  const unit = kind === "dayUse" ? "회" : "개";
  const rows = summary.rows;
  const totalMax = summary.operatingTotal;
  const set = (name, value) => { item[prefix + name] = value; };
  set("Days", rows.length);
  set("ObservedDays", rows.filter((row) => !row.missing).length);
  set("TotalStock", summary.total);
  set("TotalSoldOut", summary.sold);
  for (const name of ["PublicBookings", "PhoneBookings", "ExplicitBlockedBookings", "ExplicitBlockedRevenue", "SharedDayUseExcluded", "UnknownUnavailable", "InventoryShortfall", "PublicRevenue", "PhoneRevenue", "PhoneFallbackRevenue", "PhoneFallbackBookings", "PhonePricedBookings", "PhoneMissingPriceBookings"]) set(name, summary[name[0].toLowerCase() + name.slice(1)]);
  set("BasisTotal", totalMax);
  set("OperatingTotal", summary.operatingTotal);
  set("StructuralBlockedTotal", summary.sharedDayUseExcluded);
  set("OfflineReservedTotal", summary.phoneBookings);
  set("MinTotal", totalMax);
  set("MaxTotal", totalMax);
  set("TotalVarianceGap", 0);
  set("EstimatedRevenue", summary.revenue);
  set("AdjustedRevenue", summary.revenue);
  set("MissingPriceEstimatedRevenue", 0);
  set("PricedSoldOut", summary.pricedSoldOut);
  set("MissingPriceSoldOut", summary.missingPriceSoldOut);
  set("RevenuePrecisionRate", summary.sold ? (summary.pricedSoldOut - summary.phoneFallbackBookings) / summary.sold : null);
  set("AvgSoldUnitPrice", summary.pricedSoldOut ? Math.round(summary.revenue / summary.pricedSoldOut) : null);
  set("AvgReservationRate", summary.complete && summary.total ? summary.sold / summary.total : null);
  set("OfflineReservationDetail", rows.filter((row) => row.phoneBookings).map((row) => `${shortDate(row.date)} 전화·타채널 추정 ${row.phoneBookings}${unit}`).join(", "));
  const capacityLabel = summary.capacitySource === "db_correction" ? "DB 보정 수량" : "최대 관측 수량(추정)";
  set("BasisRule", kind === "lodging" ? `${capacityLabel}을 매일 총량으로 유지합니다. 총량에서 예약 가능·공개 예약·당일 이용 공유 차단을 뺀 수량은 전화·타채널 예약으로 추정합니다. 당일 이용이나 일부 상품을 확인하지 못했으면 정상 응답에서 직접 확인한 방막기만 별도로 추정합니다. 확인된 당일 이용 공유 예약은 제외합니다. 방막기 가격은 같은 상품의 해당 날짜, 같은 요일, 가까운 날짜 순으로 적용하며 대체 근거를 보존합니다. 실패·누락 수량과 수량 충돌은 예약으로 추정하지 않습니다. 객실 안내는 참고값입니다.` : `${capacityLabel}을 매일 총량으로 유지하며, 당일 이용 예약은 공개 예약 수량만 사용합니다.`);
  set("StockBasisType", "maximum_capacity_phone_estimate_v4");
  set("Detail", rows.filter((row) => !row.missing).map((row) => `${shortDate(row.date)} ${row.available}/${row.total}`).join(", "));
  set("ReservationRateDetail", rows.filter((row) => row.rate !== null).map((row) => `${shortDate(row.date)} ${Math.round(row.rate * 100)}%(${row.sold}/${row.total})`).join(", "));
  set("RawStockVariance", rows.map((row) => `${shortDate(row.date)} 수집 ${row.available}/${row.rawTotal}`).join(", "));
  set("RevenueDetail", rows.filter((row) => !row.missing).map((row) => `${shortDate(row.date)} ${Math.round(row.estimatedRevenue).toLocaleString("en-US")}원(${row.pricedSoldOut}${unit}${row.missingPriceSoldOut ? ` · 가격누락 ${row.missingPriceSoldOut}${unit}` : ""})`).join(", "));
  const buckets = new Map();
  for (const row of rows) {
    const key = dayType(row.date);
    const bucket = buckets.get(key) || { revenue: 0, priced: 0, missing: 0 };
    bucket.revenue += row.estimatedRevenue; bucket.priced += row.pricedSoldOut; bucket.missing += row.missingPriceSoldOut;
    buckets.set(key, bucket);
  }
  set("RevenueByDayType", [...buckets].map(([key, b]) => `${key} ${Math.round(b.revenue).toLocaleString("en-US")}원(${b.priced}${unit}${b.missing ? ` · 가격누락 ${b.missing}${unit}` : ""})`).join(", "));
  const basis = rows[0];
  const basisPrefix = kind === "dayUse" ? "basisDayUse" : "basisLodging";
  item[basisPrefix + "Revenue"] = basis.estimatedRevenue;
  item[basisPrefix + "AdjustedRevenue"] = basis.estimatedRevenue;
  item[basisPrefix + "PublicRevenue"] = basis.publicRevenue;
  item[basisPrefix + "PhoneRevenue"] = basis.phoneRevenue;
  item[basisPrefix + "PhoneFallbackRevenue"] = basis.phoneFallbackRevenue;
  item[basisPrefix + "PhoneFallbackBookings"] = basis.phoneFallbackBookings;
  item[basisPrefix + "MissingPriceEstimatedRevenue"] = 0;
  item[basisPrefix + "PricedSoldOut"] = basis.pricedSoldOut;
  item[basisPrefix + "MissingPriceSoldOut"] = basis.missingPriceSoldOut;
  if (kind === "lodging") {
    item.nightTotalStock = item.totalRooms = basis.total;
    item.nightAvailableStock = item.availableRooms = basis.available;
    item.soldOutRooms = basis.sold;
    item.soldOutRate = basis.rate;
  } else {
    item.dayUseTotalStock = basis.total;
    item.dayUseAvailableStock = basis.available;
  }
}

function requestedDates(products, original) {
  const observed = [...new Set(products.map((row) => row.date))].sort();
  const count = Math.max(nonnegative(original.bookingRangeDays), nonnegative(original.weeklyDays), nonnegative(original.dayUseWeeklyDays), observed.length);
  const result = new Set(observed);
  const requestedStart = [original.checkIn, original.checkInDate].find((date) => /^\d{4}-\d{2}-\d{2}$/.test(date || "") && Number.isFinite(Date.parse(`${date}T12:00:00Z`)));
  const start = requestedStart || observed[0];
  for (let index = 0; index < Math.min(366, count); index++) result.add(new Date(Date.parse(`${start}T12:00:00Z`) + index * 86400000).toISOString().slice(0, 10));
  return [...result].sort();
}

// Warning evidence is deliberately separate from the capacity/revenue model.
// It never caps a count, combines products, downgrades a reviewed DB total, or
// changes collectionQuality. A normal zero is not an error or a room count.
function buildCapacityReview(item = {}, context = {}) {
  const baseline = context.baseline || item.inventoryCapacityBaseline || {};
  const corrected = context.rows || reviewedProductEvidence(applyProductStockCorrections(evidenceProducts(item), baseline.productStockCorrections, (row) => productKind(row) === "lodging").rows, baseline).rows;
  const rows = corrected.filter((row) => productKind(row) === "lodging");
  const lodging = Object.hasOwn(context, "lodging") ? context.lodging : item.inventoryEvidence?.lodging;
  const existingBasis = item.inventoryEvidence?.capacityBasis || item.capacityBasis;
  // An explicit baseline (including a cleared correction) wins over cached UI.
  const hasBaseline = Object.hasOwn(context, "baseline") || Object.hasOwn(item, "inventoryCapacityBaseline");
  const reviewedCount = correctionCapacity(baseline.lodgingOverride)
    ?? (!hasBaseline && (lodging?.capacitySource === "db_correction" || existingBasis?.source === "db_correction")
      ? correctionCapacity(lodging?.operatingTotal ?? existingBasis?.count) : null);
  const reviewed = reviewedCount !== null;
  const keyFor = (row) => String(row.bizItemId || row.key || row.name || "");
  const failed = (row) => Boolean(row.collectionFailed || row.collectionErrorCode
    || (Array.isArray(row.errors) ? row.errors.length : row.errors));
  const stockKnown = (row) => !failed(row) && row.stockObserved !== false && row.queryAttempted !== false && row.missing !== true
    && number(row.stock) !== null && number(row.stock) >= 0;
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const validRows = rows.filter(stockKnown);
  const byDate = new Map();
  for (const row of validRows) {
    if (!byDate.has(row.date)) byDate.set(row.date, { keys: new Set(), total: 0 });
    const date = byDate.get(row.date);
    date.keys.add(keyFor(row)); date.total += productEvidence(row).rawTotal;
  }
  const currentMaximum = Math.max(0, ...[...byDate.values()].map((row) => row.total));
  const observedMaximum = Math.max(currentMaximum, capacityNumber(baseline.lodging), nonnegative(lodging?.maximumObservedCapacity),
    !hasBaseline && existingBasis?.source !== "db_correction" ? nonnegative(existingBasis?.observedMaximum ?? existingBasis?.count) : 0);
  const basis = reviewed ? "db_correction" : observedMaximum > 0 ? "observed_maximum" : "missing";
  const reasons = [];
  const add = (code, message, scope = "capacity", evidence = {}, severity = reviewed ? "info" : "warning") => {
    reasons.push({ code, severity, scope, message, evidence });
  };
  const glamping = /글램핑|glamping/i.test([item.name, item.keyword, item.searchKeyword, item.category, item.businessType, item.lodgingType, item.accommodationMarketType, baseline.businessType].filter(Boolean).join(" "));
  if (glamping && !reviewed && observedMaximum > 40) add("glamping_observed_over_40", "글램핑 최대 관측 수량이 40실을 초과합니다. 실제 객실 수를 확인해 주세요.", "capacity", { observedMaximum, threshold: 40 });

  const coverage = item.collectionProductCoverage;
  const ownBusinessId = String(item.bookingBusinessId || item.businessId || "");
  if (coverage && (!ownBusinessId || !coverage.businessId || String(coverage.businessId) === ownBusinessId)) {
    const target = nonnegative(coverage.eligible), queried = nonnegative(coverage.queried), truncated = nonnegative(coverage.truncated);
    if (truncated > 0) add("product_targets_truncated", `상품 ${truncated}개가 제한으로 미조회되어 전체 객실 구성을 확인하지 못했습니다.`, "capacity", { eligibleProducts: target, queriedProducts: queried, omittedProducts: truncated });
    if (coverage.productListComplete === false) add("product_list_incomplete", "전체 상품 목록을 확인하지 못해 객실 수 근거가 부족합니다.", "capacity");
    const days = Array.isArray(coverage.days) ? coverage.days : [];
    const incompleteDays = days.filter((day) => day && nonnegative(day.eligible) > nonnegative(day.queried) + nonnegative(day.truncated));
    const absentDays = Math.max(0, nonnegative(coverage.expectedDays) - days.length);
    if (incompleteDays.length || absentDays) add("product_day_targets_incomplete", "일부 날짜의 상품 조회가 빠져 객실 수 근거를 모두 확인하지 못했습니다.", "capacity", { incompleteDays: incompleteDays.length, absentDays, dates: incompleteDays.map((day) => day.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date || "")).slice(0, 5) });
  }

  const normalizeRoomName = (name) => String(name || "").normalize("NFKC").trim()
    .replace(/^(?:\[(?:연박(?:특가|할인|전용|상품)?|일반(?:가|상품)?|\d+박(?:이상)?(?:특가|할인|전용)?)\]\s*)+/i, "")
    .replace(/^[*\s]+|[*\s]+$/g, "").replace(/\s+/g, " ");
  const roomIdentity = (name) => /(?:[a-z][-\s]?\d{1,3}(?:동|호)?|\d{1,4}(?:동|호(?:실)?|번)|(?:글램핑|방갈로|카라반|펜션|풀빌라)\s+\d{1,3}(?:\s|\(|$))/i.test(name);
  const nameGroups = new Map();
  for (const [id, productRows] of groups) {
    for (const row of productRows) {
      const name = normalizeRoomName(row.name);
      if (!roomIdentity(name)) continue;
      const normalized = name.toLowerCase().replace(/[\s-]+/g, "");
      if (!nameGroups.has(normalized)) nameGroups.set(normalized, { name, products: new Map() });
      const group = nameGroups.get(normalized);
      if (!group.products.has(id)) group.products.set(id, new Set());
      group.products.get(id).add(row.date);
    }
  }
  const duplicates = [...nameGroups.values()].filter((group) => {
    const seenDates = new Set();
    for (const dates of group.products.values()) for (const date of dates) {
      if (seenDates.has(date)) return true;
      seenDates.add(date);
    }
    return false;
  });
  if (duplicates.length) add("duplicate_room_product_names", "같은 객실명의 일반·연박 등 중복 상품 후보가 있습니다. 재고 공유 여부를 확인해 주세요.", "composition", {
    candidateGroups: duplicates.length, examples: duplicates.slice(0, 5).map((group) => ({ name: group.name.slice(0, 100), productIds: [...group.products.keys()].slice(0, 6) }))
  });
  const facilityKind = (name) => {
    if (/글램핑|glamping/i.test(name)) return "glamping";
    if (/방갈로|bungalow/i.test(name)) return "bungalow";
    if (/카라반|caravan/i.test(name)) return "caravan";
    if (/펜션|풀빌라|pension|pool\s*villa/i.test(name)) return "pension";
    if (/오토\s*캠핑|캠핑\s*(?:면|사이트|빌리지|장|[A-Z][\s-]*\d)|파쇄석|데크|camp(?:ing)?\s*site/i.test(name)) return "campsite";
    return "unknown";
  };
  const facilityCounts = {};
  for (const productRows of groups.values()) {
    const kinds = new Set(productRows.map((row) => facilityKind(String(row.name || ""))).filter((kind) => kind !== "unknown"));
    for (const kind of kinds) facilityCounts[kind] = (facilityCounts[kind] || 0) + 1;
  }
  if (glamping && ["bungalow", "caravan", "pension", "campsite"].some((kind) => facilityCounts[kind])) add("glamping_mixed_facility_types", "글램핑 집계에 펜션·방갈로·캠핑면 등 다른 시설 상품이 포함돼 있습니다.", "composition", { productCountsByFacility: facilityCounts });
  if (/묶음|범위/.test(String(item.listType || "")) || nonnegative(item.groupedRoomCount) > 0) add("grouped_room_stock_unverified", "묶음·범위형 상품이 있어 상품 수와 실제 객실 수를 대조해야 합니다.", "composition", { groupedRoomCount: nonnegative(item.groupedRoomCount) });

  if (!context.summaryOnly) {
  const dates = context.dates || ((rows.length || /^\d{4}-\d{2}-\d{2}$/.test(item.checkIn || item.checkInDate || "")) ? requestedDates(rows, item) : []);
  const failedRows = rows.filter(failed);
  const missingRows = rows.filter((row) => !failed(row) && !stockKnown(row));
  const productsWithoutStock = [...groups.values()].filter((productRows) => !productRows.some(stockKnown)).length;
  const completeDates = [...byDate.values()].filter((day) => groups.size > 0 && day.keys.size === groups.size).length;
  const presentDates = new Set(rows.map((row) => row.date));
  const missingDays = dates.filter((date) => !presentDates.has(date)).length;
  // With at least one complete stock date, isolated later gaps are collection
  // caveats. They do not by themselves invalidate an observed capacity basis.
  const weakStockBasis = !validRows.length || productsWithoutStock > 0 || completeDates === 0;
  const stockSeverity = reviewed || !weakStockBasis ? "info" : "warning";
  const stockScope = stockSeverity === "warning" ? "capacity" : "observation";
  const onlyDayUse = corrected.length > 0 && rows.length === 0 && !reviewed && observedMaximum === 0;
  if (!onlyDayUse && (!rows.length || missingRows.length || missingDays)) add("stock_evidence_missing", "객실 재고가 없는 상품·날짜가 있습니다. 누락을 0실로 해석하지 않습니다.", stockScope,
    { missingProductDates: missingRows.length, missingDays, productsWithoutStock, productDetailsAvailable: rows.length > 0 }, stockSeverity);
  if (failedRows.length) add("stock_collection_failed", "일부 객실 재고 응답에 오류·차단이 있습니다. 오류의 0은 정상 재고 0과 다릅니다.", stockScope, { failedProductDates: failedRows.length, productsWithoutStock }, stockSeverity);
  const zeroOnlyProducts = [...groups.values()].filter((productRows) => productRows.some(stockKnown) && productRows.filter(stockKnown).every((row) => number(row.stock) === 0)).length;
  if (zeroOnlyProducts) {
    const noCapacity = !reviewed && observedMaximum === 0;
    add("zero_stock_capacity_unverified", noCapacity ? "정상 응답 재고가 모두 0이어서 실제 객실 총량을 확인할 수 없습니다." : "정상 재고가 계속 0인 상품이 있습니다. 실제 객실 수 감소나 전화예약 확정 근거는 아닙니다.", noCapacity ? "capacity" : "observation",
      { normalZeroProducts: zeroOnlyProducts }, noCapacity ? "warning" : "info");
  }
  }
  const conflicts = (lodging?.rows || []).filter((row) => row.capacityConflict);
  const rawOverReviewed = reviewed ? [...byDate].filter(([, day]) => day.total > reviewedCount).map(([date]) => date) : [];
  if (conflicts.length || rawOverReviewed.length) add("db_capacity_observation_conflict", "DB 검수 객실 수보다 수집 수량이 큽니다. 검수값을 유지하고 수집 수량을 검토해 주세요.", "observation",
    { reviewedCount, dates: [...new Set([...conflicts.map((row) => row.date), ...rawOverReviewed])].slice(0, 5) }, "warning");
  const bookingConflicts = validRows.filter((row) => productEvidence(row).inventoryConflict);
  if (bookingConflicts.length) add("stock_booking_conflict", "공개 예약 수가 해당 상품 재고보다 커 수량이 서로 맞지 않습니다.", reviewed ? "observation" : "capacity", { conflictingProductDates: bookingConflicts.length }, "warning");
  const warnings = reasons.filter((reason) => reason.severity === "warning");
  return { version: 2, required: warnings.length > 0, codes: warnings.map((reason) => reason.code), threshold: 40,
    message: warnings.map((reason) => reason.message).join(" "), level: warnings.length ? "warning" : reasons.length ? "info" : "none", basis, reviewed,
    capacityUncertain: !reviewed && warnings.some((reason) => reason.scope === "capacity" || reason.scope === "composition"), reasons };
}

// Company snapshots retain product identities and aggregate daily evidence,
// not the original per-product stock/error flags. Reassess identity/composition
// without pretending the stored product maximum is a healthy daily response.
function buildStoredCapacityReview(snapshot = {}, context = {}) {
  const baseline = context.baseline || {};
  const sourceProducts = Array.isArray(snapshot.products) ? snapshot.products : [];
  const sourceDaily = (Array.isArray(snapshot.daily) ? snapshot.daily : []).filter((row) => row?.productType === "lodging");
  const rows = sourceProducts.filter((product) => product && product.productType !== "dayuse").flatMap((product) => {
    const identity = { bizItemId: product.bizItemId, key: product.key, name: product.name,
      saleType: product.saleType || (product.productType === "lodging" ? "숙박" : ""), bizItemSubType: product.bizItemSubType };
    const dates = [...new Set((Array.isArray(product.priceByDate) ? product.priceByDate : []).map((row) => row?.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date || "")))];
    return dates.length ? dates.map((date) => ({ ...identity, date })) : [identity];
  });
  const count = correctionCapacity(baseline.lodgingOverride);
  // Re-evaluate conflict flags against the *current* correction. Old flags
  // must not survive a reviewed count change merely because a snapshot is old.
  const daily = sourceDaily.map((row) => ({ ...row, capacityConflict: count !== null
    && ((number(row.rawTotal) !== null && number(row.rawTotal) > count)
      || (number(row.available) !== null && number(row.publicBookings) !== null && number(row.available) + number(row.publicBookings) > count)) }));
  const observedMaximum = Math.max(nonnegative(snapshot.capacityBasis?.observedMaximum), nonnegative(snapshot.capacityBasis?.currentObservedMaximum),
    ...sourceDaily.filter((row) => !row.missing).map((row) => nonnegative(row.rawTotal)));
  const review = buildCapacityReview({ name: context.name, keyword: context.keyword, businessType: context.businessType,
    inventoryCapacityBaseline: baseline, collectionProductCoverage: snapshot.collectionProductCoverage,
    listType: sourceProducts.map((product) => product?.listType || "").join(" ") },
  { baseline, rows, summaryOnly: true, lodging: { rows: daily, maximumObservedCapacity: observedMaximum } });
  const reasons = [...review.reasons];
  const add = (code, message, scope, evidence = {}, severity = review.reviewed ? "info" : "warning") => {
    if (!reasons.some((reason) => reason.code === code)) reasons.push({ code, message, scope, severity, evidence: { source: "stored_snapshot", ...evidence } });
  };
  const fullDaily = sourceDaily.filter((row) => !row.missing && !row.partial && number(row.rawTotal) !== null && number(row.rawTotal) >= 0);
  const weakDaily = sourceDaily.filter((row) => row.missing || row.partial || number(row.rawTotal) === null);
  const noFullDaily = fullDaily.length === 0;
  const collectionScope = review.reviewed || !noFullDaily ? "observation" : "capacity";
  const collectionSeverity = review.reviewed || !noFullDaily ? "info" : "warning";
  const onlyDayUse = sourceProducts.length > 0 && rows.length === 0 && sourceDaily.length === 0;
  if (!onlyDayUse && (!sourceDaily.length || weakDaily.length)) add("stock_evidence_missing", "저장된 일부 날짜의 재고 근거가 부족합니다. 오류·누락의 세부 원인은 원문 확인이 필요합니다.", collectionScope,
    { incompleteDays: weakDaily.length, dailySummaryAvailable: sourceDaily.length > 0 }, collectionSeverity);
  if (!onlyDayUse && !rows.length) add("product_identity_evidence_missing", "저장된 상품명·번호가 없어 객실 구성과 중복 상품을 확인하지 못했습니다.", "composition");
  if (snapshot.summary?.productTruncated === true) add("product_identity_summary_truncated", "업체 DB의 상품 목록이 일부만 저장되어 전체 객실 구성은 확인이 필요합니다.", "composition", { observedProducts: nonnegative(snapshot.summary.observedProductCount), storedProducts: sourceProducts.length });
  // Preserve already-recorded provider/coverage facts that aggregate summaries
  // cannot reconstruct. Change their severity only when the DB basis changes.
  const retainedCodes = new Set(["product_targets_truncated", "product_list_incomplete", "product_day_targets_incomplete", "stock_collection_failed", "zero_stock_capacity_unverified", "stock_booking_conflict"]);
  for (const previous of Array.isArray(snapshot.capacityReview?.reasons) ? snapshot.capacityReview.reasons : []) {
    if (!retainedCodes.has(previous?.code) || reasons.some((reason) => reason.code === previous.code)) continue;
    const collection = ["stock_collection_failed", "zero_stock_capacity_unverified"].includes(previous.code);
    const noZeroBasis = previous.code === "zero_stock_capacity_unverified" && !review.reviewed && review.basis === "missing";
    const scope = noZeroBasis ? "capacity" : collection ? collectionScope : previous.code === "stock_booking_conflict" && review.reviewed ? "observation" : "capacity";
    const severity = noZeroBasis || previous.code === "stock_booking_conflict" ? "warning" : collection ? collectionSeverity : review.reviewed ? "info" : "warning";
    reasons.push({ ...previous, scope, severity });
  }
  if (snapshot.recalculationUnavailable || snapshot.capacityReview?.codes?.includes("correction_recalculation_unavailable")) add("correction_recalculation_unavailable", "현재 DB 검수값을 적용했지만 저장 원문이 없어 예약·매출 재계산을 확인하지 못했습니다.", "observation", {}, "warning");
  const warnings = reasons.filter((reason) => reason.severity === "warning");
  return { ...review, reasons, required: warnings.length > 0, codes: warnings.map((reason) => reason.code), message: warnings.map((reason) => reason.message).join(" "),
    level: warnings.length ? "warning" : reasons.length ? "info" : "none",
    capacityUncertain: !review.reviewed && warnings.some((reason) => reason.scope === "capacity" || reason.scope === "composition"), source: "stored_snapshot" };
}

function applyInventoryEvidence(original) {
  const previous = original.inventoryEvidence;
  const rawProducts = evidenceProducts(original);
  if (!rawProducts.some((row) => Object.hasOwn(row, "stock") && Object.hasOwn(row, "bookingCount"))) return original;
  const baseline = original.inventoryCapacityBaseline || {};
  const stockCorrections = applyProductStockCorrections(rawProducts, baseline.productStockCorrections, (row) => productKind(row) === "lodging");
  const reviewedProducts = reviewedProductEvidence(stockCorrections.rows, baseline);
  const products = reviewedProducts.rows.map(productEvidence);
  const item = { ...original };
  const dates = requestedDates(products, original);
  const verified = verifiedInventory[String(item.placeId || item.place_id || "")];
  const hasLodging = products.some((row) => row.kind === "lodging");
  const hasDayUse = products.some((row) => row.kind === "dayUse") || nonnegative(original.dayUseItemCount) > 0;
  let sharedRooms = original.sharedRooms || verified?.sharedRooms || previous?.sharedRooms || { status: "unknown" };
  if (hasLodging && hasDayUse && !["confirmed", "separate", "confirmed_separate", "not_shared"].includes(sharedRooms.status)) sharedRooms = { ...sharedRooms, status: "assumed_shared", note: "숙박과 당일 이용을 병행하는 업체는 공유 객실로 가정하여, 같은 날짜의 당일 이용 공개 예약만큼 숙박 전화·타채널 예약 추정에서 제외합니다." };
  if (!hasDayUse) sharedRooms = { ...sharedRooms, note: sharedRooms.note || "데이유즈 상품이 관측되지 않았습니다." };
  const dayUse = summarizeEvidence(products, "dayUse", { dates, capacity: baseline.dayUse, override: baseline.dayUseOverride });
  const physicalRooms = original.roomGuideReference || verified?.physicalRooms || previous?.roomGuideReference || previous?.physicalRooms || { count: null, label: "객실 안내 참고값 없음" };
  // Public room descriptions are a reference, never an automatic capacity
  // override or a source of extra product capacity for inferred revenue.
  const roomGuideReference = { ...physicalRooms, label: "객실 안내 참고", role: "reference_only" };
  const lodging = summarizeEvidence(products, "lodging", {
    dates, capacity: baseline.lodging, override: baseline.lodgingOverride,
    productCapacities: correctionCapacity(baseline.lodgingOverride) === null ? {} : Object.fromEntries((baseline.lodgingOverride.products || []).map((product) => [String(product.id), nonnegative(product.count)])),
    dayUse, shared: ["confirmed", "assumed_shared"].includes(sharedRooms.status),
    // An incomplete product list cannot establish that day use is absent. Do
    // not turn unmeasured sharing/stock into synthetic telephone reservations.
    dayUseUnverified: original.dayUsePresence === "unknown"
      || (original.dayUsePresence === "present" && original.dayUseScheduleStatus !== undefined
        && original.dayUseScheduleStatus !== "requested" && !["separate", "confirmed_separate", "not_shared"].includes(sharedRooms.status))
  });
  if (!lodging && !dayUse) return original;
  const capacityBasis = lodging ? {
    count: lodging.operatingTotal, source: lodging.capacitySource,
    label: lodging.capacitySource === "db_correction" ? "DB 보정" : "최대 관측(추정)",
    observedMaximum: lodging.maximumObservedCapacity,
    currentObservedMaximum: lodging.observedMaximum,
  } : null;
  const capacityReview = buildCapacityReview(item, { baseline, rows: reviewedProducts.rows, lodging, dates });
  const originalRevenue = nonnegative(item.weeklyAdjustedRevenue ?? item.weeklyEstimatedRevenue) + nonnegative(item.dayUseWeeklyAdjustedRevenue ?? item.dayUseWeeklyEstimatedRevenue);
  item.inventoryEvidence = {
    version: 4, policy: POLICY, phoneValuationPolicy: PHONE_VALUATION_POLICY, lodging, dayUse, physicalRooms: roomGuideReference, roomGuideReference, sharedRooms, capacityBasis, capacityReview,
    exclusionEvidence: reviewedProducts.exclusionEvidence,
    normalizationEvidence: [...stockCorrections.normalizationEvidence, ...reviewedProducts.normalizationEvidence],
    excludedNonRoomProductCount: reviewedProducts.excludedProductCount,
    legacyExcluded: previous?.version === 4 && previous.policy === POLICY ? previous.legacyExcluded : {
      lodgingSold: lodging ? Math.max(0, nonnegative(original.weeklyTotalSoldOut) - lodging.sold) : 0,
      dayUseSold: dayUse ? Math.max(0, nonnegative(original.dayUseWeeklyTotalSoldOut) - dayUse.sold) : 0,
      revenue: Math.max(0, originalRevenue - (lodging?.revenue || 0) - (dayUse?.revenue || 0))
    }
  };
  applyKindFields(item, lodging, "lodging");
  applyKindFields(item, dayUse, "dayUse");
  if (previous?.version === 4 && JSON.stringify(previous) === JSON.stringify(item.inventoryEvidence) && Object.keys(item).every((key) => typeof item[key] === "object" || item[key] === original[key])) return original;
  return item;
}

module.exports = { applyInventoryEvidence, productEvidence, summarizeEvidence, buildCapacityReview, buildStoredCapacityReview };
