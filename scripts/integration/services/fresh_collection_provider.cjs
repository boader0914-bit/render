"use strict";

const crypto = require("node:crypto");

const SYNTHETIC_PROVIDER_ID = "stage228-synthetic-fresh-collection";
const SYNTHETIC_SOURCE_HOST = "collector.example.invalid";

class SyntheticProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SyntheticProviderError";
    this.code = options.code || "SYNTHETIC_PROVIDER_ERROR";
    this.retryable = Boolean(options.retryable);
    this.retryAfterMs = Number(options.retryAfterMs || 0) || 0;
    this.statusCode = Number(options.statusCode || (this.retryable ? 503 : 422));
  }
}

function cleanText(value, maximum = 240) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function stableHex(value, length = 16) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

function stableNumber(value, minimum, maximum) {
  const span = maximum - minimum + 1;
  const integer = Number.parseInt(stableHex(value, 8), 16);
  return minimum + (integer % span);
}

function sourceUrl(stage, identity) {
  const safeStage = cleanText(stage, 40).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const safeIdentity = cleanText(identity, 80).replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  return `https://${SYNTHETIC_SOURCE_HOST}/${safeStage}/${safeIdentity}`;
}

function assertSyntheticSource(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".example.invalid")) {
    throw new Error("Stage 228 synthetic sources must use an HTTPS example.invalid URL");
  }
  return parsed.toString();
}

function normalizeFailure(value, stage) {
  if (value instanceof Error) return value;
  if (typeof value === "function") return value(stage);
  const options = value && typeof value === "object" ? value : {};
  return new SyntheticProviderError(
    cleanText(options.message || `Synthetic ${stage} failure`, 240),
    options
  );
}

function createSyntheticFreshCollectionProvider(options = {}) {
  const clock = options.clock || (() => Date.now());
  const failurePlan = new Map();
  for (const [stage, entries] of Object.entries(options.failurePlan || {})) {
    failurePlan.set(stage, Array.isArray(entries) ? [...entries] : [entries]);
  }
  const stats = {
    syntheticCalls: 0,
    externalNetworkCalls: 0,
    callsByStage: {}
  };

  function invoke(stage) {
    stats.syntheticCalls += 1;
    stats.callsByStage[stage] = (stats.callsByStage[stage] || 0) + 1;
    const planned = failurePlan.get(stage);
    if (planned?.length) {
      const failure = normalizeFailure(planned.shift(), stage);
      if (failure) throw failure;
    }
  }

  function base(input = {}) {
    const targetName = cleanText(input.targetName || input.keyword || input.companyName, 180);
    const regionLabel = cleanText(input.regionLabel || input.regionCode || "경남", 120);
    const targetDate = cleanText(input.targetDate, 16) || new Date(clock()).toISOString().slice(0, 10);
    if (!targetName) throw new SyntheticProviderError("targetName is required", {
      code: "SYNTHETIC_TARGET_NAME_REQUIRED",
      statusCode: 400
    });
    const identity = stableHex(`${regionLabel}|${targetName}`, 12);
    return { targetName, regionLabel, targetDate, identity };
  }

  async function discover(input = {}) {
    invoke("discovery");
    const value = base(input);
    const placeId = `syn${stableNumber(value.identity, 1000000, 9999999)}`;
    return {
      provider: SYNTHETIC_PROVIDER_ID,
      synthetic: true,
      dataMode: "synthetic-test",
      source: assertSyntheticSource(sourceUrl("discovery", value.identity)),
      collectedAt: new Date(clock()).toISOString(),
      candidate: {
        companyName: value.targetName,
        regionLabel: value.regionLabel,
        address: `${value.regionLabel} 합성수집로 ${stableNumber(value.identity, 1, 99)}`,
        placeId,
        bookingBusinessId: `syn-booking-${value.identity}`,
        externalIdentities: [
          { source: SYNTHETIC_PROVIDER_ID, externalId: placeId }
        ],
        duplicateCandidates: []
      }
    };
  }

  async function collectQuick(input = {}) {
    invoke("quick");
    const value = base(input);
    const companyIdentity = cleanText(input.companyId || value.identity, 160);
    return {
      provider: SYNTHETIC_PROVIDER_ID,
      synthetic: true,
      dataMode: "synthetic-test",
      source: assertSyntheticSource(sourceUrl("quick", companyIdentity)),
      collectedAt: new Date(clock()).toISOString(),
      profile: {
        companyName: value.targetName,
        regionLabel: value.regionLabel,
        category: "glamping",
        rank: stableNumber(`${value.identity}|rank`, 1, 20),
        reviewCount: stableNumber(`${value.identity}|reviews`, 20, 600),
        latitude: 35 + stableNumber(`${value.identity}|lat`, 1000, 9999) / 10000,
        longitude: 127 + stableNumber(`${value.identity}|lng`, 1000, 9999) / 10000
      }
    };
  }

  async function collectDetail(input = {}) {
    invoke("detail");
    const value = base(input);
    const companyIdentity = cleanText(input.companyId || value.identity, 160);
    const basePrice = stableNumber(`${value.identity}|price`, 90, 180) * 1000;
    return {
      provider: SYNTHETIC_PROVIDER_ID,
      synthetic: true,
      dataMode: "synthetic-test",
      source: assertSyntheticSource(sourceUrl("detail", companyIdentity)),
      collectedAt: new Date(clock()).toISOString(),
      products: [
        {
          productKey: "lodging-standard",
          targetDate: value.targetDate,
          price: basePrice,
          totalStock: 8,
          availableStock: stableNumber(`${value.identity}|standard-stock`, 1, 7)
        },
        {
          productKey: "lodging-premium",
          targetDate: value.targetDate,
          price: basePrice + 50000,
          totalStock: 4,
          availableStock: stableNumber(`${value.identity}|premium-stock`, 0, 3)
        }
      ]
    };
  }

  async function collectOta(input = {}) {
    invoke("ota");
    const value = base(input);
    const companyIdentity = cleanText(input.companyId || value.identity, 160);
    return {
      provider: SYNTHETIC_PROVIDER_ID,
      synthetic: true,
      dataMode: "synthetic-test",
      source: assertSyntheticSource(sourceUrl("ota", companyIdentity)),
      collectedAt: new Date(clock()).toISOString(),
      channels: [
        { channel: "naver", productKey: "lodging-standard", targetDate: value.targetDate, exposed: true },
        { channel: "yanolja", productKey: "lodging-standard", targetDate: value.targetDate, exposed: true },
        { channel: "yeogi", productKey: "lodging-premium", targetDate: value.targetDate, exposed: false }
      ]
    };
  }

  return Object.freeze({
    id: SYNTHETIC_PROVIDER_ID,
    kind: "synthetic",
    enabled: true,
    synthetic: true,
    dataMode: "synthetic-test",
    seedSourceUrl: "https://collector.example.invalid/stage228",
    discover,
    collectQuick,
    collectDetail,
    collectOta,
    diagnostics() {
      return JSON.parse(JSON.stringify(stats));
    }
  });
}

function createDisabledFreshCollectionProvider(options = {}) {
  const reason = cleanText(options.reason || "실제 V2 수집 provider가 구성되지 않았습니다.", 240);
  const stats = {
    externalNetworkCalls: 0,
    externalRequests: 0,
    credentialReads: 0,
    callsByStage: {},
    disabled: true,
    reason
  };
  function unavailable(stage) {
    stats.callsByStage[stage] = (stats.callsByStage[stage] || 0) + 1;
    throw new SyntheticProviderError(reason, {
      code: "FRESH_PROVIDER_NOT_CONFIGURED",
      retryable: false,
      statusCode: 503
    });
  }
  return Object.freeze({
    id: "fresh-provider-disabled",
    kind: "disabled",
    enabled: false,
    synthetic: false,
    dataMode: "live",
    seedSourceUrl: "",
    discover: () => unavailable("discovery"),
    collectQuick: () => unavailable("quick"),
    collectDetail: () => unavailable("detail"),
    collectOta: () => unavailable("ota"),
    diagnostics: () => JSON.parse(JSON.stringify(stats))
  });
}

module.exports = {
  SYNTHETIC_PROVIDER_ID,
  SYNTHETIC_SOURCE_HOST,
  SyntheticProviderError,
  assertSyntheticSource,
  createDisabledFreshCollectionProvider,
  createSyntheticFreshCollectionProvider,
  sourceUrl,
  stableHex
};
