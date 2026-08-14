"use strict";

const { normalizeQuery } = require("./naver_place_apollo_parser.cjs");

function entity(state, key, value) {
  state[key] = value;
  return { __ref: key };
}

function room(state, key, name, minPrice, maxPrice) {
  return entity(state, key, { name, minPrice, maxPrice });
}

function createBasicPlaceDemoHtml(keyword) {
  const query = normalizeQuery(keyword);
  if (!query) throw new TypeError("A demo query is required");
  const state = { ROOT_QUERY: {} };
  const places = [
    entity(state, "Place:37812354", {
      id: "37812354",
      name: "에이원글램핑",
      category: "캠핑,야영장",
      roadAddress: "경상남도 산청군 생비량면",
      hasBooking: true,
      placeReviewScore: 4.7,
      placeReviewCount: 318,
      totalReviewCount: 462,
      roomImages: [room(state, "Room:37812354:1", "A동 글램핑", 149000, 189000)]
    }),
    entity(state, "Place:1557159426", {
      id: "1557159426",
      name: "비토노을숲 글램핑",
      category: "캠핑,야영장",
      roadAddress: "경상남도 사천시 서포면",
      hasBooking: true,
      placeReviewScore: 4.8,
      placeReviewCount: 241,
      totalReviewCount: 355,
      roomImages: [room(state, "Room:1557159426:1", "오션 글램핑", 169000, 219000)]
    }),
    entity(state, "Place:1460523479", {
      id: "1460523479",
      name: "피카푸 피크닉앤글램핑 진주점",
      category: "캠핑,야영장",
      roadAddress: "경상남도 진주시 내동면",
      hasBooking: true,
      placeReviewScore: 4.6,
      placeReviewCount: 174,
      totalReviewCount: 280,
      roomImages: [room(state, "Room:1460523479:1", "객실6 [캠핑톡]", 159000, 199000)]
    }),
    entity(state, "Place:35644668", {
      id: "35644668",
      name: "월명 글램핑",
      category: "캠핑,야영장",
      roadAddress: "경상남도 산청군 단성면",
      hasBooking: true,
      placeReviewScore: 4.9,
      placeReviewCount: 219,
      totalReviewCount: 301,
      roomImages: [
        room(state, "Room:35644668:1", "별빛 글램핑", 179000, 219000),
        room(state, "Room:35644668:2", "달빛 글램핑", 189000, 229000)
      ]
    }),
    entity(state, "Place:90000001", {
      id: "90000001",
      name: "산청 숲속 펜션",
      category: "펜션",
      jibunAddress: "경상남도 산청군 시천면",
      hasBooking: false,
      matchRoomMinPrice: 99000,
      roomImages: []
    })
  ];
  state.ROOT_QUERY[`accommodationSearch(${JSON.stringify({ input: { query, display: 50 } })})`] = {
    business: { items: places, total: 5 }
  };
  state.ROOT_QUERY[`adBusinesses(${JSON.stringify({ input: { query, businessType: "accommodation" } })})`] = {
    items: [places[2], places[0], places[3]],
    total: 3
  };
  return `<!doctype html><html><script>window.__APOLLO_STATE__=${JSON.stringify(state)};</script></html>`;
}

module.exports = { createBasicPlaceDemoHtml };
