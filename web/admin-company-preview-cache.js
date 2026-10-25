(function (root) {
  "use strict";
  const KEY = "staydatalab:admin-company-preview:v1", LIMIT = 1500000, TTL = 30 * 60 * 1000;
  const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,180}$/.test(value);
  const month = value => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
  const record = value => value && typeof value === "object" && !Array.isArray(value);
  function create({ storage, now = () => Date.now() } = {}) {
    let auth = null, authExpiresAt = 0;
    const calendarMonth = () => new Date(now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
    function clear() { try { storage?.removeItem(KEY); } catch {} }
    function configure(session, { customerView = false } = {}) {
      const valid = session?.authenticated === true && session.role === "admin" && !customerView
        && typeof session.username === "string" && session.username.length > 0 && session.username.length <= 180
        && Number.isFinite(Date.parse(session.sessionCreatedAt)) && Number.isFinite(Date.parse(session.expiresAt))
        && Date.parse(session.expiresAt) > now();
      const next = valid ? JSON.stringify([session.username, session.role, session.sessionCreatedAt]) : null;
      if (auth && next !== auth || !next) clear();
      auth = next;
      authExpiresAt = valid ? Date.parse(session.expiresAt) : 0;
      if (auth) { try { const raw = storage?.getItem(KEY); if (raw && (raw.length > LIMIT || JSON.parse(raw)?.auth !== auth)) clear(); } catch { clear(); } }
      return Boolean(auth);
    }
    function matchingEnvelope(value, companyId, selectedMonth) {
      const snapshot = value?.snapshot;
      return record(value) && value.companyId === companyId && value.selectedMonth === selectedMonth
        && value.status === "ready" && !value.errorCode && !value.freshness?.selectedMonthVerificationError
        && snapshot?.request?.type === "company" && snapshot.request.targetId === companyId && snapshot.request.month === selectedMonth
        && snapshot?.target?.type === "company" && snapshot.target.id === companyId
        && record(snapshot.summary) && record(snapshot.summary.lodging) && Array.isArray(snapshot.daily);
    }
    function read(companyId, requestedMonth = "", context = null) {
      if (auth && now() >= authExpiresAt) configure(null);
      if (!auth || !id(companyId) || requestedMonth !== "" && !month(requestedMonth)) return null;
      try {
        const raw = storage?.getItem(KEY);
        if (!raw) return null;
        if (raw.length > LIMIT) { clear(); return null; }
        const entry = JSON.parse(raw), age = now() - entry.storedAt;
        if (entry.schema !== 1 || entry.auth !== auth || !Number.isFinite(age) || age < 0 || age > TTL
          || !id(entry.company?.companyId) || entry.company.companyId !== companyId || entry.requestedMonth !== requestedMonth
          || !month(entry.selectedMonth) || requestedMonth && requestedMonth !== entry.selectedMonth
          || !requestedMonth && entry.calendarMonth !== calendarMonth()
          || typeof entry.sourceRevision !== "string" || !entry.sourceRevision || entry.sourceRevision.length > 256
          || typeof entry.company.primaryName !== "string" || entry.company.primaryName.length > 200
          || !Number.isSafeInteger(entry.company.manualCorrectionRevision) || entry.company.manualCorrectionRevision < 0
          || !matchingEnvelope(entry.envelope, companyId, entry.selectedMonth)) return null;
        if (context && (context.sourceRevision !== entry.sourceRevision
          || context.correctionRevision !== entry.company.manualCorrectionRevision)) return null;
        return { ...entry, company: { ...entry.company, detailLoaded: false }, envelope: { ...entry.envelope,
          freshness: { ...entry.envelope.freshness, savedPreview: true, browserPreview: true, selectedMonthVerified: false } } };
      } catch { clear(); return null; }
    }
    function write(context, envelope, requestedMonth = "") {
      if (auth && now() >= authExpiresAt) configure(null);
      if (!auth || !id(context?.companyId) || typeof context.isCurrent !== "function" || !context.isCurrent()
        || requestedMonth !== "" && !month(requestedMonth) || !month(envelope?.selectedMonth)
        || requestedMonth && requestedMonth !== envelope.selectedMonth
        || !matchingEnvelope(envelope, context.companyId, envelope.selectedMonth)
        || envelope.freshness?.savedPreview === true || typeof context.sourceRevision !== "string"
        || !context.sourceRevision || context.sourceRevision.length > 256
        || !Number.isSafeInteger(context.correctionRevision) || context.correctionRevision < 0) return false;
      const company = { companyId: context.companyId, primaryName: String(context.companyName || "").slice(0, 200),
        manualCorrectionRevision: context.correctionRevision, updatedAt: String(context.updatedAt || "").slice(0, 64) };
      try {
        const raw = JSON.stringify({ schema: 1, auth, storedAt: now(), calendarMonth: calendarMonth(),
          requestedMonth, selectedMonth: envelope.selectedMonth, sourceRevision: context.sourceRevision, company, envelope });
        if (raw.length > LIMIT || !context.isCurrent() || now() >= authExpiresAt) return false;
        storage?.setItem(KEY, raw); return true;
      } catch { return false; }
    }
    return { configure, clear, read, write };
  }
  // Access may be disabled by browser privacy settings. That is a cache miss.
  let storage; try { storage = root.sessionStorage; } catch {}
  const api = { create, ...create({ storage }) };
  root.AdminCompanyPreviewCache = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
