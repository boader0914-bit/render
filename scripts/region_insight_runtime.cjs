"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const {
  buildRegionInsightState,
  publishRegionInsightState,
  toPublicRegionInsight,
  validPublicationActorId,
  validateRegionInsightState
} = require("./region_insight_contract.cjs");
const { createLocationRegionMatcher } = require("./location_region_matcher.cjs");
const {
  readJsonFile: readSecureJsonFile,
  updateJsonFile: updateSecureJsonFile
} = require("./secure_json_store.cjs");

const STORE_DOCUMENT_TYPE = "region-insight-publication-store";
const STORE_SCHEMA_VERSION = 1;
const REGION_CONTEXT_STATUSES = Object.freeze(["matched", "ambiguous", "unmatched"]);

class RegionInsightRuntimeError extends Error {
  constructor(message, { code = "REGION_INSIGHT_RUNTIME_ERROR", statusCode = 400, details = [] } = {}) {
    super(message);
    this.name = "RegionInsightRuntimeError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function text(value, max = 240) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])])
  );
}

function sameJsonValue(left, right) {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function emptyRegionInsightStore() {
  return {
    documentType: STORE_DOCUMENT_TYPE,
    schemaVersion: STORE_SCHEMA_VERSION,
    updatedAt: "",
    regions: {}
  };
}

function regionKeywordBases(value = "") {
  const raw = text(value, 160);
  const compact = raw.replace(/[^\p{L}\p{N}]+/gu, "");
  const stripped = compact
    .replace(/(글램핑장|글램핑|풀빌라|펜션|캠핑장|야영장|카라반|캠핑|숙소|리조트|호텔|모텔)$/u, "")
    .trim();
  return [...new Set([raw, compact, stripped].filter((entry) => entry && entry.length >= 2))];
}

function publicRegionContext(value = {}, matcher = null) {
  const requestedStatus = text(value.matchStatus || value.status, 24).toLowerCase();
  const matchStatus = REGION_CONTEXT_STATUSES.includes(requestedStatus) ? requestedStatus : "unmatched";
  if (matchStatus === "matched" && typeof matcher === "function") {
    const canonical = matcher({ regionKey: text(value.regionKey, 160) });
    if (canonical.status === "matched") {
      const region = canonical.region;
      return Object.freeze({
        regionKey: region.regionKey,
        matchStatus: "matched",
        sido: text(region.sido, 40),
        sigungu: text(region.sigungu, 80),
        displayLabel: text(`${region.sido} ${region.sigungu}`, 120)
      });
    }
  }
  return Object.freeze({
    regionKey: "",
    matchStatus: matchStatus === "matched" ? "unmatched" : matchStatus,
    sido: "",
    sigungu: "",
    displayLabel: text(value.displayLabel, 120)
  });
}

function contextFromMatch(match = {}, displayLabel = "", matcher = null) {
  if (match.status === "matched") {
    return publicRegionContext({
      regionKey: match.region.regionKey,
      matchStatus: "matched",
      displayLabel: `${match.region.sido} ${match.region.sigungu}`
    }, matcher);
  }
  return publicRegionContext({
    matchStatus: match.status === "ambiguous" ? "ambiguous" : "unmatched",
    displayLabel
  }, matcher);
}

function resolveRunRegionContext(data = {}, options = {}) {
  const matcher = options.matcher || createLocationRegionMatcher(options.registry);
  const run = data.run || data || {};
  const displayLabel = text(run.keyword || run.searchKeyword || run.label, 120);
  const explicitRegionKey = text(run.regionKey || run.searchRegionKey, 160);
  if (explicitRegionKey) {
    return contextFromMatch(matcher({ regionKey: explicitRegionKey }), displayLabel, matcher);
  }

  const sido = text(run.provinceLabel || run.sido || run.sidoFull, 40);
  const labels = [run.keyword, run.searchKeyword, run.label]
    .flatMap(regionKeywordBases)
    .filter((value, index, values) => values.indexOf(value) === index);
  const matchedByKey = new Map();
  const ambiguousKeys = new Set();
  for (const keyword of labels) {
    const match = matcher({ ...(sido ? { sido } : {}), keyword });
    if (match.status === "matched") matchedByKey.set(match.region.regionKey, match);
    if (match.status === "ambiguous") {
      for (const candidate of match.candidates || []) ambiguousKeys.add(candidate.regionKey);
    }
  }
  if (matchedByKey.size === 1 && !ambiguousKeys.size) {
    return contextFromMatch([...matchedByKey.values()][0], displayLabel, matcher);
  }
  if (matchedByKey.size > 1 || ambiguousKeys.size > 1) {
    return publicRegionContext({ matchStatus: "ambiguous", displayLabel }, matcher);
  }
  return publicRegionContext({ matchStatus: "unmatched", displayLabel }, matcher);
}

function projectB2BRegionInsight(value = null) {
  if (!value) return null;
  try {
    return toPublicRegionInsight(value);
  } catch {
    return null;
  }
}

function createRegionInsightRuntime(options = {}) {
  const filePath = path.resolve(String(options.filePath || ""));
  if (!path.isAbsolute(filePath) || !String(options.filePath || "").trim()) {
    throw new TypeError("region insight runtime requires an absolute file path");
  }
  const matcher = options.matcher || createLocationRegionMatcher(options.registry);
  const registryVersion = text(options.registry?.registryVersion, 120);
  if (!registryVersion) throw new TypeError("region insight runtime requires a versioned region registry");
  const readJsonFile = options.readJsonFile || readSecureJsonFile;
  const updateJsonFile = options.updateJsonFile || updateSecureJsonFile;
  const clock = options.clock || (() => new Date());
  const idFactory = options.idFactory || (() => `region-publication-${crypto.randomUUID()}`);

  function nowIso() {
    const value = clock();
    const instant = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(instant.getTime())) throw new TypeError("region insight runtime clock must return a valid date");
    return instant.toISOString();
  }

  function canonicalRegion(regionKey) {
    const key = text(regionKey, 160);
    const match = matcher({ regionKey: key });
    if (match.status !== "matched" || match.region.regionKey !== key) {
      throw new RegionInsightRuntimeError("정확히 일치하는 canonical 지역 키가 필요합니다.", {
        code: "CANONICAL_REGION_KEY_REQUIRED",
        statusCode: 400,
        details: [{ regionKey: key, matchStatus: match.status, reason: match.reason }]
      });
    }
    return match.region;
  }

  function workflowRevisionFor(record) {
    if (!record || record.workflowRevision === undefined) return 0;
    return Number.isSafeInteger(record.workflowRevision) && record.workflowRevision >= 1
      ? record.workflowRevision
      : -1;
  }

  function assertExpectedWorkflowRevision(record, expectedWorkflowRevision) {
    const actual = workflowRevisionFor(record);
    if (actual < 0) throw new Error("region insight workflowRevision is invalid");
    const missing = expectedWorkflowRevision === undefined
      || expectedWorkflowRevision === null
      || expectedWorkflowRevision === "";
    if (record && missing) {
      throw new RegionInsightRuntimeError("The latest workflow revision is required.", {
        code: "REGION_WORKFLOW_REVISION_REQUIRED",
        statusCode: 409,
        details: [{ actualWorkflowRevision: actual }]
      });
    }
    if (!record && missing) return;
    if (!Number.isSafeInteger(expectedWorkflowRevision) || expectedWorkflowRevision < 0 || expectedWorkflowRevision !== actual) {
      throw new RegionInsightRuntimeError("The region workflow changed. Reload the latest record and retry.", {
        code: "REGION_WORKFLOW_REVISION_CONFLICT",
        statusCode: 409,
        details: [{ expectedWorkflowRevision, actualWorkflowRevision: actual }]
      });
    }
  }

  function durableRegionIdentity(region) {
    return {
      regionKey: text(region.regionKey, 160),
      sido: text(region.sido, 40),
      sigungu: text(region.sigungu, 80),
      displayLabel: text(region.displayLabel || `${region.sido} ${region.sigungu}`, 120)
    };
  }

  function syncPublicationHistory(history = [], publication = {}) {
    if (!publication.publicationId) return [...history];
    return history.map((entry) => {
      if (entry.publicationId !== publication.publicationId) return entry;
      return {
        ...entry,
        publicationId: publication.publicationId,
        version: publication.version,
        publishedAt: publication.publishedAt,
        publishedBy: publication.publishedBy || entry.publishedBy || "",
        supersededAt: publication.supersededAt || "",
        publication: cloneJson(publication)
      };
    });
  }

  function validateStore(store = {}) {
    if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("region insight store must be an object");
    if (store.documentType !== STORE_DOCUMENT_TYPE) throw new Error("region insight store documentType is invalid");
    if (store.schemaVersion !== STORE_SCHEMA_VERSION) throw new Error("region insight store schemaVersion is invalid");
    if (!store.regions || typeof store.regions !== "object" || Array.isArray(store.regions)) throw new Error("region insight store regions must be an object");
    const storePublicationIds = new Set();
    for (const [regionKey, record] of Object.entries(store.regions)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`region insight record is invalid: ${regionKey}`);
      if (record.region?.regionKey !== regionKey) throw new Error(`region insight record key mismatch: ${regionKey}`);
      if (!text(record.region?.sido, 40) || !text(record.region?.sigungu, 80)) {
        throw new Error(`region insight record identity is invalid: ${regionKey}`);
      }
      if (workflowRevisionFor(record) < 0) throw new Error(`region insight workflowRevision is invalid: ${regionKey}`);
      const validation = validateRegionInsightState(record.state || {});
      if (!validation.valid) throw new Error(`region insight state is invalid: ${regionKey}`);
      if ((record.state || {}).regionKey !== regionKey) throw new Error(`region insight state regionKey mismatch: ${regionKey}`);
      if (!Array.isArray(record.auditHistory) || !Array.isArray(record.publicationHistory)) {
        throw new Error(`region insight histories are invalid: ${regionKey}`);
      }
      const publicationVersions = new Set();
      for (const [historyIndex, entry] of record.publicationHistory.entries()) {
        const prefix = `${regionKey}.publicationHistory[${historyIndex}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${prefix} is invalid`);
        const publication = entry.publication;
        if (!publication || typeof publication !== "object" || Array.isArray(publication)) throw new Error(`${prefix}.publication is invalid`);
        if (!entry.publicationId || entry.publicationId !== publication.publicationId) throw new Error(`${prefix}.publicationId mismatch`);
        if (!entry.version || entry.version !== publication.version) throw new Error(`${prefix}.version mismatch`);
        if (!entry.publishedAt || entry.publishedAt !== publication.publishedAt) throw new Error(`${prefix}.publishedAt mismatch`);
        const durableSnapshot = Boolean(text(publication.snapshot?.registryVersion, 120));
        const outerPublishedBy = text(entry.publishedBy, 120);
        const nestedPublishedBy = text(publication.publishedBy, 120);
        if (durableSnapshot && outerPublishedBy !== nestedPublishedBy) throw new Error(`${prefix}.publishedBy mismatch`);
        if (!durableSnapshot && nestedPublishedBy && outerPublishedBy !== nestedPublishedBy) throw new Error(`${prefix}.publishedBy mismatch`);
        if ((outerPublishedBy || nestedPublishedBy) && !validPublicationActorId(outerPublishedBy || nestedPublishedBy)) {
          throw new Error(`${prefix}.publishedBy is invalid`);
        }
        if (text(entry.supersededAt, 40) !== text(publication.supersededAt, 40)) throw new Error(`${prefix}.supersededAt mismatch`);
        if (durableSnapshot) {
          const identity = publication.snapshot || {};
          if (
            identity.regionKey !== regionKey
            || !text(identity.sido, 40)
            || !text(identity.sigungu, 80)
            || !text(identity.displayLabel, 120)
          ) {
            throw new Error(`${prefix}.snapshot region identity is invalid`);
          }
        }
        if (storePublicationIds.has(entry.publicationId)) throw new Error(`${regionKey} publicationId is duplicated across the store`);
        if (publicationVersions.has(entry.version)) throw new Error(`${regionKey} publication version is duplicated`);
        storePublicationIds.add(entry.publicationId);
        publicationVersions.add(entry.version);
        const snapshot = publication.snapshot || {};
        buildState({
          regionKey,
          draftHash: snapshot.reviewedDraftHash,
          locationAttractiveness: snapshot.locationAttractiveness,
          dataQuality: snapshot.dataQuality,
          review: {
            status: "reviewed",
            reviewedDraftHash: snapshot.reviewedDraftHash,
            reviewedAt: publication.publishedAt,
            reviewer: { id: publication.publishedBy || entry.publishedBy || "publication-history-validator" }
          },
          publication
        });
      }
      const currentPublication = record.state.publication || {};
      const activeHistoryEntries = record.publicationHistory.filter((entry) => (
        ["published", "stale"].includes(entry.publication?.status)
      ));
      if (currentPublication.status === "unpublished") {
        if (record.publicationHistory.length) throw new Error(`${regionKey} unpublished state cannot have publication history`);
      } else {
        if (!["published", "stale"].includes(currentPublication.status)) {
          throw new Error(`${regionKey} current publication status is invalid`);
        }
        if (activeHistoryEntries.length !== 1) {
          throw new Error(`${regionKey} must have exactly one current publication history entry`);
        }
        const currentEntry = record.publicationHistory.find((entry) => (
          entry.publicationId === currentPublication.publicationId
          && entry.version === currentPublication.version
          && entry.publication?.snapshot?.snapshotHash === currentPublication.snapshot?.snapshotHash
        ));
        if (!currentEntry) throw new Error(`${regionKey} current publication is missing from publication history`);
        if (activeHistoryEntries[0] !== currentEntry) {
          throw new Error(`${regionKey} current publication history link is invalid`);
        }
        if (!sameJsonValue(currentEntry.publication, currentPublication)) {
          throw new Error(`${regionKey} current publication does not match publication history`);
        }
      }
    }
    return true;
  }

  const storeOptions = {
    defaultValue: emptyRegionInsightStore,
    validator: validateStore,
    mode: 0o600,
    directoryMode: 0o700,
    space: 2
  };

  async function readStore() {
    return readJsonFile(filePath, storeOptions);
  }

  function assertExpectedDraftHash(record, expectedDraftHash, { required = false } = {}) {
    const expected = text(expectedDraftHash, 64).toLowerCase();
    if (!expected) {
      if (!required) return;
      throw new RegionInsightRuntimeError("검수한 지역 초안의 해시가 필요합니다.", {
        code: "REGION_DRAFT_HASH_REQUIRED",
        statusCode: 409
      });
    }
    const actual = text(record?.state?.draftHash, 64).toLowerCase();
    if (!actual || actual !== expected) {
      throw new RegionInsightRuntimeError("지역 초안이 변경되었습니다. 최신 초안을 다시 확인하세요.", {
        code: "REGION_DRAFT_CHANGED",
        statusCode: 409
      });
    }
  }

  function actorMeta(actor = {}) {
    return {
      id: text(actor.id || actor.username || actor.memberId || "admin", 120),
      displayName: text(actor.displayName || actor.roleLabel || actor.username || actor.memberId || "관리자", 120)
    };
  }

  function buildState(input, statusCode = 400) {
    try {
      return buildRegionInsightState(input);
    } catch (error) {
      if (error && !error.statusCode) error.statusCode = statusCode;
      throw error;
    }
  }

  function adminProjection(record = null) {
    if (!record) return null;
    return { ...cloneJson(record), workflowRevision: workflowRevisionFor(record) };
  }

  function apiResult(region, record = null, action = "read") {
    return {
      action,
      regionContext: publicRegionContext({
        regionKey: region.regionKey,
        matchStatus: "matched",
        displayLabel: `${region.sido} ${region.sigungu}`
      }, matcher),
      regionInsight: record ? adminProjection(record) : null
    };
  }

  async function readAdminRegion(regionKey) {
    const region = canonicalRegion(regionKey);
    const store = await readStore();
    return apiResult(region, store.regions[region.regionKey] || null, "read");
  }

  async function saveDraft(regionKey, payload = {}, actor = {}) {
    const region = canonicalRegion(regionKey);
    const at = nowIso();
    const by = actorMeta(actor);
    let savedRecord = null;
    await updateJsonFile(filePath, (store) => {
      const current = store.regions[region.regionKey] || null;
      assertExpectedWorkflowRevision(current, payload.expectedWorkflowRevision);
      assertExpectedDraftHash(current, payload.expectedDraftHash, { required: Boolean(current) });
      const currentState = current?.state || null;
      if (!currentState && (!payload.locationAttractiveness || !payload.dataQuality)) {
        throw new RegionInsightRuntimeError("최초 초안에는 입지점수와 데이터 품질이 모두 필요합니다.", {
          code: "REGION_DRAFT_FIELDS_REQUIRED",
          statusCode: 400
        });
      }
      let nextState = buildState({
        regionKey: region.regionKey,
        locationAttractiveness: payload.locationAttractiveness || currentState?.locationAttractiveness,
        dataQuality: payload.dataQuality || currentState?.dataQuality,
        review: currentState?.review || { status: "draft" },
        publication: currentState?.publication || { status: "unpublished" }
      });
      const draftChanged = Boolean(currentState && nextState.draftHash !== currentState.draftHash);
      if (draftChanged) {
        const review = currentState.review?.status === "changes_requested"
          ? { ...nextState.review, status: "review_required", requestedAt: at }
          : nextState.review;
        const publication = currentState.publication?.status === "published"
          ? { ...currentState.publication, status: "stale", staleAt: at }
          : nextState.publication;
        nextState = buildState({ ...nextState, review, publication });
      }
      let publicationHistory = [...(current?.publicationHistory || [])];
      if (draftChanged && nextState.publication?.publicationId) {
        publicationHistory = syncPublicationHistory(publicationHistory, nextState.publication);
      }
      savedRecord = {
        region: {
          regionKey: region.regionKey,
          sido: text(region.sido, 40),
          sigungu: text(region.sigungu, 80)
        },
        state: nextState,
        createdAt: current?.createdAt || at,
        updatedAt: at,
        updatedBy: by.id,
        workflowRevision: workflowRevisionFor(current) + 1,
        auditHistory: [
          ...(current?.auditHistory || []),
          { action: "draft_saved", at, by: by.id, draftHash: nextState.draftHash }
        ].slice(-200),
        publicationHistory
      };
      return {
        ...store,
        updatedAt: at,
        regions: { ...store.regions, [region.regionKey]: savedRecord }
      };
    }, storeOptions);
    return apiResult(region, savedRecord, "draft_saved");
  }

  async function reviewDraft(regionKey, payload = {}, actor = {}) {
    const region = canonicalRegion(regionKey);
    const at = nowIso();
    const by = actorMeta(actor);
    const requestedStatus = text(payload.status || "reviewed", 32).toLowerCase();
    if (!["reviewed", "review_required", "changes_requested"].includes(requestedStatus)) {
      throw new RegionInsightRuntimeError("지원하지 않는 지역 초안 검수 상태입니다.", {
        code: "INVALID_REGION_REVIEW_STATUS",
        statusCode: 400
      });
    }
    let savedRecord = null;
    await updateJsonFile(filePath, (store) => {
      const current = store.regions[region.regionKey] || null;
      if (!current) {
        throw new RegionInsightRuntimeError("검수할 지역 초안을 찾지 못했습니다.", {
          code: "REGION_DRAFT_NOT_FOUND",
          statusCode: 404
        });
      }
      assertExpectedWorkflowRevision(current, payload.expectedWorkflowRevision);
      assertExpectedDraftHash(current, payload.expectedDraftHash, { required: true });
      const currentState = current.state;
      const review = {
        status: requestedStatus,
        reviewedDraftHash: requestedStatus === "reviewed" ? currentState.draftHash : currentState.review?.reviewedDraftHash || "",
        reviewedAt: requestedStatus === "reviewed" ? at : currentState.review?.reviewedAt || "",
        requestedAt: requestedStatus === "reviewed" ? currentState.review?.requestedAt || "" : at,
        reviewer: by,
        adminMemo: text(payload.adminMemo || payload.note, 2000)
      };
      const publication = currentState.publication?.status === "published" && requestedStatus !== "reviewed"
        ? { ...currentState.publication, status: "stale", staleAt: at }
        : currentState.publication;
      const nextState = buildState({ ...currentState, review, publication });
      const publicationHistory = nextState.publication?.publicationId
        ? syncPublicationHistory(current.publicationHistory || [], nextState.publication)
        : [...(current.publicationHistory || [])];
      savedRecord = {
        ...current,
        state: nextState,
        updatedAt: at,
        updatedBy: by.id,
        workflowRevision: workflowRevisionFor(current) + 1,
        auditHistory: [
          ...(current.auditHistory || []),
          { action: "review_saved", at, by: by.id, draftHash: nextState.draftHash, reviewStatus: nextState.review.status }
        ].slice(-200),
        publicationHistory
      };
      return {
        ...store,
        updatedAt: at,
        regions: { ...store.regions, [region.regionKey]: savedRecord }
      };
    }, storeOptions);
    return apiResult(region, savedRecord, "review_saved");
  }

  async function publishDraft(regionKey, payload = {}, actor = {}) {
    const region = canonicalRegion(regionKey);
    const at = nowIso();
    const by = actorMeta(actor);
    const version = text(payload.version, 80);
    if (!version) {
      throw new RegionInsightRuntimeError("발행 버전이 필요합니다.", {
        code: "REGION_PUBLICATION_VERSION_REQUIRED",
        statusCode: 400
      });
    }
    let savedRecord = null;
    await updateJsonFile(filePath, (store) => {
      const current = store.regions[region.regionKey] || null;
      if (!current) {
        throw new RegionInsightRuntimeError("발행할 지역 초안을 찾지 못했습니다.", {
          code: "REGION_DRAFT_NOT_FOUND",
          statusCode: 404
        });
      }
      assertExpectedWorkflowRevision(current, payload.expectedWorkflowRevision);
      assertExpectedDraftHash(current, payload.expectedDraftHash, { required: true });
      if ((current.publicationHistory || []).some((entry) => entry.version === version)) {
        throw new RegionInsightRuntimeError("이미 사용한 지역 발행 버전입니다.", {
          code: "REGION_PUBLICATION_VERSION_CONFLICT",
          statusCode: 409
        });
      }
      const publicationId = text(idFactory({ regionKey: region.regionKey, version, at }), 120);
      if (!publicationId) {
        throw new RegionInsightRuntimeError("발행 ID를 생성하지 못했습니다.", {
          code: "REGION_PUBLICATION_ID_REQUIRED",
          statusCode: 500
        });
      }
      if (Object.values(store.regions || {}).some((record) => (
        (record?.publicationHistory || []).some((entry) => entry.publicationId === publicationId)
      ))) {
        throw new RegionInsightRuntimeError("이미 사용한 지역 발행 ID입니다.", {
          code: "REGION_PUBLICATION_ID_CONFLICT",
          statusCode: 409
        });
      }
      let nextState;
      try {
        nextState = publishRegionInsightState(current.state, {
          publicationId,
          version,
          publishedAt: at,
          publishedBy: by.id,
          registryVersion,
          regionIdentity: durableRegionIdentity(region),
          adminMemo: text(payload.adminMemo || payload.note, 2000)
        });
      } catch (error) {
        if (error && !error.statusCode) error.statusCode = 409;
        throw error;
      }
      const immutablePublication = cloneJson(nextState.publication);
      const supersededHistory = (current.publicationHistory || []).map((entry) => {
        const publication = entry.publication || {};
        if (!["published", "stale"].includes(publication.status)) return entry;
        return {
          ...entry,
          publishedBy: publication.publishedBy || entry.publishedBy || "",
          supersededAt: entry.supersededAt || at,
          publication: {
            ...publication,
            status: "superseded",
            supersededAt: publication.supersededAt || at
          }
        };
      });
      savedRecord = {
        ...current,
        state: nextState,
        updatedAt: at,
        updatedBy: by.id,
        workflowRevision: workflowRevisionFor(current) + 1,
        auditHistory: [
          ...(current.auditHistory || []),
          { action: "published", at, by: by.id, draftHash: nextState.draftHash, publicationId, version }
        ].slice(-200),
        publicationHistory: [
          ...supersededHistory,
          {
            publicationId,
            version,
            publishedAt: at,
            publishedBy: by.id,
            supersededAt: "",
            publication: immutablePublication
          }
        ]
      };
      return {
        ...store,
        updatedAt: at,
        regions: { ...store.regions, [region.regionKey]: savedRecord }
      };
    }, storeOptions);
    return apiResult(region, savedRecord, "published");
  }

  async function stateForRegion(regionKey) {
    const region = canonicalRegion(regionKey);
    const store = await readStore();
    return store.regions[region.regionKey]?.state || null;
  }

  return Object.freeze({
    filePath,
    matcher,
    publishDraft,
    readAdminRegion,
    readStore,
    reviewDraft,
    saveDraft,
    stateForRegion
  });
}

module.exports = {
  REGION_CONTEXT_STATUSES,
  RegionInsightRuntimeError,
  STORE_DOCUMENT_TYPE,
  STORE_SCHEMA_VERSION,
  createRegionInsightRuntime,
  emptyRegionInsightStore,
  projectB2BRegionInsight,
  publicRegionContext,
  resolveRunRegionContext
};
