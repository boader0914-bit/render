"use strict";
// One explicit budget for normalized two-month JSON and its decoded projection.
// Encoded projections, HTTP/final results, row counts and generation storage
// retain their separate existing limits. Exceeding this bound never clips rows.
const KEYWORD_MONTHLY_SOURCE_BUDGET = Object.freeze({ normalizedJsonBytes: 96 * 1024 * 1024, decodedProjectionBytes: 96 * 1024 * 1024 });
module.exports = { KEYWORD_MONTHLY_SOURCE_BUDGET };
