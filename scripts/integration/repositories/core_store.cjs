"use strict";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function emptyCoreStore() {
  return {
    schemaVersion: 1,
    storeKind: "stage227-provisional-memory",
    fixtureMode: false,
    fixtureVersion: "",
    companies: [],
    fixtureHistory: [],
    jobs: [],
    interests: [],
    locationCardRequests: [],
    tourismRequests: [],
    connectors: {
      traffic: { state: "not-configured", configured: false, verified: false, lastCheckedAt: "" },
      tourism: { state: "not-configured", configured: false, verified: false, lastCheckedAt: "" },
      ota: { state: "not-configured", configured: false, verified: false, lastCheckedAt: "" }
    }
  };
}

function normalizeFixture(fixture = {}) {
  if (!fixture || fixture.synthetic !== true || fixture.source !== "synthetic-fresh-collection") {
    throw new Error("Stage 227 fixture must be explicitly synthetic fresh-collection data");
  }
  return {
    fixtureMode: true,
    fixtureVersion: String(fixture.fixtureVersion || "stage227-synthetic-v1"),
    companies: clone(Array.isArray(fixture.companies) ? fixture.companies : []),
    fixtureHistory: clone(Array.isArray(fixture.history) ? fixture.history : []),
    connectors: clone(fixture.connectors || emptyCoreStore().connectors)
  };
}

function createCoreRepository(options = {}) {
  const store = emptyCoreStore();
  if (options.fixture) Object.assign(store, normalizeFixture(options.fixture));

  return Object.freeze({
    snapshot() {
      return clone(store);
    },
    currentUnsafe() {
      return store;
    },
    transaction(_label, mutate) {
      const result = mutate(store);
      return clone(result);
    }
  });
}

module.exports = {
  createCoreRepository,
  emptyCoreStore,
  normalizeFixture
};
