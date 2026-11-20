# Industry snapshot allocation reduction

Industry analysis previously built a full monthly report, including nested
evidence copies, company/day aggregates, insights and output digests, before
discarding most of that report. The trusted saved-JSON industry path now uses
the same normalization and winner-selection kernel and returns only the fields
industry analysis consumes. The optimized kernel and lineage helper live in
`industry_monthly_snapshot.cjs` and `industry_monthly_insights.cjs`. Public
monthly report calculation files are restored byte-for-byte to the preceding
f4b release and retain their full output.

The producer capability is in-process provenance established after the saved
source boundary succeeds. It is not a JSON validator or a security boundary.
Generic sources and callbacks retain eager cloning. Borrowed nested evidence
cannot escape the private industry projection; public full output still clones
each selected row independently.

## Verification before release

- Same-generation saved financial source: 62 compressed files, 49,492
  observations, 558 companies, 356 runs and 6,275 rank rows.
- Original source files, provider APIs and KOSIS were not used for replay.
- Three fresh-process glamping pairs and one eight-industry pair had identical
  complete DTO bytes (11 comparisons). Original array shapes, chunk bytes,
  scaffold metadata and transitive code pins were rechecked after every replay.
- Corrected private-module candidate, glamping median sampled pipeline heap:
  715,822,640 to 554,994,528 bytes (-22.47%); RSS: 897,667,072 to
  737,529,856 bytes (-17.84%).
- Eight consecutive industries, one pair: sampled pipeline heap 1,441,312,272
  to 955,556,560 bytes (-33.70%); RSS: 1,654,845,440 to 1,146,073,088 bytes
  (-30.74%). No forced garbage collection was used.
- Corrected private-module candidate passed 306 regression tests across 23
  non-overlapping files and isolated monthly-report/industry API checks.
  An earlier PDF test failure was a missing local declared dependency;
  the unchanged test passed after installing the declared dependencies.

These are local sampled pipeline peaks, with the later preservation audit
excluded. They do not establish an absolute maximum, resolve the exact historic
company-source allocation event, or prove production response/paint latency.
Production deployment, guard/configuration readback and authenticated UI timing
are separate release gates.

Memory watermarks (65%/55%, two recovery samples), saved-read admission
(1,500 ms), collection schedules, call limits and protection policies are
unchanged. The industry calculation fingerprint explicitly includes both private
modules and `monthly_snapshot_owned_inputs.cjs`. The public prepared-result
fingerprint still hashes its actual seven public files; no fingerprint override,
accepted legacy alias, data migration or catalogue rewrite is introduced.

## Saved monthly compatibility correction

The first 3bb production check returned HTTP 503
`KEYWORD_MONTHLY_RESULT_CALCULATION_CHANGED`: the shared monthly files had
changed the public calculation fingerprint from `8cd94ef4...ee7d2` to
`897a4889...625ac`, while all 73 stored prepared results still used the former.
This was a release compatibility regression, separate from memory admission.
The strict rejection was retained and the existing catalogue/results were left
untouched. Restoring the real public source bytes restores the original
fingerprint naturally; the memory optimization is isolated to industry code.

The private kernel's normalization/selection calculation body matches the tested
3bb body. Its untrusted fallback directly calls the original public full builder.
This intentional code duplication keeps public saved-result compatibility stable;
future calculation changes must review both kernels and their parity tests.

The corrected candidate repeats the complete same-source replay (three glamping
pairs plus eight industries) and the public-byte/fingerprint regression before
deployment. Complete DTO bytes and original arrays/chunks/metadata/code pins are
checked, rather than comparing selected totals alone. Actual production UI
checks remain a separate gate and any authentication reset is reported
separately from same-session state restoration.

## Cold-source retention and failed navigation

An actual 5f production check subsequently encountered a separate failure:
process 88 on instance njnv9 exited at 12:51:12 KST with V8 `Reached heap
limit` around 2,045 MB of old-space usage. Its last recorded owner was industry
build 9, in a nested source-preparation phase since 12:46:30. A later month
request received proxy 502 after the process had already exited. This is not a
monthly-query calculation-version rejection or a proven cgroup OOM kill.
The exact allocating object is not established by those coarse phase records.

The source adapter formerly retained the original observation Map while the
recalculation producer retained a second complete monthly row array. The explicit
`streamIndustryObservations` application opt-in now transfers industry rows into
that same Map in original run/company/row order as they are produced. Generic
and public consumers retain the full-array contract. Final evidence metadata,
freshness assertions, publication rules and transfer checkpoint counts remain.
This equivalence relies on the application's fixed pure observation projector;
it is not a contract for arbitrary stateful callbacks. Three bounded diagnostic
phases distinguish history, recalculation and recovery memory in future runs.

A separate replay sends all 49,492 sealed derived observations through the real
producer/source factories using explicit stand-in parsing adapters. Both complete
source digests, row/field order and eight entire DTO byte sequences match. The
producer's returned row array falls from 49,492 to zero. One pair's sampled
transport heap is 588,109,800 to 583,175,904 bytes (0.84%); input derived rows
remain retained for audit. This does not reproduce raw saved-run parsing,
capacity reconstruction or the complete production cold-source prefix, and
does not establish that the production heap exhaustion is fully resolved.

The observed failed month navigation also discarded its previous visible KPIs.
The UI now restores the complete last successful displayed scope on transient
failure, while retaining the failed request as an unapplied draft and explicit
notice. Authentication clearing, newer requests, destroyed views and successful
authoritative missing/stale responses never revive an old result.

Final local gates: 387 core tests across 27 files, 219 UI/cache cases across
two other files, and both isolated API tests pass. The UI mock suite is split
into bounded fresh processes; the exact prior 5f UI/test source also exhausted
a 512 MiB monolithic test process. No production memory threshold was raised.
