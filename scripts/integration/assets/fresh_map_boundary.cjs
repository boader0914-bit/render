"use strict";

const FRESH_MAP_BOUNDARY_SHA256 = "1cd70bc95ec6ce5cbce1a98ea49fe7a81bdaada98a536b075f25c471e998aae8";

function canonicalizeFreshMapBoundaryPayload(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  return Buffer.from(text.replace(/\r\n|\r|\n/g, "\n").replace(/\n/g, "\r\n"), "utf8");
}

module.exports = {
  FRESH_MAP_BOUNDARY_SHA256,
  canonicalizeFreshMapBoundaryPayload
};
