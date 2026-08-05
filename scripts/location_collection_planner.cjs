"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  classifySnapshotFreshness,
  validateCollectionSnapshot
} = require("./location_collection_snapshot_contract.cjs");

const COLLECTION_PLAN_SCHEMA_VERSION = "location-collection-run-plan.v1";
const DEFAULT_POLICY_FILE = path.join(__dirname, "..", "web", "data", "location_collection_policy.json");
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTOMATIC_CLASSES = new Set([
  "scheduled_current_snapshot",
  "scheduled_closed_period",
  "rolling_window_signal",
  "release_driven"
]);
const NON_AUTOMATIC_CLASSES = new Set(["event_driven_reference", "unavailable"]);
const SUCCESS_STATUSES = new Set(["ready", "zero"]);
const LATE_ARRIVAL_REASONS = new Set(["late_arrival", "provider_revision"]);
const REPLAY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/;
const READ_CONTEXTS = new Set([
  "read",
  "ui_read",
  "admin_read",
  "member_read",
  "b2b_read",
  "screen_read",
  "http_read"
]);
const WEEKDAYS = Object.freeze(["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function validDate(value, name = "date") {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid date`);
  return date;
}

function seoulParts(value) {
  const shifted = new Date(validDate(value).getTime() + SEOUL_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds()
  };
}

function pad(number) {
  return String(number).padStart(2, "0");
}

function dateString(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function seoulDate(value) {
  const parts = seoulParts(value);
  return dateString(parts.year, parts.month, parts.day);
}

function dateEpoch(date) {
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new TypeError("period dates must use YYYY-MM-DD");
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (new Date(epoch).toISOString().slice(0, 10) !== date) throw new TypeError("period date is invalid");
  return epoch;
}

function addDays(date, amount) {
  return new Date(dateEpoch(date) + Number(amount) * DAY_MS).toISOString().slice(0, 10);
}

function addMonths(date, amount) {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new TypeError("period dates must use YYYY-MM-DD");
  const originalDay = Number(match[3]);
  const first = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + Number(amount), 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return dateString(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(originalDay, lastDay));
}

function normalizePeriod(value, name = "measurementPeriod") {
  if (!value || typeof value !== "object") return null;
  const from = String(value.from || "");
  const to = String(value.to || "");
  const fromEpoch = dateEpoch(from);
  const toEpoch = dateEpoch(to);
  if (fromEpoch > toEpoch) throw new RangeError(`${name}.from must not be after ${name}.to`);
  return Object.freeze({ from, to });
}

function localTimeMinutes(value) {
  if (value === null || value === undefined || value === "") return 0;
  const match = String(value).match(/^(\d{2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new TypeError("proposedCadence.localTime must use HH:MM");
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function startOfWeek(date, desiredWeekday = "MONDAY") {
  const current = new Date(dateEpoch(date));
  const desiredIndex = WEEKDAYS.indexOf(String(desiredWeekday || "MONDAY").toUpperCase());
  if (desiredIndex < 0) throw new TypeError("proposedCadence.weekday is invalid");
  const distance = (current.getUTCDay() - desiredIndex + 7) % 7;
  return addDays(date, -distance);
}

function previousClosedMonth(value) {
  const parts = seoulParts(value);
  const first = new Date(Date.UTC(parts.year, parts.month - 2, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return Object.freeze({
    from: dateString(first.getUTCFullYear(), first.getUTCMonth() + 1, 1),
    to: dateString(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate())
  });
}

function contextObject(value) {
  if (value === undefined || value === null) return {};
  if (value instanceof Date || typeof value === "string" || typeof value === "number") return { asOf: value };
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("planner context must be an object");
  return value;
}

function isReadContext(context = {}) {
  const rawTrigger = context.triggerContext || context.context || context.mode || "";
  const trigger = typeof rawTrigger === "object" && rawTrigger
    ? rawTrigger.type || rawTrigger.mode || rawTrigger.kind || rawTrigger.name || ""
    : rawTrigger;
  return Boolean(context.readSurface)
    || context.externalCallOnRead === true
    || READ_CONTEXTS.has(String(trigger).toLowerCase());
}

function computeMeasurementWindow(policy, value = {}) {
  const context = contextObject(value);
  const asOf = validDate(context.asOf || new Date(), "asOf");
  const rule = policy?.measurementWindowRule || {};
  const localDate = seoulDate(asOf);

  switch (rule.type) {
    case "current_snapshot": {
      const unit = policy?.proposedCadence?.unit;
      const bucketDate = unit === "week"
        ? startOfWeek(localDate, policy.proposedCadence.weekday || "MONDAY")
        : unit === "month"
          ? `${localDate.slice(0, 7)}-01`
          : localDate;
      return Object.freeze({ from: bucketDate, to: bucketDate });
    }
    case "previous_day": {
      const day = addDays(localDate, -1);
      return Object.freeze({ from: day, to: day });
    }
    case "previous_closed_month":
      return previousClosedMonth(asOf);
    case "rolling_days": {
      const days = Number(context.rollingDays ?? rule.days);
      if (!Number.isInteger(days) || days <= 0) return null;
      const to = addDays(localDate, -1);
      return Object.freeze({ from: addDays(to, -(days - 1)), to });
    }
    case "release_period":
      return normalizePeriod(
        context.releaseMeasurementPeriod || context.providerRelease?.measurementPeriod || context.releasePeriod,
        "releaseMeasurementPeriod"
      );
    default:
      return null;
  }
}

function computeOverlapWindow(policy, measurementPeriod) {
  const period = normalizePeriod(measurementPeriod);
  if (!period) return null;
  const days = Number(policy?.overlapWindow?.days);
  const months = Number(policy?.overlapWindow?.months);
  if ((!Number.isFinite(days) || days <= 0) && (!Number.isFinite(months) || months <= 0)) return null;
  let from = period.from;
  if (Number.isInteger(months) && months > 0) {
    from = addMonths(period.from, -(months - 1));
  }
  if (Number.isInteger(days) && days > 0) {
    from = addDays(period.to, -(days - 1));
  }
  return Object.freeze({ from, to: period.to });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value === undefined ? null : value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function taskKeyInput(policy, context, measurementPeriod) {
  const sharedCollectionScope = context.sharedCollectionScope ?? policy.sharedCollectionScope ?? null;
  const replay = context.lateArrivalReplay || null;
  return {
    sourceId: policy.sourceId,
    regionKey: sharedCollectionScope ? null : context.regionKey || null,
    sharedCollectionScope,
    measurementPeriod,
    operation: context.operation || "unresolved",
    sourceSchemaVersion: context.sourceSchemaVersion || "unresolved",
    mappingVersion: context.mappingVersion || "unresolved",
    configVersion: context.configVersion || null,
    keywordGroupVersion: context.keywordGroupVersion || null,
    keywordDictionaryVersion: context.keywordDictionaryVersion || null,
    anchorVersion: context.anchorVersion || null,
    timeUnit: context.timeUnit || null,
    tableContractVersion: context.tableContractVersion || null,
    providerReleaseVersion: context.providerReleaseVersion || context.providerRelease?.version || null,
    lateArrivalVersion: replay?.version || null
  };
}

function normalizeLateArrivalReplay(policy, input) {
  if (input === undefined || input === null) return Object.freeze({ requested: false, valid: true, replay: null, error: null });
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Object.freeze({ requested: true, valid: false, replay: null, error: "late_arrival_replay_invalid" });
  }
  if (policy?.lateArrivalPolicy?.enabled !== true) {
    return Object.freeze({ requested: true, valid: false, replay: null, error: "late_arrival_replay_not_enabled" });
  }
  if (input.approved !== true) {
    return Object.freeze({ requested: true, valid: false, replay: null, error: "late_arrival_replay_approval_required" });
  }
  const reason = String(input.reason || "").trim().toLowerCase().replace(/-/g, "_");
  if (!LATE_ARRIVAL_REASONS.has(reason)) {
    return Object.freeze({ requested: true, valid: false, replay: null, error: "late_arrival_replay_reason_not_allowed" });
  }
  if (policy?.invocationClass === "release_driven" && reason !== "provider_revision") {
    return Object.freeze({ requested: true, valid: false, replay: null, error: "late_arrival_replay_reason_not_allowed" });
  }
  const version = String(input.version ?? input.revision ?? "").trim();
  if (!REPLAY_VERSION_PATTERN.test(version)) {
    return Object.freeze({ requested: true, valid: false, replay: null, error: "late_arrival_replay_version_required" });
  }
  return deepFreeze({ requested: true, valid: true, replay: { reason, version }, error: null });
}

function buildCollectionTaskKey(policy, value = {}) {
  const context = contextObject(value);
  if (!policy || typeof policy.sourceId !== "string" || !policy.sourceId) throw new TypeError("policy.sourceId is required");
  const replay = normalizeLateArrivalReplay(policy, context.lateArrivalReplay);
  if (!replay.valid) throw new TypeError(replay.error);
  const measurementPeriod = normalizePeriod(
    context.measurementPeriod || computeMeasurementWindow(policy, context)
  );
  if (!measurementPeriod) throw new TypeError("a resolved measurementPeriod is required");
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify(stableValue(taskKeyInput(policy, { ...context, lateArrivalReplay: replay.replay }, measurementPeriod))))
    .digest("hex");
  return `location-collection-task:${digest}`;
}

function scheduleBoundary(policy, asOf) {
  const parts = seoulParts(asOf);
  const localDate = dateString(parts.year, parts.month, parts.day);
  const unit = policy?.proposedCadence?.unit;
  let scheduleDate = localDate;
  if (unit === "week") scheduleDate = startOfWeek(localDate, policy.proposedCadence.weekday || "MONDAY");
  if (unit === "month") scheduleDate = `${localDate.slice(0, 7)}-01`;
  const [year, month, day] = scheduleDate.split("-").map(Number);
  const minutes = localTimeMinutes(policy?.proposedCadence?.localTime);
  return new Date(Date.UTC(year, month - 1, day, Math.floor(minutes / 60) - 9, minutes % 60));
}

function scopeMatches(snapshot, policy, context) {
  if (!snapshot || snapshot.sourceId !== policy.sourceId) return false;
  const shared = context.sharedCollectionScope ?? policy.sharedCollectionScope ?? null;
  if (shared) return snapshot.sharedCollectionScope === shared;
  return snapshot.regionKey === context.regionKey;
}

function relevantSnapshots(policy, context) {
  const values = [
    ...(Array.isArray(context.snapshots) ? context.snapshots : []),
    ...(Array.isArray(context.lastSuccessfulSnapshots) ? context.lastSuccessfulSnapshots : []),
    context.lastSnapshot,
    context.lastSuccessfulSnapshot,
    context.lastFailure
  ].filter(Boolean).map((snapshot) => {
    const validation = validateCollectionSnapshot(snapshot);
    return validation.valid ? validation.normalized : null;
  }).filter(Boolean).filter((snapshot) => scopeMatches(snapshot, policy, context));
  const byIdentity = new Map();
  for (const snapshot of values) {
    const key = snapshot.snapshotId || `${snapshot.taskKey || ""}:${snapshot.collectedAt || ""}:${snapshot.status || ""}`;
    byIdentity.set(key, snapshot);
  }
  return [...byIdentity.values()].sort((left, right) => (
    new Date(left.collectedAt || 0).getTime() - new Date(right.collectedAt || 0).getTime()
  ));
}

function cadenceDistance(unit, earlierDate, laterDate) {
  if (unit === "day") return Math.floor((dateEpoch(laterDate) - dateEpoch(earlierDate)) / DAY_MS);
  if (unit === "week") return Math.floor((dateEpoch(laterDate) - dateEpoch(earlierDate)) / (7 * DAY_MS));
  if (unit === "month") {
    const [earlierYear, earlierMonth] = earlierDate.split("-").map(Number);
    const [laterYear, laterMonth] = laterDate.split("-").map(Number);
    return (laterYear * 12 + laterMonth) - (earlierYear * 12 + earlierMonth);
  }
  return null;
}

function dueResult(due, dueReason, details = {}) {
  return deepFreeze({ due, dueReason, ...details });
}

function isCollectionDue(policy, value = {}) {
  const context = contextObject(value);
  if (!policy || typeof policy !== "object") throw new TypeError("policy is required");
  if (isReadContext(context)) {
    return dueResult(false, "external_call_on_read_forbidden", { readBoundary: true, measurementPeriod: null, taskKey: null });
  }
  if (policy.externalCallOnRead !== false) {
    return dueResult(false, "external_call_on_read_policy_invalid", { readBoundary: true, measurementPeriod: null, taskKey: null });
  }
  if (NON_AUTOMATIC_CLASSES.has(policy.invocationClass) || !AUTOMATIC_CLASSES.has(policy.invocationClass)) {
    return dueResult(false, policy.invocationClass === "unavailable" ? "source_unavailable" : "automatic_collection_forbidden", {
      readBoundary: false,
      measurementPeriod: null,
      taskKey: null
    });
  }

  const asOf = validDate(context.asOf || new Date(), "asOf");
  const measurementPeriod = computeMeasurementWindow(policy, { ...context, asOf });
  if (!measurementPeriod) {
    const reason = policy.invocationClass === "release_driven"
      ? "release_period_unavailable"
      : policy.measurementWindowRule?.type === "rolling_days"
        ? "rolling_window_contract_unresolved"
        : "measurement_window_unresolved";
    return dueResult(false, reason, { readBoundary: false, measurementPeriod: null, taskKey: null });
  }
  if (dateEpoch(measurementPeriod.to) > dateEpoch(seoulDate(asOf))) {
    return dueResult(false, "measurement_period_after_as_of", {
      readBoundary: false,
      measurementPeriod,
      taskKey: null
    });
  }

  const boundary = policy.invocationClass === "release_driven" ? null : scheduleBoundary(policy, asOf);
  const delayHours = Number(policy?.expectedAvailabilityDelay?.hours);
  const dueAt = boundary && Number.isFinite(delayHours) && delayHours > 0
    ? new Date(boundary.getTime() + delayHours * 60 * 60 * 1000)
    : boundary;
  if (dueAt && asOf.getTime() < dueAt.getTime()) {
    return dueResult(false, "before_scheduled_local_time", {
      readBoundary: false,
      measurementPeriod,
      taskKey: null,
      dueAt: dueAt.toISOString()
    });
  }

  const replayState = normalizeLateArrivalReplay(policy, context.lateArrivalReplay);
  const baseTaskKey = buildCollectionTaskKey(policy, { ...context, measurementPeriod, lateArrivalReplay: null });
  if (replayState.requested
    && policy.invocationClass !== "scheduled_closed_period"
    && policy.invocationClass !== "release_driven") {
    return dueResult(false, "late_arrival_replay_requires_closed_or_release_period", {
      readBoundary: false,
      measurementPeriod,
      taskKey: baseTaskKey,
      lateArrivalReplay: null
    });
  }
  if (!replayState.valid) {
    return dueResult(false, replayState.error, {
      readBoundary: false,
      measurementPeriod,
      taskKey: baseTaskKey,
      lateArrivalReplay: null
    });
  }
  const taskKey = replayState.requested
    ? buildCollectionTaskKey(policy, {
      ...context,
      measurementPeriod,
      lateArrivalReplay: { ...replayState.replay, approved: true }
    })
    : baseTaskKey;
  const snapshots = relevantSnapshots(policy, context);
  const latest = snapshots.at(-1) || null;
  const latestSuccessful = [...snapshots].reverse().find((snapshot) => SUCCESS_STATUSES.has(snapshot.status)) || null;
  const minimumHours = Number(policy?.minimumRefreshInterval?.hours);
  if (latest && Number.isFinite(minimumHours) && minimumHours > 0) {
    const lastTime = new Date(latest.collectedAt).getTime();
    if (Number.isFinite(lastTime) && asOf.getTime() < lastTime + minimumHours * 60 * 60 * 1000) {
      return dueResult(false, "minimum_refresh_interval_not_elapsed", {
        readBoundary: false,
        measurementPeriod,
        taskKey,
        lastSnapshot: latest,
        lastSuccessfulSnapshot: latestSuccessful
      });
    }
  }

  const cadenceInterval = Number(policy?.proposedCadence?.interval);
  const previousPeriod = normalizePeriod(latest?.measurementPeriod, "lastSnapshot.measurementPeriod");
  if (previousPeriod && previousPeriod.from !== measurementPeriod.from
    && Number.isInteger(cadenceInterval) && cadenceInterval > 1) {
    const distance = cadenceDistance(policy.proposedCadence.unit, previousPeriod.from, measurementPeriod.from);
    if (Number.isFinite(distance) && distance < cadenceInterval) {
      return dueResult(false, "cadence_interval_not_elapsed", {
        readBoundary: false,
        measurementPeriod,
        taskKey,
        lastSnapshot: latest,
        lastSuccessfulSnapshot: latestSuccessful
      });
    }
  }

  const successfulDuplicate = snapshots.find((snapshot) => SUCCESS_STATUSES.has(snapshot.status) && snapshot.taskKey === taskKey);
  if (successfulDuplicate) {
    return dueResult(false, "successful_snapshot_already_exists", {
      readBoundary: false,
      measurementPeriod,
      taskKey,
      lastSnapshot: successfulDuplicate || latest,
      lastSuccessfulSnapshot: successfulDuplicate || latestSuccessful,
      lateArrivalReplay: replayState.replay
    });
  }

  if (replayState.requested) {
    const completedBaseSnapshot = snapshots.find((snapshot) => (
      SUCCESS_STATUSES.has(snapshot.status) && snapshot.taskKey === baseTaskKey
    ));
    if (!completedBaseSnapshot) {
      return dueResult(false, "late_arrival_replay_requires_completed_snapshot", {
        readBoundary: false,
        measurementPeriod,
        taskKey,
        lastSnapshot: latest,
        lastSuccessfulSnapshot: latestSuccessful,
        lateArrivalReplay: replayState.replay
      });
    }
    return dueResult(true, replayState.replay.reason === "provider_revision"
      ? "approved_provider_revision_replay"
      : "approved_late_arrival_replay", {
      readBoundary: false,
      measurementPeriod,
      taskKey,
      lastSnapshot: latest,
      lastSuccessfulSnapshot: latestSuccessful,
      lateArrivalReplay: replayState.replay
    });
  }

  return dueResult(true, policy.invocationClass === "release_driven" ? "new_provider_release" : "new_collection_period", {
    readBoundary: false,
    measurementPeriod,
    taskKey,
    lastSnapshot: latest,
    lastSuccessfulSnapshot: latestSuccessful,
    lateArrivalReplay: null
  });
}

function versionFor(options, field, sourceId) {
  const sourceVersions = options.sourceVersions?.[sourceId] || {};
  const keyed = options[`${field}s`];
  return sourceVersions[field] ?? keyed?.[sourceId] ?? options[field] ?? null;
}

function normalizeRegions(regions, canonicalRegistry = null) {
  if (!Array.isArray(regions)) return [];
  const canonicalIndex = canonicalRegistry && Array.isArray(canonicalRegistry.regions)
    ? new Map(canonicalRegistry.regions.map((region) => [region.regionKey, region]))
    : null;
  const normalized = [];
  for (const input of regions) {
    const candidate = typeof input === "string" ? { regionKey: input } : input;
    if (typeof candidate?.regionKey !== "string" || !/^kr_[a-z0-9_]+$/.test(candidate.regionKey)) {
      throw new TypeError("every region must have a canonical regionKey");
    }
    if (!canonicalIndex) {
      normalized.push(candidate);
      continue;
    }
    const canonical = canonicalIndex.get(candidate.regionKey);
    if (!canonical || canonical.active !== true) {
      throw new Error(`Unknown or inactive canonical regionKey: ${candidate.regionKey}`);
    }
    normalized.push(canonical);
  }
  return normalized;
}

function primaryBlocker(policy, approved) {
  if (policy.activationStatus !== "active") return `activation_status_${policy.activationStatus || "missing"}`;
  if (policy.providerCadenceStatus !== "verified") return "provider_cadence_unverified";
  if (policy.approvalRequired && !approved) return "collection_approval_required";
  if (policy.actualCallsEnabled !== true) return "actual_calls_disabled";
  return null;
}

function deduplicateSharedTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array");
  const unique = new Map();
  for (const task of tasks) {
    if (!task || typeof task.taskKey !== "string") throw new TypeError("every task must have a taskKey");
    const prior = unique.get(task.taskKey);
    if (!prior) {
      unique.set(task.taskKey, { ...task, targetRegionKeys: [...new Set(task.targetRegionKeys || [])] });
      continue;
    }
    const sameSharedScope = Boolean(task.sharedCollectionScope)
      && prior.sharedCollectionScope === task.sharedCollectionScope;
    const sameRegionalScope = !task.sharedCollectionScope
      && !prior.sharedCollectionScope
      && prior.regionKey === task.regionKey;
    if (prior.sourceId !== task.sourceId || (!sameSharedScope && !sameRegionalScope)) {
      throw new Error(`Conflicting non-shared collection task key: ${task.taskKey}`);
    }
    prior.targetRegionKeys = [...new Set([...(prior.targetRegionKeys || []), ...(task.targetRegionKeys || [])])].sort();
  }
  return deepFreeze([...unique.values()]);
}

function buildCollectionRunPlan(input = {}) {
  const options = input && Array.isArray(input.policies) ? input : { ...input };
  const registry = options.policyRegistry || (Array.isArray(options.policies) ? null : readCollectionPolicyRegistry(options.policyFile));
  const policies = options.policies || registry?.policies || [];
  const asOf = validDate(options.asOf || new Date(), "asOf");
  const plannedAt = asOf.toISOString();
  if (isReadContext(options)) {
    return deepFreeze({
      schemaVersion: COLLECTION_PLAN_SCHEMA_VERSION,
      policyVersion: registry?.policyVersion || options.policyVersion || null,
      plannedAt,
      timezone: "Asia/Seoul",
      readBoundary: true,
      dueTasks: [],
      tasks: [],
      skipped: policies.map((policy) => ({ sourceId: policy.sourceId, reason: "external_call_on_read_forbidden" })),
      actualCallsEnabled: false,
      authorizedCallCount: 0,
      executedCallCount: 0,
      summary: { sourceCount: policies.length, dueTaskCount: 0, blockedTaskCount: 0, executableTaskCount: 0 }
    });
  }

  if (!options.canonicalRegionRegistry
    || options.canonicalRegionRegistry.active !== true
    || !Array.isArray(options.canonicalRegionRegistry.regions)) {
    throw new Error("A valid active canonicalRegionRegistry is required for collection planning");
  }
  const regions = normalizeRegions(
    options.regions || options.regionKeys || options.pilotRegionKeys,
    options.canonicalRegionRegistry
  );
  if (regions.length === 0) throw new Error("At least one active canonical regionKey is required for collection planning");
  const rawTasks = [];
  const skipped = [];
  for (const policy of policies) {
    if (NON_AUTOMATIC_CLASSES.has(policy.invocationClass) || !AUTOMATIC_CLASSES.has(policy.invocationClass)) {
      skipped.push({ sourceId: policy.sourceId, reason: policy.invocationClass === "unavailable" ? "source_unavailable" : "automatic_collection_forbidden" });
      continue;
    }
    const sharedCollectionScope = policy.sharedCollectionScope || null;
    const targets = sharedCollectionScope ? [{ regionKey: null }] : regions;
    if (targets.length === 0) {
      skipped.push({ sourceId: policy.sourceId, reason: "no_canonical_region_target" });
      continue;
    }
    for (const target of targets) {
      const sourceId = policy.sourceId;
      const context = {
        asOf,
        regionKey: target.regionKey,
        sharedCollectionScope,
        operation: options.operations?.[sourceId] || "unresolved",
        sourceSchemaVersion: versionFor(options, "sourceSchemaVersion", sourceId) || "unresolved",
        mappingVersion: versionFor(options, "mappingVersion", sourceId) || "unresolved",
        configVersion: versionFor(options, "configVersion", sourceId),
        keywordGroupVersion: versionFor(options, "keywordGroupVersion", sourceId),
        keywordDictionaryVersion: versionFor(options, "keywordDictionaryVersion", sourceId),
        anchorVersion: versionFor(options, "anchorVersion", sourceId),
        timeUnit: versionFor(options, "timeUnit", sourceId),
        tableContractVersion: versionFor(options, "tableContractVersion", sourceId),
        providerReleaseVersion: versionFor(options, "providerReleaseVersion", sourceId),
        rollingDays: options.rollingDaysBySource?.[sourceId],
        releaseMeasurementPeriod: options.releasePeriods?.[sourceId],
        lateArrivalReplay: options.lateArrivalReplays?.[sourceId]
          ?? options.replayRequests?.[sourceId]
          ?? null,
        snapshots: options.snapshots,
        lastSuccessfulSnapshots: options.lastSuccessfulSnapshots,
        lastSuccessfulSnapshot: options.lastSuccessfulSnapshot,
        lastSnapshot: options.lastSnapshot,
        lastFailure: options.lastFailure
      };
      const due = isCollectionDue(policy, context);
      if (!due.due) {
        skipped.push({ sourceId, regionKey: target.regionKey, sharedCollectionScope, reason: due.dueReason, taskKey: due.taskKey });
        continue;
      }
      const approved = options.approvals?.[sourceId] === true;
      const blocker = primaryBlocker(policy, approved);
      rawTasks.push({
        sourceId,
        regionKey: target.regionKey,
        sharedCollectionScope,
        targetRegionKeys: sharedCollectionScope ? regions.map((region) => region.regionKey) : [target.regionKey],
        due: true,
        dueReason: due.dueReason,
        measurementPeriod: due.measurementPeriod,
        overlapPeriod: computeOverlapWindow(policy, due.measurementPeriod),
        taskKey: due.taskKey,
        watermark: due.lastSuccessfulSnapshot?.watermark ?? null,
        executionState: blocker ? "blocked" : "fixture_plan_only",
        approvalRequired: policy.approvalRequired === true,
        actualCallsEnabled: false,
        authorizedCallCount: 0,
        executedCallCount: 0,
        blocker,
        lateArrivalReplay: due.lateArrivalReplay
          ? { reason: due.lateArrivalReplay.reason, version: due.lateArrivalReplay.version }
          : null,
        remainingBlockers: [...new Set([...(policy.remainingBlockers || []), ...(blocker ? [blocker] : [])])]
      });
    }
  }
  const tasks = deduplicateSharedTasks(rawTasks);
  return deepFreeze({
    schemaVersion: COLLECTION_PLAN_SCHEMA_VERSION,
    policyVersion: registry?.policyVersion || options.policyVersion || null,
    plannedAt,
    timezone: "Asia/Seoul",
    readBoundary: false,
    dueTasks: tasks,
    tasks,
    skipped,
    actualCallsEnabled: false,
    authorizedCallCount: 0,
    executedCallCount: 0,
    summary: {
      sourceCount: policies.length,
      dueTaskCount: tasks.length,
      blockedTaskCount: tasks.filter((task) => task.executionState === "blocked").length,
      executableTaskCount: 0
    }
  });
}

function readCollectionPolicyRegistry(filePath = DEFAULT_POLICY_FILE) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

module.exports = {
  AUTOMATIC_CLASSES,
  COLLECTION_PLAN_SCHEMA_VERSION,
  DEFAULT_POLICY_FILE,
  NON_AUTOMATIC_CLASSES,
  buildCollectionRunPlan,
  buildCollectionTaskKey,
  classifySnapshotFreshness,
  computeMeasurementWindow,
  computeOverlapWindow,
  deduplicateSharedTasks,
  isCollectionDue,
  readCollectionPolicyRegistry
};
