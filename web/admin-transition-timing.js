(function (root) {
  "use strict";
  // Handler entry -> synchronous DOM update -> two animation-frame callbacks.
  // This is display-readiness instrumentation, not proof of physical paint.
  // One active measurement and one frame callback are retained; no storage,
  // network, application data or permission state is changed.
  let sequence = 0, active = null, frameScheduled = false, frameHandle;
  let navigationMeasurement = null, navigationDone = false;
  const navigationStageFields = Object.freeze({ scriptReady: "appNavigationScriptReadyMs", sessionStart: "appNavigationSessionStartMs",
    sessionReady: "appNavigationSessionReadyMs", bootstrapStart: "appNavigationBootstrapStartMs", bootstrapParsed: "appNavigationBootstrapParsedMs",
    priorityRenderStart: "appNavigationPriorityRenderStartMs", priorityRendered: "appNavigationPriorityRenderedMs",
    savedFetchStart: "appNavigationSavedFetchStartMs", savedParsed: "appNavigationSavedParsedMs", savedRendered: "appNavigationSavedRenderedMs" });
  const earlyNavigationStages = new Map(), recordedNavigationStages = new Set();
  let navigationStageScope = null, navigationCompanyClaim = null;
  let verifiedNavigationScope = null, verifiedNavigationClaim = null, verifiedNavigationDone = false;
  const maximumInputWait = 60000;
  const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const milliseconds = value => String(Math.round(value * 10) / 10);
  const target = () => root.document?.getElementById?.("appMain") || null;
  function clock() {
    let wall = null, monotonic = null, origin = null;
    try { const value = root.Date?.now(); if (finite(value)) wall = value; } catch {}
    try { const value = root.performance?.now(); if (finite(value)) monotonic = value; } catch {}
    try { const value = root.performance?.timeOrigin; if (finite(value)) origin = value; } catch {}
    return { wall, monotonic, origin };
  }
  function roleStamp() {
    const classes = root.document?.body?.classList;
    if (!classes || typeof classes.contains !== "function") return null;
    return ["role-admin", "role-b2b", "admin-user-view"].filter(name => classes.contains(name)).join("|");
  }
  function elapsed(measurement, value) {
    const end = measurement.monotonic ? value.monotonic : value.wall;
    return finite(end) && end >= measurement.started ? end - measurement.started : null;
  }
  function inputWait(input, start) {
    if (!finite(input) || !finite(start.wall)) return null;
    // Modern event timestamps share performance.timeOrigin. Verify its axis
    // against the wall clock before accepting that interpretation.
    if (finite(start.monotonic) && finite(start.origin)
      && Math.abs(start.origin + start.monotonic - start.wall) <= 1000) {
      const wait = start.monotonic - input;
      if (wait >= 0 && wait <= maximumInputWait) return wait;
    }
    // Older browsers may supply an epoch timestamp instead. A close past wall
    // timestamp is accepted; future, stale and ambiguous values are omitted.
    const wait = start.wall - input;
    return wait >= 0 && wait <= maximumInputWait ? wait : null;
  }
  function cancelFrame() {
    if (!frameScheduled || typeof root.cancelAnimationFrame !== "function") return;
    try { root.cancelAnimationFrame(frameHandle); frameScheduled = false; frameHandle = undefined; } catch {}
  }
  function write(measurement, values, remove = []) {
    try {
      if (!measurement.target?.dataset || measurement.target.dataset.appTransitionSeq !== String(measurement.token.seq)) return false;
      for (const key of remove) delete measurement.target.dataset[key];
      for (const [key, value] of Object.entries(values)) measurement.target.dataset[key] = String(value);
      return true;
    } catch { return false; }
  }
  function finish(measurement, status, reason) {
    if (active !== measurement) return;
    measurement.stage = 0;
    measurement.finished = true;
    write(measurement, { appTransitionStatus: status, ...(reason ? { appTransitionReason: reason } : {}) }, ["appTransitionDisplayMs"]);
    cancelFrame();
  }
  function validity(measurement) {
    if (active !== measurement || measurement.finished) return "invalidated";
    if (target() !== measurement.target || roleStamp() !== measurement.role) return "invalidated";
    if (measurement.isCurrent && !measurement.isCurrent()) return "invalidated";
    const element = measurement.target;
    if (root.document?.visibilityState && root.document.visibilityState !== "visible") return "hidden";
    if (!element || element.isConnected === false || element.hidden === true || element.getAttribute?.("aria-hidden") === "true") return "hidden";
    if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return "hidden";
    const style = root.getComputedStyle?.(element);
    if (style && (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || style.opacity === "0")) return "hidden";
    if (measurement.isVisible && !measurement.isVisible(element)) return "hidden";
    return "current";
  }
  function check(measurement) {
    try {
      const status = validity(measurement);
      if (status === "current") return true;
      finish(measurement, status, status === "hidden" ? "NOT_VISIBLE" : "DESTINATION_CHANGED"); return false;
    } catch { finish(measurement, "error", "CURRENT_OR_VISIBILITY_CHECK_FAILED"); return false; }
  }
  function scheduleFrame() {
    if (frameScheduled) return;
    frameScheduled = true;
    try {
      const handle = root.requestAnimationFrame(advanceFrame);
      if (frameScheduled) frameHandle = handle;
    } catch {
      frameScheduled = false; frameHandle = undefined;
      if (active) finish(active, "error", "FRAME_SCHEDULING_FAILED");
    }
  }
  function advanceFrame() {
    frameScheduled = false; frameHandle = undefined;
    const measurement = active;
    if (!measurement || measurement.finished || !measurement.stage || !check(measurement)) return;
    if (measurement.stage === 1) { measurement.stage = 2; scheduleFrame(); return; }
    const duration = elapsed(measurement, clock());
    if (duration === null) { finish(measurement, "error", "CLOCK_UNAVAILABLE"); return; }
    measurement.stage = 0;
    // A loading DB can paint first, then finish under the same navigation.
    // Keep its original begin time until a later ready/error render completes.
    measurement.finished = measurement.status !== "waiting";
    write(measurement, { appTransitionStatus: measurement.status, appTransitionDisplayMs: milliseconds(duration) }, ["appTransitionReason"]);
  }
  function invalidate() {
    if (active) finish(active, "invalidated", "DESTINATION_CHANGED");
    active = null;
    cancelFrame();
  }
  function begin(options = {}) {
    invalidate();
    const token = Object.freeze({ seq: ++sequence });
    const start = clock();
    const measurement = { token, target: null, role: null, started: start.monotonic ?? start.wall,
      monotonic: start.monotonic !== null, finished: false, stage: 0 };
    active = measurement;
    try {
      const { tab, section = "", source = "", inputTimeStamp } = options && typeof options === "object" ? options : {};
      measurement.target = target(); measurement.role = roleStamp();
      const data = measurement.target?.dataset;
      if (!data) { measurement.finished = true; return token; }
      for (const name of ["appTransitionSyncMs", "appTransitionDisplayMs", "appTransitionInputWaitMs", "appTransitionReason", "appTransitionSource", "appTransitionStartedAt"]) delete data[name];
      data.appTransitionSeq = String(token.seq);
      const validName = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
      data.appTransitionDestination = validName(tab) && (!section || validName(section)) ? tab + (section ? ":" + section : "") : "unknown";
      data.appTransitionStatus = "pending";
      if (start.wall !== null) data.appTransitionStartedAt = String(start.wall);
      if (typeof source === "string" && source) data.appTransitionSource = source.slice(0, 96);
      if (data.appTransitionDestination === "unknown") { finish(measurement, "error", "INVALID_DESTINATION"); return token; }
      if (measurement.started === null || start.wall === null) { finish(measurement, "error", "CLOCK_UNAVAILABLE"); return token; }
      const wait = inputWait(inputTimeStamp, start);
      if (wait !== null) data.appTransitionInputWaitMs = milliseconds(wait);
    } catch { finish(measurement, "error", "TIMING_INITIALIZATION_FAILED"); }
    return token;
  }
  function rendered(token, options = {}) {
    const measurement = active;
    if (!measurement || measurement.token !== token || measurement.finished) return false;
    let status, isCurrent, isVisible;
    try {
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError();
      ({ status = "ready", isCurrent, isVisible } = options);
    } catch { finish(measurement, "error", "INVALID_OPTIONS"); return false; }
    if (!["ready", "waiting", "error"].includes(status)) { finish(measurement, "error", "INVALID_STATUS"); return false; }
    if ((isCurrent !== undefined && typeof isCurrent !== "function") || (isVisible !== undefined && typeof isVisible !== "function")) {
      finish(measurement, "error", "INVALID_CALLBACK"); return false;
    }
    measurement.isCurrent = typeof isCurrent === "function" ? isCurrent : null;
    measurement.isVisible = typeof isVisible === "function" ? isVisible : null;
    measurement.status = status;
    const duration = elapsed(measurement, clock());
    if (duration === null) { finish(measurement, "error", "CLOCK_UNAVAILABLE"); return false; }
    write(measurement, { appTransitionSyncMs: milliseconds(duration), appTransitionStatus: "pending" }, ["appTransitionDisplayMs", "appTransitionReason"]);
    if (!check(measurement)) return false;
    if (typeof root.requestAnimationFrame !== "function") { finish(measurement, "unavailable", "FRAME_API_UNAVAILABLE"); return false; }
    measurement.stage = 1; scheduleFrame(); return !measurement.finished;
  }
  function navigationRendered(options = {}) {
    if (navigationDone || navigationMeasurement) return false;
    let hasSavedMonth, isCurrent, isVisible;
    try { ({ hasSavedMonth, isCurrent, isVisible } = options); } catch { return false; }
    if ([hasSavedMonth, isCurrent, isVisible].some(callback => typeof callback !== "function")) return false;
    try { if (!hasSavedMonth() || !isCurrent() || !isVisible()) return false; } catch { return false; }
    const measurement = { target: target(), role: roleStamp(), hasSavedMonth, isCurrent, isVisible, handle: null };
    if (!measurement.target?.dataset) return false;
    navigationMeasurement = measurement;
    const finish = status => {
      if (navigationMeasurement !== measurement) return;
      navigationDone = true; navigationMeasurement = null;
      measurement.target.dataset.appNavigationStatus = status;
      if (measurement.handle !== null && typeof root.cancelAnimationFrame === "function") {
        try { root.cancelAnimationFrame(measurement.handle); } catch {}
      }
      measurement.hasSavedMonth = measurement.isCurrent = measurement.isVisible = null;
      navigationStageScope = null; navigationCompanyClaim = null; earlyNavigationStages.clear();
    };
    function valid() {
      try {
        const element = measurement.target, style = root.getComputedStyle?.(element);
        return navigationMeasurement === measurement && target() === element && roleStamp() === measurement.role
          && root.document?.visibilityState !== "hidden" && element.isConnected !== false && !element.hidden
          && element.getAttribute?.("aria-hidden") !== "true" && (!element.getClientRects || element.getClientRects().length > 0)
          && (!style || style.display !== "none" && !["hidden", "collapse"].includes(style.visibility) && style.opacity !== "0")
          && measurement.hasSavedMonth() && measurement.isCurrent() && measurement.isVisible();
      } catch { return false; }
    }
    const frame = callback => {
      try { measurement.handle = root.requestAnimationFrame(callback); }
      catch { finish("unavailable"); }
    };
    if (typeof root.requestAnimationFrame !== "function") { finish("unavailable"); return false; }
    measurement.target.dataset.appNavigationStatus = "pending";
    frame(() => {
      measurement.handle = null;
      if (!valid()) { finish("invalidated"); return; }
      frame(() => {
        measurement.handle = null;
        if (!valid()) { finish("invalidated"); return; }
        // performance.now() starts at this document's navigation origin, not
        // the later app handler/session/bootstrap-summary transition token.
        const end = clock(), duration = finite(end.monotonic) ? end.monotonic
          : finite(end.origin) && finite(end.wall) && end.wall >= end.origin ? end.wall - end.origin : null;
        if (duration === null) { finish("unavailable"); return; }
        measurement.target.dataset.appNavigationDisplayMs = milliseconds(duration);
        finish("ready");
      });
    });
    return navigationMeasurement === measurement;
  }
  function navigationStagesCurrent() {
    try { return !navigationDone && navigationStageScope
      && target() === navigationStageScope.target && roleStamp() === navigationStageScope.role && navigationStageScope.isCurrent(); }
    catch { return false; }
  }
  function writeNavigationStage(name, at) {
    if (!navigationStagesCurrent() || !finite(at) || recordedNavigationStages.has(name)) return false;
    try { navigationStageScope.target.dataset[navigationStageFields[name]] = milliseconds(at); recordedNavigationStages.add(name); return true; }
    catch { return false; }
  }
  function configureNavigationStages(options = {}) {
    if (navigationStageScope || navigationDone) return false;
    try {
      const { companyId, isCurrent } = options, element = target();
      if (typeof companyId !== "string" || !/^[A-Za-z0-9_-]{1,180}$/.test(companyId) || typeof isCurrent !== "function"
        || !element?.dataset || !isCurrent()) return false;
      navigationStageScope = { companyId, isCurrent, target: element, role: roleStamp() };
      verifiedNavigationScope = navigationStageScope;
      for (const [name, at] of earlyNavigationStages) writeNavigationStage(name, at);
      earlyNavigationStages.clear(); return true;
    } catch { return false; }
  }
  function markNavigationStage(name) {
    if (typeof name !== "string" || !Object.hasOwn(navigationStageFields, name) || name.startsWith("saved") || navigationDone) return false;
    const at = clock().monotonic;
    if (!finite(at)) return false;
    if (!navigationStageScope) {
      // No pre-authentication timing is exposed. Retain at most two numbers
      // until the app supplies its fresh-session/initial-route guard.
      if (!["scriptReady", "sessionStart"].includes(name) || earlyNavigationStages.has(name)) return false;
      earlyNavigationStages.set(name, at); return true;
    }
    return writeNavigationStage(name, at);
  }
  function markNavigationCompanyStage(name, options = {}) {
    if (!["savedFetchStart", "savedParsed", "savedRendered"].includes(name) || !navigationStagesCurrent()) return false;
    try {
      const { companyId, month, sequence: requestSequence, isCurrent } = options;
      if (companyId !== navigationStageScope.companyId || typeof month !== "string" || month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
        || !Number.isSafeInteger(requestSequence) || requestSequence < 0 || typeof isCurrent !== "function" || !isCurrent()) return false;
      if (!navigationCompanyClaim) {
        if (name !== "savedFetchStart") return false;
        navigationCompanyClaim = { companyId, month, sequence: requestSequence };
        verifiedNavigationClaim = navigationCompanyClaim;
      }
      if (navigationCompanyClaim.companyId !== companyId || navigationCompanyClaim.month !== month || navigationCompanyClaim.sequence !== requestSequence) return false;
      if (name === "savedParsed" && !recordedNavigationStages.has("savedFetchStart")
        || name === "savedRendered" && !recordedNavigationStages.has("savedParsed")) return false;
      return writeNavigationStage(name, clock().monotonic);
    } catch { return false; }
  }
  // Called only by the normal-read controller's successful two-frame ticket.
  // Its scope survives the earlier saved-display measurement, which remains
  // unchanged. Unknown/error/obsolete source states cannot certify completion.
  function markNavigationLatestReady(options = {}) {
    if (verifiedNavigationDone || !verifiedNavigationScope || !verifiedNavigationClaim) return false;
    try {
      const scope = verifiedNavigationScope, claim = verifiedNavigationClaim;
      const { companyId, month, savedSequence, sequence: requestSequence, isCurrent, isVisible, hasVerifiedMonth } = options;
      if (target() !== scope.target || roleStamp() !== scope.role || !scope.isCurrent() || companyId !== scope.companyId
        || companyId !== claim.companyId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || claim.month && month !== claim.month
        || savedSequence !== claim.sequence || !Number.isSafeInteger(requestSequence) || requestSequence <= savedSequence
        || [isCurrent, isVisible, hasVerifiedMonth].some(callback => typeof callback !== "function")
        || !isCurrent() || !isVisible() || !hasVerifiedMonth() || root.document?.visibilityState === "hidden"
        || scope.target.isConnected === false || scope.target.hidden || scope.target.getAttribute?.("aria-hidden") === "true"
        || scope.target.getClientRects && !scope.target.getClientRects().length) return false;
      const style = root.getComputedStyle?.(scope.target), at = clock().monotonic;
      if (style && (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || style.opacity === "0") || !finite(at)) return false;
      scope.target.dataset.appNavigationLatestReadyMs = milliseconds(at);
      scope.target.dataset.appNavigationLatestStatus = "ready";
      verifiedNavigationDone = true; verifiedNavigationScope = null; verifiedNavigationClaim = null;
      return true;
    } catch { return false; }
  }
  const api = { begin, rendered, invalidate, navigationRendered, markNavigationStage, configureNavigationStages, markNavigationCompanyStage, markNavigationLatestReady };
  root.AdminTransitionTiming = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
