"use strict";

const FIXTURE_SCHEMA_VERSION = "v2-naver-place-room-provider-marker-fixture.v1";
const RESULT_SCHEMA_VERSION = "v2-naver-place-room-provider-marker-result.v1";
const CAPTURE_KIND = "sanitized_visible_dom_fixture";
const LIVE_CAPTURE_KIND = "sanitized_live_html_projection";
const CAPTURE_KINDS = new Set([CAPTURE_KIND, LIVE_CAPTURE_KIND]);

class V2NaverPlaceRoomProviderMarkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "V2NaverPlaceRoomProviderMarkerError";
    this.code = code;
    this.retryable = false;
  }
}

function fail(code, message) {
  throw new V2NaverPlaceRoomProviderMarkerError(code, message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("V2_NAVER_ROOM_MARKER_INPUT_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("V2_NAVER_ROOM_MARKER_INPUT_INVALID", `${label} keys are invalid`);
  }
}

function cleanText(value, maximum = 80) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function channelAliasKey(value) {
  return cleanText(value, 80).toLocaleLowerCase("ko-KR").replace(/[\s._/()\-]+/gu, "");
}

const CHANNEL_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "campingtalk", name: "캠핑톡", aliases: Object.freeze(["캠핑톡", "campingtalk", "camping talk"]) }),
  Object.freeze({ id: "naver", name: "네이버", aliases: Object.freeze(["네이버", "naver"]) }),
  Object.freeze({ id: "nol", name: "NOL/야놀자", aliases: Object.freeze(["NOL", "야놀자", "놀유니버스", "nol야놀자"]) }),
  Object.freeze({ id: "yeogi", name: "여기어때", aliases: Object.freeze(["여기어때", "yeogi"]) }),
  Object.freeze({ id: "ddnayo", name: "떠나요", aliases: Object.freeze(["떠나요", "ddnayo"]) }),
  Object.freeze({ id: "onda", name: "ONDA", aliases: Object.freeze(["ONDA", "온다"]) })
]);

const CHANNEL_BY_ALIAS = new Map();
for (const definition of CHANNEL_DEFINITIONS) {
  for (const alias of definition.aliases) CHANNEL_BY_ALIAS.set(channelAliasKey(alias), definition);
}

function standardizeProviderChannel(label) {
  const sourceLabel = cleanText(label, 40);
  if (!sourceLabel) return null;
  const definition = CHANNEL_BY_ALIAS.get(channelAliasKey(sourceLabel));
  if (!definition) {
    return Object.freeze({
      sourceLabel,
      standardChannelId: null,
      standardChannelName: null,
      mappingStatus: "unmapped"
    });
  }
  return Object.freeze({
    sourceLabel,
    standardChannelId: definition.id,
    standardChannelName: definition.name,
    mappingStatus: "mapped"
  });
}

function parseRoomHeading(value) {
  const headingText = cleanText(value, 40);
  const match = headingText.match(/^객실\s*([0-9]{1,3})$/u);
  if (!match || Number(match[1]) < 1) {
    fail("V2_NAVER_ROOM_HEADING_INVALID", "Room heading must contain an explicit positive room count");
  }
  return Object.freeze({ headingText, roomCount: Number(match[1]) });
}

function parseProviderMarker(value) {
  const markerText = cleanText(value, 80);
  if (!markerText) {
    return Object.freeze({
      observed: false,
      displayText: "",
      sourceLabel: "",
      standardChannelId: null,
      standardChannelName: null,
      mappingStatus: "absent"
    });
  }
  const match = markerText.match(/^[\[【]\s*([^\[\]【】]{1,40}?)\s*[\]】]$/u);
  if (!match) {
    fail("V2_NAVER_ROOM_PROVIDER_MARKER_INVALID", "Provider marker must be an explicit bracketed label");
  }
  const standardized = standardizeProviderChannel(match[1]);
  return Object.freeze({
    observed: true,
    displayText: `[${standardized.sourceLabel}]`,
    ...standardized
  });
}

function normalizeSection(section, index) {
  exactKeys(section, ["sectionKind", "headingText", "extraText"], `sections[${index}]`);
  if (section.sectionKind !== "room_header") {
    fail("V2_NAVER_ROOM_MARKER_INPUT_INVALID", `sections[${index}].sectionKind is invalid`);
  }
  return Object.freeze({
    ...parseRoomHeading(section.headingText),
    providerMarker: parseProviderMarker(section.extraText)
  });
}

function collectRoomProviderMarker(input, options = {}) {
  exactKeys(input, ["schemaVersion", "placeId", "captureKind", "sections"], "fixture");
  if (input.schemaVersion !== FIXTURE_SCHEMA_VERSION || !CAPTURE_KINDS.has(input.captureKind)) {
    fail("V2_NAVER_ROOM_MARKER_INPUT_INVALID", "Fixture schema or capture kind is unsupported");
  }
  const placeId = cleanText(input.placeId, 30);
  if (!/^\d{1,30}$/u.test(placeId)) {
    fail("V2_NAVER_ROOM_MARKER_INPUT_INVALID", "Place ID is invalid");
  }
  if (!Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > 10) {
    fail("V2_NAVER_ROOM_MARKER_INPUT_INVALID", "Fixture must contain one to ten room header sections");
  }

  const observations = input.sections.map(normalizeSection);
  const signatures = new Set(observations.map((row) => JSON.stringify({
    roomCount: row.roomCount,
    providerMarker: row.providerMarker
  })));
  if (signatures.size !== 1) {
    fail("V2_NAVER_ROOM_MARKER_AMBIGUOUS", "Room header observations conflict");
  }

  const observation = observations[0];
  const marker = observation.providerMarker;
  const evidenceLevel = marker.mappingStatus === "mapped" ? "high" : "medium";
  const evidenceType = marker.mappingStatus === "mapped"
    ? "explicit_room_header_provider_marker"
    : marker.mappingStatus === "unmapped"
      ? "explicit_unmapped_room_header_provider_marker"
      : "explicit_room_header_count_only";
  const fixtureDigestSha256 = cleanText(options.fixtureDigestSha256, 64).toLowerCase();
  if (fixtureDigestSha256 && !/^[a-f0-9]{64}$/u.test(fixtureDigestSha256)) {
    fail("V2_NAVER_ROOM_MARKER_INPUT_INVALID", "Fixture digest is invalid");
  }

  return Object.freeze({
    schemaVersion: RESULT_SCHEMA_VERSION,
    placeId,
    roomCount: observation.roomCount,
    providerMarker: marker,
    evidence: Object.freeze({
      level: evidenceLevel,
      type: evidenceType,
      source: "naver_place_room_section_header",
      captureKind: input.captureKind,
      duplicateObservationCount: observations.length,
      fixtureDigestSha256: fixtureDigestSha256 || null
    }),
    audit: Object.freeze({
      fixtureMode: input.captureKind === CAPTURE_KIND,
      externalRequests: 0,
      operationalWrites: 0,
      rawProviderResponseStored: false
    })
  });
}

module.exports = {
  CAPTURE_KIND,
  LIVE_CAPTURE_KIND,
  CHANNEL_DEFINITIONS,
  FIXTURE_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  V2NaverPlaceRoomProviderMarkerError,
  collectRoomProviderMarker,
  parseProviderMarker,
  parseRoomHeading,
  standardizeProviderChannel
};
