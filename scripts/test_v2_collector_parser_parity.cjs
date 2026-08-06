"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const { collectNaverPlaceSnapshot } = require("./naver_collector_strategy.cjs");
const {
  apolloHtml,
  createApolloFixture,
  fixtureProviderReservation,
  staticFixtureTransport
} = require("./naver_collector_fixture_factory.cjs");
const { mainPlaceProjection } = require("./v2_collector_compatibility.cjs");

async function main() {
  const guard = installFixtureNetworkGuard({ label: "V2 collector parser parity fixtures" });
  try {
    const query = "Synthetic parity lodging";
    const fixture = createApolloFixture({
      query,
      items: Array.from({ length: 50 }, (_, index) => ({
        id: `parity-place-${String(index + 1).padStart(2, "0")}`,
        name: `Synthetic lodging ${index + 1}`,
        roadAddress: `Synthetic road ${index + 1}`,
        hasBooking: index < 3
      }))
    });
    const snapshot = await collectNaverPlaceSnapshot({
      contract: {
        keyword: query,
        searchMode: "keyword",
        rankStart: 1,
        rankEnd: 50,
        regionKey: "kr_fixture_parity",
        categoryKey: "glamping",
        measurementPeriod: { start: "2026-08-06", end: "2026-08-06" },
        legacyNaverQuery: query
      },
      strategy: "legacy_candidate",
      asOf: "2026-08-06T00:00:00.000Z",
      fixtureMode: true,
      allowLegacyCandidate: true,
      providerReservation: fixtureProviderReservation(),
      transport: staticFixtureTransport({
        status: 200,
        headers: { "content-type": "text/html" },
        body: apolloHtml(fixture.state)
      })
    });
    const projection = mainPlaceProjection(snapshot);
    assert.equal(projection.status, "ready");
    assert.equal(projection.organicCount, 50);
    assert.equal(projection.mainPlaceRequestCount, 1);
    assert.deepEqual(projection.ranks.map((row) => row.rank), Array.from({ length: 50 }, (_, index) => index + 1));
    assert.deepEqual(projection.detailTargets, [
      { rank: 1, placeId: "parity-place-01" },
      { rank: 2, placeId: "parity-place-02" },
      { rank: 3, placeId: "parity-place-03" }
    ]);
    assert.equal(Object.prototype.hasOwnProperty.call(projection.detailTargets[0], "location"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(projection.detailTargets[0], "name"), false);

    const malformed = { ...snapshot, sampleCount: 49, items: snapshot.items.slice(0, 49) };
    assert.throws(
      () => mainPlaceProjection(malformed),
      (error) => error.code === "V2_COLLECTOR_COMPATIBILITY_MAIN_INVALID"
    );
    const duplicate = {
      ...snapshot,
      items: snapshot.items.map((row, index) => index === 1 ? { ...row, placeId: snapshot.items[0].placeId } : row)
    };
    assert.throws(
      () => mainPlaceProjection(duplicate),
      (error) => error.code === "V2_COLLECTOR_COMPATIBILITY_MAIN_INVALID"
    );
    assert.equal(guard.blockedAttempts(), 0);
  } finally {
    guard.restore();
  }
  console.log("V2 collector parser parity tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
