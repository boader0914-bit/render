"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_REGISTRY_FILE = path.join(__dirname, "..", "web", "data", "location_region_registry.json");
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REGION_KEY_PATTERN = /^kr_[a-z0-9_]+$/;

class LocationRegionRegistryError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "LocationRegionRegistryError";
    this.code = "INVALID_LOCATION_REGION_REGISTRY";
    this.details = details;
  }
}

function normalizedText(value = "") {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function comparableText(value = "") {
  return normalizedText(value)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, "");
}

function exactCode(value = "") {
  return normalizedText(value);
}

function validDate(value) {
  const text = String(value || "");
  if (!DATE_PATTERN.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function seoulCalendarDate(value = new Date()) {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) return "";
  return new Date(instant.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function hasCodeSource(value) {
  if (typeof value === "string") return Boolean(normalizedText(value));
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Boolean(normalizedText(value.file || value.dataset || value.url));
}

function validateLocationRegionRegistry(registry = {}) {
  const errors = [];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new LocationRegionRegistryError("Location region registry must be an object", ["registry"]);
  }
  if (!normalizedText(registry.registryVersion)) errors.push("registryVersion is required");
  if (registry.active !== true) errors.push("registry.active must be true");
  if (!validDate(registry.effectiveFrom)) errors.push("registry.effectiveFrom must be an ISO date");
  if (registry.effectiveTo !== null && registry.effectiveTo !== undefined && !validDate(registry.effectiveTo)) {
    errors.push("registry.effectiveTo must be null or an ISO date");
  }
  if (!registry.codeSystem || typeof registry.codeSystem !== "object") errors.push("codeSystem is required");
  if (!Array.isArray(registry.regions) || !registry.regions.length) errors.push("regions must be a non-empty array");

  const regionKeys = new Set();
  const legalCodes = new Set();
  const ktoCodes = new Set();
  for (const [index, region] of (Array.isArray(registry.regions) ? registry.regions : []).entries()) {
    const prefix = `regions[${index}]`;
    if (!REGION_KEY_PATTERN.test(String(region?.regionKey || ""))) errors.push(`${prefix}.regionKey is invalid`);
    if (regionKeys.has(region?.regionKey)) errors.push(`${prefix}.regionKey is duplicated`);
    regionKeys.add(region?.regionKey);

    const legalStatus = String(region?.legalDongCodeStatus || "");
    const legalCode = String(region?.legalDongCode10 || "");
    if (!["verified", "unverified"].includes(legalStatus)) errors.push(`${prefix}.legalDongCodeStatus is invalid`);
    if (legalStatus === "verified") {
      if (!/^\d{10}$/.test(legalCode)) errors.push(`${prefix}.legalDongCode10 must contain 10 digits when verified`);
      if (!legalCode.endsWith("00000")) errors.push(`${prefix}.legalDongCode10 must use the sigungu five-digit prefix plus 00000`);
      if (legalCodes.has(legalCode)) errors.push(`${prefix}.legalDongCode10 is duplicated`);
      legalCodes.add(legalCode);
      if (!hasCodeSource(region?.legalDongCodeSource)) errors.push(`${prefix}.legalDongCodeSource is required when verified`);
      if (!validDate(region?.legalDongCodeEffectiveFrom)) errors.push(`${prefix}.legalDongCodeEffectiveFrom is required when verified`);
    } else {
      if (region?.legalDongCode10 !== null) errors.push(`${prefix}.legalDongCode10 must be null when unverified`);
      if (region?.legalDongCodeSource !== null) errors.push(`${prefix}.legalDongCodeSource must be null when unverified`);
      if (region?.legalDongCodeEffectiveFrom !== null) errors.push(`${prefix}.legalDongCodeEffectiveFrom must be null when unverified`);
    }

    const ktoStatus = String(region?.ktoSggCdStatus || "");
    if (!["mapped", "verified", "verify-before-api-call", "unverified"].includes(ktoStatus)) {
      errors.push(`${prefix}.ktoSggCdStatus is invalid`);
    }
    if (ktoStatus === "unverified") {
      if (region?.ktoSggCd !== null) errors.push(`${prefix}.ktoSggCd must be null when unverified`);
      if (region?.ktoSggCdSource !== null) errors.push(`${prefix}.ktoSggCdSource must be null when unverified`);
      if (region?.ktoSggCdEffectiveFrom !== null) errors.push(`${prefix}.ktoSggCdEffectiveFrom must be null when unverified`);
    } else {
      if (!/^\d{5}$/.test(String(region?.ktoSggCd || ""))) errors.push(`${prefix}.ktoSggCd must contain 5 digits`);
      if (ktoCodes.has(region?.ktoSggCd)) errors.push(`${prefix}.ktoSggCd is duplicated`);
      ktoCodes.add(region?.ktoSggCd);
      if (!hasCodeSource(region?.ktoSggCdSource)) errors.push(`${prefix}.ktoSggCdSource is required`);
      if (!validDate(region?.ktoSggCdEffectiveFrom)) errors.push(`${prefix}.ktoSggCdEffectiveFrom is required`);
    }
    if (!normalizedText(region?.sido)) errors.push(`${prefix}.sido is required`);
    if (!normalizedText(region?.sigungu)) errors.push(`${prefix}.sigungu is required`);
    if (!Array.isArray(region?.aliases)) errors.push(`${prefix}.aliases must be an array`);
    if (region?.active !== true) errors.push(`${prefix}.active must be true`);
    if (!validDate(region?.effectiveFrom)) errors.push(`${prefix}.effectiveFrom must be an ISO date`);
    if (region?.effectiveTo !== null && region?.effectiveTo !== undefined && !validDate(region?.effectiveTo)) {
      errors.push(`${prefix}.effectiveTo must be null or an ISO date`);
    }
  }

  if (errors.length) throw new LocationRegionRegistryError("Location region registry validation failed", errors);
  return registry;
}

function readLocationRegionRegistry(filePath = DEFAULT_REGISTRY_FILE) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return validateLocationRegionRegistry(JSON.parse(raw));
}

function dateForMatch(value, registry) {
  const candidate = normalizedText(value) || seoulCalendarDate();
  if (!validDate(candidate)) {
    const error = new RangeError("asOf must be an ISO calendar date");
    error.code = "INVALID_REGION_MATCH_DATE";
    throw error;
  }
  if (candidate < registry.effectiveFrom || (registry.effectiveTo && candidate > registry.effectiveTo)) return null;
  return candidate;
}

function regionIsActive(region, asOf) {
  return Boolean(
    asOf
    && region?.active === true
    && region.effectiveFrom <= asOf
    && (!region.effectiveTo || region.effectiveTo >= asOf)
  );
}

function uniqueRegions(regions = []) {
  const seen = new Set();
  return regions.filter((region) => {
    if (!region?.regionKey || seen.has(region.regionKey)) return false;
    seen.add(region.regionKey);
    return true;
  });
}

function candidateSummary(region = {}) {
  return {
    regionKey: region.regionKey || "",
    legalDongCode10: region.legalDongCode10 || null,
    ktoSggCd: region.ktoSggCd || null,
    sido: region.sido || "",
    sigungu: region.sigungu || ""
  };
}

function unmatched(reason, candidates = []) {
  return {
    status: "unmatched",
    matched: false,
    region: null,
    confidence: 0,
    reason,
    matchType: "none",
    candidates: uniqueRegions(candidates).map(candidateSummary)
  };
}

function ambiguous(reason, candidates = []) {
  return {
    status: "ambiguous",
    matched: false,
    region: null,
    confidence: 0,
    reason,
    matchType: "none",
    candidates: uniqueRegions(candidates).map(candidateSummary)
  };
}

function matched(region, reason) {
  return {
    status: "matched",
    matched: true,
    region,
    confidence: 100,
    reason,
    matchType: reason,
    candidates: [candidateSummary(region)]
  };
}

function provinceKeysForValue(registry, value) {
  const comparable = comparableText(value);
  if (!comparable) return [];
  return Object.entries(registry.sidoAliases || {})
    .filter(([, aliases]) => (Array.isArray(aliases) ? aliases : []).some((alias) => comparableText(alias) === comparable))
    .map(([key]) => key);
}

function provinceAliasesForKey(registry, sidoKey) {
  return [...new Set((registry.sidoAliases?.[sidoKey] || []).map(comparableText).filter(Boolean))];
}

function regionAliases(region = {}) {
  return [...new Set([region.sigungu, ...(region.aliases || [])].map(comparableText).filter(Boolean))];
}

function resolveExactSelector(selectors, activeRegions) {
  if (!selectors.length) return null;
  const resolved = [];
  for (const selector of selectors) {
    const candidates = uniqueRegions(activeRegions.filter(selector.predicate));
    if (!candidates.length) return unmatched(`${selector.name}_unmatched`);
    if (candidates.length > 1) return ambiguous(`${selector.name}_ambiguous`, candidates);
    resolved.push({ ...selector, region: candidates[0] });
  }
  const unique = uniqueRegions(resolved.map((entry) => entry.region));
  if (unique.length !== 1) return ambiguous("exact_selector_conflict", unique);
  const reason = resolved.length === 1 ? resolved[0].reason : "explicit_selectors_exact";
  return matched(unique[0], reason);
}

function matchLocationRegion(input = {}, registryInput = null) {
  const registry = validateLocationRegionRegistry(registryInput || readLocationRegionRegistry());
  const asOf = dateForMatch(input.asOf, registry);
  if (!asOf) return unmatched("registry_not_effective");
  const allRegions = registry.regions || [];
  const activeRegions = allRegions.filter((region) => regionIsActive(region, asOf));

  const regionKey = normalizedText(input.regionKey);
  const legalDongCode10 = exactCode(input.legalDongCode10 || input.legalRegionCode || input.legalCode);
  const legalSigunguCode5 = exactCode(input.legalSigunguCode5 || input.sigunguCode5 || input.sigunguCode);
  const ktoSggCd = exactCode(input.ktoSggCd);
  const selectors = [];
  if (regionKey) {
    selectors.push({
      name: "region_key",
      reason: "region_key_exact",
      predicate: (region) => region.regionKey === regionKey
    });
  }
  if (legalDongCode10) {
    if (!/^\d{10}$/.test(legalDongCode10)) return unmatched("legal_dong_code_invalid");
    selectors.push({
      name: "legal_dong_code",
      reason: "legal_dong_code_exact",
      predicate: (region) => region.legalDongCodeStatus === "verified" && region.legalDongCode10 === legalDongCode10
    });
  }
  if (legalSigunguCode5) {
    if (!/^\d{5}$/.test(legalSigunguCode5)) return unmatched("legal_sigungu_code_invalid");
    selectors.push({
      name: "legal_sigungu_code",
      reason: "legal_sigungu_code_exact",
      predicate: (region) => (
        region.legalDongCodeStatus === "verified"
        && region.legalDongCode10.slice(0, 5) === legalSigunguCode5
      )
    });
  }
  if (ktoSggCd) {
    if (!/^\d{5}$/.test(ktoSggCd)) return unmatched("kto_sgg_code_invalid");
    selectors.push({
      name: "kto_sgg_code",
      reason: "kto_sgg_code_exact",
      predicate: (region) => region.ktoSggCd === ktoSggCd
    });
  }
  const exactSelectorResult = resolveExactSelector(selectors, activeRegions);
  if (exactSelectorResult) return exactSelectorResult;

  const sidoValue = normalizedText(input.sido || input.sidoFull || input.province || input.provinceName);
  const sigunguValue = normalizedText(input.sigungu || input.cityCounty || input.locality);
  const sidoKeys = provinceKeysForValue(registry, sidoValue);
  if (sidoValue && !sidoKeys.length) return unmatched("sido_unmatched");
  if (sidoKeys.length > 1) return ambiguous("sido_ambiguous");

  if (sidoKeys.length === 1 && sigunguValue) {
    const exactPair = uniqueRegions(activeRegions.filter((region) => (
      region.sidoKey === sidoKeys[0]
      && comparableText(region.sigungu) === comparableText(sigunguValue)
    )));
    if (exactPair.length === 1) return matched(exactPair[0], "sido_sigungu_exact");
    if (exactPair.length > 1) return ambiguous("sido_sigungu_ambiguous", exactPair);
  }

  const query = normalizedText(
    input.keyword
    || input.query
    || input.searchKeyword
    || input.alias
    || sigunguValue
  );
  const queryComparable = comparableText(query);
  if (!queryComparable) return unmatched("missing_region_selector");

  if (sidoKeys.length === 1) {
    const provinceCandidates = uniqueRegions(activeRegions.filter((region) => (
      region.sidoKey === sidoKeys[0]
      && regionAliases(region).includes(queryComparable)
    )));
    if (provinceCandidates.length === 1) return matched(provinceCandidates[0], "sido_alias_exact");
    if (provinceCandidates.length > 1) return ambiguous("sido_alias_ambiguous", provinceCandidates);
    return unmatched("sido_alias_unmatched");
  }

  const qualifiedCandidates = [];
  for (const region of activeRegions) {
    const aliases = regionAliases(region);
    const provinceAliases = provinceAliasesForKey(registry, region.sidoKey);
    if (provinceAliases.some((province) => aliases.some((alias) => (
      queryComparable === `${province}${alias}`
      || queryComparable === `${alias}${province}`
    )))) {
      qualifiedCandidates.push(region);
    }
  }
  const uniqueQualified = uniqueRegions(qualifiedCandidates);
  if (uniqueQualified.length === 1) return matched(uniqueQualified[0], "sido_alias_exact");
  if (uniqueQualified.length > 1) return ambiguous("sido_alias_ambiguous", uniqueQualified);

  const bareAliasCandidates = uniqueRegions(activeRegions.filter((region) => regionAliases(region).includes(queryComparable)));
  if (bareAliasCandidates.length > 1) return ambiguous("alias_ambiguous", bareAliasCandidates);
  if (bareAliasCandidates.length === 1) return unmatched("sido_context_required", bareAliasCandidates);
  return unmatched("region_unmatched");
}

function createLocationRegionMatcher(registryInput = null) {
  const registry = validateLocationRegionRegistry(registryInput || readLocationRegionRegistry());
  return (input = {}) => matchLocationRegion(input, registry);
}

module.exports = {
  DEFAULT_REGISTRY_FILE,
  LocationRegionRegistryError,
  comparableText,
  createLocationRegionMatcher,
  matchLocationRegion,
  readLocationRegionRegistry,
  seoulCalendarDate,
  validateLocationRegionRegistry
};
