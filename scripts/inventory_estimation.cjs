"use strict";

// A read model only: original CSVs, provider responses and saved snapshots stay intact.
const verifiedInventory = require("./verified_room_inventory.json");
const number = (value) => value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && !value.trim()) ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const nonnegative = (value) => Math.max(0, number(value) || 0);
const shortDate = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const dayType = (date) => ["일요일", "평일", "평일", "평일", "평일", "금요일", "토요일"][new Date(`${date}T12:00:00+09:00`).getUTCDay()];
const POLICY = "maximum_capacity_phone_estimate";
const SUM_FIELDS = ["total", "rawTotal", "available", "sold", "publicBookings", "phoneBookings", "sharedDayUseExcluded", "unknownUnavailable", "publicRevenue", "phoneRevenue", "pricedSoldOut", "missingPriceSoldOut", "phonePricedBookings", "phoneMissingPriceBookings", "inventoryShortfall", "unverifiedOccupied", "unverifiedUnavailable"];
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
    inventoryConflict: false, observedProducts: 0, productCount: 0, closedProducts: 0 };
}

// Product maxima locate a shortage for pricing; their sum never increases the
// company's capacity. Ambiguous quantities keep their price missing.
function phoneValuation(dateProducts, capacities, capacity, phoneBookings, excluded) {
  if (!phoneBookings || [...capacities.values()].reduce((sum, value) => sum + value, 0) > capacity) return { revenue: 0, priced: 0 };
  const candidates = dateProducts.map((product) => ({
    product, quantity: Math.max(0, (capacities.get(product.key) || 0) - product.available - product.sold)
  })).filter((candidate) => candidate.quantity > 0);
  // No implicit cross-product price when the shared block cannot be mapped.
  if (excluded && candidates.length !== 1) return { revenue: 0, priced: 0 };
  let remaining = phoneBookings, revenue = 0, priced = 0;
  for (const { product, quantity } of candidates) {
    const amount = Math.min(remaining, Math.max(0, quantity - excluded));
    remaining -= amount;
    if (product.price > 0) { priced += amount; revenue += amount * product.price; }
  }
  return { revenue, priced };
}

function summarizeEvidence(products, kind, options = {}) {
  const source = products.filter((row) => row.kind === kind);
  if (!source.length) return null;
  const productKeys = new Set(source.map((row) => row.key));
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
    row.sharedDayUseIncomplete = kind === "lodging" && options.shared && (!dayUse || dayUse.partial || dayUse.inventoryConflict);
    row.partial ||= Boolean(row.sharedDayUseIncomplete);
    const canEstimate = !row.partial && !row.inventoryConflict;
    if (kind === "lodging" && canEstimate) {
      row.sharedDayUseExcluded = options.shared && dayUse && !dayUse.partial ? Math.min(unavailable, dayUse.publicBookings) : 0;
      row.phoneBookings = Math.max(0, unavailable - row.sharedDayUseExcluded);
      const value = phoneValuation(byDate.get(row.date) || [], capacities, operatingTotal, row.phoneBookings, row.sharedDayUseExcluded);
      row.phoneRevenue = value.revenue;
      row.phonePricedBookings = value.priced;
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
  for (const name of ["PublicBookings", "PhoneBookings", "SharedDayUseExcluded", "UnknownUnavailable", "InventoryShortfall", "PublicRevenue", "PhoneRevenue", "PhonePricedBookings", "PhoneMissingPriceBookings"]) set(name, summary[name[0].toLowerCase() + name.slice(1)]);
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
  set("RevenuePrecisionRate", summary.sold ? summary.pricedSoldOut / summary.sold : null);
  set("AvgSoldUnitPrice", summary.pricedSoldOut ? Math.round(summary.revenue / summary.pricedSoldOut) : null);
  set("AvgReservationRate", summary.complete && summary.total ? summary.sold / summary.total : null);
  set("OfflineReservationDetail", rows.filter((row) => row.phoneBookings).map((row) => `${shortDate(row.date)} 전화·타채널 추정 ${row.phoneBookings}${unit}`).join(", "));
  const capacityLabel = summary.capacitySource === "db_correction" ? "DB 보정 수량" : "최대 관측 수량(추정)";
  set("BasisRule", kind === "lodging" ? `${capacityLabel}을 매일 총량으로 유지합니다. 총량에서 예약 가능·공개 예약·당일 이용 공유 차단을 뺀 수량은 전화·타채널 예약으로 추정합니다. 수집 실패·누락·수량 충돌은 예약으로 추정하지 않습니다. 객실 안내는 참고값입니다.` : `${capacityLabel}을 매일 총량으로 유지하며, 당일 이용 예약은 공개 예약 수량만 사용합니다.`);
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

function applyInventoryEvidence(original) {
  const previous = original.inventoryEvidence;
  const rawProducts = evidenceProducts(original);
  if (!rawProducts.some((row) => Object.hasOwn(row, "stock") && Object.hasOwn(row, "bookingCount"))) return original;
  const products = rawProducts.map(productEvidence);
  const item = { ...original };
  const dates = requestedDates(products, original);
  const verified = verifiedInventory[String(item.placeId || item.place_id || "")];
  const hasLodging = products.some((row) => row.kind === "lodging");
  const hasDayUse = products.some((row) => row.kind === "dayUse") || nonnegative(original.dayUseItemCount) > 0;
  let sharedRooms = original.sharedRooms || verified?.sharedRooms || previous?.sharedRooms || { status: "unknown" };
  if (hasLodging && hasDayUse && !["confirmed", "separate", "confirmed_separate", "not_shared"].includes(sharedRooms.status)) sharedRooms = { ...sharedRooms, status: "assumed_shared", note: "숙박과 당일 이용을 병행하는 업체는 공유 객실로 가정하여, 같은 날짜의 당일 이용 공개 예약만큼 숙박 전화·타채널 예약 추정에서 제외합니다." };
  if (!hasDayUse) sharedRooms = { ...sharedRooms, note: sharedRooms.note || "데이유즈 상품이 관측되지 않았습니다." };
  const baseline = original.inventoryCapacityBaseline || {};
  const dayUse = summarizeEvidence(products, "dayUse", { dates, capacity: baseline.dayUse, override: baseline.dayUseOverride });
  const physicalRooms = original.roomGuideReference || verified?.physicalRooms || previous?.roomGuideReference || previous?.physicalRooms || { count: null, label: "객실 안내 참고값 없음" };
  // Public room descriptions are a reference, never an automatic capacity
  // override or a source of extra product capacity for inferred revenue.
  const roomGuideReference = { ...physicalRooms, label: "객실 안내 참고", role: "reference_only" };
  const lodging = summarizeEvidence(products, "lodging", {
    dates, capacity: baseline.lodging, override: baseline.lodgingOverride,
    productCapacities: correctionCapacity(baseline.lodgingOverride) === null ? {} : Object.fromEntries((baseline.lodgingOverride.products || []).map((product) => [String(product.id), nonnegative(product.count)])),
    dayUse, shared: ["confirmed", "assumed_shared"].includes(sharedRooms.status)
  });
  if (!lodging && !dayUse) return original;
  const capacityBasis = lodging ? {
    count: lodging.operatingTotal, source: lodging.capacitySource,
    label: lodging.capacitySource === "db_correction" ? "DB 보정" : "최대 관측(추정)",
    observedMaximum: lodging.maximumObservedCapacity,
    currentObservedMaximum: lodging.observedMaximum,
  } : null;
  const glamping = /글램핑|glamping/i.test([item.name, item.keyword, item.searchKeyword, item.category, item.businessType, item.lodgingType, item.accommodationMarketType, baseline.businessType].filter(Boolean).join(" "));
  const reviewCodes = [];
  if (glamping && lodging?.capacitySource === "observed_maximum" && lodging.operatingTotal > 40) reviewCodes.push("glamping_observed_over_40");
  if (lodging?.rows.some((row) => row.capacityConflict)) reviewCodes.push("db_capacity_observation_conflict");
  const capacityReview = { required: reviewCodes.length > 0, codes: reviewCodes, threshold: 40, message: reviewCodes.map((code) => code === "glamping_observed_over_40" ? "글램핑 최대 관측 수량이 40실을 초과합니다. 객실 수와 상품 구성을 검토해 주세요." : "DB 보정 객실 수보다 수집 수량이 큽니다. 해당 날짜의 전화예약 추정과 예약률은 계산하지 않습니다.").join(" ") };
  const originalRevenue = nonnegative(item.weeklyAdjustedRevenue ?? item.weeklyEstimatedRevenue) + nonnegative(item.dayUseWeeklyAdjustedRevenue ?? item.dayUseWeeklyEstimatedRevenue);
  item.inventoryEvidence = {
    version: 4, policy: POLICY, lodging, dayUse, physicalRooms: roomGuideReference, roomGuideReference, sharedRooms, capacityBasis, capacityReview,
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

module.exports = { applyInventoryEvidence, productEvidence, summarizeEvidence };
