# Industry snapshot allocation reduction

Industry analysis previously built a full monthly report, including nested
evidence copies, company/day aggregates, insights and output digests, before
discarding most of that report. The trusted saved-JSON industry path now uses
the same normalization and winner-selection kernel and returns only the fields
industry analysis consumes. Public monthly reports retain their full output.

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
- Glamping median sampled pipeline heap: 716,703,448 to 554,848,440 bytes
  (-22.58%); RSS: 898,322,432 to 738,095,104 bytes (-17.84%).
- Eight consecutive industries, one pair: sampled pipeline heap 1,441,316,368
  to 956,000,376 bytes (-33.67%). No forced garbage collection was used.
- 270 focused regression tests and isolated monthly-report/industry API checks
  passed. An initial PDF test failure was a missing local declared dependency;
  the unchanged test passed after installing the declared dependencies.

These are local sampled pipeline peaks, with the later preservation audit
excluded. They do not establish an absolute maximum, resolve the exact historic
company-source allocation event, or prove production response/paint latency.
Production deployment, guard/configuration readback and authenticated UI timing
are separate release gates.

Memory watermarks (65%/55%, two recovery samples), saved-read admission
(1,500 ms), collection schedules, call limits and protection policies are
unchanged. Calculation/source fingerprints include the new dependency; existing
cache generations must pass normal version validation.
