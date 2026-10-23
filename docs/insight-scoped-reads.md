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
