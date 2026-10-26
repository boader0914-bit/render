"use strict";

// Select an existing business address only. No geocoder, region centroid,
// spelling inference, original/master mutation or network dependency.
function normalizeCompanyAddress(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f\uFFFD]/.test(value) || value.length > 300) return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= 300 ? normalized : null;
}
function hasDetailedAddress(value) {
  const address = normalizeCompanyAddress(value);
  return Boolean(address && (/(?:로|길)\s+\d+(?:-\d+)?(?=\s|$|[,(/])/u.test(address)
    || /(?:읍|면|동|리|가)\s+(?:산\s*)?\d+(?:-\d+)?(?:번지)?(?=\s|$|[,(/])/u.test(address)));
}
function companyAddressBasis(company) {
  if (!company || typeof company !== "object" || company.deletedAt || company.mergedIntoCompanyId) return { status: "missing", address: null, basis: "saved_company_address" };
  const input = [...(Array.isArray(company.addresses) ? company.addresses : []), ...(typeof company.address === "string" ? [company.address] : [])];
  const addresses = [...new Set(input.map(value => normalizeCompanyAddress(typeof value === "string" ? value : value?.address)).filter(Boolean))];
  // Different road/parcel aliases are not proven equivalent without saved
  // evidence. A municipality name alone is not a facility's detailed address.
  const status = addresses.length > 1 ? "ambiguous" : addresses.length === 1 && hasDetailedAddress(addresses[0]) ? "ready" : "missing";
  return { status, address: status === "ready" ? addresses[0] : null, basis: "saved_company_address" };
}
function addressRegion(address, regions) {
  const value = normalizeCompanyAddress(address);
  if (!value) return null;
  const token = text => String(text || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const target = token(value);
  // Full province-qualified aliases only. Same-name cities in another
  // province and broad administrative overrides are never location evidence.
  const candidates = (Array.isArray(regions) ? regions : []).filter(r => r && r.active !== false && r.selectable !== false && r.level === "local" && r.unitType !== "general_district")
    .flatMap(region => [...new Set([region.fullName, ...(region.aliases || [])].filter(v => typeof v === "string" && /\s/.test(v.trim())).map(token))]
      .filter(alias => alias && target.startsWith(alias)).map(alias => ({ region, length: alias.length })));
  if (!candidates.length) return null;
  const maximum = Math.max(...candidates.map(row => row.length));
  const unique = [...new Map(candidates.filter(row => row.length === maximum).map(row => [row.region.regionKey, row.region])).values()];
  return unique.length === 1 ? unique[0] : null;
}
module.exports = { normalizeCompanyAddress, hasDetailedAddress, companyAddressBasis, addressRegion };
