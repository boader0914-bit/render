"use strict";

const crypto = require("node:crypto");
const { normalizeQuery, parseRootKey } = require("./naver_place_apollo_parser.cjs");

const SCHEMA_VERSION = "v2-place-ad-response-diagnostics.v1";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dereference(state, value) {
  if (!isObject(value)) return null;
  if (typeof value.__ref !== "string") return value;
  return isObject(state[value.__ref]) ? state[value.__ref] : null;
}

function locatedValue(args, key) {
  if (Object.prototype.hasOwnProperty.call(args?.input || {}, key)) {
    return { location: `input.${key}`, value: args.input[key] };
  }
  if (Object.prototype.hasOwnProperty.call(args || {}, key)) {
    return { location: key, value: args[key] };
  }
  return { location: "missing", value: undefined };
}

function classifiedValue(value, expected) {
  if (value === undefined || value === null || value === "") return "missing";
  return String(value) === expected ? expected : "other";
}

function itemEvidence(state, entries) {
  const items = entries.map((entry) => dereference(state, entry)).filter(Boolean);
  return Object.freeze({
    resolvedItemCount: items.length,
    placeIdPresentCount: items.filter((item) => /^\d{1,30}$/u.test(String(item.id || item.placeId || ""))).length,
    namePresentCount: items.filter((item) => typeof item.name === "string" && item.name.trim()).length,
    adIdPresentCount: items.filter((item) => typeof item.adId === "string" && item.adId.trim()).length
  });
}

function itemsShape(state, root, containerName) {
  const container = containerName === "direct" ? root : dereference(state, root?.[containerName]);
  const entries = Array.isArray(container?.items) ? container.items : null;
  return Object.freeze({
    itemsArray: Boolean(entries),
    itemCount: entries ? entries.length : 0,
    ...(entries ? itemEvidence(state, entries) : {
      resolvedItemCount: 0,
      placeIdPresentCount: 0,
      namePresentCount: 0,
      adIdPresentCount: 0
    })
  });
}

function operationBucket(key) {
  const parsed = parseRootKey(key);
  if (!parsed) return "unparseable";
  if (["accommodationSearch", "placeList", "adBusinesses"].includes(parsed.operation)) return parsed.operation;
  return "other";
}

function candidateDiagnostic(state, key, rootValue, query) {
  const parsed = parseRootKey(key);
  if (!parsed || parsed.operation !== "adBusinesses") return null;
  const queryValue = locatedValue(parsed.args, "query");
  const businessType = locatedValue(parsed.args, "businessType");
  const channel = locatedValue(parsed.args, "channel");
  const root = dereference(state, rootValue);
  const direct = itemsShape(state, root, "direct");
  const business = itemsShape(state, root, "business");
  const businesses = itemsShape(state, root, "businesses");
  const normalizedTarget = normalizeQuery(query);
  const queryMatches = normalizeQuery(queryValue.value) === normalizedTarget;
  const businessTypeClass = classifiedValue(businessType.value, "accommodation");
  const channelClass = classifiedValue(channel.value, "openingPlace");
  const currentFilterMatched = (
    key.startsWith("adBusinesses(")
    && !key.includes('"channel":"openingPlace"')
    && queryMatches
    && businessType.value === "accommodation"
  );
  const total = Number(root?.total);
  return Object.freeze({
    keyDigest: sha256(Buffer.from(key, "utf8")),
    queryLocation: queryValue.location,
    queryMatches,
    businessTypeLocation: businessType.location,
    businessTypeClass,
    channelLocation: channel.location,
    channelClass,
    currentFilterMatched,
    rootResolved: Boolean(root),
    direct,
    business,
    businesses,
    totalKnown: Number.isFinite(total) && total >= 0,
    total: Number.isFinite(total) && total >= 0 ? total : null
  });
}

function diagnosticStatus(candidates) {
  if (candidates.length === 0) return "ad-operation-absent";
  const matched = candidates.filter((candidate) => candidate.currentFilterMatched);
  if (matched.length === 0) return "ad-candidates-filtered";
  if (matched.some((candidate) => candidate.direct.itemsArray && candidate.direct.itemCount > 0)) {
    return "current-filter-matched-with-items";
  }
  if (matched.some((candidate) => !candidate.direct.itemsArray && (
    candidate.business.itemCount > 0 || candidate.businesses.itemCount > 0
  ))) return "current-filter-matched-root-shape-mismatch";
  if (matched.some((candidate) => candidate.direct.itemsArray)) return "current-filter-matched-empty";
  return "current-filter-matched-root-unrecognized";
}

function buildAdResponseDiagnostics({ state, query, body }) {
  if (!isObject(state) || !isObject(state.ROOT_QUERY)) {
    throw new TypeError("Apollo state with ROOT_QUERY is required");
  }
  const rootEntries = Object.entries(state.ROOT_QUERY);
  const operationCounts = {
    accommodationSearch: 0,
    placeList: 0,
    adBusinesses: 0,
    other: 0,
    unparseable: 0
  };
  for (const [key] of rootEntries) operationCounts[operationBucket(key)] += 1;
  const candidates = rootEntries
    .map(([key, value]) => candidateDiagnostic(state, key, value, query))
    .filter(Boolean);
  const matched = candidates.filter((candidate) => candidate.currentFilterMatched);
  const bodyBytes = Buffer.from(String(body || ""), "utf8");
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    status: diagnosticStatus(candidates),
    response: {
      bodyBytes: bodyBytes.length,
      bodySha256: sha256(bodyBytes),
      rawProviderResponseStored: false,
      providerHeadersStored: false,
      cookieValuesStored: false
    },
    apollo: {
      entityCount: Object.keys(state).length,
      rootQueryKeyCount: rootEntries.length,
      operationCounts
    },
    advertisement: {
      candidateCount: candidates.length,
      matchedCandidateCount: matched.length,
      queryMatchedCandidateCount: candidates.filter((candidate) => candidate.queryMatches).length,
      accommodationCandidateCount: candidates.filter((candidate) => candidate.businessTypeClass === "accommodation").length,
      openingPlaceCandidateCount: candidates.filter((candidate) => candidate.channelClass === "openingPlace").length,
      matchedDirectItemCount: matched.reduce((sum, candidate) => sum + candidate.direct.itemCount, 0),
      candidates
    }
  });
}

module.exports = {
  SCHEMA_VERSION,
  buildAdResponseDiagnostics,
  diagnosticStatus,
  sha256
};
