"use strict";

const DAY_USE_MODES = Object.freeze({ inspect: "유무확인", lodging_only: "숙박만", detail: "상세수집" });
function normalizeDayUseMode(value, fallback = "inspect") {
  const text = String(value ?? "").trim();
  return Object.hasOwn(DAY_USE_MODES, text) ? text : fallback;
}

// The product list proves existence only. It never proves shared physical rooms
// or the daily stock/booking quantity of a day-use product.
function dayUsePlan({ mode, itemResult, classify, collectDetail = true }) {
  mode = normalizeDayUseMode(mode);
  const listed = Array.isArray(itemResult.items) ? itemResult.items : [];
  const hasErrors = Array.isArray(itemResult.errors) ? itemResult.errors.length > 0 : Boolean(itemResult.errors);
  const listComplete = itemResult.status >= 200 && itemResult.status < 300 && !hasErrors && itemResult.listObserved === true;
  const all = listed.filter(item => item.isImp !== false && item.isClosedBooking !== true && item.isClosedBookingUser !== true);
  const dayUseItems = all.filter(item => classify(item) === "데이유즈");
  const lodgingItems = all.filter(item => classify(item) !== "데이유즈");
  const presence = listed.some(item => classify(item) === "데이유즈") ? "present"
    : listComplete && !listed.some(item => classify(item) === "미분류") ? "absent" : "unknown";
  const collectDayUseSchedules = mode === "detail" && collectDetail;
  return {
    mode, all, lodgingItems, dayUseItems, listComplete, presence, collectDayUseSchedules,
    eligible: collectDayUseSchedules ? all : lodgingItems,
    excludedDayUse: collectDayUseSchedules ? 0 : dayUseItems.length,
    scheduleStatus: collectDayUseSchedules ? "requested" : mode === "lodging_only" ? "excluded" : collectDetail ? "not_requested" : "not_requested_basic",
    sharingStatus: presence === "absent" ? "not_applicable" : "unconfirmed",
  };
}

function withoutUncollectedDayUse(result, plan) {
  const updated = { ...result, dayUseMode: plan.mode, dayUsePresence: plan.presence,
    dayUseScheduleStatus: plan.scheduleStatus, dayUseSharingStatus: plan.sharingStatus,
    dayUseItemCount: plan.presence === "unknown" && !plan.dayUseItems.length ? null : plan.dayUseItems.length };
  if (!plan.collectDayUseSchedules) {
    for (const key of Object.keys(updated)) {
      if (/^dayUse(?:Estimated|Adjusted|Missing|Revenue|Priced|Avg|Min|Max|Available|Total|Availability|Counted)/.test(key)) updated[key] = null;
    }
    updated.dayUseWeekly = null;
  }
  return updated;
}

module.exports = { DAY_USE_MODES, normalizeDayUseMode, dayUsePlan, withoutUncollectedDayUse };
