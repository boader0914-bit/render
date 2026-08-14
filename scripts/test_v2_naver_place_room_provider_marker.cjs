"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  CAPTURE_KIND,
  FIXTURE_SCHEMA_VERSION,
  LIVE_CAPTURE_KIND,
  RESULT_SCHEMA_VERSION,
  collectRoomProviderMarker,
  parseProviderMarker,
  parseRoomHeading,
  standardizeProviderChannel
} = require("./v2_naver_place_room_provider_marker_contract.cjs");

let assertions = 0;
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
function deepEqual(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}
function throws(fn, validator) {
  assertions += 1;
  assert.throws(fn, validator);
}
function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function fixture(overrides = {}) {
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    placeId: "1460523479",
    captureKind: CAPTURE_KIND,
    sections: [{ sectionKind: "room_header", headingText: "객실6", extraText: "[캠핑톡]" }],
    ...overrides
  };
}

(() => {
  const guard = installFixtureNetworkGuard({ label: "N5-D1 room provider marker tests" });
  try {
    const fixtureFile = path.resolve(__dirname, "..", "tests", "fixtures", "v2_naver_place_room_provider_marker_positive.json");
    const positiveDocument = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
    const positive = collectRoomProviderMarker(positiveDocument, {
      fixtureDigestSha256: "a".repeat(64)
    });

    equal(positive.schemaVersion, RESULT_SCHEMA_VERSION);
    equal(positive.placeId, "1460523479");
    equal(positive.roomCount, 6);
    equal(positive.providerMarker.observed, true);
    equal(positive.providerMarker.displayText, "[캠핑톡]");
    equal(positive.providerMarker.sourceLabel, "캠핑톡");
    equal(positive.providerMarker.standardChannelId, "campingtalk");
    equal(positive.providerMarker.standardChannelName, "캠핑톡");
    equal(positive.providerMarker.mappingStatus, "mapped");
    equal(positive.evidence.level, "high");
    equal(positive.evidence.type, "explicit_room_header_provider_marker");
    equal(positive.evidence.source, "naver_place_room_section_header");
    equal(positive.evidence.captureKind, CAPTURE_KIND);
    equal(positive.evidence.duplicateObservationCount, 1);
    equal(positive.evidence.fixtureDigestSha256, "a".repeat(64));
    equal(positive.audit.fixtureMode, true);
    equal(positive.audit.externalRequests, 0);
    equal(positive.audit.operationalWrites, 0);
    equal(positive.audit.rawProviderResponseStored, false);

    const liveProjection = collectRoomProviderMarker({
      ...positiveDocument,
      captureKind: LIVE_CAPTURE_KIND
    });
    equal(liveProjection.evidence.captureKind, LIVE_CAPTURE_KIND);
    equal(liveProjection.audit.fixtureMode, false);

    deepEqual(parseRoomHeading(" 객실 006 "), { headingText: "객실 006", roomCount: 6 });
    equal(parseProviderMarker("【 캠핑톡 】").standardChannelId, "campingtalk");
    equal(standardizeProviderChannel("Camping Talk").standardChannelId, "campingtalk");
    equal(standardizeProviderChannel("야놀자").standardChannelId, "nol");
    equal(standardizeProviderChannel("NOL").standardChannelName, "NOL/야놀자");
    equal(standardizeProviderChannel("여기어때").standardChannelId, "yeogi");
    equal(standardizeProviderChannel("떠나요").standardChannelId, "ddnayo");
    equal(standardizeProviderChannel("ONDA").standardChannelId, "onda");

    const noMarker = collectRoomProviderMarker(fixture({
      sections: [{ sectionKind: "room_header", headingText: "객실 6", extraText: "" }]
    }));
    equal(noMarker.roomCount, 6);
    equal(noMarker.providerMarker.observed, false);
    equal(noMarker.providerMarker.mappingStatus, "absent");
    equal(noMarker.providerMarker.standardChannelId, null);
    equal(noMarker.evidence.level, "medium");
    equal(noMarker.evidence.type, "explicit_room_header_count_only");

    const unknownMarker = collectRoomProviderMarker(fixture({
      sections: [{ sectionKind: "room_header", headingText: "객실6", extraText: "[새공급자]" }]
    }));
    equal(unknownMarker.providerMarker.observed, true);
    equal(unknownMarker.providerMarker.mappingStatus, "unmapped");
    equal(unknownMarker.providerMarker.standardChannelId, null);
    equal(unknownMarker.evidence.level, "medium");
    equal(unknownMarker.evidence.type, "explicit_unmapped_room_header_provider_marker");

    const duplicated = collectRoomProviderMarker(fixture({
      sections: [
        { sectionKind: "room_header", headingText: "객실6", extraText: "[캠핑톡]" },
        { sectionKind: "room_header", headingText: "객실 6", extraText: "【캠핑톡】" }
      ]
    }));
    equal(duplicated.roomCount, 6);
    equal(duplicated.evidence.duplicateObservationCount, 2);

    throws(() => collectRoomProviderMarker(fixture({
      sections: [
        { sectionKind: "room_header", headingText: "객실6", extraText: "[캠핑톡]" },
        { sectionKind: "room_header", headingText: "객실7", extraText: "[캠핑톡]" }
      ]
    })), (error) => error?.code === "V2_NAVER_ROOM_MARKER_AMBIGUOUS");
    throws(() => collectRoomProviderMarker(fixture({
      sections: [
        { sectionKind: "room_header", headingText: "객실6", extraText: "[캠핑톡]" },
        { sectionKind: "room_header", headingText: "객실6", extraText: "[ONDA]" }
      ]
    })), (error) => error?.code === "V2_NAVER_ROOM_MARKER_AMBIGUOUS");
    throws(() => parseRoomHeading("객실"), (error) => error?.code === "V2_NAVER_ROOM_HEADING_INVALID");
    throws(() => parseRoomHeading("객실0"), (error) => error?.code === "V2_NAVER_ROOM_HEADING_INVALID");
    throws(() => parseProviderMarker("캠핑톡"), (error) => error?.code === "V2_NAVER_ROOM_PROVIDER_MARKER_INVALID");
    throws(() => collectRoomProviderMarker(fixture({ placeId: "place-1460523479" })), (error) => error?.code === "V2_NAVER_ROOM_MARKER_INPUT_INVALID");
    throws(() => collectRoomProviderMarker({ ...fixture(), rawHtml: "forbidden" }), (error) => error?.code === "V2_NAVER_ROOM_MARKER_INPUT_INVALID");
    throws(() => collectRoomProviderMarker(fixture({ sections: [] })), (error) => error?.code === "V2_NAVER_ROOM_MARKER_INPUT_INVALID");
    throws(() => collectRoomProviderMarker(fixture(), { fixtureDigestSha256: "bad" }), (error) => error?.code === "V2_NAVER_ROOM_MARKER_INPUT_INVALID");

    const runner = path.resolve(__dirname, "v2_naver_place_room_provider_marker_one_shot.cjs");
    const preload = path.resolve(__dirname, "fixture_network_guard_preload.cjs");
    const child = spawnSync(process.execPath, ["--require", preload, runner, "fixture", fixtureFile], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      env: { ...process.env }
    });
    equal(child.status, 0, child.stderr);
    equal(child.stderr, "");
    equal(child.stdout.trim().split(/\r?\n/u).length, 1);
    const childResult = JSON.parse(child.stdout);
    equal(childResult.placeId, "1460523479");
    equal(childResult.roomCount, 6);
    equal(childResult.providerMarker.standardChannelId, "campingtalk");
    equal(childResult.evidence.level, "high");
    ok(/^[a-f0-9]{64}$/u.test(childResult.evidence.fixtureDigestSha256));
    equal(childResult.audit.externalRequests, 0);
    equal(childResult.audit.operationalWrites, 0);
    equal(/cookie|authorization|bearer|token|rawHtml|rawResponse/iu.test(child.stdout), false);

    const forbiddenPath = spawnSync(process.execPath, [runner, "fixture", path.resolve(__dirname, "package.json")], {
      encoding: "utf8"
    });
    equal(forbiddenPath.status, 1);
    equal(forbiddenPath.stdout, "");
    const forbiddenError = JSON.parse(forbiddenPath.stderr);
    equal(forbiddenError.code, "V2_NAVER_ROOM_MARKER_FIXTURE_PATH_INVALID");
    equal(forbiddenError.retryable, false);

    equal(guard.blockedAttempts(), 0);
    console.log(JSON.stringify({
      schemaVersion: "v2-naver-place-room-provider-marker-test.v1",
      status: "passed",
      assertions,
      positivePlaceId: positive.placeId,
      roomCount: positive.roomCount,
      standardChannelId: positive.providerMarker.standardChannelId,
      evidenceLevel: positive.evidence.level,
      externalRequests: 0,
      operationalWrites: 0
    }));
  } finally {
    guard.restore();
  }
})();
