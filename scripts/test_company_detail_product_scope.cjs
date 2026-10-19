"use strict";
// Run the exact application helper and identity/rank dependencies without
// starting a server, collecting data, or reading any product JSON references.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n/g, "\n");
const names = ["compactKeyword", "extractNaverPlaceId", "extractBookingBusinessId", "numericField", "availabilityPlaceKey",
  "availabilityBookingBusinessId", "companyProductAvailabilityMatch", "companyDetailAvailabilityRows"];
const declarations = names.map(name => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, "Missing actual application function " + name); return match[0];
});
const context = vm.createContext({}); vm.runInContext(declarations.join("\n"), context);
const select = (rows, company) => context.companyDetailAvailabilityRows(rows, company);
const company = { companyId: "[모의]selected", placeIds: ["111"], bookingBusinessIds: ["999"] };
const row = (marker, extra = {}) => Object.freeze({ marker, overall_rank: 1, "업체명": "[모의] " + marker,
  "네이버상품상세JSON": "@json-file:must-not-be-opened/" + marker + ".json", ...extra });

test("selected availability keys retain every duplicate in original input order and exact source identity", () => {
  const a = row("first", { place_id: "111", bookingBusinessId: "999", overall_rank: 2 }),
    unrelated = row("other", { place_id: "222", bookingBusinessId: "888" }),
    duplicate = row("later-duplicate", { place_id: "111", bookingBusinessId: "999", overall_rank: 4 }),
    conflictWithinSelectedKey = row("same-key-conflict", { place_id: "111", bookingBusinessId: "888", overall_rank: 5 });
  const rows = Object.freeze([a, unrelated, duplicate, conflictWithinSelectedKey]), bytes = JSON.stringify(rows);
  const selected = select(rows, company);
  assert.deepEqual(selected, [a, duplicate, conflictWithinSelectedKey]);
  assert.equal(selected[0], a); assert.equal(selected[1], duplicate); assert.equal(selected[2], conflictWithinSelectedKey);
  assert.equal(JSON.stringify(rows), bytes, "raw evidence rows are untouched");
});

test("place and booking identities both match while contradictory other-company identities stay excluded", () => {
  const place = row("place-url", { url: "https://m.place.naver.com/accommodation/111", bookingBusinessId: "999" }),
    booking = row("booking-url", { "네이버예약URL": "https://booking.naver.com/booking/3/bizes/999" }),
    conflictPlace = row("place-conflict", { place_id: "222", bookingBusinessId: "999" }),
    conflictBooking = row("booking-conflict", { url: "https://booking.naver.com/booking/3/bizes/888" });
  assert.deepEqual(select([conflictPlace, place, conflictBooking, booking], company), [place, booking]);
});

test("one selected duplicate without a positive explicit rank keeps the entire original ranking path", () => {
  const first = row("unrelated-before", { place_id: "222" }), selected = row("selected", { place_id: "111", overall_rank: 3 });
  for (const rankFields of [{ overall_rank: undefined }, { overall_rank: 0 }, { overall_rank: -1 }, { overall_rank: "invalid" },
    { overall_rank: null, "순위": "" }, { overall_rank: "" }]) {
    const duplicate = row("missing-rank", { place_id: "111", ...rankFields });
    const rows = Object.freeze([first, selected, duplicate]), bytes = JSON.stringify(rows);
    assert.equal(select(rows, company), rows, "fallback must retain original byPlace.size rank positions");
    assert.equal(JSON.stringify(rows), bytes);
  }
});

test("the actual rank aliases permit a scoped projection but unrelated missing ranks do not alter selected rank", () => {
  const outside = row("outside-no-rank", { place_id: "222", overall_rank: undefined }),
    regional = row("regional", { place_id: "111", overall_rank: null, "순위": "2" }),
    alternative = row("alternative", { place_id: "111", overall_rank: "", rank_or_order: "3" });
  const rows = Object.freeze([outside, regional, alternative]);
  assert.deepEqual(select(rows, company), [regional, alternative]);
});

test("same-name rows without a selected identity are not introduced and zero matching rows stay empty", () => {
  const rows = Object.freeze([row("same-name", { "업체명": "[모의]selected", place_id: "222", overall_rank: undefined }),
    row("missing-ids", { "업체명": "[모의]selected", overall_rank: undefined }),
    row("booking-other", { bookingBusinessId: "888" })]);
  const bytes = JSON.stringify(rows);
  assert.deepEqual(select(rows, company), []);
  assert.deepEqual(select([], company), []);
  assert.equal(JSON.stringify(rows), bytes);
});

test("shared name/location availability keys retain original duplicate projection ordering", () => {
  // Explicit placeId participates in identity matching, while this old CSV
  // shape falls back to its name/location availability key in the projection.
  const selected = row("selected-legacy-key", { placeId: "111", "업체명": "같은 키", "주소": "[모의] 경남 산청" }),
    sameKey = row("same-legacy-key", { placeId: "222", "업체명": "같은키", "주소": "[모의]경남산청" }),
    differentKey = row("different-legacy-key", { placeId: "222", "업체명": "다른 업체", "주소": "[모의]경남산청" });
  assert.deepEqual(select([sameKey, differentKey, selected], company), [sameKey, selected]);
});
