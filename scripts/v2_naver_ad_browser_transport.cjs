"use strict";

const BOOKMARKLET_PATH = "/naver-ad-bookmarklet.txt";

function browserCaptureMain() {
  "use strict";
  const root = globalThis;
  const doc = root.document;
  const page = root.location;
  const schemaVersion = "v2-naver-visible-place-ad-capture.v1";
  const source = "naver-integrated-search-visible-dom";
  const evidenceLevel = "visible-ad-label-and-place-destination";
  const handoffMessageType = "v2-naver-visible-place-ad-handoff.v1";
  const handoffNonceName = "datalabCapture";
  const handoffOriginName = "datalabOrigin";
  const clean = (value, limit) => String(value || "").normalize("NFC").trim().replace(/\s+/gu, " ").slice(0, limit);
  const finishFailure = (code) => {
    if (typeof root.__V2_NAVER_AD_CAPTURE_TEST_HOOK__ === "function") {
      root.__V2_NAVER_AD_CAPTURE_TEST_HOOK__(null, { code });
      return null;
    }
    root.alert?.(`DataLab 광고 캡처 중단: ${code}`);
    return null;
  };
  if (!doc || !page || page.protocol !== "https:" || page.hostname !== "search.naver.com") {
    return finishFailure("NAVER_SEARCH_PAGE_REQUIRED");
  }
  const query = clean(new URL(page.href).searchParams.get("query"), 120);
  if (!query) return finishFailure("NAVER_SEARCH_QUERY_MISSING");
  const visible = (node) => {
    if (!node || node.hidden || node.getAttribute?.("aria-hidden") === "true") return false;
    const view = node.ownerDocument?.defaultView || root;
    const style = typeof view.getComputedStyle === "function" ? view.getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
    if (typeof node.getClientRects === "function" && node.getClientRects().length === 0) return false;
    return true;
  };
  const placeFromLink = (anchor) => {
    try {
      const redirect = new URL(anchor.href);
      if (redirect.protocol !== "https:" || redirect.hostname !== "ader.naver.com") return null;
      const destination = new URL(redirect.searchParams.get("fu") || "");
      if (destination.protocol !== "https:" || destination.hostname !== "map.naver.com") return null;
      const parts = destination.pathname.split("/").filter(Boolean);
      const index = parts.indexOf("place");
      const placeId = index >= 0 ? parts[index + 1] : "";
      return /^\d{1,30}$/u.test(placeId) ? placeId : null;
    } catch {
      return null;
    }
  };
  const advertisements = [];
  const seen = new Set();
  let candidateContainerCount = 0;
  let advertiserLinkCount = 0;
  let duplicateLinkCount = 0;
  let rejectedContainerCount = 0;
  for (const container of [...doc.querySelectorAll("li")].slice(0, 500)) {
    if (!visible(container)) continue;
    const adLabelPresent = [...container.querySelectorAll("*")]
      .some((node) => node.children.length === 0 && visible(node) && clean(node.textContent, 40) === "광고");
    if (!adLabelPresent) continue;
    candidateContainerCount += 1;
    const links = [...container.querySelectorAll("a[href]")]
      .filter(visible)
      .map((anchor) => ({ anchor, placeId: placeFromLink(anchor) }))
      .filter((entry) => entry.placeId);
    advertiserLinkCount += links.length;
    const ids = [...new Set(links.map((entry) => entry.placeId))];
    if (ids.length === 0) {
      rejectedContainerCount += 1;
      continue;
    }
    duplicateLinkCount += Math.max(0, links.length - ids.length);
    for (const placeId of ids) {
      if (seen.has(placeId)) {
        duplicateLinkCount += 1;
        continue;
      }
      const representative = links
        .filter((entry) => entry.placeId === placeId)
        .map((entry) => entry.anchor)
        .find((anchor) => ["span", "div"].includes(anchor.firstElementChild?.tagName?.toLowerCase()) && clean(anchor.firstElementChild.textContent, 300));
      const name = clean(representative?.firstElementChild?.textContent, 300);
      if (!name) {
        rejectedContainerCount += 1;
        continue;
      }
      if (advertisements.length >= 100) {
        rejectedContainerCount += 1;
        continue;
      }
      seen.add(placeId);
      advertisements.push({
        adOrder: advertisements.length + 1,
        placeId,
        name,
        adTagPresent: true,
        source,
        evidenceLevel
      });
    }
  }
  const envelope = {
    schemaVersion,
    query,
    capturedAt: new Date().toISOString(),
    sourceHost: "search.naver.com",
    sourceSurface: "integrated-search-place",
    transport: "manual-bookmarklet",
    advertisements,
    diagnostics: {
      candidateContainerCount,
      advertiserLinkCount,
      acceptedCount: advertisements.length,
      duplicateLinkCount,
      rejectedContainerCount
    },
    privacy: {
      rawHtmlStored: false,
      trackingUrlsStored: false,
      cookiesStored: false,
      providerResponseStored: false,
      operationalWrites: 0
    }
  };
  let handoffDelivered = false;
  try {
    const fragment = new URL(`https://capture.invalid/?${String(page.hash || "").replace(/^#/u, "")}`);
    const nonce = clean(fragment.searchParams.get(handoffNonceName), 32);
    const returnOrigin = clean(fragment.searchParams.get(handoffOriginName), 300);
    const returnUrl = new URL(returnOrigin);
    const localHttp = returnUrl.protocol === "http:"
      && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(returnUrl.hostname);
    const validHandoff = /^[a-f0-9]{32}$/u.test(nonce)
      && returnUrl.origin === returnOrigin
      && (returnUrl.protocol === "https:" || localHttp)
      && root.opener
      && typeof root.opener.postMessage === "function";
    if (validHandoff) {
      root.opener.postMessage({ type: handoffMessageType, nonce, capture: envelope }, returnOrigin);
      handoffDelivered = true;
    }
  } catch {
    handoffDelivered = false;
  }
  if (typeof root.__V2_NAVER_AD_CAPTURE_TEST_HOOK__ === "function") {
    root.__V2_NAVER_AD_CAPTURE_TEST_HOOK__(envelope, null, { handoffDelivered });
    return envelope;
  }
  if (handoffDelivered) {
    root.alert?.(`DataLab 광고 스냅샷 ${advertisements.length}건 전달 완료`);
    return envelope;
  }
  const bytes = JSON.stringify(envelope, null, 2) + "\n";
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/json;charset=utf-8" }));
  const link = doc.createElement("a");
  link.href = objectUrl;
  link.download = `datalab-naver-place-ads-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  return envelope;
}

function bookmarkletUrl() {
  return `javascript:(${browserCaptureMain.toString()})()`;
}

module.exports = {
  BOOKMARKLET_PATH,
  bookmarkletUrl,
  browserCaptureMain
};
