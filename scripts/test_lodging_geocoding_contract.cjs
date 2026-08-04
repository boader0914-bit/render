"use strict";

const assert = require("node:assert/strict");

let networkCalls = 0;
global.fetch = async (url) => {
  networkCalls += 1;
  throw new Error(`Network forbidden in lodging geocoding contract tests: ${url}`);
};

const {
  coordinatePair,
  createFixtureGeocoder,
  effectiveCompanyLocation,
  geocodeAddress,
  locationCandidateFromObservation,
  mergeCompanyLocation,
  mergeCompanyLocationProfiles,
  normalizeAddress,
  normalizeLocationContract,
  publicCompanyLocationSummary
} = require("./lodging_geocoding_contract.cjs");

async function main() {
  const fullAddress = "경상남도 합천군 가야면 가야산로 1";
  const normalized = normalizeAddress(`  ${fullAddress}\n`);
  assert.equal(normalized.normalizedAddress, fullAddress);
  assert.equal(normalized.specificity, "address");
  assert.equal(normalized.fingerprint, normalizeAddress(fullAddress).fingerprint, "address fingerprints must be deterministic");
  assert.equal(normalizeAddress("경남 합천군").specificity, "locality", "region-only queries must not become exact company points");
  assert.equal(normalizeAddress("").specificity, "missing");

  assert.deepEqual(coordinatePair(35.566, 128.165), { latitude: 35.566, longitude: 128.165 });
  assert.equal(coordinatePair("35.566", 128.165), null, "numeric strings must not silently become coordinates");
  assert.equal(coordinatePair(95, 128.165), null);
  assert.equal(coordinatePair(40.1, 127.1), null, "coordinates outside the Korean service boundary must fail in the shared contract");
  assert.equal(coordinatePair(0, 0), null);

  const normalizedLocation = normalizeLocationContract({
    latitude: 35.566,
    longitude: 128.165,
    status: "resolved",
    source: "provider",
    providerKey: "fixture",
    confidence: 4,
    precision: "rooftop",
    resolvedAddress: fullAddress,
    privateProviderPayload: { mustNotSurvive: true }
  }, { address: fullAddress });
  assert.equal(normalizedLocation.crs, "EPSG:4326");
  assert.equal(normalizedLocation.confidence, 1);
  assert.equal(normalizedLocation.providerKey, "fixture");
  assert.equal("privateProviderPayload" in normalizedLocation, false, "provider payloads must not enter the normalized contract");
  assert.equal(normalizeLocationContract({ latitude: 35.566, longitude: 128.165, status: "verified", source: "provider" }).status, "resolved", "providers cannot self-assert the administrator-verified state");
  assert.equal(normalizeLocationContract({ latitude: 999, longitude: 128, status: "resolved", source: "provider" }).status, "invalid");

  const manualCompany = {
    addresses: [fullAddress],
    location: {
      latitude: 35.5,
      longitude: 128.1,
      status: "resolved",
      source: "provider",
      resolvedAddress: fullAddress
    },
    manualCorrection: {
      location: {
        latitude: 35.61,
        longitude: 128.21,
        precision: "rooftop",
        resolvedAddress: fullAddress
      }
    }
  };
  const manual = effectiveCompanyLocation(manualCompany);
  assert.equal(manual.source, "manual");
  assert.equal(manual.status, "verified");
  assert.equal(manual.latitude, 35.61);
  assert.equal(publicCompanyLocationSummary(manualCompany).lat, 35.61);

  const disabledManual = effectiveCompanyLocation({
    ...manualCompany,
    manualCorrection: { ...manualCompany.manualCorrection, active: false }
  });
  assert.equal(disabledManual.source, "provider", "an explicitly disabled manual location must not revive");
  assert.equal(disabledManual.latitude, 35.5);

  const invalidManual = effectiveCompanyLocation({
    ...manualCompany,
    manualCorrection: {
      active: true,
      location: { latitude: 95, longitude: 128.21, resolvedAddress: fullAddress }
    }
  });
  assert.equal(invalidManual.source, "manual");
  assert.equal(invalidManual.status, "invalid", "an invalid explicit manual point must fail closed instead of falling through to provider data");
  assert.equal(invalidManual.latitude, null);

  const changedAddress = "경상남도 합천군 대병면 합천호수로 100";
  const staleExplicit = effectiveCompanyLocation({
    addresses: [changedAddress],
    location: {
      latitude: 35.56,
      longitude: 128.16,
      status: "resolved",
      source: "provider",
      addressFingerprint: normalizeAddress(fullAddress).fingerprint,
      resolvedAddress: fullAddress
    }
  });
  assert.equal(staleExplicit.status, "ambiguous", "an address change must invalidate an automatic point");
  assert.equal(staleExplicit.latitude, null);

  const latestAddressWins = effectiveCompanyLocation({
    addresses: [fullAddress, changedAddress],
    location: {
      latitude: 35.56,
      longitude: 128.16,
      status: "resolved",
      source: "provider",
      addressFingerprint: normalizeAddress(changedAddress).fingerprint,
      resolvedAddress: changedAddress
    }
  });
  assert.equal(latestAddressWins.status, "resolved", "the most recently appended address is the current automatic-location fingerprint authority");

  const legacy = effectiveCompanyLocation({
    addresses: [fullAddress],
    coordinates: [
      { latitude: 35.1, longitude: 128.1 },
      { latitude: 35.2, longitude: 128.2 }
    ]
  });
  assert.equal(legacy.source, "legacy");
  assert.equal(legacy.latitude, 35.2, "the newest valid legacy coordinate must be selected");

  const observation = locationCandidateFromObservation({
    address: fullAddress,
    lat: 35.566,
    lng: 128.165,
    observedAt: "2026-08-03T00:00:00.000Z"
  });
  assert.equal(observation.source, "legacy");
  assert.equal(observation.resolvedAddress, fullAddress);
  const spoofedObservation = locationCandidateFromObservation({
    address: fullAddress,
    latitude: 35.566,
    longitude: 128.165,
    source: "provider",
    addressFingerprint: "0".repeat(64)
  });
  assert.equal(spoofedObservation.addressFingerprint, normalizeAddress(fullAddress).fingerprint, "provider fingerprints are recomputed from the server-side address input");

  const fixture = createFixtureGeocoder({
    [fullAddress]: {
      latitude: 35.566,
      longitude: 128.165,
      status: "resolved",
      source: "provider",
      providerKey: "fixture",
      precision: "rooftop",
      confidence: 0.98,
      resolvedAddress: fullAddress,
      geocodedAt: "2026-08-03T00:00:00.000Z"
    },
    [changedAddress]: [
      { latitude: 35.4, longitude: 128.1, status: "resolved", source: "provider" },
      { latitude: 35.5, longitude: 128.2, status: "resolved", source: "provider" }
    ],
    "경상남도 합천군 봉산면 오류로 9": { error: { code: "FIXTURE_FAILURE", message: "fixture failure" } },
    "경상남도 합천군 율곡면 제한로 9": { error: { code: "RATE_LIMIT", statusCode: 429, message: "fixture rate limit" } },
    "경상남도 합천군 묘산면 장애로 9": { error: { code: "UPSTREAM", statusCode: 503, message: "fixture unavailable" } },
    "경상남도 합천군 적중면 잘못로 9": { latitude: 95, longitude: 128, status: "resolved", source: "provider" }
  });

  const resolved = await geocodeAddress({ address: fullAddress }, { enabled: true, adapter: fixture });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.latitude, 35.566);
  assert.equal(resolved.providerKey, "fixture");
  assert.equal(resolved.addressFingerprint, normalizeAddress(fullAddress).fingerprint);

  const ambiguous = await geocodeAddress({ address: changedAddress }, { enabled: true, adapter: fixture });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.latitude, null, "ambiguous provider matches must never create a marker");

  const aliasAmbiguous = await geocodeAddress({ address: fullAddress }, {
    enabled: true,
    adapter: async () => ({
      status: "ambiguous",
      lat: 35.566,
      lon: 128.165,
      precision: "locality",
      source: "provider",
      resolvedAddress: fullAddress
    })
  });
  assert.equal(aliasAmbiguous.status, "ambiguous", "coordinate aliases must not re-promote an ambiguous result");
  assert.equal(aliasAmbiguous.latitude, null);
  assert.equal(aliasAmbiguous.longitude, null);

  const notFound = await geocodeAddress({ address: "경상남도 합천군 쌍책면 없는길 12" }, { enabled: true, adapter: fixture });
  assert.equal(notFound.status, "not_found");
  const failed = await geocodeAddress({ address: "경상남도 합천군 봉산면 오류로 9" }, { enabled: true, adapter: fixture });
  assert.equal(failed.status, "error");
  assert.equal(failed.errorCode, "provider_error");
  const limited = await geocodeAddress({ address: "경상남도 합천군 율곡면 제한로 9" }, { enabled: true, adapter: fixture });
  assert.equal(limited.errorCode, "rate_limited");
  const unavailable = await geocodeAddress({ address: "경상남도 합천군 묘산면 장애로 9" }, { enabled: true, adapter: fixture });
  assert.equal(unavailable.errorCode, "provider_unavailable");
  const invalidProviderPoint = await geocodeAddress({ address: "경상남도 합천군 적중면 잘못로 9" }, { enabled: true, adapter: fixture });
  assert.equal(invalidProviderPoint.status, "invalid");
  const timeout = await geocodeAddress({ address: fullAddress }, {
    enabled: true,
    timeoutMs: 100,
    adapter: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  });
  assert.equal(timeout.status, "error");
  assert.equal(timeout.errorCode, "timeout");
  const disabled = await geocodeAddress({ address: fullAddress }, { enabled: false, adapter: fixture });
  assert.equal(disabled.status, "pending");
  const locality = await geocodeAddress({ address: "경남 합천군" }, { enabled: true, adapter: fixture });
  assert.equal(locality.status, "ambiguous");

  const providerCompany = {
    addresses: [fullAddress],
    location: {
      ...resolved,
      confidence: 0.98
    }
  };
  const lowerPriority = mergeCompanyLocation(providerCompany, {
    latitude: 35.9,
    longitude: 128.9,
    source: "legacy",
    status: "resolved",
    resolvedAddress: fullAddress
  });
  assert.equal(lowerPriority.latitude, 35.566, "lower-priority legacy points must not replace provider points");
  const manualPreserved = mergeCompanyLocation(manualCompany, resolved);
  assert.equal(manualPreserved.source, "manual", "automatic geocoding must never override manual location correction");
  const currentAutomatic = {
    addresses: [fullAddress],
    location: {
      latitude: 35.566,
      longitude: 128.165,
      status: "resolved",
      source: "provider",
      confidence: 0.9,
      resolvedAddress: fullAddress,
      geocodedAt: "2026-08-03T00:00:00.000Z"
    }
  };
  const farNewer = mergeCompanyLocation(currentAutomatic, {
    latitude: 35.9,
    longitude: 128.9,
    status: "resolved",
    source: "provider",
    confidence: 0.9,
    resolvedAddress: fullAddress,
    geocodedAt: "2026-08-04T00:00:00.000Z"
  });
  assert.equal(farNewer.latitude, 35.566, "a distant same-priority duplicate point must not silently move the current marker");
  const nearNewer = mergeCompanyLocation(currentAutomatic, {
    latitude: 35.5665,
    longitude: 128.1655,
    status: "resolved",
    source: "provider",
    confidence: 0.9,
    resolvedAddress: fullAddress,
    geocodedAt: "2026-08-04T00:00:00.000Z"
  });
  assert.equal(nearNewer.latitude, 35.5665, "a newer nearby equal-priority point may replace the current automatic point");
  const nearOlder = mergeCompanyLocation(currentAutomatic, {
    latitude: 35.5664,
    longitude: 128.1654,
    status: "resolved",
    source: "provider",
    confidence: 0.9,
    resolvedAddress: fullAddress,
    geocodedAt: "2026-08-02T00:00:00.000Z"
  });
  assert.equal(nearOlder.latitude, 35.566, "an older equal-priority point must not replace the stable current point");
  const mergedProfiles = mergeCompanyLocationProfiles({}, providerCompany);
  assert.equal(mergedProfiles.latitude, 35.566, "duplicate profile merge must make the source location available to its caller");

  const publicSummary = publicCompanyLocationSummary(providerCompany);
  assert.deepEqual(
    Object.keys(publicSummary).sort(),
    ["confidence", "crs", "displayAddress", "geocodedAt", "lat", "lon", "precision", "providerKey", "resolvedAddress", "source", "status", "statusLabel"].sort()
  );
  assert.equal(publicSummary.lat, 35.566);
  assert.equal(publicSummary.lon, 128.165);
  assert.equal("privateProviderPayload" in publicSummary, false);
  assert.equal(networkCalls, 0, "the contract and fixture adapter must perform zero external requests");

  console.log("Lodging geocoding normalization, precedence, fixture, and public projection contract tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
