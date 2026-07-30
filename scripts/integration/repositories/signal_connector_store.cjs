"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  INSIGHTS_SIGNAL_KINDS,
  SIGNAL_CONNECTOR_DIRECTORY,
  SIGNAL_CONNECTOR_SCHEMA_VERSION,
  SIGNAL_CONNECTOR_STORE_KIND,
  assertSignalJobTransition,
  connectorError,
  normalizeConnectorSignal,
  normalizeSignalJobRequest
} = require("../contracts/signal_connector.cjs");
const { cleanId, cleanText, clone, stableHash } = require("../contracts/insights.cjs");

const STATE_FILE = "state.json";
const LOCK_FILE = ".signal-connector.lock";

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(normalizedPath(parent), normalizedPath(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalizeCandidate(candidate) {
  const resolved = path.resolve(candidate);
  let cursor = resolved;
  const tail = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonical = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor;
  return path.resolve(canonical, ...tail);
}

function timestamp(clock) {
  const value = clock();
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value || ""));
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function utcDay(value) {
  return String(value).slice(0, 10);
}

function utcMonth(value) {
  return String(value).slice(0, 7);
}

function cleanActor(actor) {
  if (!actor || typeof actor !== "object") return { type: "system", id: cleanText(actor || "system", 120), role: "" };
  return {
    type: cleanText(actor.type || "account", 32),
    id: cleanText(actor.accountId || actor.id || "system", 120),
    role: cleanText(actor.role, 32)
  };
}

function emptyState(clock) {
  const now = timestamp(clock);
  return {
    schemaVersion: SIGNAL_CONNECTOR_SCHEMA_VERSION,
    storeKind: SIGNAL_CONNECTOR_STORE_KIND,
    storeId: `signal_connector_${crypto.randomUUID().replaceAll("-", "")}`,
    dataBoundary: "fresh-integration-stage231-signal-only",
    createdAt: now,
    updatedAt: now,
    revision: 0,
    scheduler: { stopped: true, stoppedAt: now, reason: "default-fail-closed" },
    killSwitches: {},
    scheduleKeys: {},
    jobs: [],
    reservations: [],
    signals: [],
    audits: [],
    metrics: {
      transportAttempts: 0,
      externalNetworkCalls: 0,
      credentialReads: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      migrationRows: 0,
      backfillRows: 0,
      dualWriteRows: 0
    }
  };
}

function assertState(state) {
  if (!state || state.schemaVersion !== SIGNAL_CONNECTOR_SCHEMA_VERSION || state.storeKind !== SIGNAL_CONNECTOR_STORE_KIND) {
    throw connectorError("Configured directory is not a Stage 231 signal connector store", "SIGNAL_CONNECTOR_STORE_INVALID", 500);
  }
  for (const key of ["jobs", "reservations", "signals", "audits"]) {
    if (!Array.isArray(state[key])) throw connectorError(`Signal connector ${key} state is invalid`, "SIGNAL_CONNECTOR_STORE_CORRUPT", 500);
  }
  return state;
}

function createSignalConnectorRepository(options = {}) {
  const integrationRootInput = String(options.integrationRoot || "").trim();
  if (!integrationRootInput) {
    throw connectorError("An explicit fresh integration root is required", "SIGNAL_CONNECTOR_ROOT_REQUIRED", 500);
  }
  const integrationRoot = path.resolve(integrationRootInput);
  const root = path.join(integrationRoot, SIGNAL_CONNECTOR_DIRECTORY);
  const integrationCanonical = canonicalizeCandidate(integrationRoot);
  const rootCanonical = canonicalizeCandidate(root);
  if (!isInsideOrEqual(integrationRoot, root) || !isInsideOrEqual(integrationCanonical, rootCanonical) || normalizedPath(root) === normalizedPath(integrationRoot)) {
    throw connectorError("Signal connector store escaped the fresh integration root", "SIGNAL_CONNECTOR_PATH_ESCAPE", 500);
  }
  for (const legacy of options.legacyPaths || []) {
    if (!legacy) continue;
    const legacyPath = path.resolve(legacy);
    if (isInsideOrEqual(legacyPath, root) || isInsideOrEqual(root, legacyPath)) {
      throw connectorError("Signal connector store overlaps a legacy data path", "SIGNAL_CONNECTOR_LEGACY_PATH_FORBIDDEN", 500);
    }
  }

  const clock = options.clock || Date.now;
  const leaseMs = Math.max(1_000, Math.min(60 * 60_000, Number(options.leaseMs || 5 * 60_000)));
  const allowTestFixtures = options.env?.NODE_ENV === "test";
  let queue = Promise.resolve();
  let initialized = false;

  function absolute(relative) {
    const target = path.resolve(root, ...String(relative).replace(/\\/g, "/").split("/").filter(Boolean));
    if (!isInsideOrEqual(root, target) || !isInsideOrEqual(canonicalizeCandidate(root), canonicalizeCandidate(target))) {
      throw connectorError("Signal connector path escaped its store", "SIGNAL_CONNECTOR_PATH_ESCAPE", 500);
    }
    return target;
  }

  function serialize(work) {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function withLock(work) {
    await fsp.mkdir(root, { recursive: true });
    const lockPath = absolute(LOCK_FILE);
    const started = Date.now();
    let handle;
    while (!handle) {
      try {
        handle = await fsp.open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const stat = await fsp.stat(lockPath);
          if (Date.now() - stat.mtimeMs > 30_000) await fsp.unlink(lockPath);
        } catch (statError) {
          if (statError.code !== "ENOENT") throw statError;
        }
        if (Date.now() - started > 10_000) throw connectorError("Signal connector lock timed out", "SIGNAL_CONNECTOR_LOCK_TIMEOUT", 503);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await work();
    } finally {
      await handle.close();
      await fsp.unlink(lockPath).catch(() => undefined);
    }
  }

  async function atomicWrite(state) {
    const target = absolute(STATE_FILE);
    const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await fsp.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, target);
  }

  async function readState() {
    try {
      return assertState(JSON.parse((await fsp.readFile(absolute(STATE_FILE), "utf8")).replace(/^\uFEFF/, "")));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function initialize() {
    if (initialized) return { initialized: true, storeKind: SIGNAL_CONNECTOR_STORE_KIND };
    await serialize(() => withLock(async () => {
      const existing = await readState();
      if (!existing) await atomicWrite(emptyState(clock));
      initialized = true;
    }));
    return { initialized: true, storeKind: SIGNAL_CONNECTOR_STORE_KIND };
  }

  function auditEntry(event, actor, details = {}) {
    return {
      auditId: `signal_audit_${crypto.randomUUID().replaceAll("-", "")}`,
      at: timestamp(clock),
      event: cleanText(event, 120),
      actor: cleanActor(actor),
      details: clone(details)
    };
  }

  async function mutation(event, actor, mutate) {
    await initialize();
    return serialize(() => withLock(async () => {
      const state = await readState();
      const result = await mutate(state);
      if (result?.changed === false) return clone(result.value);
      state.revision += 1;
      state.updatedAt = timestamp(clock);
      if (event) state.audits.push(auditEntry(event, actor, result?.details || {}));
      await atomicWrite(state);
      return clone(result?.value);
    }));
  }

  async function snapshot() {
    await initialize();
    return serialize(() => withLock(async () => clone(await readState())));
  }

  async function createJob(payload, context = {}) {
    const request = normalizeSignalJobRequest(payload?.target && payload?.quota ? {
      ...payload,
      ...payload.target,
      ...payload.quota
    } : payload);
    const scheduleKey = context.scheduleKey ? cleanId(context.scheduleKey, "scheduleKey") : "";
    return mutation("signal.job.queued", context.actor, async (state) => {
      const byRequest = state.jobs.find((row) => row.clientRequestId === request.clientRequestId);
      if (byRequest) {
        if (byRequest.signature !== request.signature) {
          throw connectorError("clientRequestId is bound to a different signal request", "SIGNAL_CONNECTOR_IDEMPOTENCY_CONFLICT", 409);
        }
        return { changed: false, value: { job: byRequest, idempotent: true } };
      }
      if (scheduleKey && state.scheduleKeys[scheduleKey]) {
        const scheduled = state.jobs.find((row) => row.jobId === state.scheduleKeys[scheduleKey]);
        return { changed: false, value: { job: scheduled, idempotent: true, schedulerDeduplicated: true } };
      }
      const now = timestamp(clock);
      const jobId = `signal_job_${stableHash(`${request.providerId}|${request.clientRequestId}`, 32)}`;
      const job = {
        jobId,
        clientRequestId: request.clientRequestId,
        signature: request.signature,
        mode: request.mode,
        providerId: request.providerId,
        target: request.target,
        quota: request.quota,
        maxAttempts: request.maxAttempts,
        timeoutMs: request.timeoutMs,
        status: "queued",
        attempts: 0,
        nextAttemptAt: null,
        error: null,
        signalIds: [],
        scheduleKey,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        leaseExpiresAt: null
      };
      state.jobs.push(job);
      if (scheduleKey) state.scheduleKeys[scheduleKey] = jobId;
      return { value: { job, idempotent: false }, details: { jobId, providerId: request.providerId, scheduleKey } };
    });
  }

  async function listJobs(filter = {}) {
    const state = await snapshot();
    return state.jobs.filter((job) => (
      (!filter.providerId || job.providerId === filter.providerId)
      && (!filter.clientRequestId || job.clientRequestId === filter.clientRequestId)
      && (!filter.statuses || filter.statuses.includes(job.status))
    ));
  }

  async function getJob(reference) {
    const state = await snapshot();
    const job = state.jobs.find((row) => row.jobId === reference || row.clientRequestId === reference);
    return job ? clone(job) : null;
  }

  async function claimNext(filter = {}, actor = { type: "worker", id: "signal-connector" }) {
    return mutation("signal.job.running", actor, async (state) => {
      const now = timestamp(clock);
      const job = state.jobs.filter((row) => (
        (!filter.providerId || row.providerId === filter.providerId)
        && (row.status === "queued" || (row.status === "retry-wait" && (!row.nextAttemptAt || row.nextAttemptAt <= now)))
      )).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))[0];
      if (!job) return { changed: false, value: null };
      assertSignalJobTransition(job.status, "running");
      job.status = "running";
      job.attempts += 1;
      job.startedAt = job.startedAt || now;
      job.updatedAt = now;
      job.leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      job.nextAttemptAt = null;
      job.error = null;
      return { value: job, details: { jobId: job.jobId, providerId: job.providerId, attempt: job.attempts } };
    });
  }

  function jobMutation(event, reference, actor, update) {
    return mutation(event, actor, async (state) => {
      const job = state.jobs.find((row) => row.jobId === reference || row.clientRequestId === reference);
      if (!job) throw connectorError("Signal connector job was not found", "SIGNAL_CONNECTOR_JOB_NOT_FOUND", 404);
      const result = update(job, state) || {};
      job.updatedAt = timestamp(clock);
      return { value: result.value || job, changed: result.changed, details: { jobId: job.jobId, providerId: job.providerId, ...(result.details || {}) } };
    });
  }

  async function completeJob(reference, signalIds, actor) {
    return jobMutation("signal.job.completed", reference, actor, (job) => {
      assertSignalJobTransition(job.status, "completed");
      job.status = "completed";
      job.signalIds = [...new Set(signalIds || [])];
      job.completedAt = timestamp(clock);
      job.leaseExpiresAt = null;
      job.error = null;
      return { details: { signalCount: job.signalIds.length } };
    });
  }

  async function retryJob(reference, error, nextAttemptAt, actor) {
    return jobMutation("signal.job.retry-wait", reference, actor, (job) => {
      assertSignalJobTransition(job.status, "retry-wait");
      job.status = "retry-wait";
      job.error = clone(error);
      job.nextAttemptAt = String(nextAttemptAt);
      job.leaseExpiresAt = null;
      return { details: { category: error.category, nextAttemptAt: job.nextAttemptAt } };
    });
  }

  async function failJob(reference, error, actor) {
    return jobMutation("signal.job.failed", reference, actor, (job) => {
      assertSignalJobTransition(job.status, "failed");
      job.status = "failed";
      job.error = clone(error);
      job.completedAt = timestamp(clock);
      job.leaseExpiresAt = null;
      return { details: { category: error.category } };
    });
  }

  async function cancelJob(reference, actor, reason = "manual-stop") {
    return jobMutation("signal.job.cancelled", reference, actor, (job) => {
      if (job.status === "cancelled") return { changed: false };
      if (job.status === "completed") throw connectorError("Completed signal jobs cannot be cancelled", "SIGNAL_CONNECTOR_STATE_INVALID", 409);
      assertSignalJobTransition(job.status, "cancelled");
      job.status = "cancelled";
      job.error = { category: "cancelled", code: "SIGNAL_CONNECTOR_CANCELLED", message: "수집 작업이 취소되었습니다." };
      job.completedAt = timestamp(clock);
      job.leaseExpiresAt = null;
      return { details: { reason: cleanText(reason, 120) } };
    });
  }

  async function resumeJob(reference, actor) {
    return jobMutation("signal.job.resumed", reference, actor, (job) => {
      if (job.status === "queued") return { changed: false };
      if (job.status === "running") {
        if (!job.leaseExpiresAt || job.leaseExpiresAt > timestamp(clock)) {
          throw connectorError("A running signal job can resume only after its lease expires", "SIGNAL_CONNECTOR_LEASE_ACTIVE", 409);
        }
      } else {
        assertSignalJobTransition(job.status, "queued");
      }
      job.status = "queued";
      job.error = null;
      job.nextAttemptAt = null;
      job.completedAt = null;
      job.leaseExpiresAt = null;
      return {};
    });
  }

  async function reserveQuota(payload, actor) {
    const providerId = cleanId(payload.providerId, "providerId");
    const reservationKey = cleanId(payload.reservationKey, "reservationKey");
    const jobId = cleanId(payload.jobId, "jobId");
    const calls = Number(payload.calls);
    const cost = Number(payload.cost);
    const caps = payload.caps || {};
    if (!Number.isInteger(calls) || calls < 1 || !Number.isFinite(cost) || cost < 0) {
      throw connectorError("Quota reservation calls and cost are invalid", "SIGNAL_CONNECTOR_QUOTA_INVALID", 500);
    }
    for (const key of ["dailyCallCap", "monthlyCallCap", "dailyCostCap", "monthlyCostCap"]) {
      if (!Number.isFinite(Number(caps[key])) || Number(caps[key]) < 0) {
        throw connectorError("Explicit provider quota caps are required", "SIGNAL_CONNECTOR_QUOTA_REQUIRED", 503);
      }
    }
    return mutation("signal.quota.reserved", actor, async (state) => {
      if (!state.jobs.some((row) => row.jobId === jobId)) {
        throw connectorError("Quota reservation job was not found", "SIGNAL_CONNECTOR_JOB_NOT_FOUND", 404);
      }
      const existing = state.reservations.find((row) => row.reservationKey === reservationKey);
      if (existing) {
        if (existing.jobId !== jobId || existing.providerId !== providerId || existing.calls !== calls || existing.cost !== cost) {
          throw connectorError("Quota reservation key conflict", "SIGNAL_CONNECTOR_QUOTA_CONFLICT", 409);
        }
        return { changed: false, value: { reservation: existing, idempotent: true } };
      }
      const now = timestamp(clock);
      const day = utcDay(now);
      const month = utcMonth(now);
      const providerRows = state.reservations.filter((row) => row.providerId === providerId);
      const daily = providerRows.filter((row) => row.day === day);
      const monthly = providerRows.filter((row) => row.month === month);
      const dailyCalls = daily.reduce((sum, row) => sum + row.calls, 0) + calls;
      const monthlyCalls = monthly.reduce((sum, row) => sum + row.calls, 0) + calls;
      const dailyCost = daily.reduce((sum, row) => sum + row.cost, 0) + cost;
      const monthlyCost = monthly.reduce((sum, row) => sum + row.cost, 0) + cost;
      if (
        dailyCalls > Number(caps.dailyCallCap)
        || monthlyCalls > Number(caps.monthlyCallCap)
        || dailyCost > Number(caps.dailyCostCap)
        || monthlyCost > Number(caps.monthlyCostCap)
      ) {
        throw connectorError("Approved provider quota or cost cap exceeded", "SIGNAL_CONNECTOR_QUOTA_EXCEEDED", 429, { category: "quota" });
      }
      const reservation = {
        reservationId: `signal_reservation_${stableHash(reservationKey, 32)}`,
        reservationKey,
        jobId,
        providerId,
        day,
        month,
        calls,
        cost,
        currency: cleanText(caps.currency || "KRW", 8),
        transportStarted: false,
        createdAt: now
      };
      state.reservations.push(reservation);
      return { value: { reservation, idempotent: false }, details: { reservationId: reservation.reservationId, providerId, calls, cost } };
    });
  }

  async function recordTransportAttempt(reservationId, externalNetworkCalls = 0, actor) {
    return mutation("signal.transport.started", actor, async (state) => {
      const row = state.reservations.find((entry) => entry.reservationId === reservationId);
      if (!row) throw connectorError("Quota reservation was not found", "SIGNAL_CONNECTOR_RESERVATION_NOT_FOUND", 404);
      const reportedCalls = Math.max(0, Math.floor(Number(externalNetworkCalls) || 0));
      if (row.transportStarted) {
        const previousCalls = Math.max(0, Number(row.externalNetworkCalls) || 0);
        if (reportedCalls <= previousCalls) return { changed: false, value: row };
        row.externalNetworkCalls = reportedCalls;
        state.metrics.externalNetworkCalls += reportedCalls - previousCalls;
        return { value: row, details: { reservationId, providerId: row.providerId, externalNetworkCalls: row.externalNetworkCalls } };
      }
      row.transportStarted = true;
      row.transportStartedAt = timestamp(clock);
      row.externalNetworkCalls = reportedCalls;
      state.metrics.transportAttempts += 1;
      state.metrics.externalNetworkCalls += row.externalNetworkCalls;
      return { value: row, details: { reservationId, providerId: row.providerId, externalNetworkCalls: row.externalNetworkCalls } };
    });
  }

  async function appendSignals(reference, rows, mode, actor) {
    if (mode === "fixture" && !allowTestFixtures) {
      throw connectorError("Fixture signals require an explicit NODE_ENV=test repository", "SIGNAL_CONNECTOR_FIXTURE_FORBIDDEN", 503);
    }
    const normalized = (rows || []).map((row) => normalizeConnectorSignal(row, mode));
    return mutation("signal.rows.appended", actor, async (state) => {
      const job = state.jobs.find((entry) => entry.jobId === reference || entry.clientRequestId === reference);
      if (!job) throw connectorError("Signal connector job was not found", "SIGNAL_CONNECTOR_JOB_NOT_FOUND", 404);
      if (job.status !== "running") throw connectorError("Signals can be appended only by a running job", "SIGNAL_CONNECTOR_STATE_INVALID", 409);
      const known = new Set(state.signals.map((row) => row.signalId));
      const inserted = normalized.filter((row) => !known.has(row.signalId));
      state.signals.push(...inserted);
      return { value: { signals: inserted, duplicates: normalized.length - inserted.length }, details: { jobId: job.jobId, inserted: inserted.length } };
    });
  }

  async function commitSignals(reference, rows, mode, actor) {
    if (mode === "fixture" && !allowTestFixtures) {
      throw connectorError("Fixture signals require an explicit NODE_ENV=test repository", "SIGNAL_CONNECTOR_FIXTURE_FORBIDDEN", 503);
    }
    const normalized = (rows || []).map((row) => normalizeConnectorSignal(row, mode));
    return mutation("signal.job.completed", actor, async (state) => {
      const job = state.jobs.find((entry) => entry.jobId === reference || entry.clientRequestId === reference);
      if (!job) throw connectorError("Signal connector job was not found", "SIGNAL_CONNECTOR_JOB_NOT_FOUND", 404);
      assertSignalJobTransition(job.status, "completed");
      const known = new Set(state.signals.map((row) => row.signalId));
      const inserted = normalized.filter((row) => !known.has(row.signalId));
      state.signals.push(...inserted);
      job.status = "completed";
      job.signalIds = [...new Set(normalized.map((row) => row.signalId))];
      job.completedAt = timestamp(clock);
      job.updatedAt = job.completedAt;
      job.leaseExpiresAt = null;
      job.error = null;
      state.audits.push(auditEntry("signal.rows.appended", actor, {
        jobId: job.jobId,
        providerId: job.providerId,
        inserted: inserted.length,
        duplicates: normalized.length - inserted.length
      }));
      return {
        value: { job, signals: inserted, duplicates: normalized.length - inserted.length },
        details: { jobId: job.jobId, providerId: job.providerId, signalCount: job.signalIds.length }
      };
    });
  }

  async function listSignals(filter = {}) {
    const state = await snapshot();
    return state.signals.filter((row) => (
      (!filter.providerId || row.source === filter.providerId)
      && (!filter.companyId || row.companyId === filter.companyId)
      && (!filter.kind || row.kind === filter.kind)
      && (filter.synthetic === undefined || row.synthetic === filter.synthetic)
    ));
  }

  async function setKillSwitch(providerIdInput, open, actor, reason = "manual-stop") {
    const providerId = cleanId(providerIdInput, "providerId");
    return mutation(open ? "signal.provider.stopped" : "signal.provider.resumed", actor, async (state) => {
      state.killSwitches[providerId] = {
        open: Boolean(open),
        reason: cleanText(reason, 120),
        updatedAt: timestamp(clock),
        actor: cleanActor(actor)
      };
      return { value: clone(state.killSwitches[providerId]), details: { providerId, open: Boolean(open), reason: cleanText(reason, 120) } };
    });
  }

  async function killSwitch(providerId) {
    const state = await snapshot();
    return clone(state.killSwitches[providerId] || { open: false, reason: "", updatedAt: "" });
  }

  async function setSchedulerStopped(stopped, actor, reason = "manual-stop") {
    return mutation(stopped ? "signal.scheduler.stopped" : "signal.scheduler.enabled", actor, async (state) => {
      state.scheduler = {
        stopped: Boolean(stopped),
        reason: cleanText(reason, 120),
        updatedAt: timestamp(clock),
        actor: cleanActor(actor)
      };
      return { value: state.scheduler, details: { stopped: Boolean(stopped), reason: cleanText(reason, 120) } };
    });
  }

  async function schedulerStatus() {
    return clone((await snapshot()).scheduler);
  }

  async function audits(filter = {}) {
    const state = await snapshot();
    return state.audits.filter((row) => !filter.event || row.event === filter.event).slice(-(Number(filter.limit) || 500));
  }

  async function providerMetrics(providerIdInput = "") {
    const state = await snapshot();
    const providerIds = providerIdInput
      ? [cleanId(providerIdInput, "providerId")]
      : [...new Set([...state.jobs.map((row) => row.providerId), ...Object.keys(state.killSwitches)])].sort();
    const now = Date.parse(timestamp(clock));
    return providerIds.map((providerId) => {
      const jobs = state.jobs.filter((row) => row.providerId === providerId);
      const settled = jobs.filter((row) => ["completed", "failed"].includes(row.status));
      const signals = state.signals.filter((row) => row.source === providerId && row.synthetic === false && row.dataMode === "live");
      const expectedKinds = new Set(jobs.flatMap((row) => row.target.signalKinds));
      const observedKinds = new Set(signals.map((row) => row.kind));
      const latestSignalAt = signals.map((row) => row.observedAt).sort().at(-1) || "";
      const ageHours = latestSignalAt ? Math.max(0, (now - Date.parse(latestSignalAt)) / 3_600_000) : null;
      return {
        providerId,
        killSwitchOpen: Boolean(state.killSwitches[providerId]?.open),
        jobs: jobs.length,
        completed: jobs.filter((row) => row.status === "completed").length,
        failed: jobs.filter((row) => row.status === "failed").length,
        successRate: settled.length ? Math.round((jobs.filter((row) => row.status === "completed").length / settled.length) * 10_000) / 100 : null,
        coverage: expectedKinds.size ? Math.round((observedKinds.size / expectedKinds.size) * 10_000) / 100 : 0,
        expectedSignalKinds: expectedKinds.size,
        observedSignalKinds: observedKinds.size,
        latestSignalAt,
        freshness: ageHours === null ? "not-collected" : ageHours <= 24 ? "fresh" : ageHours <= 168 ? "current" : "stale"
      };
    });
  }

  async function quotaUsage(providerIdInput = "") {
    const state = await snapshot();
    const providerIds = providerIdInput
      ? [cleanId(providerIdInput, "providerId")]
      : [...new Set([
        ...state.jobs.map((row) => row.providerId),
        ...state.reservations.map((row) => row.providerId),
        ...Object.keys(state.killSwitches)
      ])].sort();
    const now = timestamp(clock);
    const day = utcDay(now);
    const month = utcMonth(now);
    return providerIds.map((providerId) => {
      const jobs = state.jobs.filter((row) => row.providerId === providerId);
      const latestJob = [...jobs].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).at(-1);
      const daily = state.reservations.filter((row) => row.providerId === providerId && row.day === day);
      const monthly = state.reservations.filter((row) => row.providerId === providerId && row.month === month);
      return {
        providerId,
        day,
        month,
        daily: {
          calls: daily.reduce((sum, row) => sum + Number(row.calls || 0), 0),
          cost: daily.reduce((sum, row) => sum + Number(row.cost || 0), 0),
          callCap: latestJob ? Number(latestJob.quota.dailyCallCap) : null,
          costCap: latestJob ? Number(latestJob.quota.dailyCostCap) : null
        },
        monthly: {
          calls: monthly.reduce((sum, row) => sum + Number(row.calls || 0), 0),
          cost: monthly.reduce((sum, row) => sum + Number(row.cost || 0), 0),
          callCap: latestJob ? Number(latestJob.quota.monthlyCallCap) : null,
          costCap: latestJob ? Number(latestJob.quota.monthlyCostCap) : null
        },
        currency: cleanText(latestJob?.quota?.currency || "KRW", 8),
        transportAttempts: state.reservations.filter((row) => row.providerId === providerId && row.transportStarted).length,
        externalNetworkCalls: state.reservations
          .filter((row) => row.providerId === providerId)
          .reduce((sum, row) => sum + Math.max(0, Number(row.externalNetworkCalls) || 0), 0)
      };
    });
  }

  async function diagnostics() {
    const state = await snapshot().catch(() => null);
    if (!state) {
      return {
        storeKind: SIGNAL_CONNECTOR_STORE_KIND,
        initialized: false,
        externalNetworkCalls: 0,
        legacyRuntimeReads: 0,
        legacyRuntimeCopies: 0
      };
    }
    return {
      storeKind: state.storeKind,
      schemaVersion: state.schemaVersion,
      initialized: true,
      revision: state.revision,
      jobs: state.jobs.length,
      signals: state.signals.length,
      reservations: state.reservations.length,
      schedulerStopped: state.scheduler.stopped,
      ...clone(state.metrics)
    };
  }

  return Object.freeze({
    initialize,
    createJob,
    listJobs,
    getJob,
    claimNext,
    completeJob,
    retryJob,
    failJob,
    cancelJob,
    resumeJob,
    reserveQuota,
    recordTransportAttempt,
    appendSignals,
    commitSignals,
    listSignals,
    setKillSwitch,
    killSwitch,
    setSchedulerStopped,
    schedulerStatus,
    audits,
    providerMetrics,
    quotaUsage,
    diagnostics,
    snapshot,
    signalKinds: INSIGHTS_SIGNAL_KINDS
  });
}

module.exports = {
  createSignalConnectorRepository
};
