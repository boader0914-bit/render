"use strict";

const crypto = require("node:crypto");

const FRESH_DATA_STAGE = 228;
const FRESH_DATA_SCHEMA_VERSION = 1;
const FRESH_DATA_STORE_KIND = "glamping-datalab-v2-fresh-integration-store";
const FRESH_DATA_IDENTITY_RULE = "v2-company-identity-v1";
const FRESH_KOREA_COORDINATE_BOUNDS = Object.freeze({ west: 124, south: 33, east: 132, north: 39.5 });
const FRESH_DATA_LAYERS = Object.freeze([
  "raw",
  "observation",
  "verified",
  "derived",
  "business-safe"
]);
const FRESH_OBSERVATION_MODES = Object.freeze(["quick", "detail", "ota"]);
const FRESH_DATA_MODES = Object.freeze(["synthetic-test", "live"]);
const FRESH_LIVE_SOURCE_HOSTS = Object.freeze([
  "naverapihub.apigw.ntruss.com",
  "pcmap.place.naver.com",
  "m.place.naver.com",
  "pcmap-api.place.naver.com",
  "m.booking.naver.com",
  "nol.yanolja.com",
  "www.goodchoice.kr",
  "trip.ddnayo.com"
]);
const FRESH_RUN_STATUSES = Object.freeze([
  "queued",
  "running",
  "retry-wait",
  "cancel-requested",
  "cancelled",
  "completed",
  "failed"
]);

function freshError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function cleanText(value, maximum = 240) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function cleanId(value, label = "id", maximum = 160) {
  const id = cleanText(value, maximum);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/.test(id)) {
    throw freshError(`${label} must be a URL-safe identifier`, "FRESH_ID_INVALID");
  }
  return id;
}

function requiredIso(value, label) {
  const text = cleanText(value, 40);
  const timestamp = Date.parse(text);
  if (!text || !Number.isFinite(timestamp)) {
    throw freshError(`${label} must be an ISO timestamp`, "FRESH_TIMESTAMP_INVALID");
  }
  return new Date(timestamp).toISOString();
}

function optionalIso(value, label) {
  return cleanText(value, 40) ? requiredIso(value, label) : "";
}

function requiredDate(value, label) {
  const text = cleanText(value, 16);
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  const canonical = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || canonical !== text) {
    throw freshError(`${label} must be YYYY-MM-DD`, "FRESH_DATE_INVALID");
  }
  return text;
}

function stableHash(value, length = 16, algorithm = "sha1") {
  return crypto.createHash(algorithm).update(String(value ?? "")).digest("hex").slice(0, length);
}

// These normalizers and the fallback ordering intentionally mirror the V2
// company-master identity contract. Existing V2 files are never consulted.
function normalizeCompanyIdentityName(value) {
  return cleanText(value, 240)
    .replace(/㈜|\((?:주|유)\)|주식회사|유한회사|농업회사법인|영농조합법인|사단법인/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function normalizeCompanyLooseName(value) {
  return normalizeCompanyIdentityName(value)
    .replace(/글램핑앤카라반|오토캠핑장|카라반캠핑장|글램핑장|오토캠핑|글램핑|카라반|캠핑장|야영장|펜션|리조트|호텔|모텔|스테이|빌리지|지점|본점/gu, "");
}

function normalizeAddressKey(value) {
  return cleanText(value, 320)
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function cleanStrongId(value, label) {
  const text = cleanText(value, 160);
  if (!text) return "";
  if (!/^[\p{L}\p{N}._:-]+$/u.test(text)) {
    throw freshError(`${label} contains unsupported characters`, "FRESH_SOURCE_ID_INVALID");
  }
  return text;
}

function sourceIdentityKeys(identity = {}) {
  const keys = [];
  if (identity.placeId) keys.push(`place:${identity.placeId}`);
  if (identity.bookingBusinessId) keys.push(`booking:${identity.bookingBusinessId}`);
  if (identity.nameKey && identity.addressKey) keys.push(`name_addr:${identity.nameKey}:${identity.addressKey}`);
  if (identity.nameKey && identity.regionKey) keys.push(`name_region:${identity.nameKey}:${identity.regionKey}`);
  return [...new Set(keys)].slice(0, 10);
}

function normalizeCompanyIdentity(payload = {}) {
  const name = cleanText(payload.name || payload.companyName, 180);
  const address = cleanText(payload.address, 320);
  const region = cleanText(payload.region || payload.regionLabel || payload.regionCode, 160);
  const identity = {
    name,
    address,
    region,
    nameKey: normalizeCompanyIdentityName(name),
    looseNameKey: normalizeCompanyLooseName(name),
    addressKey: normalizeAddressKey(address),
    regionKey: normalizeCompanyIdentityName(region),
    placeId: cleanStrongId(payload.placeId, "placeId"),
    bookingBusinessId: cleanStrongId(payload.bookingBusinessId, "bookingBusinessId")
  };
  identity.sourceKeys = sourceIdentityKeys(identity);
  if (!identity.nameKey || !identity.sourceKeys.length) {
    throw freshError(
      "Company discovery requires a name and at least one V2 identity key",
      "FRESH_COMPANY_IDENTITY_INSUFFICIENT"
    );
  }
  return identity;
}

function deterministicCompanyId(payload = {}) {
  const identity = payload.nameKey ? payload : normalizeCompanyIdentity(payload);
  if (identity.placeId) return `cmp_place_${identity.placeId}`;
  const basis = [
    identity.nameKey,
    identity.addressKey,
    identity.regionKey,
    identity.bookingBusinessId
  ].filter(Boolean).join("|");
  if (!basis) throw freshError("Company identity basis is empty", "FRESH_COMPANY_IDENTITY_INSUFFICIENT");
  return `cmp_${stableHash(basis, 16, "sha1")}`;
}

function duplicateCandidateKey(payload = {}) {
  const identity = payload.looseNameKey ? payload : normalizeCompanyIdentity(payload);
  return identity.looseNameKey && identity.regionKey
    ? `${identity.looseNameKey}:${identity.regionKey}`
    : "";
}

function assertExampleInvalidUrl(value, label = "sourceUrl") {
  const text = cleanText(value, 2048);
  if (!text) throw freshError(`${label} is required`, "FRESH_SOURCE_URL_REQUIRED");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw freshError(`${label} must be an absolute URL`, "FRESH_SOURCE_URL_INVALID");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (hostname !== "example.invalid" && !hostname.endsWith(".example.invalid"))) {
    throw freshError(
      `${label} must use the approved synthetic HTTPS example.invalid namespace`,
      "FRESH_EXTERNAL_PROVIDER_FORBIDDEN"
    );
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizeFreshDataMode(record = {}) {
  const synthetic = record.synthetic === true;
  const mode = cleanText(record.dataMode || record.provenance?.dataMode, 32).toLowerCase()
    || (synthetic ? "synthetic-test" : "");
  if (synthetic && mode !== "synthetic-test") {
    throw freshError("Synthetic records must use dataMode=synthetic-test", "FRESH_DATA_MODE_INVALID");
  }
  if (!synthetic && (record.synthetic !== false || mode !== "live")) {
    throw freshError(
      "Live records must explicitly use synthetic=false and dataMode=live",
      "FRESH_DATA_MODE_REQUIRED"
    );
  }
  return Object.freeze({ dataMode: mode, synthetic });
}

function assertPublicHttpsUrl(value, label = "sourceUrl", options = {}) {
  const text = cleanText(value, 2048);
  if (!text) throw freshError(`${label} is required`, "FRESH_SOURCE_URL_REQUIRED");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw freshError(`${label} must be an absolute URL`, "FRESH_SOURCE_URL_INVALID");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw freshError(`${label} must be credential-free HTTPS`, "FRESH_SOURCE_URL_INVALID");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "0.0.0.0"
    || hostname === "::1"
    || /^127\./.test(hostname)
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^169\.254\./.test(hostname)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
  ) {
    throw freshError(`${label} must not target a local or private host`, "FRESH_SOURCE_HOST_FORBIDDEN");
  }
  const allowedHosts = Array.isArray(options.allowedHosts) ? options.allowedHosts : [];
  if (allowedHosts.length && !allowedHosts.some((allowed) => (
    hostname === allowed || hostname.endsWith(`.${allowed}`)
  ))) {
    throw freshError(`${label} host is not approved for fresh collection`, "FRESH_SOURCE_HOST_FORBIDDEN");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

function assertFreshSourceUrl(value, record = {}, label = "sourceUrl") {
  const mode = normalizeFreshDataMode(record);
  if (mode.synthetic) return assertExampleInvalidUrl(value, label);
  return assertPublicHttpsUrl(value, label, { allowedHosts: FRESH_LIVE_SOURCE_HOSTS });
}

function assertFreshPayload(value, keyPath = "payload", mode = { synthetic: true, dataMode: "synthetic-test" }) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFreshPayload(item, `${keyPath}[${index}]`, mode));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertFreshPayload(item, `${keyPath}.${key}`, mode);
    }
    return;
  }
  if (typeof value !== "string") return;
  const text = value.trim();
  if (
    /^(?:[A-Za-z]:[\\/]|\/var\/|\/tmp\/|\/home\/|\\\\)/.test(text)
    || /(?:^|[\\/])(?:outputs?|data|db|config|customer_db|web)[\\/]/i.test(text)
  ) {
    throw freshError(`Fresh value contains a filesystem path at ${keyPath}`, "FRESH_RAW_PATH_FORBIDDEN");
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    if (mode.synthetic) assertExampleInvalidUrl(match[0], keyPath);
    else assertPublicHttpsUrl(match[0], keyPath, { allowedHosts: FRESH_LIVE_SOURCE_HOSTS });
  }
}

function assertSyntheticPayload(value, keyPath = "payload") {
  return assertFreshPayload(value, keyPath, { synthetic: true, dataMode: "synthetic-test" });
}

function normalizeRawEvidence(record = {}, context = {}) {
  const recordMode = normalizeFreshDataMode(record);
  const runId = cleanId(record.runId || context.runId, "runId");
  const source = cleanText(record.source, 80);
  if (!source) throw freshError("Raw evidence source is required", "FRESH_PROVENANCE_REQUIRED");
  const capturedAt = requiredIso(record.capturedAt || record.observedAt, "capturedAt");
  const sourceUrl = assertFreshSourceUrl(record.sourceUrl, record);
  const payload = clone(record.payload ?? {});
  assertFreshPayload(payload, "payload", recordMode);
  assertFreshPayload(record.provenance || {}, "raw.provenance", recordMode);
  const companyId = cleanText(record.companyId, 160)
    ? cleanId(record.companyId, "companyId")
    : "";
  const externalId = cleanText(record.externalId, 240);
  const collectionEvidenceKey = cleanText(record.evidenceKey, 160);
  const evidenceKey = cleanText(record.idempotencyKey, 240) || collectionEvidenceKey || [
    runId,
    source,
    companyId,
    externalId,
    sourceUrl,
    capturedAt,
    stableHash(JSON.stringify(payload), 24, "sha256")
  ].join("|");
  const evidenceId = cleanText(record.evidenceId || record.rawEvidenceId, 160)
    ? cleanId(record.evidenceId || record.rawEvidenceId, "evidenceId")
    : `raw_${stableHash(evidenceKey, 24, "sha256")}`;
  return {
    schemaVersion: FRESH_DATA_SCHEMA_VERSION,
    evidenceId,
    rawEvidenceId: evidenceId,
    synthetic: recordMode.synthetic,
    dataMode: recordMode.dataMode,
    source,
    runId,
    companyId,
    capturedAt,
    observedAt: capturedAt,
    stage: cleanText(record.stage, 40),
    evidenceKey: collectionEvidenceKey,
    sourceUrl,
    externalId,
    contentHash: cleanText(record.contentHash, 128) || stableHash(JSON.stringify(payload), 64, "sha256"),
    mediaType: cleanText(record.mediaType || "application/json", 120),
    payload,
    provenance: {
      ...clone(record.provenance || {}),
      source,
      runId,
      capturedAt,
      observedAt: capturedAt,
      sourceUrl,
      evidenceKey: collectionEvidenceKey,
      synthetic: recordMode.synthetic,
      dataMode: recordMode.dataMode
    }
  };
}

function normalizeObservation(record = {}, context = {}) {
  const recordMode = normalizeFreshDataMode(record);
  const kind = cleanText(record.observationType || record.kind, 80);
  const inferredMode = kind.startsWith("profile.") ? "quick" : kind.startsWith("ota.") ? "ota" : "detail";
  const mode = cleanText(record.mode || record.collectionMode || inferredMode, 32).toLowerCase();
  if (!FRESH_OBSERVATION_MODES.includes(mode)) {
    throw freshError("Observation mode must be quick, detail, or ota", "FRESH_OBSERVATION_MODE_INVALID");
  }
  const runId = cleanId(record.runId || context.runId, "runId");
  const companyId = cleanId(record.companyId, "companyId");
  const source = cleanText(record.source, 80);
  const observedAt = requiredIso(record.observedAt, "observedAt");
  const targetDate = requiredDate(record.targetDate, "targetDate");
  const channel = cleanText(record.channel, 80);
  const productKey = cleanText(record.productKey, 160);
  if (!source || !channel || !productKey) {
    throw freshError(
      "Observation source, channel, and productKey are required",
      "FRESH_PROVENANCE_REQUIRED"
    );
  }
  const sourceUrl = assertFreshSourceUrl(record.sourceUrl, record);
  const values = clone(record.values ?? record.value ?? {});
  assertFreshPayload(values, "observation.values", recordMode);
  assertFreshPayload(record.provenance || {}, "observation.provenance", recordMode);
  const key = cleanText(record.idempotencyKey, 240) || [
    runId,
    companyId,
    source,
    mode,
    observedAt,
    targetDate,
    channel,
    productKey
  ].join("|");
  const observationId = cleanText(record.observationId, 160)
    ? cleanId(record.observationId, "observationId")
    : `obs_${stableHash(key, 24, "sha256")}`;
  const evidenceId = cleanText(record.evidenceId || record.rawEvidenceId, 160)
    ? cleanId(record.evidenceId || record.rawEvidenceId, "evidenceId")
    : "";
  return {
    schemaVersion: FRESH_DATA_SCHEMA_VERSION,
    observationId,
    synthetic: recordMode.synthetic,
    dataMode: recordMode.dataMode,
    mode,
    observationType: kind || `${mode}-availability`,
    kind: kind || `${mode}-availability`,
    source,
    runId,
    companyId,
    observedAt,
    targetDate,
    channel,
    productKey,
    sourceUrl,
    requestKey: cleanText(record.requestKey || record.provenance?.requestKey, 160),
    conditionHash: cleanText(record.conditionHash || record.provenance?.conditionHash, 128),
    evidenceId,
    rawEvidenceId: evidenceId,
    unit: cleanText(record.unit, 40),
    values,
    value: clone(values),
    provenance: {
      ...clone(record.provenance || {}),
      source,
      runId,
      observedAt,
      targetDate,
      channel,
      productKey,
      sourceUrl,
      requestKey: cleanText(record.requestKey || record.provenance?.requestKey, 160),
      conditionHash: cleanText(record.conditionHash || record.provenance?.conditionHash, 128),
      synthetic: recordMode.synthetic,
      dataMode: recordMode.dataMode
    }
  };
}

function normalizeVerifiedProfile(profile = {}) {
  const allowed = {
    primaryName: cleanText(profile.primaryName || profile.name, 180),
    region: cleanText(profile.region, 160),
    address: cleanText(profile.address, 320),
    phone: cleanText(profile.phone, 80),
    website: cleanText(profile.website, 2048),
    notes: cleanText(profile.notes, 1000)
  };
  if (allowed.website) allowed.website = assertPublicHttpsUrl(allowed.website, "verifiedProfile.website");
  const latitudeProvided = profile.latitude !== undefined && profile.latitude !== null && profile.latitude !== "";
  const longitudeProvided = profile.longitude !== undefined && profile.longitude !== null && profile.longitude !== "";
  if (latitudeProvided || longitudeProvided) {
    throw freshError("Coordinates require the field-scoped coordinate review contract", "FRESH_COORDINATE_REVIEW_REQUIRED");
  }
  return allowed;
}

function normalizeVerifiedCoordinates(value = {}) {
  const latitudeProvided = value.latitude !== undefined && value.latitude !== null && value.latitude !== "";
  const longitudeProvided = value.longitude !== undefined && value.longitude !== null && value.longitude !== "";
  if (!latitudeProvided || !longitudeProvided) {
    throw freshError("Coordinate review requires both latitude and longitude", "FRESH_VERIFIED_COORDINATE_PAIR_REQUIRED");
  }
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw freshError("Verified coordinates are outside the valid WGS84 range", "FRESH_VERIFIED_COORDINATE_INVALID");
  }
  if (latitude < FRESH_KOREA_COORDINATE_BOUNDS.south || latitude > FRESH_KOREA_COORDINATE_BOUNDS.north
    || longitude < FRESH_KOREA_COORDINATE_BOUNDS.west || longitude > FRESH_KOREA_COORDINATE_BOUNDS.east) {
    throw freshError("Verified coordinates are outside the supported Korea boundary", "FRESH_COORDINATE_REVIEW_OUT_OF_RANGE");
  }
  return {
    latitude: Math.round(latitude * 1_000_000) / 1_000_000,
    longitude: Math.round(longitude * 1_000_000) / 1_000_000
  };
}

function latestTimestamp(rows = []) {
  return rows.map((row) => row.observedAt || row.capturedAt || "").filter(Boolean).sort().at(-1) || "";
}

function deriveCompanyQuality(company = {}, observations = [], verified = null, now = Date.now()) {
  function usableValue(row = {}) {
    const value = row.values ?? row.value;
    if (value === null || value === undefined || value === "") return false;
    if ((row.observationType || row.kind) === "profile.location") {
      const latitude = value?.latitude ?? value?.lat;
      const longitude = value?.longitude ?? value?.lng ?? value?.lon;
      return Boolean(
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && latitude !== null && latitude !== undefined && latitude !== ""
        && longitude !== null && longitude !== undefined && longitude !== ""
        && Number.isFinite(Number(latitude))
        && Number.isFinite(Number(longitude))
      );
    }
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") return Boolean(cleanText(value, 1));
    if (typeof value === "boolean") return true;
    return Boolean(value && typeof value === "object" && Object.keys(value).length);
  }
  const usable = observations.filter(usableValue);
  const kinds = new Set(usable.map((row) => row.observationType || row.kind));
  const completeProducts = new Map();
  for (const row of usable.filter((item) => String(item.observationType || item.kind).startsWith("product."))) {
    const key = `${row.companyId}|${row.targetDate}|${row.channel}|${row.productKey}`;
    const fields = completeProducts.get(key) || new Set();
    fields.add(row.observationType || row.kind);
    completeProducts.set(key, fields);
  }
  const modes = [];
  if (["profile.company-name", "profile.region", "profile.category", "profile.location"].every((kind) => kinds.has(kind))) {
    modes.push("quick");
  }
  if ([...completeProducts.values()].some((fields) => (
    ["product.price", "product.total-stock", "product.available-stock"].every((kind) => fields.has(kind))
  ))) {
    modes.push("detail");
  }
  if (kinds.has("ota.exposure")) modes.push("ota");
  const latestObservedAt = latestTimestamp(observations);
  const ageHours = latestObservedAt
    ? Math.max(0, (Number(now) - Date.parse(latestObservedAt)) / 3_600_000)
    : null;
  const completeness = Math.round((modes.length / FRESH_OBSERVATION_MODES.length) * 100);
  let freshness = "missing";
  if (ageHours !== null && ageHours <= 24) freshness = "fresh";
  else if (ageHours !== null && ageHours <= 168) freshness = "current";
  else if (ageHours !== null) freshness = "stale";
  const approved = verified?.status === "approved" && ["primaryName", "region", "address", "phone", "website"]
    .some((field) => Boolean(cleanText(verified?.profile?.[field], 1)));
  const confidenceScore = Math.min(100, Math.round(completeness * 0.8 + (approved ? 20 : 0)));
  const confidence = confidenceScore >= 85
    ? "high"
    : confidenceScore >= 55
      ? "medium"
      : confidenceScore > 0
        ? "low"
        : "insufficient";
  const missingModes = FRESH_OBSERVATION_MODES.filter((mode) => !modes.includes(mode));
  const nextAction = missingModes.length
    ? `collect-${missingModes[0]}`
    : approved
      ? "none"
      : "request-verification";
  return {
    schemaVersion: FRESH_DATA_SCHEMA_VERSION,
    companyId: company.companyId || "",
    generatedAt: new Date(Number(now)).toISOString(),
    dataCompleteness: {
      score: completeness,
      collectedModes: modes,
      missingModes,
      requiredModes: [...FRESH_OBSERVATION_MODES]
    },
    freshness: {
      state: freshness,
      latestObservedAt,
      ageHours: ageHours === null ? null : Math.round(ageHours * 100) / 100
    },
    confidence: {
      level: confidence,
      score: confidenceScore,
      verified: approved
    },
    enrichmentCta: {
      required: nextAction !== "none",
      action: nextAction,
      label: nextAction === "none" ? "수집 완료" : "데이터 보강 필요"
    }
  };
}

function businessSafeProjection(company = {}, verified = null, derived = null, observations = [], options = {}) {
  const approved = verified?.status === "approved" ? verified : null;
  const approvedProfile = Boolean(approved && ["primaryName", "region", "address", "phone", "website"]
    .some((field) => Boolean(cleanText(approved.profile?.[field], 1))));
  const latest = observations.slice().sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)))[0] || null;
  const quality = clone(derived || deriveCompanyQuality(company, observations, verified));
  const profileFields = [
    ["primaryName", "업체명", approved?.profile?.primaryName || company.primaryName || ""],
    ["region", "지역", approved?.profile?.region || company.region || ""],
    ["address", "주소", approved?.profile?.address || company.address || ""],
    ["phone", "전화", approved?.profile?.phone || ""],
    ["website", "웹사이트", approved?.profile?.website || ""]
  ];
  const verifiedValues = profileFields.map(([field, label, value]) => ({
    field,
    label,
    value,
    verified: Boolean(approved && value),
    verifiedAt: approved?.reviewedAt || ""
  }));
  const verifiedFields = verifiedValues.filter((row) => row.verified).length;
  const missingFields = verifiedValues.filter((row) => !row.value).map((row) => row.label);
  const sourceCount = new Set(observations.map((row) => row.source).filter(Boolean)).size;
  const containsLiveObservations = observations.some((row) => row.synthetic === false && row.dataMode === "live");
  const repeatGroups = new Map();
  for (const row of observations) {
    const key = `${row.companyId}|${row.productKey}|${row.targetDate}`;
    repeatGroups.set(key, (repeatGroups.get(key) || 0) + 1);
  }
  const repeatCount = [...repeatGroups.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  const completenessState = quality.dataCompleteness.score >= 100 ? "complete" : quality.dataCompleteness.score > 0 ? "partial" : "empty";
  const coordinateReview = options.coordinateReview && typeof options.coordinateReview === "object" ? options.coordinateReview : null;
  const approvedCoordinate = coordinateReview?.approvedCoordinates || null;
  const verifiedLatitude = approvedCoordinate?.latitude;
  const verifiedLongitude = approvedCoordinate?.longitude;
  const verifiedCoordinates = verifiedLatitude !== null && verifiedLatitude !== undefined && verifiedLatitude !== ""
    && verifiedLongitude !== null && verifiedLongitude !== undefined && verifiedLongitude !== ""
    && Number.isFinite(Number(verifiedLatitude)) && Number.isFinite(Number(verifiedLongitude))
    ? {
      latitude: Number(verifiedLatitude),
      longitude: Number(verifiedLongitude),
      confidence: "verified",
      reviewedAt: coordinateReview?.approvedAt || coordinateReview?.reviewedAt || ""
    }
    : null;
  return {
    schemaVersion: FRESH_DATA_SCHEMA_VERSION,
    projection: "business-safe",
    state: quality.dataCompleteness.score >= 100 && approvedProfile ? "ready" : observations.length ? "partial" : "empty",
    companyId: company.companyId || "",
    synthetic: !containsLiveObservations,
    dataMode: containsLiveObservations ? "live" : "synthetic-test",
    name: approved?.profile?.primaryName || company.primaryName || "",
    region: approved?.profile?.region || company.region || "",
    address: approved?.profile?.address || company.address || "",
    coordinates: verifiedCoordinates,
    identity: {
      ruleVersion: company.identityRule || FRESH_DATA_IDENTITY_RULE,
      confidence: company.identityConfidence || "review"
    },
    collection: {
      observationCount: observations.length,
      modes: [...new Set(observations.map((row) => row.mode))],
      lastObservedAt: latest?.observedAt || "",
      latestTargetDate: latest?.targetDate || ""
    },
    verification: {
      status: verified?.status || "pending",
      reviewedAt: verified?.reviewedAt || ""
    },
    completeness: {
      state: completenessState,
      displayValue: `${quality.dataCompleteness.score}%`,
      detail: `${quality.dataCompleteness.collectedModes.length}/${quality.dataCompleteness.requiredModes.length}개 수집 모드 완료`,
      verifiedFields,
      totalFields: verifiedValues.length,
      missingFields
    },
    freshness: {
      state: quality.freshness.state,
      displayValue: quality.freshness.latestObservedAt ? quality.freshness.latestObservedAt.slice(0, 10) : "수집 전",
      detail: quality.freshness.ageHours === null ? "신규 관측이 없습니다." : `${quality.freshness.ageHours}시간 전 관측`,
      observedAt: quality.freshness.latestObservedAt,
      validUntil: quality.freshness.latestObservedAt
        ? new Date(Date.parse(quality.freshness.latestObservedAt) + 168 * 3_600_000).toISOString()
        : ""
    },
    confidence: {
      state: quality.confidence.level,
      displayValue: `${quality.confidence.score}%`,
      detail: quality.confidence.verified ? "수동 검수와 신규 관측을 반영했습니다." : "신규 관측 표본을 기준으로 산정했습니다.",
      basis: `quick/detail/OTA ${quality.dataCompleteness.collectedModes.length}개 모드`
    },
    provenance: {
      summary: observations.length
        ? (containsLiveObservations ? "V2 신규 실수집 provenance 100%" : "Stage 228 신규 합성 수집 provenance 100%")
        : "신규 수집 전",
      sourceCount,
      lastVerifiedAt: approved?.reviewedAt || ""
    },
    verifiedValues,
    changes: clone(Array.isArray(options.changes) ? options.changes : []),
    enrichment: {
      state: quality.enrichmentCta.required ? "required" : "complete",
      ctaLabel: quality.enrichmentCta.label,
      detail: quality.enrichmentCta.required ? "누락된 수집 모드 또는 검수값을 보강하세요." : "필수 신규 수집과 검수가 완료되었습니다.",
      missingFields: [...quality.dataCompleteness.missingModes, ...missingFields]
    },
    observations: {
      displayCount: `${observations.length}회`,
      repeatCount,
      firstObservedAt: observations.map((row) => row.observedAt).filter(Boolean).sort()[0] || "",
      lastObservedAt: latest?.observedAt || "",
      summary: `${observations.length}건 신규 관측 · 반복 관측 ${repeatCount}건`
    },
    dataQuality: quality,
    sourceBoundary: "fresh-integration-only"
  };
}

module.exports = {
  FRESH_DATA_MODES,
  FRESH_DATA_IDENTITY_RULE,
  FRESH_DATA_LAYERS,
  FRESH_DATA_SCHEMA_VERSION,
  FRESH_DATA_STAGE,
  FRESH_DATA_STORE_KIND,
  FRESH_KOREA_COORDINATE_BOUNDS,
  FRESH_OBSERVATION_MODES,
  FRESH_LIVE_SOURCE_HOSTS,
  FRESH_RUN_STATUSES,
  assertExampleInvalidUrl,
  assertFreshPayload,
  assertFreshSourceUrl,
  assertPublicHttpsUrl,
  assertSyntheticPayload,
  businessSafeProjection,
  cleanId,
  cleanText,
  clone,
  deriveCompanyQuality,
  deterministicCompanyId,
  duplicateCandidateKey,
  freshError,
  normalizeAddressKey,
  normalizeCompanyIdentity,
  normalizeCompanyIdentityName,
  normalizeCompanyLooseName,
  normalizeObservation,
  normalizeFreshDataMode,
  normalizeRawEvidence,
  normalizeVerifiedCoordinates,
  normalizeVerifiedProfile,
  sourceIdentityKeys,
  stableHash
};
