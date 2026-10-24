# Insight company reads and analytical memory

The 2026-10-23 13:21 and 16:28 KST production incidents exhausted the central Node.js heap and caused the process to exit with status 134. Insight received a non-JSON upstream 502 during recovery and returned `CONNECTION_UNAVAILABLE` 503. The observed master and observation files were approximately 93 MiB and 179 MiB. Parsing both complete files and retaining split history lines and parsed objects can consume substantially more heap than their file sizes.

## Read boundaries

- Insight company detail uses the existing streaming master/history readers and retains only canonical or explicitly merged company IDs. Name similarity never grants inclusion.
- The complete read/build lifetime runs under the existing analytical scheduler. Different heavy jobs do not overlap their allocations. Lease re-entry is supported; do not join an outer queued promise while holding the same lease.
- Insight's saved detail has a separate namespace from the administrator's detail cache. Both keep source-revision checks and the existing bounded cache policy.
- The integrated company DB remains the source of the monthly observation view. Skip the older observation-flow calculation that the connected projection discards. Explicit legacy adapter mode preserves that calculation.
- Stored-result evidence and receipt verification also stream the selected company master and use the analytical lease. Receipt validation conditions and collection dispatch remain unchanged.
- Evidence loading uses only that company's capacity correction context. A single selected run's existing parser remains in use; this change does not replace every archive parser.

## Preservation and verification

Raw master, observation, and run files are not rewritten. Room review precedence, public/other-channel booking estimates, missing values, and integrated calculation rules are unchanged. Source changes invalidate the derived detail; a failed rebuild keeps the previous normal saved file intact.

Validate strict and merged identity, same-name separation, real zero versus missing/error, saved-view restart reuse, namespace isolation, source-change races, analytical serialization/re-entry, and the real Insight and administrator HTTP paths. The low-heap fixture verifies streaming with inputs larger than the available heap, without network requests or loading the complete master/history through `readFile`.

## Saved-month format and pricing evidence (2026-10-24)

The read-only report preview accepts only the explicitly supported `company-integrated-v1`, `company-integrated-v2-price-observation-time`, and `company-integrated-v3-saved-product-recovery` envelopes. Future or similar-looking labels are rejected. The latter two require SHA-256 source-revision and complete-envelope cache-integrity markers. Existing v1 files retain their legacy compatibility, including verification of any markers they carry. Exact company/month, schema, date boundaries, file stability, room-review consistency, and nonnegative integer quantities with internally consistent booking totals remain required. This reader neither runs the monthly engine nor reads or changes its queue, raw evidence, room basis, or published reports.

The customer projection now preserves the engine's `phoneMissingPriceBookings`, `phoneFallbackBookings`, and `phoneFallbackRevenue`. For an individual date only, an unknown missing-price count from the revenue-eligible aggregate may fall back to the exact selected observation's count. Explicit aggregate zero remains zero. Monetary totals and monthly counts are copied, never re-summed or recalculated by the projection. `publicMissingPriceBookings`, `phonePricedBookings`, and `missingPriceSoldOut` are not currently part of the normalized monthly contract and must not be invented. Public partial-price displays use the existing `revenuePartial` flag conservatively.

Verify with `test_insight_saved_report_sources.cjs`, `test_insight_integrated_projection.cjs`, `test_insight_company_detail.cjs`, and `test_insight_report_source_status.cjs`.
