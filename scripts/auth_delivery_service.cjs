const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const DELIVERY_LOG_LIMIT = 3000;
const RETRY_QUEUE_LIMIT = 1000;
const WEBHOOK_EVENT_LIMIT = 3000;
const SUCCESS_STATES = new Set(["succeeded", "delivered"]);
const RETRYABLE_STATES = new Set(["retry_required"]);

function nowIso() {
  return new Date().toISOString();
}

function secureHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function shortText(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function defaultStore(name) {
  return { version: 1, name, updatedAt: "", items: [] };
}

async function readStore(filePath, name) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      version: Number(parsed.version || 1),
      name: parsed.name || name,
      updatedAt: parsed.updatedAt || "",
      items: Array.isArray(parsed.items) ? parsed.items : []
    };
  } catch (error) {
    if (error?.code === "ENOENT") return defaultStore(name);
    throw error;
  }
}

async function writeStore(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const next = { ...payload, updatedAt: nowIso() };
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
  return next;
}

function deliveryStatus(options = {}) {
  const requestedMode = String(options.mode || "mock").trim().toLowerCase();
  const endpoint = String(options.endpoint || "").trim();
  const token = String(options.apiToken || "").trim();
  const from = String(options.from || "").trim();
  const queueSecret = String(options.queueSecret || "").trim();
  const webhookSecret = String(options.webhookSecret || "").trim();
  const realConfigured = /^https:\/\//i.test(endpoint) && Boolean(token && from);
  const activeMode = requestedMode === "real" && realConfigured ? "real" : "mock";
  return {
    requestedMode: requestedMode === "real" ? "real" : "mock",
    activeMode,
    provider: shortText(options.provider || "generic_http", 80) || "generic_http",
    realConfigured,
    operationalReady: activeMode === "real" && Boolean(queueSecret && webhookSecret),
    endpointConfigured: /^https:\/\//i.test(endpoint),
    tokenConfigured: Boolean(token),
    fromConfigured: Boolean(from),
    queueEncryptionConfigured: queueSecret.length >= 16,
    webhookConfigured: webhookSecret.length >= 16,
    maxAttempts: boundedNumber(options.maxAttempts, 3, 1, 10),
    claimTimeoutSeconds: boundedNumber(options.claimTimeoutSeconds, 300, 30, 3600),
    webhookPath: "/api/auth/email/webhook"
  };
}

function providerResultId(payload = {}, headers = null) {
  return shortText(
    payload.id ||
    payload.messageId ||
    payload.message_id ||
    payload.deliveryId ||
    payload.data?.id ||
    payload.data?.messageId ||
    payload.data?.message_id ||
    headers?.get?.("x-message-id") ||
    headers?.get?.("x-provider-message-id") ||
    "",
    180
  );
}

function providerResultStatus(payload = {}) {
  return shortText(payload.status || payload.state || payload.data?.status || payload.data?.state || "", 80);
}

async function parseProviderResponse(response) {
  let text = "";
  try {
    text = String(await response.text()).slice(0, 32768);
  } catch {}
  let payload = {};
  try {
    payload = text.trim() ? JSON.parse(text) : {};
  } catch {}
  return {
    providerDeliveryId: providerResultId(payload, response.headers),
    providerStatus: providerResultStatus(payload),
    retryAfterSeconds: boundedNumber(response.headers?.get?.("retry-after"), 0, 0, 86400)
  };
}

function normalizeWebhookState(value) {
  const state = String(value || "").trim().toLowerCase().replace(/[.\s-]+/g, "_");
  if (["delivered", "delivery", "success", "sent"].includes(state)) return "delivered";
  if (["bounce", "bounced", "hard_bounce", "soft_bounce"].includes(state)) return "bounced";
  if (["complaint", "complained", "spam", "spam_complaint"].includes(state)) return "complained";
  if (["failed", "failure", "dropped", "rejected", "undeliverable"].includes(state)) return "failed";
  if (["deferred", "delayed", "queued", "processing"].includes(state)) return "processing";
  return "unknown";
}

function serviceError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function createAuthDeliveryService(options = {}) {
  const logsFile = path.resolve(options.logsFile);
  const retryQueueFile = path.resolve(options.retryQueueFile || path.join(path.dirname(logsFile), "auth_delivery_retry_queue.json"));
  const webhookEventsFile = path.resolve(options.webhookEventsFile || path.join(path.dirname(logsFile), "auth_delivery_webhook_events.json"));
  const timeoutMs = boundedNumber(options.timeoutMs, 8000, 1000, 30000);
  const maxAttempts = boundedNumber(options.maxAttempts, 3, 1, 10);
  const retryBaseSeconds = boundedNumber(options.retryBaseSeconds, 60, 1, 86400);
  const claimTimeoutSeconds = boundedNumber(options.claimTimeoutSeconds, 300, 30, 3600);
  const queueSecret = String(options.queueSecret || "");
  const previousQueueSecret = String(options.previousQueueSecret || "");
  const queueKeyVersion = shortText(options.queueKeyVersion || "v1", 80) || "v1";
  const previousQueueKeyVersion = shortText(options.previousQueueKeyVersion || "", 80);
  const webhookSecret = String(options.webhookSecret || "");
  const previousWebhookSecret = String(options.previousWebhookSecret || "");
  const webhookKeyVersion = shortText(options.webhookKeyVersion || "v1", 80) || "v1";
  const previousWebhookKeyVersion = shortText(options.previousWebhookKeyVersion || "", 80);
  const keyTransitionActive = Boolean(options.keyTransitionActive);
  const webhookToleranceSeconds = boundedNumber(options.webhookToleranceSeconds, 300, 30, 3600);
  let mutationQueue = Promise.resolve();

  function mutate(task) {
    const next = mutationQueue.then(task, task);
    mutationQueue = next.catch(() => {});
    return next;
  }

  function status() {
    return deliveryStatus({ ...options, maxAttempts });
  }

  function encryptionKey(secret = queueSecret) {
    return secret.length >= 16 ? crypto.createHash("sha256").update(secret).digest() : null;
  }

  function encryptEnvelope(payload) {
    const key = encryptionKey();
    if (!key) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return {
      version: 1,
      keyVersion: queueKeyVersion,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  }

  function decryptEnvelopeWithMetadata(encrypted) {
    if (encrypted?.algorithm !== "aes-256-gcm") {
      throw serviceError("AUTH_DELIVERY_QUEUE_DECRYPT_FAILED", "The retry payload cannot be decrypted.", 409);
    }
    const payloadVersion = shortText(encrypted.keyVersion, 80);
    const candidates = [
      { keyVersion: queueKeyVersion, secret: queueSecret, source: "current" },
      ...(keyTransitionActive ? [{ keyVersion: previousQueueKeyVersion, secret: previousQueueSecret, source: "previous" }] : [])
    ]
      .filter((item) => item.secret.length >= 16)
      .sort((left, right) => Number(right.keyVersion === payloadVersion) - Number(left.keyVersion === payloadVersion));
    for (const candidate of candidates) {
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(candidate.secret), Buffer.from(encrypted.iv, "base64"));
        decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
          decipher.final()
        ]).toString("utf8");
        return { payload: JSON.parse(plaintext), source: candidate.source, keyVersion: candidate.keyVersion };
      } catch {}
    }
    throw serviceError("AUTH_DELIVERY_QUEUE_DECRYPT_FAILED", "The retry payload cannot be decrypted.", 409);
  }

  function decryptEnvelope(encrypted) {
    return decryptEnvelopeWithMetadata(encrypted).payload;
  }

  function normalizedEnvelope(payload = {}) {
    return {
      kind: shortText(payload.kind, 60),
      targetId: shortText(payload.targetId, 120),
      recipient: String(payload.recipient || "").trim().toLowerCase(),
      link: String(payload.link || "").trim(),
      requestedBy: shortText(payload.requestedBy, 120),
      subject: shortText(payload.subject, 200),
      text: shortText(payload.text, 4000),
      html: shortText(payload.html, 12000)
    };
  }

  function publicQueueItem(item = {}) {
    const { encryptedEnvelope, ...safe } = item;
    return safe;
  }

  async function createAttempt(envelope, controls = {}) {
    const connector = status();
    const idempotencyKey = shortText(
      controls.idempotencyKey || secureHash([envelope.kind, envelope.targetId, envelope.recipient, envelope.link].join("|")),
      128
    );
    return mutate(async () => {
      const store = await readStore(logsFile, "auth_delivery_logs");
      const sendingFreshAfter = Date.now() - Math.max(60000, timeoutMs * 3);
      const duplicate = !controls.force && store.items.find((item) =>
        item.idempotencyKey === idempotencyKey && (
          SUCCESS_STATES.has(item.status) ||
          (item.status === "sending" && Date.parse(item.requestedAt || "") >= sendingFreshAfter)
        )
      );
      if (duplicate) return { duplicate: { ...duplicate, duplicateSuppressed: true }, idempotencyKey };
      const requestedAt = nowIso();
      const item = {
        deliveryId: randomId("dlv"),
        rootDeliveryId: shortText(controls.rootDeliveryId, 120),
        parentDeliveryId: shortText(controls.parentDeliveryId, 120),
        retryId: shortText(controls.retryId, 120),
        idempotencyKey,
        kind: envelope.kind,
        targetId: envelope.targetId,
        recipient: shortText(envelope.recipient, 160),
        recipientHash: secureHash(envelope.recipient),
        provider: connector.provider,
        mode: connector.activeMode,
        status: "sending",
        providerDeliveryId: "",
        providerStatus: "",
        responseCode: 0,
        errorCode: "",
        queueStatus: "",
        attemptNumber: boundedNumber(controls.attemptNumber, 1, 1, 100),
        requestedBy: shortText(envelope.requestedBy, 120),
        requestedAt,
        completedAt: "",
        webhookUpdatedAt: ""
      };
      store.items.push(item);
      if (store.items.length > DELIVERY_LOG_LIMIT) store.items = store.items.slice(-DELIVERY_LOG_LIMIT);
      await writeStore(logsFile, store);
      return { item, idempotencyKey };
    });
  }

  async function patchDelivery(deliveryId, changes = {}) {
    return mutate(async () => {
      const store = await readStore(logsFile, "auth_delivery_logs");
      const index = store.items.findIndex((item) => item.deliveryId === String(deliveryId || ""));
      if (index < 0) return null;
      store.items[index] = { ...store.items[index], ...changes };
      await writeStore(logsFile, store);
      return store.items[index];
    });
  }

  function nextRetryAt(attemptNumber, retryAfterSeconds = 0) {
    const delaySeconds = retryAfterSeconds || Math.min(86400, retryBaseSeconds * (2 ** Math.max(0, attemptNumber - 1)));
    return new Date(Date.now() + delaySeconds * 1000).toISOString();
  }

  async function enqueueRetry(delivery, envelope, retryAfterSeconds = 0) {
    const encryptedEnvelope = encryptEnvelope(envelope);
    if (!encryptedEnvelope) {
      return patchDelivery(delivery.deliveryId, { queueStatus: "blocked", queueErrorCode: "retry_queue_key_missing" });
    }
    const queueItem = await mutate(async () => {
      const store = await readStore(retryQueueFile, "auth_delivery_retry_queue");
      const existingIndex = store.items.findIndex((item) => item.idempotencyKey === delivery.idempotencyKey && ["pending", "running"].includes(item.status));
      const item = {
        retryId: existingIndex >= 0 ? store.items[existingIndex].retryId : randomId("retry"),
        rootDeliveryId: delivery.rootDeliveryId || delivery.deliveryId,
        lastDeliveryId: delivery.deliveryId,
        idempotencyKey: delivery.idempotencyKey,
        kind: delivery.kind,
        targetId: delivery.targetId,
        recipientHash: delivery.recipientHash,
        status: "pending",
        attemptCount: Number(delivery.attemptNumber || 1),
        maxAttempts,
        nextAttemptAt: nextRetryAt(Number(delivery.attemptNumber || 1), retryAfterSeconds),
        lastErrorCode: delivery.errorCode,
        encryptedEnvelope,
        claimedAt: "",
        createdAt: existingIndex >= 0 ? store.items[existingIndex].createdAt : nowIso(),
        updatedAt: nowIso(),
        completedAt: ""
      };
      if (existingIndex >= 0) store.items[existingIndex] = item;
      else store.items.push(item);
      if (store.items.length > RETRY_QUEUE_LIMIT) store.items = store.items.slice(-RETRY_QUEUE_LIMIT);
      await writeStore(retryQueueFile, store);
      return item;
    });
    await patchDelivery(delivery.deliveryId, { retryId: queueItem.retryId, queueStatus: queueItem.status });
    return queueItem;
  }

  async function updateRetryOutcome(retryId, delivery) {
    const queueItem = await mutate(async () => {
      const store = await readStore(retryQueueFile, "auth_delivery_retry_queue");
      const index = store.items.findIndex((item) => item.retryId === String(retryId || ""));
      if (index < 0) return null;
      const current = store.items[index];
      const attempts = Number(delivery.attemptNumber || current.attemptCount + 1);
      let queueStatus = SUCCESS_STATES.has(delivery.status) ? "succeeded" : "failed";
      let nextAttempt = "";
      if (RETRYABLE_STATES.has(delivery.status) && attempts < Number(current.maxAttempts || maxAttempts)) {
        queueStatus = "pending";
        nextAttempt = nextRetryAt(attempts, delivery.retryAfterSeconds || 0);
      }
      store.items[index] = {
        ...current,
        lastDeliveryId: delivery.deliveryId,
        status: queueStatus,
        attemptCount: attempts,
        nextAttemptAt: nextAttempt,
        lastErrorCode: delivery.errorCode || "",
        claimedAt: "",
        updatedAt: nowIso(),
        completedAt: ["succeeded", "failed"].includes(queueStatus) ? nowIso() : ""
      };
      await writeStore(retryQueueFile, store);
      return store.items[index];
    });
    if (queueItem) await patchDelivery(delivery.deliveryId, { queueStatus: queueItem.status });
    return queueItem;
  }

  async function sendReal(attempt, envelope) {
    let responseCode = 0;
    let deliveryState = "failed";
    let errorCode = "provider_request_failed";
    let providerDeliveryId = "";
    let providerStatus = "";
    let retryAfterSeconds = 0;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(String(options.endpoint), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${String(options.apiToken)}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": attempt.idempotencyKey
          },
          body: JSON.stringify({
            from: String(options.from),
            to: envelope.recipient,
            subject: envelope.subject,
            text: envelope.text,
            html: envelope.html,
            metadata: {
              deliveryId: attempt.deliveryId,
              kind: envelope.kind,
              targetId: envelope.targetId,
              idempotencyKey: attempt.idempotencyKey
            }
          }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
      responseCode = response.status;
      const providerResult = await parseProviderResponse(response);
      providerDeliveryId = providerResult.providerDeliveryId;
      providerStatus = providerResult.providerStatus;
      retryAfterSeconds = providerResult.retryAfterSeconds;
      if (response.ok) {
        deliveryState = "succeeded";
        errorCode = "";
      } else if (response.status === 429) {
        deliveryState = "retry_required";
        errorCode = "provider_rate_limited";
      } else if (response.status >= 500) {
        deliveryState = "retry_required";
        errorCode = `provider_http_${response.status}`;
      } else if (response.status === 401 || response.status === 403) {
        deliveryState = "review_required";
        errorCode = "provider_authentication_failed";
      } else {
        deliveryState = "failed";
        errorCode = `provider_http_${response.status}`;
      }
    } catch (error) {
      errorCode = error?.name === "AbortError" ? "provider_timeout" : "provider_network_failed";
      deliveryState = "retry_required";
    }
    return { responseCode, status: deliveryState, errorCode, providerDeliveryId, providerStatus, retryAfterSeconds };
  }

  async function deliver(payload = {}, controls = {}) {
    const connector = status();
    const envelope = normalizedEnvelope(payload);
    if (!envelope.recipient || !envelope.link) {
      const created = await createAttempt(envelope, controls);
      if (created.duplicate) return { ...created.duplicate, previewLink: "" };
      const failed = await patchDelivery(created.item.deliveryId, {
        status: "review_required",
        errorCode: "delivery_payload_incomplete",
        completedAt: nowIso()
      });
      return { ...failed, previewLink: "" };
    }
    if (connector.activeMode === "real" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(envelope.recipient)) {
      const created = await createAttempt(envelope, controls);
      if (created.duplicate) return { ...created.duplicate, previewLink: "" };
      const failed = await patchDelivery(created.item.deliveryId, {
        status: "review_required",
        errorCode: "recipient_email_invalid",
        completedAt: nowIso()
      });
      return { ...failed, previewLink: "" };
    }

    const created = await createAttempt(envelope, controls);
    if (created.duplicate) {
      return { ...created.duplicate, previewLink: connector.activeMode === "mock" ? envelope.link : "" };
    }
    const attempt = created.item;
    const outcome = connector.activeMode === "mock"
      ? { responseCode: 0, status: "succeeded", errorCode: "", providerDeliveryId: `mock_${attempt.deliveryId}`, providerStatus: "accepted", retryAfterSeconds: 0 }
      : await sendReal(attempt, envelope);
    let delivery = await patchDelivery(attempt.deliveryId, {
      status: outcome.status,
      responseCode: outcome.responseCode,
      errorCode: outcome.errorCode,
      providerDeliveryId: outcome.providerDeliveryId,
      providerStatus: outcome.providerStatus,
      completedAt: nowIso()
    });
    delivery = { ...delivery, retryAfterSeconds: outcome.retryAfterSeconds };
    if (controls.retryId) {
      await updateRetryOutcome(controls.retryId, delivery);
      delivery = await getDelivery(delivery.deliveryId);
    } else if (RETRYABLE_STATES.has(delivery.status)) {
      await enqueueRetry(delivery, envelope, outcome.retryAfterSeconds);
      delivery = await getDelivery(delivery.deliveryId);
    }
    return { ...delivery, previewLink: connector.activeMode === "mock" ? envelope.link : "" };
  }

  async function getDelivery(deliveryId) {
    const store = await readStore(logsFile, "auth_delivery_logs");
    return store.items.find((item) => item.deliveryId === String(deliveryId || "")) || null;
  }

  async function runRetries(filters = {}) {
    const limit = boundedNumber(filters.limit, 20, 1, 100);
    const force = Boolean(filters.force);
    const requestedDeliveryId = shortText(filters.deliveryId, 120);
    const requestedRetryId = shortText(filters.retryId, 120);
    const candidates = await mutate(async () => {
      const store = await readStore(retryQueueFile, "auth_delivery_retry_queue");
      const now = Date.now();
      const selected = store.items
        .filter((item) => !requestedRetryId || item.retryId === requestedRetryId)
        .filter((item) => !requestedDeliveryId || item.lastDeliveryId === requestedDeliveryId || item.rootDeliveryId === requestedDeliveryId)
        .filter((item) =>
          item.status === "pending" ||
          (item.status === "running" && Date.parse(item.claimedAt || item.updatedAt || "") <= now - claimTimeoutSeconds * 1000) ||
          (force && ["failed", "review_required"].includes(item.status))
        )
        .filter((item) => force || Date.parse(item.nextAttemptAt || "") <= now)
        .slice(0, limit);
      const selectedIds = new Set(selected.map((item) => item.retryId));
      store.items = store.items.map((item) => selectedIds.has(item.retryId) ? { ...item, status: "running", claimedAt: nowIso(), updatedAt: nowIso() } : item);
      if (selected.length) await writeStore(retryQueueFile, store);
      return selected.map((item) => ({ ...item, status: "running" }));
    });
    const results = [];
    for (const candidate of candidates) {
      try {
        const envelope = decryptEnvelope(candidate.encryptedEnvelope);
        envelope.requestedBy = shortText(filters.requestedBy || envelope.requestedBy, 120);
        const result = await deliver(envelope, {
          force: true,
          retryId: candidate.retryId,
          rootDeliveryId: candidate.rootDeliveryId,
          parentDeliveryId: candidate.lastDeliveryId,
          attemptNumber: Number(candidate.attemptCount || 1) + 1,
          idempotencyKey: candidate.idempotencyKey
        });
        results.push(result);
      } catch (error) {
        await mutate(async () => {
          const store = await readStore(retryQueueFile, "auth_delivery_retry_queue");
          const index = store.items.findIndex((item) => item.retryId === candidate.retryId);
          if (index >= 0) {
            store.items[index] = {
              ...store.items[index],
              status: "review_required",
              lastErrorCode: shortText(error.code || "retry_execution_failed", 100),
              claimedAt: "",
              updatedAt: nowIso()
            };
            await writeStore(retryQueueFile, store);
          }
        });
        results.push({ retryId: candidate.retryId, status: "review_required", errorCode: error.code || "retry_execution_failed" });
      }
    }
    return { generatedAt: nowIso(), attempted: candidates.length, results, report: await listReport({ limit: 100 }) };
  }

  function verifyWebhookSignature(rawBody, signature, timestamp = "") {
    if (webhookSecret.length < 16) throw serviceError("AUTH_DELIVERY_WEBHOOK_NOT_CONFIGURED", "Email webhook verification is not configured.", 503);
    const signatureValue = String(signature || "").trim().replace(/^sha256=/i, "");
    if (!/^[a-f0-9]{64}$/i.test(signatureValue)) throw serviceError("AUTH_DELIVERY_WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature.", 401);
    const timestampValue = String(timestamp || "").trim();
    if (timestampValue) {
      const timestampMs = /^\d{13}$/.test(timestampValue) ? Number(timestampValue) : Number(timestampValue) * 1000;
      if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > webhookToleranceSeconds * 1000) {
        throw serviceError("AUTH_DELIVERY_WEBHOOK_EXPIRED", "Webhook timestamp is outside the accepted window.", 401);
      }
    }
    const signed = timestampValue ? `${timestampValue}.${rawBody}` : rawBody;
    const right = Buffer.from(signatureValue, "hex");
    const candidates = [
      { keyVersion: webhookKeyVersion, secret: webhookSecret, source: "current" },
      ...(keyTransitionActive ? [{ keyVersion: previousWebhookKeyVersion, secret: previousWebhookSecret, source: "previous" }] : [])
    ].filter((item) => item.secret.length >= 16);
    for (const candidate of candidates) {
      const expected = crypto.createHmac("sha256", candidate.secret).update(signed).digest("hex");
      const left = Buffer.from(expected, "hex");
      if (left.length === right.length && crypto.timingSafeEqual(left, right)) return candidate;
    }
    throw serviceError("AUTH_DELIVERY_WEBHOOK_SIGNATURE_INVALID", "Invalid webhook signature.", 401);
  }

  async function processWebhook({ rawBody = "", signature = "", timestamp = "" } = {}) {
    const signatureMatch = verifyWebhookSignature(String(rawBody), signature, timestamp);
    let payload;
    try {
      payload = JSON.parse(String(rawBody || "{}"));
    } catch {
      throw serviceError("AUTH_DELIVERY_WEBHOOK_JSON_INVALID", "Webhook payload is not valid JSON.", 400);
    }
    const eventType = shortText(payload.event || payload.type || payload.status || payload.data?.event || payload.data?.status, 80);
    const normalizedState = normalizeWebhookState(eventType);
    const providerDeliveryId = shortText(
      payload.providerDeliveryId || payload.messageId || payload.message_id ||
      payload.data?.providerDeliveryId || payload.data?.messageId || payload.data?.message_id ||
      payload.data?.id || payload.id || "",
      180
    );
    const internalDeliveryId = shortText(payload.deliveryId || payload.metadata?.deliveryId || payload.data?.metadata?.deliveryId, 120);
    if (!providerDeliveryId && !internalDeliveryId) {
      throw serviceError("AUTH_DELIVERY_WEBHOOK_TARGET_MISSING", "Webhook delivery identifier is missing.", 400);
    }
    const eventId = shortText(payload.eventId || payload.event_id || payload.id || payload.data?.eventId, 180) || secureHash(rawBody);
    const eventHash = secureHash([status().provider, eventId].join("|"));
    return mutate(async () => {
      const [events, logs] = await Promise.all([
        readStore(webhookEventsFile, "auth_delivery_webhook_events"),
        readStore(logsFile, "auth_delivery_logs")
      ]);
      const duplicate = events.items.find((item) => item.eventHash === eventHash);
      if (duplicate) return { accepted: true, duplicate: true, event: duplicate, delivery: null };
      const deliveryIndex = logs.items.findIndex((item) =>
        (providerDeliveryId && item.providerDeliveryId === providerDeliveryId) ||
        (internalDeliveryId && item.deliveryId === internalDeliveryId)
      );
      const occurredAt = shortText(payload.occurredAt || payload.createdAt || payload.timestamp || payload.data?.timestamp, 60) || nowIso();
      const event = {
        webhookEventId: randomId("wh"),
        eventId,
        eventHash,
        provider: status().provider,
        providerDeliveryId,
        deliveryId: deliveryIndex >= 0 ? logs.items[deliveryIndex].deliveryId : internalDeliveryId,
        eventType,
        normalizedState,
        signatureKeyVersion: signatureMatch.keyVersion,
        signatureKeySource: signatureMatch.source,
        matched: deliveryIndex >= 0,
        occurredAt,
        receivedAt: nowIso()
      };
      events.items.push(event);
      if (events.items.length > WEBHOOK_EVENT_LIMIT) events.items = events.items.slice(-WEBHOOK_EVENT_LIMIT);
      let delivery = null;
      if (deliveryIndex >= 0) {
        const current = logs.items[deliveryIndex];
        const nextStatus = normalizedState === "unknown" || normalizedState === "processing" ? current.status : normalizedState;
        logs.items[deliveryIndex] = {
          ...current,
          status: nextStatus,
          providerStatus: eventType || current.providerStatus,
          webhookUpdatedAt: event.receivedAt,
          errorCode: ["bounced", "complained", "failed"].includes(nextStatus) ? `provider_webhook_${nextStatus}` : current.errorCode
        };
        delivery = logs.items[deliveryIndex];
      }
      await Promise.all([writeStore(webhookEventsFile, events), writeStore(logsFile, logs)]);
      return { accepted: true, duplicate: false, event, delivery };
    });
  }

  async function keyRotationStatus() {
    const retryQueue = await readStore(retryQueueFile, "auth_delivery_retry_queue");
    const queue = { total: 0, current: 0, previous: 0, legacy: 0, unreadable: 0 };
    retryQueue.items.forEach((item) => {
      if (!item.encryptedEnvelope) return;
      queue.total += 1;
      try {
        const result = decryptEnvelopeWithMetadata(item.encryptedEnvelope);
        if (!item.encryptedEnvelope.keyVersion) queue.legacy += 1;
        if (result.source === "previous") queue.previous += 1;
        else queue.current += 1;
      } catch {
        queue.unreadable += 1;
      }
    });
    return {
      generatedAt: nowIso(),
      queue: {
        ...queue,
        currentVersion: queueKeyVersion,
        previousVersion: previousQueueKeyVersion,
        currentConfigured: queueSecret.length >= 16,
        previousConfigured: previousQueueSecret.length >= 16,
        pending: retryQueue.items.filter((item) => ["pending", "running"].includes(item.status)).length,
        reviewRequired: retryQueue.items.filter((item) => ["failed", "review_required"].includes(item.status)).length,
        reencryptRequired: queue.previous + queue.legacy > 0,
        reencryptBlocked: queue.unreadable > 0
      },
      webhook: {
        currentVersion: webhookKeyVersion,
        previousVersion: previousWebhookKeyVersion,
        currentConfigured: webhookSecret.length >= 16,
        previousConfigured: previousWebhookSecret.length >= 16,
        previousVerificationActive: keyTransitionActive && previousWebhookSecret.length >= 16
      }
    };
  }

  async function reencryptRetryQueue() {
    return mutate(async () => {
      const store = await readStore(retryQueueFile, "auth_delivery_retry_queue");
      let reencrypted = 0;
      let alreadyCurrent = 0;
      let failed = 0;
      const nextItems = store.items.map((item) => {
        if (!item.encryptedEnvelope) return item;
        try {
          const decrypted = decryptEnvelopeWithMetadata(item.encryptedEnvelope);
          if (item.encryptedEnvelope.keyVersion === queueKeyVersion && decrypted.source === "current") {
            alreadyCurrent += 1;
            return item;
          }
          reencrypted += 1;
          return { ...item, encryptedEnvelope: encryptEnvelope(decrypted.payload), updatedAt: nowIso() };
        } catch {
          failed += 1;
          return item;
        }
      });
      if (failed) throw serviceError("AUTH_DELIVERY_QUEUE_KEY_ROTATION_BLOCKED", "One or more retry rows cannot be decrypted with the active key ring.", 409);
      store.items = nextItems;
      if (reencrypted) await writeStore(retryQueueFile, store);
      return { total: reencrypted + alreadyCurrent, reencrypted, alreadyCurrent, failed: 0, keyVersion: queueKeyVersion };
    });
  }

  async function securitySmokeStatus() {
    const rotation = await keyRotationStatus();
    let queueCurrentRoundTrip = false;
    try {
      const fixture = normalizedEnvelope({
        kind: "security_smoke",
        targetId: "memory_only",
        recipient: "smoke@example.invalid",
        link: "https://example.invalid/#smoke",
        subject: "Security smoke",
        text: "Memory-only encryption fixture"
      });
      const encrypted = encryptEnvelope(fixture);
      const decrypted = decryptEnvelopeWithMetadata(encrypted);
      queueCurrentRoundTrip = decrypted.source === "current"
        && decrypted.keyVersion === queueKeyVersion
        && decrypted.payload.targetId === fixture.targetId;
    } catch {}

    const webhookFixture = JSON.stringify({ eventId: "memory_only_security_smoke", type: "delivered", messageId: "memory_only" });
    let webhookCurrentVerified = false;
    let webhookPreviousAccepted = false;
    try {
      const signature = crypto.createHmac("sha256", webhookSecret).update(webhookFixture).digest("hex");
      const verified = verifyWebhookSignature(webhookFixture, signature);
      webhookCurrentVerified = verified.source === "current" && verified.keyVersion === webhookKeyVersion;
    } catch {}
    if (previousWebhookSecret.length >= 16) {
      try {
        const signature = crypto.createHmac("sha256", previousWebhookSecret).update(webhookFixture).digest("hex");
        const verified = verifyWebhookSignature(webhookFixture, signature);
        webhookPreviousAccepted = verified.source === "previous";
      } catch {}
    }
    const previousAcceptanceExpected = keyTransitionActive && previousWebhookSecret.length >= 16;
    return {
      generatedAt: nowIso(),
      retryQueue: {
        passed: rotation.queue.currentConfigured
          && queueCurrentRoundTrip
          && rotation.queue.unreadable === 0
          && rotation.queue.previous === 0
          && rotation.queue.legacy === 0,
        currentRoundTripVerified: queueCurrentRoundTrip,
        currentVersion: rotation.queue.currentVersion,
        total: rotation.queue.total,
        current: rotation.queue.current,
        previous: rotation.queue.previous,
        legacy: rotation.queue.legacy,
        unreadable: rotation.queue.unreadable,
        pending: rotation.queue.pending,
        reviewRequired: rotation.queue.reviewRequired
      },
      webhook: {
        passed: rotation.webhook.currentConfigured
          && webhookCurrentVerified
          && webhookPreviousAccepted === previousAcceptanceExpected,
        currentVersion: rotation.webhook.currentVersion,
        currentConfigured: rotation.webhook.currentConfigured,
        currentSignatureVerified: webhookCurrentVerified,
        previousConfigured: rotation.webhook.previousConfigured,
        previousVerificationActive: rotation.webhook.previousVerificationActive,
        previousAcceptanceExpected,
        previousSignatureAccepted: webhookPreviousAccepted
      }
    };
  }

  async function listReport(filters = {}) {
    const [logs, retryQueue, webhookEvents] = await Promise.all([
      readStore(logsFile, "auth_delivery_logs"),
      readStore(retryQueueFile, "auth_delivery_retry_queue"),
      readStore(webhookEventsFile, "auth_delivery_webhook_events")
    ]);
    const limit = boundedNumber(filters.limit, 100, 1, 500);
    const kind = shortText(filters.kind, 60);
    const deliveryState = shortText(filters.status, 40);
    const provider = shortText(filters.provider, 80);
    const items = logs.items
      .filter((item) => !kind || item.kind === kind)
      .filter((item) => !deliveryState || item.status === deliveryState)
      .filter((item) => !provider || item.provider === provider)
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
      .slice(0, limit);
    const pendingQueue = retryQueue.items.filter((item) => ["pending", "running"].includes(item.status));
    return {
      generatedAt: nowIso(),
      connector: status(),
      summary: {
        total: logs.items.length,
        succeeded: logs.items.filter((item) => item.status === "succeeded").length,
        delivered: logs.items.filter((item) => item.status === "delivered").length,
        bounced: logs.items.filter((item) => item.status === "bounced").length,
        complained: logs.items.filter((item) => item.status === "complained").length,
        retryRequired: logs.items.filter((item) => item.status === "retry_required").length,
        retryQueued: pendingQueue.length,
        retryFailed: retryQueue.items.filter((item) => ["failed", "review_required"].includes(item.status)).length,
        reviewRequired: logs.items.filter((item) => item.status === "review_required").length,
        failed: logs.items.filter((item) => item.status === "failed").length,
        providerIdsRecorded: logs.items.filter((item) => item.providerDeliveryId).length,
        webhookEvents: webhookEvents.items.length,
        unmatchedWebhookEvents: webhookEvents.items.filter((item) => !item.matched).length
      },
      diagnostics: {
        operationalReady: status().operationalReady,
        queueFileReady: Boolean(encryptionKey()),
        webhookVerificationReady: webhookSecret.length >= 16,
        pendingRetryCount: pendingQueue.length,
        nextRetryAt: pendingQueue.map((item) => item.nextAttemptAt).filter(Boolean).sort()[0] || "",
        latestWebhookAt: webhookEvents.items.map((item) => item.receivedAt).filter(Boolean).sort().at(-1) || ""
      },
      items,
      retryQueue: retryQueue.items
        .map(publicQueueItem)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, limit),
      webhookEvents: webhookEvents.items
        .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
        .slice(0, limit)
    };
  }

  return { deliver, getDelivery, keyRotationStatus, listReport, processWebhook, reencryptRetryQueue, runRetries, securitySmokeStatus, status };
}

module.exports = { createAuthDeliveryService, deliveryStatus, normalizeWebhookState };
