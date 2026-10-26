"use strict";
const { addressRegion } = require("./company_address_basis.cjs");
const token = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
// Saved public company location only. No run discovery, source rows, capacity
// preparation, keyword inference, provider calls or analytical queue ownership.
function registeredMarketTargets(companies, units) {
  if (!Array.isArray(companies) || companies.length > 4096 || !Array.isArray(units)) throw Error("TARGET_READ_FAILED");
  const active = units.filter(x => x?.active === true && x.selectable === true && ["local", "broad"].includes(x.level));
  const unique = values => [...new Map(values.map(x => [x.regionKey, x])).values()];
  function exact(value) {
    const id = active.filter(x => [x.regionKey, x.regionId].includes(value));
    if (id.length) return id.length === 1 ? id[0] : null;
    const text = token(value); if (!text) return null;
    const matches = unique(active.filter(x => [x.fullName, x.name, ...(x.aliases || [])].some(alias => token(alias) === text)));
    return matches.length === 1 ? matches[0] : null;
  }
  return companies.map(company => {
    const basis = company?.regionBasis;
    if (!basis || basis.invalid || !Array.isArray(basis.regions)) return "";
    if (basis.override) return exact(basis.override)?.regionKey || "";
    const addressMatches = (company.addresses || []).map(value => addressRegion(value, active));
    if (addressMatches.some(value => !value)) return "";
    const addresses = unique(addressMatches);
    if (addresses.length) return addresses.length === 1 ? addresses[0].regionKey : "";
    const regionMatches = basis.regions.map(exact);
    if (regionMatches.some(value => !value)) return "";
    const regions = unique(regionMatches);
    if (regions.length === 1) return regions[0].regionKey;
    const local = regions.filter(x => x.level === "local");
    return local.length === 1 && regions.every(x => x.regionKey === local[0].regionKey || x.regionKey === local[0].provinceRegionKey) ? local[0].regionKey : "";
  });
}
module.exports = { registeredMarketTargets };
