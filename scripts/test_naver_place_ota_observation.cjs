"use strict";

const assert = require("node:assert/strict");
const {
  bookingEvidenceFromSignals,
  observationToCsvFields,
  otaProviderFromUrl,
  parseNaverPlaceGraphqlObservation,
  parseNaverPlaceHtmlObservation,
  unwrapNaverRedirectUrl,
} = require("./naver_place_ota_observation.cjs");

const CHECKED_AT = "2026-08-22T00:00:00.000Z";
const EVIDENCE_URL = "https://pcmap.place.naver.com/accommodation/123/room";

function graphqlPayload(details = {}, naverBooking = null) {
  return {
    data: {
      business: {
        base: { id: "123", name: "테스트 숙소" },
        naverBooking,
        accommodationBookingDetails: details,
      },
    },
  };
}

function testRedirectUnwrapAndProviderDetection() {
  const target = "https://nol.yanolja.com/pension/123";
  const redirect = `https://search.naver.com/p/crd/rd?u=${encodeURIComponent(target)}`;
  assert.equal(unwrapNaverRedirectUrl(redirect), target);
  assert.equal(otaProviderFromUrl(redirect)?.channel, "yanolja");
  assert.equal(otaProviderFromUrl("https://m.booking.naver.com/booking/3/bizes/123/search"), null);
}

function testHtmlRequiresExplicitExternalAnchor() {
  const html = `
    <script>window.__APOLLO_STATE__ = {};</script>
    <script>function initNcaptcha() { window.ncaptcha = {}; }</script>
    <script src="https://ncpt.naver.com/static/ncaptcha-api.js?ncaptcha-onload=initNcaptcha"></script>
    <body class="place_on_pcm"><div id="wtm-captcha-root"></div></body>
    <script>const tryLaterText = "잠시 후 다시 시도해주세요.";</script>
    <div>야놀자 여기어때 떠나요 ONDA Airbnb</div>
    <a href="https://m.booking.naver.com/booking/3/bizes/123/search">네이버 예약</a>
    <script>const url = "https://www.goodchoice.kr/product/123";</script>
  `;
  const result = parseNaverPlaceHtmlObservation(html, {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
    bookingEvidence: { hasBooking: true, hasNPay: true, agencyId: "0" },
  });
  assert.equal(result.status, "not_observed_on_naver");
  assert.deepEqual(result.channels, []);
  assert.equal(result.bookingEvidence.bookingStatus, "노출 확인");
  assert.equal(result.bookingEvidence.nPayStatus, "Y");
}

function testHtmlExternalAnchorAndNaverRedirect() {
  const target = "https://www.goodchoice.kr/product/detail?ano=123";
  const html = `<a href="https://m.place.naver.com/redirect?targetUrl=${encodeURIComponent(target)}">예약하기</a>`;
  const result = parseNaverPlaceHtmlObservation(html, {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
  });
  assert.equal(result.status, "observed_on_naver");
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].channel, "yeogi");
  assert.equal(result.channels[0].url, target);
  assert.equal(result.channels[0].source, "naver_place");
  assert.equal(result.channels[0].method, "html_anchor");

  const genericPlatformLink = parseNaverPlaceHtmlObservation(`
    <script>window.__APOLLO_STATE__ = {};</script>
    <body class="place_on_pcm"><a href="https://www.goodchoice.kr/">여기어때 회사 소개</a></body>
  `, {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
  });
  assert.equal(genericPlatformLink.status, "not_observed_on_naver");
  assert.deepEqual(genericPlatformLink.channels, []);
}

function testGraphqlExplicitReservationUrlsOnly() {
  const result = parseNaverPlaceGraphqlObservation(graphqlPayload({
    agencyName: "예약 운영 파트너",
    rooms: [
      { resrvUrl: "https://www.yanolja.com/pension/1", isNPayUsed: false },
      { resrvUrl: "https://www.goodchoice.kr/product/2", isNPayUsed: false },
      { resrvUrl: "https://trip.ddnayo.com/detail/3", isNPayUsed: false },
      { resrvUrl: "https://booking.onda.me/rooms/4", isNPayUsed: false },
      { resrvUrl: "https://www.airbnb.co.kr/rooms/5", isNPayUsed: false },
      { resrvUrl: "https://m.booking.naver.com/booking/3/bizes/123/search", isNPayUsed: true },
    ],
  }, {
    bookingBusinessId: "123",
    naverBookingUrl: "https://m.booking.naver.com/booking/3/bizes/123/search",
  }), {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
    httpStatus: 200,
    bookingEvidence: { hasBooking: true, agencyId: "106" },
  });
  assert.equal(result.status, "observed_on_naver");
  assert.deepEqual(result.channels.map((entry) => entry.channel), [
    "yanolja",
    "yeogi",
    "tteonayo",
    "onda",
    "airbnb",
  ]);
  assert.equal(result.bookingEvidence.agencyId, "106");
  assert.match(result.bookingEvidence.operationSignal, /외부 OTA 입점 확정 아님/);
}

function testAgencySignalsDoNotBecomeOtaExposure() {
  const result = parseNaverPlaceGraphqlObservation(graphqlPayload({
    agencyName: "운영 대행사",
    rooms: [{ resrvUrl: "https://m.booking.naver.com/booking/3/bizes/123/search", isNPayUsed: true }],
  }), {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
    bookingEvidence: { hasBooking: true, agencyId: "12" },
  });
  assert.equal(result.status, "partner_observed");
  assert.deepEqual(result.channels, []);
  assert.equal(result.bookingEvidence.partnerCandidate, true);
  assert.match(result.bookingEvidence.operationSignal, /외부 OTA 입점 확정 아님/);

  const rawOnly = bookingEvidenceFromSignals({ agencyId: "12" });
  assert.equal(rawOnly.partnerCandidate, false);
  assert.match(rawOnly.operationSignal, /원시 식별값/);

  const rawIdObservation = parseNaverPlaceGraphqlObservation(graphqlPayload({
    rooms: [{ resrvUrl: "https://m.booking.naver.com/booking/3/bizes/123/search" }],
  }), {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
    bookingEvidence: { hasBooking: true, agencyId: "106" },
  });
  assert.equal(rawIdObservation.status, "not_observed_on_naver");
  assert.deepEqual(rawIdObservation.channels, []);
}

function testFailureStatesAndCsvShape() {
  const blocked = parseNaverPlaceGraphqlObservation(null, {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
    httpStatus: 429,
    rawText: "WtmCaptcha",
    bookingEvidence: { hasBooking: false, hasNPay: false, agencyId: "" },
  });
  assert.equal(blocked.status, "blocked");
  for (const httpStatus of [403, 503]) {
    const blockedByStatus = parseNaverPlaceGraphqlObservation(null, {
      checkedAt: CHECKED_AT,
      evidenceUrl: EVIDENCE_URL,
      httpStatus,
    });
    assert.equal(blockedByStatus.status, "blocked");
  }

  const partialBlocked = parseNaverPlaceGraphqlObservation(graphqlPayload({ rooms: [] }), {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
    httpStatus: 429,
  });
  assert.equal(partialBlocked.status, "blocked");

  const partialError = parseNaverPlaceGraphqlObservation({
    data: { business: { base: { id: "123" }, accommodationBookingDetails: null } },
    errors: [{ message: "field unavailable", path: ["business", "accommodationBookingDetails"] }],
  }, {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
    httpStatus: 200,
  });
  assert.equal(partialError.status, "auto_failed");

  const roomLinkPartialError = parseNaverPlaceGraphqlObservation({
    data: {
      business: {
        base: { id: "123" },
        accommodationBookingDetails: { rooms: [{ resrvUrl: null, isNPayUsed: true }] },
      },
    },
    errors: [{ message: "resrvUrl unavailable", path: ["business", "accommodationBookingDetails", "rooms", 0, "resrvUrl"] }],
  }, {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
    httpStatus: 200,
  });
  assert.equal(roomLinkPartialError.status, "auto_failed");

  const failed = parseNaverPlaceHtmlObservation("", {
    checkedAt: CHECKED_AT,
    evidenceUrl: EVIDENCE_URL,
    httpStatus: 500,
  });
  assert.equal(failed.status, "auto_failed");

  const visibleChallenge = parseNaverPlaceHtmlObservation(
    '<html><body><div id="captcha-challenge">비정상적인 접근입니다. 자동입력 방지 확인이 필요합니다.</div></body></html>',
    { checkedAt: CHECKED_AT, evidenceUrl: EVIDENCE_URL, httpStatus: 200 },
  );
  assert.equal(visibleChallenge.status, "blocked");

  const incompleteSuccessPage = parseNaverPlaceHtmlObservation(
    "<html><body><p>빈 셸 응답</p></body></html>",
    { checkedAt: CHECKED_AT, evidenceUrl: EVIDENCE_URL, httpStatus: 200 },
  );
  assert.equal(incompleteSuccessPage.status, "auto_failed");

  const fields = observationToCsvFields(blocked);
  assert.deepEqual(Object.keys(fields), [
    "네이버OTA관측상태",
    "네이버OTA관측라벨",
    "네이버OTA관측시각",
    "네이버OTA근거URL",
    "네이버OTA관측방식",
    "네이버OTA관측메모",
    "네이버OTA노출JSON",
    "네이버예약노출상태",
    "네이버페이노출",
    "네이버예약대행사ID",
    "네이버예약대행사명",
    "네이버예약운영신호",
  ]);
  assert.equal(fields.네이버OTA관측상태, "blocked");
  assert.equal(fields.네이버OTA노출JSON, "[]");
}

const tests = [
  testRedirectUnwrapAndProviderDetection,
  testHtmlRequiresExplicitExternalAnchor,
  testHtmlExternalAnchorAndNaverRedirect,
  testGraphqlExplicitReservationUrlsOnly,
  testAgencySignalsDoNotBecomeOtaExposure,
  testFailureStatesAndCsvShape,
];

for (const test of tests) test();
console.log(`Naver Place OTA observation tests passed: ${tests.length}`);
