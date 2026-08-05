"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  API_SOURCE_IDS,
  REFERENCE_ONLY_SOURCE_IDS,
  buildRequestDescriptor,
  exactActiveRegion,
  normalizeMeasurementPeriod,
  readRegionRegistry
} = require("./location_api_request_builders.cjs");

const PILOT_REQUEST_PLAN_SCHEMA_VERSION = "location-api-pilot-request-plan.v1";
const DEFAULT_SOURCE_CATALOG_FILE = path.join(__dirname, "..", "web", "data", "location_public_source_catalog.json");
const PILOT_REGION_KEYS = Object.freeze([
  "kr_gyeonggi_pocheon",
  "kr_gyeongnam_sancheong",
  "kr_gyeongnam_hadong"
]);
const SHARED_GOCAMPING_SOURCE_ID = "kto.gocamping.inventory";

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function readSourceCatalog(filePath = DEFAULT_SOURCE_CATALOG_FILE) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function previousClosedMonth(now = new Date()) {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError("now must be a valid date");
  const seoul = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const year = seoul.getUTCFullYear();
  const monthIndex = seoul.getUTCMonth() - 1;
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

function sourceCatalogIndex(catalog) {
  return new Map((Array.isArray(catalog?.sources) ? catalog.sources : []).map((source) => [source.sourceId, source]));
}

function assertCatalogCoverage(catalog) {
  const index = sourceCatalogIndex(catalog);
  for (const sourceId of [...API_SOURCE_IDS, ...REFERENCE_ONLY_SOURCE_IDS]) {
    if (!index.has(sourceId)) throw new Error(`Source catalog is missing ${sourceId}`);
  }
  return index;
}

function descriptorPlanEntry(descriptor, sharedCollectionKey = null, regionKey = descriptor.regionKey) {
  return {
    regionKey,
    sourceId: descriptor.sourceId,
    operation: descriptor.operation,
    selectionStatus: descriptor.selectionStatus,
    connectionStage: descriptor.connectionStage,
    actualCallsEnabled: false,
    approvalRequired: true,
    plannedCallCount: 0,
    estimatedPageCount: null,
    estimatedCallCount: null,
    pageCeiling: descriptor.paginationPolicy.pageCeiling,
    callCeiling: descriptor.paginationPolicy.callCeiling,
    measurementPeriod: descriptor.measurementPeriod,
    watermarkRule: descriptor.watermarkRule,
    duplicateKeyRule: descriptor.duplicateKeyRule,
    observationTarget: descriptor.observationTarget,
    sharedCollectionKey,
    blockers: descriptor.blockers,
    descriptor: sharedCollectionKey ? null : descriptor
  };
}

function buildPilotRequestPlan(options = {}) {
  const registry = options.registry || readRegionRegistry(options.regionRegistryFile);
  const catalog = options.catalog || readSourceCatalog(options.sourceCatalogFile);
  const catalogIndex = assertCatalogCoverage(catalog);
  const measurementPeriod = normalizeMeasurementPeriod(
    options.measurementPeriod || previousClosedMonth(options.now || new Date())
  );
  const plannedAt = new Date(options.plannedAt || options.now || new Date()).toISOString();
  const regionKeys = options.regionKeys || PILOT_REGION_KEYS;
  if (!Array.isArray(regionKeys) || regionKeys.length !== PILOT_REGION_KEYS.length ||
      !PILOT_REGION_KEYS.every((regionKey) => regionKeys.includes(regionKey))) {
    throw new Error("The dry-run plan must cover exactly the three approved pilot regionKeys");
  }
  const regions = regionKeys.map((regionKey) => exactActiveRegion(regionKey, registry));

  const sharedCollectionKey = `${SHARED_GOCAMPING_SOURCE_ID}:national-snapshot:${measurementPeriod.to}`;
  const sharedDescriptor = buildRequestDescriptor({
    sourceId: SHARED_GOCAMPING_SOURCE_ID,
    regionKey: regions[0].regionKey,
    registry,
    measurementPeriod,
    targetRegions: regions
  });
  const sharedCollections = [{
    sharedCollectionKey,
    sourceId: SHARED_GOCAMPING_SOURCE_ID,
    requestScope: "national_shared_snapshot",
    targetRegionKeys: regions.map((region) => region.regionKey),
    postFilter: {
      fields: ["doNm", "sigunguNm"],
      mode: "exact",
      fuzzyFallback: false
    },
    actualCallsEnabled: false,
    plannedCallCount: 0,
    estimatedPageCount: null,
    estimatedCallCount: null,
    pageCeiling: sharedDescriptor.paginationPolicy.pageCeiling,
    callCeiling: sharedDescriptor.paginationPolicy.callCeiling,
    descriptor: sharedDescriptor
  }];

  const regionPlans = regions.map((region) => ({
    regionKey: region.regionKey,
    sido: region.sido,
    sidoFull: region.sidoFull,
    sigungu: region.sigungu,
    officialSigunguIdentifiers: [
      {
        codeSystem: "KTO_DATALAB_SGG_CD",
        value: region.ktoSggCdStatus === "mapped" ? region.ktoSggCd : null,
        status: region.ktoSggCdStatus || "unverified",
        sourceVersion: region.ktoSggCdSource?.version || null
      },
      {
        codeSystem: "TOUR_API_AREA_SIGUNGU",
        value: null,
        status: "unverified"
      }
    ],
    canonicalMatch: "exact",
    fuzzyFallback: false,
    optionalCrosswalk: {
      sourceId: "mois.legal_dong.reference",
      usageRole: "canonical_crosswalk",
      apiConnectionRequired: false,
      collectionMode: "manual_versioned_snapshot",
      requiredForSigunguPlan: false,
      status: region.legalDongCodeStatus || "unverified",
      codeIncluded: false
    },
    sources: API_SOURCE_IDS.map((sourceId) => {
      if (sourceId === SHARED_GOCAMPING_SOURCE_ID) {
        return descriptorPlanEntry(sharedDescriptor, sharedCollectionKey, region.regionKey);
      }
      return descriptorPlanEntry(buildRequestDescriptor({
        sourceId,
        regionKey: region.regionKey,
        registry,
        measurementPeriod
      }));
    })
  }));

  const selectedIds = API_SOURCE_IDS.filter((sourceId) => catalogIndex.get(sourceId)?.selectionStatus === "selected");
  const candidateIds = API_SOURCE_IDS.filter((sourceId) => catalogIndex.get(sourceId)?.selectionStatus === "candidate");
  const uniqueDescriptors = [
    sharedDescriptor,
    ...regionPlans.flatMap((regionPlan) => regionPlan.sources
      .filter((sourcePlan) => !sourcePlan.sharedCollectionKey)
      .map((sourcePlan) => sourcePlan.descriptor))
  ];

  return deepFreeze({
    schemaVersion: PILOT_REQUEST_PLAN_SCHEMA_VERSION,
    planVersion: "pilot-2026-08-05.v1",
    plannedAt,
    mode: "sanitized-fixture-only",
    actualCallsEnabled: false,
    plannedCallCount: 0,
    measurementPeriod,
    pilotRegionKeys: regions.map((region) => region.regionKey),
    sourceScope: {
      apiSourceIds: API_SOURCE_IDS,
      selectedSourceIds: selectedIds,
      candidateSourceIds: candidateIds,
      referenceOnlySourceIds: REFERENCE_ONLY_SOURCE_IDS
    },
    referenceSources: [{
      sourceId: "mois.legal_dong.reference",
      apiConnectionRequired: false,
      usageRole: "canonical_crosswalk",
      connectionStage: "reference_only",
      collectionMode: "manual_versioned_snapshot",
      repeatedCollectionPlanned: false,
      optionalCrosswalk: true
    }],
    sharedCollections,
    regions: regionPlans,
    summary: {
      pilotRegionCount: regions.length,
      apiSourceCount: API_SOURCE_IDS.length,
      selectedSourceCount: selectedIds.length,
      candidateSourceCount: candidateIds.length,
      sourcePlanCount: regionPlans.reduce((sum, regionPlan) => sum + regionPlan.sources.length, 0),
      uniqueRequestDescriptorCount: uniqueDescriptors.length,
      enabledRequestDescriptorCount: uniqueDescriptors.filter((descriptor) => descriptor.actualCallsEnabled === true).length,
      repeatedReferenceCollectionCount: 0,
      estimatedPageCount: null,
      estimatedCallCount: null,
      estimateReason: "No external endpoint or provider totalCount was called"
    }
  });
}

function cliOptions(argv) {
  const options = {};
  for (const argument of argv) {
    const [name, value] = argument.split("=", 2);
    if (name === "--from") options.from = value;
    if (name === "--to") options.to = value;
    if (name === "--planned-at") options.plannedAt = value;
  }
  return options;
}

if (require.main === module) {
  const cli = cliOptions(process.argv.slice(2));
  const measurementPeriod = cli.from || cli.to ? { from: cli.from, to: cli.to } : undefined;
  const plan = buildPilotRequestPlan({ measurementPeriod, plannedAt: cli.plannedAt });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

module.exports = {
  DEFAULT_SOURCE_CATALOG_FILE,
  PILOT_REGION_KEYS,
  PILOT_REQUEST_PLAN_SCHEMA_VERSION,
  SHARED_GOCAMPING_SOURCE_ID,
  buildPilotRequestPlan,
  previousClosedMonth,
  readSourceCatalog
};
