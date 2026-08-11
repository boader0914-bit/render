"use strict";

const V2_COLLECTOR_ARCHITECTURE = "v2_collector_single_source";
const V2_COLLECTOR_BACKEND = "v2_collector_worker";
const V2_COLLECTOR_ENTRY_POINT = "gyeongnam_glamping_crawl";
const LEGACY_FROZEN_ARCHITECTURE = "legacy_frozen";

class V2CollectorExecutionMetadataError extends Error {
  constructor(message) {
    super(message);
    this.name = "V2CollectorExecutionMetadataError";
    this.code = "METADATA_INVALID";
  }
}

function metadataInvalid(message) {
  throw new V2CollectorExecutionMetadataError(message);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasFrozenExecutionEvidence(input) {
  return input.collectorBackend === LEGACY_FROZEN_ARCHITECTURE
    || input.frozenAdapterExecuted === true
    || input.frozenExecutionProfile === true
    || input.frozenArtifact === true
    || input.frozenFallbackReceipt === true;
}

// This intentionally keeps the V2 execution boundary distinct from its
// internally selected NAVER query plan.  In particular, legacy_candidate is
// a verified search strategy, not evidence of a frozen collector execution.
function buildV2CollectorExecutionMetadata(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const rawCollectorStrategy = text(source.rawCollectorStrategy || source.collectorStrategy);
  const naverSearchStrategy = text(source.naverSearchStrategy) || rawCollectorStrategy || "current";
  const frozenEvidence = hasFrozenExecutionEvidence(source);
  let collectorArchitecture = text(source.collectorArchitecture);
  let collectorBackend = text(source.collectorBackend);
  let collectorEntryPoint = text(source.collectorEntryPoint);

  if (!collectorArchitecture && frozenEvidence) collectorArchitecture = LEGACY_FROZEN_ARCHITECTURE;
  if (!collectorArchitecture && source.v2SingleSource === true) collectorArchitecture = V2_COLLECTOR_ARCHITECTURE;

  if (collectorArchitecture === V2_COLLECTOR_ARCHITECTURE) {
    if (frozenEvidence || source.legacyFrozenUsed === true) {
      metadataInvalid("V2 single-source execution cannot be marked frozen");
    }
    if (collectorBackend && collectorBackend !== V2_COLLECTOR_BACKEND) {
      metadataInvalid("V2 single-source execution backend is invalid");
    }
    if (collectorEntryPoint && collectorEntryPoint !== V2_COLLECTOR_ENTRY_POINT) {
      metadataInvalid("V2 single-source execution entry point is invalid");
    }
    collectorBackend = V2_COLLECTOR_BACKEND;
    collectorEntryPoint = V2_COLLECTOR_ENTRY_POINT;
  } else if (collectorArchitecture === LEGACY_FROZEN_ARCHITECTURE) {
    if (!frozenEvidence) metadataInvalid("Frozen execution requires frozen evidence");
    collectorBackend = collectorBackend || LEGACY_FROZEN_ARCHITECTURE;
    collectorEntryPoint = collectorEntryPoint || "frozen_v2_collector";
  } else {
    metadataInvalid("Collector execution architecture is required");
  }

  const legacyFrozenUsed = collectorArchitecture === LEGACY_FROZEN_ARCHITECTURE;
  return Object.freeze({
    collectorArchitecture,
    collectorBackend,
    collectorEntryPoint,
    naverSearchStrategy,
    legacyFrozenUsed,
    fallbackUsed: source.fallbackUsed === true,
    probeUsed: source.probeUsed === true,
    automaticRetry: source.automaticRetry === true,
    automaticFallback: source.automaticFallback === true,
  });
}

function deriveV2CollectorExecutionMetadata(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const manifest = source.manifest && typeof source.manifest === "object" ? source.manifest : {};
  const v2WorkerEvidence = source.workerRun === true
    && source.v2Top20Profile === true
    && source.v2Top20Scope === true;
  const frozenArtifact = manifest.frozenCollector && typeof manifest.frozenCollector === "object";
  return buildV2CollectorExecutionMetadata({
    collectorArchitecture: manifest.collectorArchitecture || (v2WorkerEvidence ? V2_COLLECTOR_ARCHITECTURE : ""),
    collectorBackend: manifest.collectorBackend || (v2WorkerEvidence ? V2_COLLECTOR_BACKEND : ""),
    collectorEntryPoint: manifest.collectorEntryPoint || (v2WorkerEvidence ? V2_COLLECTOR_ENTRY_POINT : ""),
    naverSearchStrategy: manifest.naverSearchStrategy || manifest.collectorStrategy,
    rawCollectorStrategy: manifest.rawCollectorStrategy || manifest.collectorStrategy,
    fallbackUsed: manifest.fallbackUsed === true,
    probeUsed: manifest.probeUsed === true,
    automaticRetry: manifest.automaticRetry === true,
    automaticFallback: manifest.automaticFallback === true,
    frozenAdapterExecuted: manifest.frozenAdapterExecuted === true,
    frozenExecutionProfile: manifest.frozenExecutionProfile === true,
    frozenArtifact,
    frozenFallbackReceipt: manifest.frozenFallbackReceipt === true,
  });
}

function projectV2CollectorExecution(input = {}) {
  const metadata = buildV2CollectorExecutionMetadata(input);
  return Object.freeze({
    architecture: metadata.collectorArchitecture,
    backend: metadata.collectorBackend,
    entryPoint: metadata.collectorEntryPoint,
    naverSearchStrategy: metadata.naverSearchStrategy,
    legacyFrozenUsed: metadata.legacyFrozenUsed,
    fallbackUsed: metadata.fallbackUsed,
    probeUsed: metadata.probeUsed,
    automaticRetry: metadata.automaticRetry,
    automaticFallback: metadata.automaticFallback,
  });
}

module.exports = {
  LEGACY_FROZEN_ARCHITECTURE,
  V2_COLLECTOR_ARCHITECTURE,
  V2_COLLECTOR_BACKEND,
  V2_COLLECTOR_ENTRY_POINT,
  V2CollectorExecutionMetadataError,
  buildV2CollectorExecutionMetadata,
  deriveV2CollectorExecutionMetadata,
  projectV2CollectorExecution,
};
