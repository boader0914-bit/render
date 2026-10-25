"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { normalizeCompanyAddress, companyAddressBasis, addressRegion } = require("./lib/company_address_basis.cjs");
const ADDRESS = "경상남도 합성군 시험로 10";
const basis = (status, address = null) => ({ status, address, basis: "saved_company_address" });

test("saved address normalization uses NFKC and whitespace only without editing its input", () => {
  assert.equal(normalizeCompanyAddress("  경상남도　합성군   시험로 １０  "), ADDRESS);
  for (const value of [null, 10, {}, "", "   ", "경남\n합성군 시험로 10", "x".repeat(301)]) assert.equal(normalizeCompanyAddress(value), null);
  const company = { address: "  경상남도　합성군   시험로 １０  ", addresses: [{ address: ADDRESS }] }, original = JSON.stringify(company);
  assert.deepEqual(companyAddressBasis(company), basis("ready", ADDRESS)); assert.equal(JSON.stringify(company), original);
});

test("only one distinct saved detailed address is ready and aliases are never inferred equivalent", () => {
  assert.deepEqual(companyAddressBasis({ address: ADDRESS, addresses: [ADDRESS, { address: ADDRESS }] }), basis("ready", ADDRESS));
  assert.deepEqual(companyAddressBasis({ addresses: [ADDRESS] }), basis("ready", ADDRESS));
  for (const company of [{ address: ADDRESS, addresses: ["경상남도 합성군 시험리 1-1"] }, { addresses: [ADDRESS, "경상남도 합성군 시험로 20"] }]) {
    assert.deepEqual(companyAddressBasis(company), basis("ambiguous"));
  }
});

test("administrative names, absent addresses and inactive source records cannot become detailed addresses", () => {
  for (const company of [null, {}, { address: "경상남도 합성군" }, { address: "합성군" }, { addresses: [] },
    { address: ADDRESS, deletedAt: "2026-10-20" }, { address: ADDRESS, mergedIntoCompanyId: "another" }]) {
    assert.deepEqual(companyAddressBasis(company), basis("missing"));
  }
});

test("digits in a district or road name alone do not prove a building number or parcel", () => {
  for (const address of ["경기도 수원시 영통구 매탄1동", "경남 산청군 산청읍 웅석봉로285번길"]) {
    assert.deepEqual(companyAddressBasis({ address }), basis("missing"));
  }
  for (const address of ["경남 산청군 산청읍 웅석봉로285번길 80-20", "경남 산청군 산청읍 지리 123-4"]) {
    assert.deepEqual(companyAddressBasis({ address }), basis("ready", address));
  }
});

const regions = [
  { regionKey: "gn-synthetic", fullName: "경상남도 합성군", aliases: ["경남 합성군", "합성군"], level: "local", active: true },
  { regionKey: "gg-synthetic", fullName: "경기도 합성군", aliases: ["경기 합성군", "합성군"], level: "local", active: true },
  { regionKey: "gn-parent", fullName: "경상남도", aliases: ["경남"], level: "province", active: true }
];
test("region matching requires the saved province-qualified address and supports saved full aliases", () => {
  assert.equal(addressRegion(ADDRESS, regions)?.regionKey, "gn-synthetic");
  assert.equal(addressRegion("  경남　합성군 시험로 １０ ", regions)?.regionKey, "gn-synthetic");
  assert.equal(addressRegion("경기도 합성군 시험로 10", regions)?.regionKey, "gg-synthetic");
  for (const address of ["합성군 시험로 10", "다른도 합성군 시험로 10", "경상남도 다른군 합성군 시험로 10", null]) assert.equal(addressRegion(address, regions), null);
});

test("the longest unique eligible prefix wins while inactive and general districts are excluded", () => {
  const city = { regionKey: "city", fullName: "경기도 시험시", level: "local" }, district = { regionKey: "district", fullName: "경기도 시험시 시험구", level: "local" };
  assert.equal(addressRegion("경기도 시험시 시험구 시험로 10", [city, district])?.regionKey, "district");
  for (const excluded of [{ active: false }, { selectable: false }, { unitType: "general_district" }, { level: "province" }]) {
    assert.equal(addressRegion("경기도 시험시 시험구 시험로 10", [city, { ...district, ...excluded }])?.regionKey, "city");
  }
  assert.equal(addressRegion("경기도 시험시 시험로 10", [city, { ...city, regionKey: "duplicate" }]), null);
  assert.equal(addressRegion("경기도 시험시 시험로 10", [city, { ...city }])?.regionKey, "city");
});
