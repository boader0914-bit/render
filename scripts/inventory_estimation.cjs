"use strict";

// A read model only: original CSVs, provider responses and saved snapshots stay intact.
const verifiedInventory = require("./verified_room_inventory.json");
const number = (value) => value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && !value.trim()) ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const nonnegative = (value) => Math.max(0, number(value) || 0);
const shortDate = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const dayType = (date) => ["일요일", "평일", "평일", "평일", "평일", "금요일", "토요일"][new Date(`${date}T12:00:00+09:00`).getUTCDay()];

function productKind(row) {
  const explicit = [row.saleType, row.bizItemSubType].filter(Boolean).join(" ");
  if (/숙박|night|overnight/i.test(explicit)) return "lodging";
  if (/데이|day[_\s]*use|당일|캠프닉|campnic|camp_nic/i.test(explicit)) return "dayUse";
  return /데이유즈|캠프닉|캠핑닉|피크닉|대실|당일|day\s*use/i.test(row.name || "") ? "dayUse" : "lodging";
}

function evidenceProducts(item) {
  const weekly = Array.isArray(item.weeklyProductDetails) ? item.weeklyProductDetails : [];
  const basis = Array.isArray(item.itemDetails) ? item.itemDetails : [];
  const seen = new Set();
  return [...weekly, ...basis].filter((row) => {
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
  const observed = stock !== null && stock >= 0 && booked !== null && booked >= 0;
  const sold = observed ? booked : 0;
  const roomList = row.listType === "객실별 예약리스트";
  const rawTotal = observed ? (roomList && stock > 0 ? 1 : stock) : 0;
  const total = Math.max(rawTotal, sold);
  const available = observed && open ? Math.min(total, Math.max(0, rawTotal - sold - occupied)) : 0;
  const price = number(row.price);
  const priced = observed && price > 0 ? sold : 0;
  return {
    date: row.date, key: row.bizItemId || row.key || row.name, kind: productKind(row),
    total, rawTotal, available, sold, observed,
    unverifiedOccupied: occupied,
    unverifiedUnavailable: Math.max(0, total - available - sold),
    inventoryConflict: observed && sold > rawTotal,
    price, estimatedRevenue: priced * (price || 0), pricedSoldOut: priced,
    missingPriceSoldOut: Math.max(0, sold - priced),
    closed: !open && !sold
  };
}

function summarizeEvidence(products, kind) {
  const source = products.filter((row) => row.kind === kind);
  if (!source.length) return null;
  const productKeys = new Set(source.map((row) => row.key));
  const dates = new Map();
  for (const product of source) {
    if (!dates.has(product.date)) dates.set(product.date, {
      date: product.date, total: 0, available: 0, sold: 0, rawTotal: 0,
      estimatedRevenue: 0, pricedSoldOut: 0, missingPriceSoldOut: 0,
      unverifiedOccupied: 0, unverifiedUnavailable: 0, inventoryConflict: false,
      observedProducts: 0, productCount: 0, closedProducts: 0
    });
    const row = dates.get(product.date);
    for (const field of ["total", "rawTotal", "available", "sold", "estimatedRevenue", "pricedSoldOut", "missingPriceSoldOut", "unverifiedOccupied", "unverifiedUnavailable"]) row[field] += product[field];
    row.inventoryConflict ||= product.inventoryConflict;
    row.productCount++;
    row.observedProducts += Number(product.observed);
    row.closedProducts += Number(product.closed);
  }
  const rows = [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
  const frequencies = new Map();
  rows.filter((row) => row.total > 0).forEach((row) => frequencies.set(row.total, (frequencies.get(row.total) || 0) + 1));
  const operatingTotal = [...frequencies].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] || 0;
  for (const row of rows) {
    row.inventoryShortfall = Math.max(0, operatingTotal - row.rawTotal);
    row.missing = row.observedProducts === 0;
    row.partial = row.observedProducts < productKeys.size;
    row.closed = row.closedProducts === row.productCount;
    row.rate = row.total > 0 && !row.inventoryConflict ? row.sold / row.total : null;
    // Missing prices remain visible. Neither sold quantities nor prices are invented.
  }
  const result = { rows, operatingTotal, total: 0, available: 0, sold: 0, revenue: 0, pricedSoldOut: 0, missingPriceSoldOut: 0, inventoryShortfall: 0, unverifiedOccupied: 0, unverifiedUnavailable: 0 };
  for (const row of rows) {
    for (const field of ["total", "available", "sold", "pricedSoldOut", "missingPriceSoldOut", "inventoryShortfall", "unverifiedOccupied", "unverifiedUnavailable"]) result[field] += row[field];
    result.revenue += row.estimatedRevenue;
  }
  result.status = rows.every((row) => row.missing) ? "missing" : rows.some((row) => row.partial || row.inventoryConflict) ? "partial" : "observed";
  result.complete = result.status === "observed";
  return result;
}

function applyKindFields(item, summary, kind) {
  if (!summary) return;
  const prefix = kind === "dayUse" ? "dayUseWeekly" : "weekly";
  const unit = kind === "dayUse" ? "회" : "개";
  const rows = summary.rows;
  const totalMax = Math.max(0, ...rows.map((row) => row.total));
  const set = (name, value) => { item[prefix + name] = value; };
  set("Days", rows.filter((row) => !row.missing).length);
  set("TotalStock", summary.total);
  set("TotalSoldOut", summary.sold);
  set("BasisTotal", totalMax);
  set("OperatingTotal", summary.operatingTotal);
  set("StructuralBlockedTotal", 0);
  set("OfflineReservedTotal", 0);
  set("MinTotal", Math.min(...rows.map((row) => row.total)));
  set("MaxTotal", totalMax);
  set("TotalVarianceGap", totalMax - item[prefix + "MinTotal"]);
  set("EstimatedRevenue", summary.revenue);
  set("AdjustedRevenue", summary.revenue);
  set("MissingPriceEstimatedRevenue", 0);
  set("PricedSoldOut", summary.pricedSoldOut);
  set("MissingPriceSoldOut", summary.missingPriceSoldOut);
  set("RevenuePrecisionRate", summary.sold ? summary.pricedSoldOut / summary.sold : null);
  set("AvgSoldUnitPrice", summary.pricedSoldOut ? Math.round(summary.revenue / summary.pricedSoldOut) : null);
  set("AvgReservationRate", summary.total ? summary.sold / summary.total : null);
  set("OfflineReservationDetail", "");
  set("BasisRule", "날짜별 수집 수량 합계. 판매 중지·방막기·수량 감소는 예약에 더하지 않습니다.");
  set("StockBasisType", "booking_evidence_v2");
  set("Detail", rows.filter((row) => !row.missing).map((row) => `${shortDate(row.date)} ${row.available}/${row.total}`).join(", "));
  set("ReservationRateDetail", rows.filter((row) => !row.missing).map((row) => `${shortDate(row.date)} ${Math.round((row.rate || 0) * 100)}%(${row.sold}/${row.total})`).join(", "));
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

function applyInventoryEvidence(original) {
  if (original.inventoryEvidence?.version === 2) return original;
  const rawProducts = evidenceProducts(original);
  if (!rawProducts.some((row) => Object.hasOwn(row, "stock") && Object.hasOwn(row, "bookingCount"))) return original;
  const products = rawProducts.map(productEvidence);
  const item = { ...original };
  const lodging = summarizeEvidence(products, "lodging");
  const dayUse = summarizeEvidence(products, "dayUse");
  if (!lodging && !dayUse) return original;
  for (const [part, expected] of [[lodging, original.weeklyDays], [dayUse, original.dayUseWeeklyDays ?? original.weeklyDays]]) {
    if (!part) continue;
    const expectedDays = Math.max(nonnegative(expected), new Set(products.map((row) => row.date)).size);
    part.missingDays = Math.max(0, expectedDays - part.rows.length);
    if (part.missingDays) { part.complete = false; if (part.status !== "missing") part.status = "partial"; }
  }
  const verified = verifiedInventory[String(item.placeId || item.place_id || "")];
  const originalRevenue = nonnegative(item.weeklyAdjustedRevenue ?? item.weeklyEstimatedRevenue) + nonnegative(item.dayUseWeeklyAdjustedRevenue ?? item.dayUseWeeklyEstimatedRevenue);
  item.inventoryEvidence = {
    version: 2, lodging, dayUse,
    physicalRooms: verified?.physicalRooms || { count: null, label: "실제 객실 수 미확인", source: "예약 페이지의 수량만으로 실제 객실 수를 확정하지 않습니다." },
    sharedRooms: verified?.sharedRooms || { status: "unknown", note: dayUse ? "데이유즈와 숙박의 객실 공유 여부는 확인이 필요합니다." : "데이유즈 상품이 관측되지 않았습니다." },
    legacyExcluded: {
      lodgingSold: lodging ? Math.max(0, nonnegative(original.weeklyTotalSoldOut) - lodging.sold) : 0,
      dayUseSold: dayUse ? Math.max(0, nonnegative(original.dayUseWeeklyTotalSoldOut) - dayUse.sold) : 0,
      revenue: Math.max(0, originalRevenue - (lodging?.revenue || 0) - (dayUse?.revenue || 0))
    }
  };
  applyKindFields(item, lodging, "lodging");
  applyKindFields(item, dayUse, "dayUse");
  return item;
}

module.exports = { applyInventoryEvidence, productEvidence, summarizeEvidence };
