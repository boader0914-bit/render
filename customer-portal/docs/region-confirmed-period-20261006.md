# Insight: confirmed monthly reference period

## Contract

- Insight only: DataLab code, source snapshots, collection schedules and DB are unchanged.
- Use each indicator group's last normal saved month at or before the requested report cutoff.
- Prefer 12 consecutive normal months; otherwise accept 11 consecutive normal months. Never join observations across a missing month. Shorter coverage is reference-only.
- A normal zero is valid; missing, partial, error, duplicate and invalid numeric observations are not zero.
- All required metrics of a group must be normal for its month to qualify. Groups may have different end months.
- Confirmed means usable saved evidence, not independent verification of the provider's publication process.
- Preserve search-index normalization periods and annual KOSIS periods. Compute comparisons only from valid same-period observations.
- Regional analysis, home briefing and report responses use the same read projection without additional upstream calls.
- Separate preparation processing progress from usable saved coverage. Keep the original job outcome under the last-refresh disclosure; do not rewrite it.

## Validation

- `node --test scripts/test_insight_connection.cjs customer-portal/test/*.test.cjs`: 118 passed, 0 failed.
- Syntax checks and `git diff --check` passed.
- Real saved Sancheong response: visitors, stay/spend, resource demand and diversity each use 2025-09 through 2026-08, with 12 normal points. Search uses 2025-10 through 2026-09, with its original 24-month normalization period preserved.
- Desktop dark/light, metric switching and 390px mobile preview verified; no horizontal overflow or console errors.
- Preview and evidence: `C:\Users\User\.codex\visualizations\2026\10\06\insight-region-confirmed`.
- No new collection or provider API refresh was run for verification.

## Release

- Deploy only Render Insight service `srv-dathlifavr4c73dj3jt0`.
- Deployed commit `c68064cb4afa25028bb2565ba0d57c1a62342812` through `dep-db294ccs728c73bj5eu0`, 2026-10-06 15:16:17 KST, duration 29.8s. Render confirms Deploy succeeded / Live.
- Render build also passed all 118 tests. GitHub Actions has no configured runs; Render performed the release checks.
- Insight health: `status=ok`, `mode=connected`, `buildCommit=c68064cb4afa`. Both changed browser assets match the checkout.
- Authenticated production regional analysis and preparation GETs returned 200. API and UI show all five monthly groups confirmed with the expected 12-month periods, 6/6 usable preparation groups, and no browser errors.
- Production screenshot: `production-confirmed.png` in the evidence directory above.
- DataLab health remains `ok=true`, `buildCommit=d157bed15242`; no DataLab deployment or source-data write occurred.
