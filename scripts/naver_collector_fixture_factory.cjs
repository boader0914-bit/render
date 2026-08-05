"use strict";

const {
  beginProviderAttempt,
  createInitialProviderCircuitState
} = require("./naver_provider_resilience.cjs");
const {
  createStaticNaverFixtureTransport
} = require("./naver_collector_strategy.cjs");

function operationKey(operation, input, extras = {}) {
  return `${operation}(${JSON.stringify({ input, ...extras })})`;
}

function createApolloFixture(options = {}) {
  const operation = options.operation || "accommodationSearch";
  const query = options.query || "fixture lodging";
  const display = options.display === undefined ? 50 : options.display;
  const page = options.page;
  const items = Array.isArray(options.items)
    ? options.items
    : [{ id: "fixture-place-1", name: "Fixture Lodge", category: "Lodging", roadAddress: "Fixture road 1" }];
  const input = { query };
  if (display !== null) input.display = display;
  if (page !== undefined) input.page = page;
  if (operation === "adBusinesses") input.businessType = options.businessType || "accommodation";
  Object.assign(input, options.inputExtras || {});
  const key = operationKey(operation, input, options.keyExtras || {});
  const state = options.state || { ROOT_QUERY: {} };
  if (!state.ROOT_QUERY) state.ROOT_QUERY = {};
  const references = items.map((item, index) => {
    if (item?.inline === true) {
      const { inline, ...inlineItem } = item;
      return inlineItem;
    }
    if (item?.missing === true) return { __ref: `Missing:${index}` };
    const reference = `${operation}:Fixture:${Object.keys(state).length}:${index}`;
    state[reference] = { ...item };
    return { __ref: reference };
  });
  if (operation === "adBusinesses") {
    state.ROOT_QUERY[key] = {
      items: references,
      total: options.total === undefined ? items.length : options.total
    };
  } else {
    const containerKey = options.containerKey || (operation === "placeList" ? "businesses" : "business");
    state.ROOT_QUERY[key] = {
      [containerKey]: {
        items: references,
        total: options.total === undefined ? items.length : options.total
      }
    };
  }
  return { state, key, query };
}

function apolloHtml(state, marker = "window.__APOLLO_STATE__ = ") {
  return `<!doctype html><html><head></head><body><script>${marker}${JSON.stringify(state)};</script></body></html>`;
}

function staticFixtureTransport(response) {
  return createStaticNaverFixtureTransport(response);
}

function fixtureProviderReservation(now = "2026-08-05T08:00:00.000Z") {
  const initial = createInitialProviderCircuitState({ now });
  return beginProviderAttempt(initial, {
    now: new Date(Date.parse(now) + 1000).toISOString(),
    expectedWorkflowRevision: initial.workflowRevision,
    explicit: true
  });
}

module.exports = {
  apolloHtml,
  createApolloFixture,
  fixtureProviderReservation,
  operationKey,
  staticFixtureTransport
};
