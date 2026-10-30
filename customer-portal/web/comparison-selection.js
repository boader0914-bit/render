/* Shared comparison selection only. This module never fetches or recalculates observations. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InsightComparisonSelection = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const STORAGE_KEY = 'insight:comparison-selection:v1';
  const VERSION = 2, MAX_STORED_CHARS = 12000, MAX_URL_CHARS = 8192;
  const MODES = ['upcoming30', 'month', 'custom'];
  const VIEWS = ['flow', 'products', 'regions'];
  const STATE_KEYS = ['ownCompanyId', 'comparisonIds', 'stayMode', 'stayMonth', 'stayStart', 'stayEnd', 'asOfDate', 'selectedView'];
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null;
  const uniqueIds = value => [...new Set((Array.isArray(value) ? value : []).map(identifier).filter(Boolean))].sort().slice(0, 100);
  const copy = value => JSON.parse(JSON.stringify(value));
  const fingerprint = value => {
    // Partition marker, never an authentication credential or an authorization decision.
    let hash = 2166136261;
    for (const c of String(value || '')) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(36);
  };
  function parseDate(value) {
    // ISO civil years 0001–9999. A comparison policy may impose a narrower product period.
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) === '0000') return null;
    const time = Date.parse(value + 'T00:00:00.000Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
  }
  const validDate = value => parseDate(value) !== null;
  const validMonth = value => typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) && validDate(value + '-01');
  const addDays = (value, days) => new Date(parseDate(value) + days * 86400000).toISOString().slice(0, 10);
  function todayAt(now) {
    const value = typeof now === 'function' ? now() : now;
    const ms = value === undefined ? Date.now() : new Date(value).getTime();
    if (!Number.isFinite(ms)) throw new TypeError('A valid current time is required.');
    return new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
  }
  function monthRange(month) {
    if (!validMonth(month)) return null;
    const start = month + '-01', d = new Date(parseDate(start));
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    return { start, end: d.toISOString().slice(0, 10) };
  }
  function safeStorage(provided) {
    try { return provided === undefined ? (typeof sessionStorage === 'undefined' ? null : sessionStorage) : provided; }
    catch (_) { return null; }
  }
  function pickSelection(input) {
    const out = {};
    for (const key of STATE_KEYS) if (input && Object.hasOwn(input, key)) out[key] = input[key];
    return out;
  }
  function encodeSelection(state) {
    const params = new URLSearchParams();
    for (const key of STATE_KEYS) {
      const value = state && state[key];
      if (key === 'comparisonIds') params.set(key, uniqueIds(value).join(','));
      else if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
    }
    return params.toString();
  }
  function decodeSelection(input) {
    const value = String(input || '');
    if (value.length > MAX_URL_CHARS) return {};
    let query = value;
    if (/^https?:\/\//i.test(value)) {
      try { const url = new URL(value); query = url.search.slice(1); }
      catch (_) { return {}; }
    } else query = value.replace(/^[?#]/, '');
    const params = new URLSearchParams(query), out = {};
    for (const key of STATE_KEYS) {
      // Ambiguous repeated values must not silently choose a different period or company.
      if (params.getAll(key).length !== 1) continue;
      if (key === 'comparisonIds') out[key] = uniqueIds(params.get(key).split(','));
      else out[key] = params.get(key);
    }
    return out;
  }
  function contextOf(options) {
    const companies = new Map((Array.isArray(options.companies) ? options.companies : []).filter(c => identifier(c?.companyId)).map(c => [c.companyId, {
      companyId: c.companyId, regionKey: identifier(c.analysisRegionKey) || identifier(c.regionKey), regionLabel: typeof c.regionLabel === 'string' ? c.regionLabel.slice(0, 100) : ''
    }]));
    const authenticated = typeof options.scope === 'string' && !!options.scope && typeof options.permissionSignature === 'string' && !!options.permissionSignature;
    const ownIds = authenticated ? uniqueIds(options.authorizedOwnCompanyIds) : [];
    const comparisonIds = authenticated ? uniqueIds(options.authorizedComparisonIds) : [];
    const byOwn = Object.create(null);
    const comparisonPurposes = Object.create(null);
    const hasComparisonMap = !!options.authorizedComparisonIdsByOwn && typeof options.authorizedComparisonIdsByOwn === 'object';
    for (const id of ownIds) if (Array.isArray(options.authorizedComparisonIdsByOwn?.[id])) byOwn[id] = uniqueIds(options.authorizedComparisonIdsByOwn[id]).filter(c => comparisonIds.includes(c));
    for (const id of comparisonIds) if (['direct', 'reference'].includes(options.comparisonPurposes?.[id])) comparisonPurposes[id] = options.comparisonPurposes[id];
    return {
      scope: typeof options.scope === 'string' ? options.scope : '',
      permissionSignature: typeof options.permissionSignature === 'string' ? options.permissionSignature : '',
      ownIds, comparisonIds, byOwn, hasComparisonMap, comparisonPurposes, companies,
      ownCompanyId: identifier(options.ownCompanyId),
      businessStatus: ['planned', 'planning'].includes(options.businessStatus) ? 'planned' : 'registered',
      plannedRegionKey: identifier(options.plannedRegionKey),
      maxRangeDays: Number.isInteger(options.maxRangeDays) && options.maxRangeDays > 0 ? Math.min(3660, options.maxRangeDays) : 366
    };
  }
  const allowedComparisons = (context, ownId) => ownId ? (context.hasComparisonMap ? context.byOwn[ownId] || [] : context.comparisonIds).filter(id => id !== ownId) : [];
  function regionContext(context, state) {
    const ownRegionKey = state.ownCompanyId ? context.companies.get(state.ownCompanyId)?.regionKey || null : null;
    const comparisons = state.comparisonIds.map(companyId => {
      const row = context.companies.get(companyId), regionKey = row?.regionKey || null;
      return { companyId, regionKey, relation: ownRegionKey && regionKey ? (ownRegionKey === regionKey ? 'same-region' : 'cross-region') : 'unknown' };
    });
    const kinds = new Set(comparisons.map(c => c.relation)), hasUnknown = kinds.has('unknown');
    let mode = !state.ownCompanyId ? (context.businessStatus === 'planned' ? 'planned' : 'unregistered') : 'no-comparisons';
    if (state.ownCompanyId && comparisons.length) mode = kinds.has('same-region') && kinds.has('cross-region') ? 'mixed' : hasUnknown ? 'unknown' : kinds.has('same-region') ? 'same-region' : 'cross-region';
    const groups = new Map();
    for (const row of comparisons) if (row.regionKey) groups.set(row.regionKey, [...(groups.get(row.regionKey) || []), row.companyId]);
    return { mode, ownRegionKey, plannedRegionKey: !state.ownCompanyId && context.businessStatus === 'planned' ? context.plannedRegionKey : null,
      comparisons, hasUnknown, groups: [...groups].map(([regionKey, companyIds]) => ({ regionKey, companyIds })),
      missingCompanyIds: [...(state.ownCompanyId && !ownRegionKey ? [state.ownCompanyId] : []), ...comparisons.filter(r => !r.regionKey).map(r => r.companyId)] };
  }
  function normalize(input, context, today, strict = false) {
    const errors = [], source = pickSelection(input), ownId = identifier(source.ownCompanyId);
    if (strict && source.ownCompanyId != null && !context.ownIds.includes(ownId)) errors.push('OWN_NOT_AUTHORIZED');
    const ownCompanyId = context.ownIds.includes(ownId) ? ownId : context.ownIds.includes(context.ownCompanyId) ? context.ownCompanyId : null;
    const allowed = allowedComparisons(context, ownCompanyId), hasComparisons = Object.hasOwn(source, 'comparisonIds');
    const rawComparisons = hasComparisons ? uniqueIds(source.comparisonIds) : allowed;
    if (strict && hasComparisons && !Array.isArray(source.comparisonIds)) errors.push('INVALID_COMPARISON_SET');
    if (strict && Array.isArray(source.comparisonIds) && (rawComparisons.length !== source.comparisonIds.length || rawComparisons.some(id => !allowed.includes(id)))) errors.push('COMPARISON_NOT_AUTHORIZED');
    const comparisonIds = rawComparisons.filter(id => allowed.includes(id));
    const stayMode = MODES.includes(source.stayMode) ? source.stayMode : 'upcoming30';
    if (strict && source.stayMode !== undefined && !MODES.includes(source.stayMode)) errors.push('INVALID_STAY_MODE');
    let stayMonth = '', stayStart = today, stayEnd = addDays(today, 29);
    if (stayMode === 'month') {
      stayMonth = validMonth(source.stayMonth) ? source.stayMonth : today.slice(0, 7);
      if (strict && !validMonth(source.stayMonth)) errors.push('INVALID_STAY_MONTH');
      const range = monthRange(stayMonth); stayStart = range.start; stayEnd = range.end;
    } else if (stayMode === 'custom') {
      if (!validDate(source.stayStart) || !validDate(source.stayEnd) || source.stayStart > source.stayEnd || (parseDate(source.stayEnd) - parseDate(source.stayStart)) / 86400000 + 1 > context.maxRangeDays) {
        if (strict) errors.push('INVALID_STAY_RANGE');
        else return normalize({ ...source, stayMode: 'upcoming30' }, context, today, false);
      } else { stayStart = source.stayStart; stayEnd = source.stayEnd; }
    }
    const defaultAsOf = stayMode === 'month' && stayEnd < today ? stayEnd : today;
    const asOfDate = validDate(source.asOfDate) && source.asOfDate <= today ? source.asOfDate : defaultAsOf;
    if (strict && source.asOfDate !== undefined && (!validDate(source.asOfDate) || source.asOfDate > today)) errors.push('INVALID_AS_OF_DATE');
    const selectedView = VIEWS.includes(source.selectedView) ? source.selectedView : 'flow';
    if (strict && source.selectedView !== undefined && !VIEWS.includes(source.selectedView)) errors.push('INVALID_VIEW');
    const state = { ownCompanyId, comparisonIds, stayMode, stayMonth, stayStart, stayEnd, asOfDate, selectedView };
    state.regionContext = regionContext(context, state);
    return { state, errors };
  }
  function createStore(options = {}) {
    const storage = safeStorage(options.storage), storageKey = options.storageKey || STORAGE_KEY;
    const now = options.now, listeners = new Set();
    let rawContext = { ...options }, context = contextOf(rawContext), generation = 0, state, lastKstDate;
    const today = () => todayAt(now);
    const partition = () => fingerprint(context.scope + '\u001f' + context.permissionSignature + '\u001f' + context.ownIds.join(',') + '\u001f' + context.comparisonIds.join(',') + '\u001f' + context.hasComparisonMap + '\u001f' + JSON.stringify(context.byOwn) + '\u001f' + JSON.stringify(context.comparisonPurposes));
    const removeStored = () => { try { storage?.removeItem(storageKey); } catch (_) {} };
    function restore() {
      if (!context.scope || !context.permissionSignature) { removeStored(); return {}; }
      try {
        const text = storage?.getItem(storageKey);
        if (!text || text.length > MAX_STORED_CHARS) { if (text) removeStored(); return {}; }
        const saved = JSON.parse(text);
        if (![1, VERSION].includes(saved.version) || saved.partition !== partition() || !validDate(saved.kstDate) || saved.kstDate > today()) { removeStored(); return {}; }
        const restored = pickSelection(saved.selection);
        // v1 also persisted its unintentional empty default. Apply the new default once;
        // v2 records subsequent explicit empty selections without repopulating them.
        if (saved.version === 1 && Array.isArray(restored.comparisonIds) && restored.comparisonIds.length === 0) delete restored.comparisonIds;
        if (saved.kstDate !== today() && restored.stayMode === 'upcoming30') restored.asOfDate = today();
        return restored;
      } catch (_) { removeStored(); return {}; }
    }
    function persist() {
      if (!context.scope || !context.permissionSignature) { removeStored(); return; }
      try {
        const text = JSON.stringify({ version: VERSION, partition: partition(), kstDate: today(), selection: pickSelection(state) });
        if (text.length > MAX_STORED_CHARS) { removeStored(); return; }
        storage?.setItem(storageKey, text);
      }
      catch (_) { /* A blocked or full optional session cache cannot block navigation. */ }
    }
    function emit() { const snapshot = copy(state); for (const listener of listeners) listener(snapshot); }
    function replace(next) { if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; generation++; persist(); emit(); } return copy(state); }
    function ensureDay() {
      const day = today();
      if (day === lastKstDate) return;
      const oldDay = lastKstDate; lastKstDate = day; generation++;
      const candidate = pickSelection(state);
      if (candidate.stayMode === 'upcoming30' && candidate.asOfDate === oldDay) delete candidate.asOfDate;
      const next = normalize(candidate, context, day).state;
      if (JSON.stringify(next) === JSON.stringify(state)) persist(); else replace(next);
    }
    const urlSelection = decodeSelection(options.url);
    const initial = { ownCompanyId: context.ownCompanyId, ...(Object.keys(urlSelection).length ? urlSelection : { ...restore(), ...pickSelection(options.initialState) }) };
    state = normalize(initial, context, today()).state;
    lastKstDate = today();
    persist();
    return {
      getState() { ensureDay(); return copy(state); },
      update(patch = {}) {
        ensureDay();
        const selected = pickSelection(patch), candidate = { ...pickSelection(state), ...selected };
        if (Object.hasOwn(selected, 'stayMode') || Object.hasOwn(selected, 'stayMonth')) {
          if (!Object.hasOwn(selected, 'asOfDate')) delete candidate.asOfDate;
        }
        // Different own stores start from their own authorized defaults, never the
        // previous store's competitor set. A supplied empty array is still explicit.
        if (Object.hasOwn(selected, 'ownCompanyId') && selected.ownCompanyId !== state.ownCompanyId && !Object.hasOwn(selected, 'comparisonIds')) delete candidate.comparisonIds;
        const result = normalize(candidate, context, today(), true);
        if (result.errors.length) return { ok: false, errors: result.errors, state: copy(state) };
        return { ok: true, errors: [], state: replace(result.state) };
      },
      configure(changes = {}) {
        ensureDay();
        const oldScope = context.scope, oldPermission = partition();
        rawContext = { ...rawContext, ...changes }; context = contextOf(rawContext);
        const scopeChanged = oldScope !== context.scope, ownChanged = Object.hasOwn(changes, 'ownCompanyId') && state.ownCompanyId !== context.ownCompanyId;
        let candidate = scopeChanged ? { ownCompanyId: context.ownCompanyId } : pickSelection(state);
        if (ownChanged) { candidate = { ...candidate, ownCompanyId: context.ownCompanyId }; delete candidate.comparisonIds; }
        // Losing access to the selected own store also changes the comparison base.
        // Do not carry a previous own store's selection into its authorized fallback.
        if (!scopeChanged && !ownChanged && !context.ownIds.includes(candidate.ownCompanyId)) delete candidate.comparisonIds;
        if (scopeChanged || oldPermission !== partition() || ownChanged) { generation++; removeStored(); }
        // Authorization changes invalidate late responses even if the visible selection remains identical.
        const normalized = normalize(candidate, context, today()).state;
        if (JSON.stringify(normalized) === JSON.stringify(state)) persist();
        return replace(normalized);
      },
      restoreUrl(url) {
        ensureDay();
        const restored = normalize({ ownCompanyId: context.ownCompanyId, ...decodeSelection(url) }, context, today()).state;
        return replace(restored);
      },
      toQuery() { ensureDay(); return encodeSelection(state); },
      requestToken() { ensureDay(); return Object.freeze({ generation, partition: partition(), selection: encodeSelection(state) }); },
      isCurrent(token) { ensureDay(); return !!token && token.generation === generation && token.partition === partition() && token.selection === encodeSelection(state); },
      subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('A listener is required.'); listeners.add(listener); return () => listeners.delete(listener); },
      clear() { generation++; removeStored(); const next = normalize({ ownCompanyId: context.ownCompanyId }, context, today()).state; state = next; emit(); return copy(state); }
    };
  }
  return { createStore, encodeSelection, decodeSelection, validDate, monthRange, todayAt, STORAGE_KEY };
});
