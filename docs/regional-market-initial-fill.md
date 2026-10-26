# Regional market initial fill

The 2026-10-26 operator request authorizes a finite daily fill of the 86 regions
not inspected by weekly job `bd14458a-0e4c-44ea-a665-b00df766f239`, plus the four
tables in that job's partial Goheung result. This is separate from lodging
collection schedules and the existing seven-day weekly job ledger.

- Default disabled; the administrator explicitly enables `/api/regional-market/bootstrap-policy`.
- First eligible execution is the next Korean calendar day at 12:10. An immutable
  per-day claim permits one batch per day. Restarts never replay an unconfirmed
  claim, and missed days are not accumulated into multiple batches.
- The worker uses the single application KOSIS client, its existing 100-request
  daily budget, serial pacing, cooldown, evidence validation and durable attempts.
  A table usually costs two requests. There is no separate provider quota.
- Existing valid values, including zero and latest published annual values, are
  reused. Only typed local budget exhaustion can defer to a later day. Provider
  quota, authentication, suppressed/unverified data and unknown executions stay held.
- The fixed input reader verifies exact SHA256 values for the preserved original
  weekly job, Goheung attempt/cache, budget and review receipt under
  `/var/data/operations/region-market-bootstrap-20261026`. It grants a one-use,
  next-day admission review for those exact four tables, never a general hold reset.
- Progress and immutable daily receipts live under `regional_market_bootstrap`.
  Existing weekly state and locks are never rewritten by this service.
- The native weekly clock and manual weekly command are gated until the finite
  cohort is fully verified. Completion requires all 86 regions and four original
  tables available, plus exact saved cache-only projections. The daily policy then
  disables itself and releases the existing enabled weekly clock.

An unconfirmed execution or malformed journal requires operator investigation;
do not clear a lock, delete history or rerun a claim to make the status appear healthy.
The Codex heartbeat inspects saved receipts only and does not execute collection.
