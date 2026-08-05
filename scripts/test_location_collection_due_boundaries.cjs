"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "location collection due boundary fixtures" });

try {
  const {
    buildCollectionRunPlan,
    buildCollectionTaskKey,
    computeMeasurementWindow,
    computeOverlapWindow,
    isCollectionDue,
    readCollectionPolicyRegistry
  } = require("./location_collection_planner.cjs");
  const { buildCollectionSnapshot } = require("./location_collection_snapshot_contract.cjs");

  let snapshotSequence = 0;
  const snapshot = ({ sourceId, regionKey, taskKey, status, collectedAt, asOf, measurementPeriod, watermark = null }) => {
    snapshotSequence += 1;
    const observed = status === "ready" || status === "zero";
    const zero = status === "zero";
    return buildCollectionSnapshot({
      snapshotId: `snapshot-due-fixture-${snapshotSequence}`,
      taskKey,
      sourceId,
      regionKey,
      sharedCollectionScope: null,
      operation: "fixtureOperation",
      measurementPeriod,
      overlapPeriod: null,
      collectedAt,
      asOf,
      providerPublishedAt: null,
      watermark,
      requestPlanVersion: "request-plan.fixture.v1",
      mappingVersion: "mapping.fixture.v1",
      sourceSchemaVersion: "source.fixture.v1",
      sampleCount: observed ? (zero ? 0 : 1) : null,
      coverage: observed
        ? { numerator: zero ? 0 : 1, denominator: 1, ratio: zero ? 0 : 1 }
        : { numerator: null, denominator: null, ratio: null },
      status,
      confidence: observed ? { grade: "A", score: 90 } : { grade: "U", score: null },
      penalties: [],
      supersedesSnapshotId: null,
      provenance: { sourceId, fixture: true }
    });
  };

  const registry = readCollectionPolicyRegistry();
  const canonicalRegionRegistry = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "web", "data", "location_region_registry.json"),
    "utf8"
  ));
  const policy = (sourceId) => {
    const found = registry.policies.find((entry) => entry.sourceId === sourceId);
    assert.ok(found, `missing policy ${sourceId}`);
    return found;
  };
  const common = {
    regionKey: "kr_gyeonggi_pocheon",
    operation: "fixtureOperation",
    sourceSchemaVersion: "source.fixture.v1",
    mappingVersion: "mapping.fixture.v1"
  };

  const events = policy("kto.tour_info.events");
  assert.equal(isCollectionDue(events, { ...common, asOf: "2026-08-04T18:29:59.999Z" }).due, false);
  const eventDue = isCollectionDue(events, { ...common, asOf: "2026-08-04T18:30:00.000Z" });
  assert.equal(eventDue.due, true);
  assert.deepEqual(eventDue.measurementPeriod, { from: "2026-08-05", to: "2026-08-05" });

  const resources = policy("kto.tour_info.resources");
  assert.equal(isCollectionDue(resources, { ...common, asOf: "2026-08-09T17:59:59.999Z" }).dueReason, "before_scheduled_local_time");
  const weeklyDue = isCollectionDue(resources, { ...common, asOf: "2026-08-09T18:00:00.000Z" });
  assert.equal(weeklyDue.due, true);
  assert.deepEqual(weeklyDue.measurementPeriod, { from: "2026-08-10", to: "2026-08-10" });

  const visitors = policy("kto.bigdata.visitors");
  assert.equal(isCollectionDue(visitors, { ...common, asOf: "2026-08-31T19:59:59.999Z" }).due, false);
  const monthlyDue = isCollectionDue(visitors, { ...common, asOf: "2026-08-31T20:00:00.000Z" });
  assert.equal(monthlyDue.due, true);
  assert.deepEqual(monthlyDue.measurementPeriod, { from: "2026-08-01", to: "2026-08-31" });
  assert.deepEqual(computeMeasurementWindow(visitors, "2026-07-31T15:00:00.000Z"), {
    from: "2026-07-01",
    to: "2026-07-31"
  }, "closed month selection must use the Asia/Seoul calendar at the UTC boundary");

  const closedMonthContext = {
    ...common,
    asOf: "2026-09-30T00:00:00.000Z"
  };
  const closedMonthPeriod = computeMeasurementWindow(visitors, closedMonthContext);
  const closedMonthTaskKey = buildCollectionTaskKey(visitors, closedMonthContext);
  const closedMonthSnapshot = snapshot({
    sourceId: visitors.sourceId,
    regionKey: common.regionKey,
    taskKey: closedMonthTaskKey,
    status: "ready",
    collectedAt: "2026-09-01T00:00:00.000Z",
    asOf: closedMonthContext.asOf,
    measurementPeriod: closedMonthPeriod,
    watermark: { closedMonth: "2026-08" }
  });
  assert.equal(isCollectionDue(visitors, {
    ...closedMonthContext,
    snapshots: [closedMonthSnapshot]
  }).dueReason, "successful_snapshot_already_exists");
  assert.equal(isCollectionDue(visitors, {
    ...closedMonthContext,
    snapshots: [closedMonthSnapshot],
    lateArrivalReplay: { approved: false, reason: "late_arrival", version: "late-2026-08.v1" }
  }).dueReason, "late_arrival_replay_approval_required");
  assert.equal(isCollectionDue(visitors, {
    ...closedMonthContext,
    snapshots: [closedMonthSnapshot],
    lateArrivalReplay: { approved: true, reason: "late_arrival", version: "" }
  }).dueReason, "late_arrival_replay_version_required");
  assert.equal(isCollectionDue(visitors, {
    ...closedMonthContext,
    snapshots: [closedMonthSnapshot],
    lateArrivalReplay: { approved: true, reason: "manual_retry", version: "retry.v1" }
  }).dueReason, "late_arrival_replay_reason_not_allowed");

  const approvedLateArrival = {
    approved: true,
    reason: "late_arrival",
    version: "late-2026-08.v1"
  };
  const lateArrivalDue = isCollectionDue(visitors, {
    ...closedMonthContext,
    snapshots: [closedMonthSnapshot],
    lateArrivalReplay: approvedLateArrival
  });
  assert.equal(lateArrivalDue.due, true);
  assert.equal(lateArrivalDue.dueReason, "approved_late_arrival_replay");
  assert.notEqual(lateArrivalDue.taskKey, closedMonthTaskKey);
  assert.deepEqual(lateArrivalDue.lateArrivalReplay, {
    reason: "late_arrival",
    version: "late-2026-08.v1"
  });

  const replaySnapshot = snapshot({
    sourceId: visitors.sourceId,
    regionKey: common.regionKey,
    taskKey: lateArrivalDue.taskKey,
    status: "ready",
    collectedAt: "2026-09-01T00:00:00.000Z",
    asOf: closedMonthContext.asOf,
    measurementPeriod: closedMonthPeriod,
    watermark: { closedMonthRevision: "late-2026-08.v1" }
  });
  assert.equal(isCollectionDue(visitors, {
    ...closedMonthContext,
    snapshots: [closedMonthSnapshot, replaySnapshot],
    lateArrivalReplay: approvedLateArrival
  }).dueReason, "successful_snapshot_already_exists", "the same approved replay version must remain idempotent");
  assert.equal(isCollectionDue(visitors, {
    ...closedMonthContext,
    snapshots: [closedMonthSnapshot, replaySnapshot],
    lateArrivalReplay: { approved: true, reason: "provider_revision", version: approvedLateArrival.version }
  }).dueReason, "successful_snapshot_already_exists",
  "a replay version must remain unique even if the caller changes the allowed reason");
  const providerRevisionDue = isCollectionDue(visitors, {
    ...closedMonthContext,
    snapshots: [closedMonthSnapshot, replaySnapshot],
    lateArrivalReplay: { approved: true, reason: "provider_revision", version: "provider-2026-08.v2" }
  });
  assert.equal(providerRevisionDue.dueReason, "approved_provider_revision_replay");
  assert.notEqual(providerRevisionDue.taskKey, lateArrivalDue.taskKey);

  const replayPlan = buildCollectionRunPlan({
    policies: [visitors],
    canonicalRegionRegistry,
    regions: [common.regionKey],
    asOf: closedMonthContext.asOf,
    operations: { [visitors.sourceId]: common.operation },
    sourceVersions: {
      [visitors.sourceId]: {
        sourceSchemaVersion: common.sourceSchemaVersion,
        mappingVersion: common.mappingVersion
      }
    },
    lastSuccessfulSnapshot: closedMonthSnapshot,
    lateArrivalReplays: { [visitors.sourceId]: approvedLateArrival }
  });
  assert.equal(replayPlan.tasks.length, 1);
  assert.equal(replayPlan.tasks[0].dueReason, "approved_late_arrival_replay");
  assert.deepEqual(replayPlan.tasks[0].lateArrivalReplay, {
    reason: "late_arrival",
    version: "late-2026-08.v1"
  });
  assert.deepEqual(Object.keys(replayPlan.tasks[0].lateArrivalReplay).sort(), ["reason", "version"]);

  const weather = policy("kma.asos.daily_weather");
  const weatherPeriod = computeMeasurementWindow(weather, "2026-08-04T19:00:00.000Z");
  assert.deepEqual(weatherPeriod, { from: "2026-08-04", to: "2026-08-04" });
  assert.deepEqual(computeOverlapWindow(weather, weatherPeriod), {
    from: "2026-07-29",
    to: "2026-08-04"
  }, "the approved query window must contain seven days total, including the current closed day");
  assert.deepEqual(computeOverlapWindow(visitors, { from: "2026-07-01", to: "2026-07-31" }), {
    from: "2026-06-01",
    to: "2026-07-31"
  }, "the two-month overlap must contain the current closed month plus one prior month");

  const datalab = policy("naver.datalab.search_trend");
  assert.equal(isCollectionDue(datalab, { ...common, asOf: "2026-08-05T00:00:00.000Z" }).dueReason, "rolling_window_contract_unresolved");
  assert.deepEqual(computeMeasurementWindow(datalab, {
    asOf: "2026-08-05T00:00:00.000Z",
    rollingDays: 30
  }), { from: "2026-07-06", to: "2026-08-04" });
  assert.equal(isCollectionDue(datalab, {
    ...common,
    asOf: "2026-08-05T00:00:00.000Z",
    rollingDays: 30,
    keywordGroupVersion: "keywords.fixture.v1",
    anchorVersion: "anchor.fixture.v1",
    timeUnit: "date"
  }).due, true);

  const datalabContext = {
    ...common,
    asOf: "2026-09-30T00:00:00.000Z",
    rollingDays: 30,
    keywordGroupVersion: "keyword-group.fixture.v1",
    anchorVersion: "anchor.fixture.v1",
    timeUnit: "date"
  };
  const datalabTaskKey = buildCollectionTaskKey(datalab, datalabContext);
  const datalabSnapshot = snapshot({
    sourceId: datalab.sourceId,
    regionKey: common.regionKey,
    taskKey: datalabTaskKey,
    status: "ready",
    collectedAt: "2026-09-28T00:00:00.000Z",
    asOf: datalabContext.asOf,
    measurementPeriod: computeMeasurementWindow(datalab, datalabContext),
    watermark: { keywordGroupVersion: "keyword-group.fixture.v1" }
  });
  assert.equal(isCollectionDue(datalab, {
    ...datalabContext,
    snapshots: [datalabSnapshot]
  }).dueReason, "successful_snapshot_already_exists");
  const keywordChanged = isCollectionDue(datalab, {
    ...datalabContext,
    snapshots: [datalabSnapshot],
    keywordGroupVersion: "keyword-group.fixture.v2"
  });
  assert.equal(keywordChanged.due, true);
  assert.notEqual(keywordChanged.taskKey, datalabTaskKey);
  assert.notEqual(buildCollectionTaskKey(datalab, { ...datalabContext, anchorVersion: "anchor.fixture.v2" }), datalabTaskKey);
  assert.notEqual(buildCollectionTaskKey(datalab, { ...datalabContext, timeUnit: "week" }), datalabTaskKey);

  const kosis = policy("kosis.population.sigungu");
  assert.equal(isCollectionDue(kosis, { ...common, asOf: "2026-08-05T00:00:00.000Z" }).dueReason, "release_period_unavailable");
  const releaseDue = isCollectionDue(kosis, {
    ...common,
    asOf: "2026-08-05T00:00:00.000Z",
    releaseMeasurementPeriod: { from: "2026-07-01", to: "2026-07-31" },
    providerReleaseVersion: "release.fixture.v1",
    tableContractVersion: "table.fixture.v1"
  });
  assert.equal(releaseDue.due, true);
  assert.equal(releaseDue.dueReason, "new_provider_release");
  const releaseSnapshot = snapshot({
    sourceId: kosis.sourceId,
    regionKey: common.regionKey,
    taskKey: releaseDue.taskKey,
    status: "ready",
    collectedAt: "2026-08-01T00:00:00.000Z",
    asOf: "2026-08-05T00:00:00.000Z",
    measurementPeriod: releaseDue.measurementPeriod,
    watermark: { release: "release.fixture.v1" }
  });
  const completedReleaseContext = {
    ...common,
    asOf: "2026-08-05T00:00:00.000Z",
    releaseMeasurementPeriod: releaseDue.measurementPeriod,
    providerReleaseVersion: "release.fixture.v1",
    tableContractVersion: "table.fixture.v1",
    snapshots: [releaseSnapshot]
  };
  assert.equal(isCollectionDue(kosis, {
    ...completedReleaseContext,
    lateArrivalReplay: { approved: false, reason: "provider_revision", version: "kosis-2026-07.r1" }
  }).dueReason, "late_arrival_replay_approval_required");
  assert.equal(isCollectionDue(kosis, {
    ...completedReleaseContext,
    lateArrivalReplay: { approved: true, reason: "late_arrival", version: "kosis-2026-07.r1" }
  }).dueReason, "late_arrival_replay_reason_not_allowed");
  const approvedReleaseRevision = {
    approved: true,
    reason: "provider_revision",
    version: "kosis-2026-07.r1"
  };
  const releaseRevisionDue = isCollectionDue(kosis, {
    ...completedReleaseContext,
    lateArrivalReplay: approvedReleaseRevision
  });
  assert.equal(releaseRevisionDue.due, true);
  assert.equal(releaseRevisionDue.dueReason, "approved_provider_revision_replay");
  assert.notEqual(releaseRevisionDue.taskKey, releaseDue.taskKey);
  const releaseRevisionSnapshot = snapshot({
    sourceId: kosis.sourceId,
    regionKey: common.regionKey,
    taskKey: releaseRevisionDue.taskKey,
    status: "ready",
    collectedAt: "2026-08-02T00:00:00.000Z",
    asOf: "2026-08-05T00:00:00.000Z",
    measurementPeriod: releaseDue.measurementPeriod,
    watermark: { revision: approvedReleaseRevision.version }
  });
  assert.equal(isCollectionDue(kosis, {
    ...completedReleaseContext,
    snapshots: [releaseSnapshot, releaseRevisionSnapshot],
    lateArrivalReplay: approvedReleaseRevision
  }).dueReason, "successful_snapshot_already_exists",
  "the same approved KOSIS provider revision must not be recollected");
  assert.equal(isCollectionDue(kosis, {
    ...common,
    asOf: "2026-08-05T00:00:00.000Z",
    releaseMeasurementPeriod: { from: "2026-09-01", to: "2026-09-30" }
  }).dueReason, "measurement_period_after_as_of");

  assert.equal(isCollectionDue(policy("mois.legal_dong.reference"), { ...common, asOf: "2026-08-05T00:00:00.000Z" }).dueReason, "automatic_collection_forbidden");
  assert.equal(isCollectionDue(policy("public.raw_sns.regional_mentions"), { ...common, asOf: "2026-08-05T00:00:00.000Z" }).dueReason, "source_unavailable");
  assert.equal(isCollectionDue(events, { ...common, asOf: "2026-08-05T00:00:00.000Z", triggerContext: "b2b_read" }).dueReason, "external_call_on_read_forbidden");

  const searchAd = policy("naver.searchad.keyword_volume");
  const septemberContext = {
    ...common,
    asOf: "2026-09-30T00:00:00.000Z",
    keywordDictionaryVersion: "dictionary.fixture.v1"
  };
  const completedTaskKey = buildCollectionTaskKey(searchAd, septemberContext);
  const completedSnapshot = snapshot({
    sourceId: searchAd.sourceId,
    regionKey: common.regionKey,
    taskKey: completedTaskKey,
    status: "ready",
    collectedAt: "2026-09-01T00:00:00.000Z",
    asOf: "2026-09-30T00:00:00.000Z",
    measurementPeriod: { from: "2026-08-01", to: "2026-08-31" },
    watermark: { period: "2026-08" }
  });
  const duplicate = isCollectionDue(searchAd, { ...septemberContext, snapshots: [completedSnapshot] });
  assert.equal(duplicate.due, false);
  assert.equal(duplicate.dueReason, "successful_snapshot_already_exists");

  const changedDictionary = isCollectionDue(searchAd, {
    ...septemberContext,
    keywordDictionaryVersion: "dictionary.fixture.v2",
    snapshots: [completedSnapshot]
  });
  assert.equal(changedDictionary.due, true, "an approved dictionary version change must produce a distinct task");
  assert.notEqual(changedDictionary.taskKey, completedTaskKey);

  const recentFailure = snapshot({
    sourceId: searchAd.sourceId,
    regionKey: common.regionKey,
    taskKey: "location-collection-task:" + "f".repeat(64),
    status: "missing",
    collectedAt: "2026-09-29T00:00:00.000Z",
    asOf: "2026-09-30T00:00:00.000Z",
    measurementPeriod: { from: "2026-08-01", to: "2026-08-31" },
    watermark: { forbiddenFailureWatermark: true }
  });
  const throttled = isCollectionDue(searchAd, {
    ...septemberContext,
    keywordDictionaryVersion: "dictionary.fixture.v2",
    snapshots: [recentFailure]
  });
  assert.equal(throttled.due, false);
  assert.equal(throttled.dueReason, "minimum_refresh_interval_not_elapsed");

  const everyOtherDay = {
    ...events,
    proposedCadence: { ...events.proposedCadence, interval: 2 },
    minimumRefreshInterval: { hours: 0 }
  };
  const priorDailyAttempt = snapshot({
    sourceId: events.sourceId,
    regionKey: common.regionKey,
    taskKey: "location-collection-task:" + "e".repeat(64),
    status: "missing",
    collectedAt: "2026-08-04T00:00:00.000Z",
    asOf: "2026-08-06T00:00:00.000Z",
    measurementPeriod: { from: "2026-08-04", to: "2026-08-04" }
  });
  assert.equal(isCollectionDue(everyOtherDay, {
    ...common,
    asOf: "2026-08-04T18:30:00.000Z",
    snapshots: [priorDailyAttempt]
  }).dueReason, "cadence_interval_not_elapsed");
  assert.equal(isCollectionDue(everyOtherDay, {
    ...common,
    asOf: "2026-08-05T18:30:00.000Z",
    snapshots: [priorDailyAttempt]
  }).due, true);

  assert.equal(guard.blockedAttempts(), 0);
  console.log("Location collection due boundary fixtures passed (Asia/Seoul daily/weekly/monthly/release/rolling)");
} finally {
  guard.restore();
}
