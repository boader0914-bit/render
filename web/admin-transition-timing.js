(function (root) {
  "use strict";
  // Handler entry -> synchronous DOM update -> two animation-frame callbacks.
  // This is display-readiness instrumentation, not proof of physical paint.
  // One active measurement and one frame callback are retained; no storage,
  // network, application data or permission state is changed.
  let sequence = 0, active = null, frameScheduled = false, frameHandle;
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
  const api = { begin, rendered, invalidate };
  root.AdminTransitionTiming = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
