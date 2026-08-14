"use strict";

const assert = require("node:assert/strict");
const vm = require("node:vm");
const { bookmarkletUrl } = require("./v2_naver_ad_browser_transport.cjs");
const { validateVisibleAdCaptureEnvelope } = require("./v2_naver_visible_place_ad_contract.cjs");
const {
  MESSAGE_TYPE,
  createCaptureSearchUrl,
  validateHandoffMessage
} = require("./v2_naver_ad_snapshot_handoff_contract.cjs");

let assertions = 0;

function equal(actual, expected) {
  assert.equal(actual, expected);
  assertions += 1;
}

function deepEqual(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
  assertions += 1;
}

function node(text = "", options = {}) {
  return {
    textContent: text,
    innerText: text,
    tagName: String(options.tagName || "span").toUpperCase(),
    children: options.children || [],
    firstElementChild: options.children?.[0] || null,
    hidden: options.hidden === true,
    style: options.style || {},
    href: options.href || "",
    getAttribute(name) {
      if (name === "aria-hidden") return options.ariaHidden ? "true" : null;
      return null;
    },
    getClientRects() {
      return options.visible === false ? [] : [{}];
    }
  };
}

function advertiserHref(placeId, token) {
  const destination = `https://map.naver.com/p/search/fixture/place/${placeId}`;
  return `https://ader.naver.com/redirect?tracking=${token}&fu=${encodeURIComponent(destination)}`;
}

function adContainer(placeId, name, options = {}) {
  const nameNode = node(name, { tagName: options.nameTag || "span" });
  const primary = node(name, {
    tagName: "a",
    href: advertiserHref(placeId, `secret-${placeId}-primary`),
    children: [nameNode]
  });
  const secondary = node("상세", {
    tagName: "a",
    href: advertiserHref(placeId, `secret-${placeId}-secondary`),
    children: [node("상세", { tagName: "div" })]
  });
  const label = node("광고", { visible: options.labelVisible !== false });
  const links = options.links || [primary, secondary];
  const container = node(`${name} 광고`, { tagName: "li" });
  container.querySelectorAll = (selector) => selector === "*" ? [label, nameNode] : selector === "a[href]" ? links : [];
  return container;
}

function organicContainer() {
  const label = node("일반");
  const container = node("일반 업체", { tagName: "li" });
  container.querySelectorAll = (selector) => selector === "*" ? [label] : [];
  return container;
}

function documentFor(containers) {
  const defaultView = { getComputedStyle: (value) => value.style || {} };
  for (const container of containers) {
    container.ownerDocument = { defaultView };
    for (const child of [...container.querySelectorAll("*"), ...container.querySelectorAll("a[href]")]) child.ownerDocument = { defaultView };
  }
  return {
    defaultView,
    body: { append() {} },
    querySelectorAll(selector) {
      return selector === "li" ? containers : [];
    },
    createElement() {
      return { click() {}, remove() {} };
    }
  };
}

function execute(url, containers, options = {}) {
  let captured = null;
  let failure = null;
  let metadata = null;
  const sandbox = {
    URL,
    Blob,
    setTimeout,
    document: documentFor(containers),
    location: new URL(url),
    opener: options.opener || null,
    __V2_NAVER_AD_CAPTURE_TEST_HOOK__(value, error, delivery) {
      captured = value;
      failure = error;
      metadata = delivery || null;
    }
  };
  vm.runInNewContext(bookmarkletUrl().slice("javascript:".length), sandbox, { timeout: 1000 });
  return { captured, failure, metadata };
}

function main() {
  const rows = [
    ["1000421329", "합천H글램핑"],
    ["1995649140", "럭셔리 비토섬 제이글램핑"],
    ["2092090019", "옥돌캠핑장"],
    ["2000486899", "아르비토 호텔 글램핑"]
  ];
  const wrongHost = adContainer("999", "위조 광고", {
    links: [node("위조 광고", { tagName: "a", href: "https://example.com/place/999", children: [node("위조 광고")] })]
  });
  const containers = [
    ...rows.map(([placeId, name], index) => adContainer(placeId, name, { nameTag: index === 3 ? "div" : "span" })),
    adContainer("1000421329", "합천H글램핑 중복"),
    adContainer("777", "숨김 광고", { labelVisible: false }),
    wrongHost,
    organicContainer()
  ];
  const result = execute("https://search.naver.com/search.naver?query=%EA%B2%BD%EB%82%A8+%EA%B8%80%EB%9E%A8%ED%95%91", containers);
  equal(result.failure, null);
  equal(result.captured.query, "경남 글램핑");
  equal(result.captured.advertisements.length, 4);
  deepEqual(result.captured.advertisements.map((row) => row.placeId), rows.map(([placeId]) => placeId));
  deepEqual(result.captured.advertisements.map((row) => row.name), rows.map(([, name]) => name));
  equal(result.captured.diagnostics.candidateContainerCount, 6);
  equal(result.captured.diagnostics.advertiserLinkCount, 10);
  equal(result.captured.diagnostics.acceptedCount, 4);
  equal(result.captured.diagnostics.duplicateLinkCount, 6);
  equal(result.captured.diagnostics.rejectedContainerCount, 1);
  equal(result.captured.privacy.operationalWrites, 0);

  const handoffCalls = [];
  const nonce = "0123456789abcdef0123456789abcdef";
  const handoffUrl = createCaptureSearchUrl({
    keyword: "경남 글램핑",
    nonce,
    returnOrigin: "https://datalab.example"
  });
  const handedOff = execute(handoffUrl, containers, {
    opener: {
      postMessage(message, targetOrigin) {
        handoffCalls.push({ message, targetOrigin });
      }
    }
  });
  equal(handedOff.failure, null);
  equal(handedOff.metadata.handoffDelivered, true);
  equal(handoffCalls.length, 1);
  equal(handoffCalls[0].targetOrigin, "https://datalab.example");
  equal(handoffCalls[0].message.type, MESSAGE_TYPE);
  equal(validateHandoffMessage(handoffCalls[0].message, { expectedNonce: nonce }).advertisements.length, 4);
  assert.doesNotMatch(JSON.stringify(handoffCalls[0].message), /ader\.naver\.com|secret-|tracking=|\bfu=/iu);
  assertions += 1;

  const invalidHandoff = execute(`${handoffUrl.split("#")[0]}#datalabCapture=${nonce}&datalabOrigin=http%3A%2F%2Fevil.example`, containers, {
    opener: { postMessage() { throw new Error("must not post"); } }
  });
  equal(invalidHandoff.metadata.handoffDelivered, false);

  const validated = validateVisibleAdCaptureEnvelope(result.captured, {
    expectedQuery: "경남 글램핑",
    now: new Date(result.captured.capturedAt)
  });
  equal(validated.advertisements.length, 4);
  const serialized = JSON.stringify(result.captured);
  assert.doesNotMatch(serialized, /ader\.naver\.com|secret-|tracking=|\bfu=|https?:\/\//iu);
  assertions += 1;
  assert.doesNotMatch(serialized, /cookie-value|authorization-value|set-cookie-value/iu);
  assertions += 1;

  const wrongPage = execute("https://example.com/?query=x", []);
  equal(wrongPage.captured, null);
  equal(wrongPage.failure.code, "NAVER_SEARCH_PAGE_REQUIRED");
  const missingQuery = execute("https://search.naver.com/search.naver", []);
  equal(missingQuery.failure.code, "NAVER_SEARCH_QUERY_MISSING");

  const bookmarklet = bookmarkletUrl();
  assert.match(bookmarklet, /^javascript:\(/u);
  assertions += 1;
  assert.ok(bookmarklet.length < 20000);
  assertions += 1;

  process.stdout.write(`${JSON.stringify({
    event: "v2_naver_ad_browser_transport_tests_complete",
    assertions,
    externalRequests: 0,
    operationalWrites: 0,
    rawProviderResponsesStored: 0,
    trackingUrlsStored: 0
  })}\n`);
}

main();
