"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { collectRoomProviderMarker } = require("./v2_naver_place_room_provider_marker_contract.cjs");

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function fixturePath(value) {
  const fixturesRoot = path.resolve(__dirname, "..", "tests", "fixtures");
  const target = path.resolve(String(value || ""));
  if (!target.startsWith(`${fixturesRoot}${path.sep}`) || path.extname(target).toLowerCase() !== ".json") {
    fail("V2_NAVER_ROOM_MARKER_FIXTURE_PATH_INVALID", "Fixture path must be a JSON file under tests/fixtures");
  }
  return target;
}

function readFixture(target) {
  const body = fs.readFileSync(target);
  if (body.length < 2 || body.length > 64 * 1024) {
    fail("V2_NAVER_ROOM_MARKER_FIXTURE_SIZE_INVALID", "Fixture size is invalid");
  }
  try {
    return {
      document: JSON.parse(body.toString("utf8")),
      digest: crypto.createHash("sha256").update(body).digest("hex")
    };
  } catch {
    fail("V2_NAVER_ROOM_MARKER_FIXTURE_JSON_INVALID", "Fixture JSON is invalid");
  }
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "fixture") {
    fail("V2_NAVER_ROOM_MARKER_MODE_INVALID", "Only fixture mode is allowed in N5-D1");
  }
  const target = fixturePath(argv[1]);
  const fixture = readFixture(target);
  return collectRoomProviderMarker(fixture.document, { fixtureDigestSha256: fixture.digest });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: "v2-naver-place-room-provider-marker-error.v1",
      status: "failed",
      code: String(error?.code || "V2_NAVER_ROOM_MARKER_FAILED"),
      retryable: false
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { fixturePath, main, readFixture };
