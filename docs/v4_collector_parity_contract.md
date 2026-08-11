# Datalab V4 Collector Parity Contract

## Status And Baselines

This contract covers offline fixture parity only. It does not establish live Provider
or production-write parity.

| Item | Verified value |
| --- | --- |
| Phase 7 source baseline | `c1d26654e52007712f9cf0389d7e69724b5d517a` |
| Frozen collector baseline | `4e4e1906e2967fe58df66f8ad67f832043d2763b` |
| Frozen collector | `scripts/gyeongnam_glamping_crawl.cjs` |
| Frozen collector blob | `bcbe229998da3afa6f31ee04375fb0766019e56f` |
| Phase 7 branch | `recovery/v4-collector-parity` |
| Worker job schema | `datalab-v4-worker-job.v1` |
| Parity report schema | `datalab-v4-collector-parity-report.v1` |
| Parity suite schema | `datalab-v4-collector-parity-suite.v1` |

The collector blob is checked before and after every parity execution. The collector
file is not modified by the parity transport, runner, comparator, or host.

## Collector Input Contract

The collector receives the search keyword as `argv[2]`. All other collection inputs
are read from the child environment. V4 validates and normalizes the job before it
constructs this environment.

| Input | Allowed or bounded values | Default in collector |
| --- | --- | --- |
| `keyword` | V4 validated string | `경남글램핑` when argv is absent |
| `CHECK_IN`, `CHECK_OUT` | V4 validated ISO dates | KST today, today + 6 |
| `ADULTS` | V4 bounded integer | `2` |
| `SEARCH_MODE` | `keyword`, `company` | `keyword` |
| `PRODUCT_MODE` | `all`, `lodging`, `campnic` | `all` |
| `COLLECTION_MODE` | `precision`, `fast` | `precision` |
| `COLLECTION_PURPOSE` | `basic_db`, `demand_location`, `revenue_detail` | `revenue_detail` |
| `DETAIL_RANK_RANGES` | V4 validated rank ranges | purpose-specific |
| `BOOKING_RANGE_DAYS` | `1..31` | `7` |
| `BOOKING_RANGE_PLACE_LIMIT` | `0..20` | profile-specific |
| `DATA_DIR`, `OUTPUTS_DIR`, `CONFIG_DIR` | V4-created isolated paths only | local fallback when not wrapped |

Collection profiles are selected in
`scripts/gyeongnam_glamping_crawl.cjs:77` and their inputs are bound at line 222.

| Profile | Regional Naver | OTA helpers | Booking detail | Weekly range |
| --- | ---: | ---: | ---: | ---: |
| `fast_rank` | no | no | no | no |
| `basic_db_light` | no | no | yes | no |
| `demand_location_signal` | yes | no | yes | no |
| `revenue_detail_deep` | yes | yes | yes | yes |

## External Call Boundaries

The frozen collector calls these boundaries through global `fetch`:

| Feature | Boundary | Code evidence | Offline fixture outcome |
| --- | --- | --- | --- |
| Naver list snapshot | `pcmap.place.naver.com/accommodation/list` | line 1029 | Apollo HTML generated in memory |
| Naver booking business | `pcmap-api.place.naver.com/graphql` | line 1119 | synthetic GraphQL response |
| Naver booking inventory | `m.booking.naver.com/graphql` | line 1219 | empty synthetic item/schedule data |
| Naver booking page fallback | `m.booking.naver.com/booking/3/bizes/...` | line 1182 | synthetic HTML |
| NOL count and list | `nol.yanolja.com/.../count`, `.../list` | line 2690 | synthetic JSON |
| Yeogi status probe | `www.goodchoice.kr/product/result` | line 2773 | synthetic HTTP 403 block |
| DDNayo search | `trip.ddnayo.com/web-api/total-search` | line 2794 | synthetic JSON |

The Naver Apollo HTML is parsed in memory; the raw HTML snapshot is not persisted as
an artifact. The frozen collector contains no `openapi.naver.com` Local Search path.
The approved Phase 6 canary therefore exercised a different Provider boundary and
cannot be declared functionally equivalent to this collector.

`scripts/fixtures/v4_collector_fixture_transport.cjs` is preloaded after the existing
low-level network blocker. Registered URLs receive in-memory fixtures. Any unregistered
`fetch` URL fails with `V4_PARITY_FIXTURE_UNHANDLED_URL`; direct HTTP, HTTPS, HTTP/2,
socket, TLS, datagram, and DNS access fails with `V4_OFFLINE_NETWORK_BLOCKED`.
Fixture traces retain route labels and query hashes, never request query text or
Provider response bodies.

## Output Contract

The collector creates one run directory under `OUTPUTS_DIR` and writes:

- platform combined CSV
- Naver overall, advertisement, and regional CSV files
- DDNayo CSV
- Markdown collection report
- combined and Naver XLSX workbooks
- optional `details/*.json` files for oversized detail values
- `manifest.json`

The manifest records the selected profile, input fields, file roles, detail JSON files,
and counts. Output creation begins before Provider collection at line 3192. Collector
writes are direct file writes; the collector itself does not atomically promote a
complete run. V4 instead executes under a private staging tree, validates the manifest
and inventory, adds `worker-envelope.json`, then atomically renames only a successful
run into its artifact directory.

The original historical Naver booking-ID fallback scans prior runs under `OUTPUT_ROOT`
at line 722. Parity runs intentionally start with an isolated empty output root, so
historical fallback behavior is not covered.

## Duplicate And Retry Contract

- Provider result rows are not globally deduplicated before CSV/XLSX output.
- Booking-detail work is deduplicated by `place_id` using a `Set`, cache, and promise
  map at line 2293. This avoids repeated booking-detail fetches but does not remove
  duplicate output rows.
- The duplicate fixture proves one duplicate Naver row remains in both direct and V4
  output. This is matching legacy behavior and a known functional gap.
- Naver booking-business lookup has an internal two-attempt loop at line 1123.
- Booking enrichment catches per-row errors and records a failure status rather than
  failing the whole run.
- The V4 adapter performs no automatic job retry or fallback. A failed idempotency key
  is terminal. A successful duplicate key reuses its existing artifact.
- Direct ONDA collection is explicitly unimplemented. Yeogi successful-response parsing
  is also unimplemented; only status/block evidence is represented.

## Comparator Contract

For each scenario, `scripts/v4_collector_parity.cjs` executes:

1. the frozen collector directly, once, in an isolated reference tree;
2. the frozen collector through `v4_worker_once.cjs`, once, in a separate worker tree;
3. a structured artifact and terminal-state comparison.

Only these nondeterministic values are canonicalized:

- manifest `outputDir`
- Markdown `수집일시`
- XLSX summary `수집일시`

The comparator does not change artifacts. It compares the collector file set, manifest
keys and values, parsed CSV columns/rows/IDs, XLSX sheet values, JSON values, Markdown,
manifest counts, process exit status, and V4 failure stage. `worker-envelope.json` is
reported as V4 adapter metadata and excluded from the collector file-set equality test.

## Offline Scenario Matrix

| Scenario | Expected contract |
| --- | --- |
| `success` | same successful artifact structure and content |
| `empty` | same empty Provider result structure |
| `duplicate` | same retained duplicate row, recorded as a functional gap |
| `missing-field` | same normalized missing-field output |
| `booking` | same booking-ID/page path with empty item inventory |
| `provider-error` | both fail with the expected non-zero collector contract |
| `timeout` | both are terminated by the configured timeout |

Additional adapter tests cover partial artifacts, terminal idempotency, path escape,
trace-path escape, secret scanning, unregistered URL blocking, and low-level socket
blocking.

## Feature Parity Classification

| Feature | Frozen collector | V4 parity path | Classification |
| --- | --- | --- | --- |
| Naver Apollo list snapshot parsing | implemented | same frozen code, fixture verified | matched offline |
| Regional Naver collection | implemented by profile | same frozen code, bounded fixture verified | matched offline |
| Naver booking lookup | implemented | same frozen code, empty-item fixture verified | partially matched |
| Official Naver Local Search API | absent | absent from collector path | mismatched with Phase 6 canary |
| NOL collection and normalization | implemented | same frozen code, fixture verified | matched offline |
| Yeogi crawl | status probe only | same behavior | matched limitation |
| DDNayo collection and normalization | implemented | same frozen code, fixture verified | matched offline |
| Direct ONDA collection | unimplemented | unimplemented | known gap |
| CSV/XLSX/report/manifest output | implemented | canonical fixture comparison passed | matched offline |
| Provider row deduplication | unimplemented | legacy duplicates preserved | known gap |
| Booking-detail request deduplication | implemented by `place_id` | inherited | code-verified, partially fixture-verified |
| Collector internal retry/fallback | limited Naver lookup retry and fallbacks | inherited | code-verified; live semantics unknown |
| Job-level retry/fallback | absent | explicitly disabled | matched |
| Atomic successful promotion | absent | implemented by V4 adapter | intentional V4 addition |
| Idempotency | absent | implemented by V4 adapter | intentional V4 addition |

## Commands And Runtime

- Build: `npm ci --omit=dev --ignore-scripts --audit=false --fund=false`
- Syntax: `npm run check:v4-parity`
- Offline tests: `npm run test:v4-parity`
- Reproduction:

```text
npm run start:v4-parity -- --suite --job-file tests/fixtures/v4_collector_parity_job.json --root <absolute-dedicated-root>
```

- Proposed persistent shadow start: `npm run start:v4-parity-shadow`
- Target Node: `26.5.0`

Phase 7 completed an offline `npm ci` and the full V4 recovery test suite with exact
Node `26.5.0`. The final parity evidence was regenerated with that runtime. An earlier
Node `24.14.0` pass was supplemental and is not the final evidence baseline.

## Shadow Storage And Environment

Required proposed environment names:

- `NODE_VERSION`
- `NODE_ENV`
- `V4_PARITY_DATA_DIR`
- `V4_PARITY_MODE`
- `V4_PARITY_EXTERNAL_CALLS_ENABLED`
- `V4_PARITY_OPERATIONAL_PUBLISH_ENABLED`
- `V4_PARITY_WEB_IMPORT_ENABLED`

The proposed disk mount is `/var/data/v4-parity`. It must not be shared with any
existing V4, Web, Worker, DB, or operational storage. The host accepts only fixture
mode and exact zero values for every external or operational gate. It runs the suite
once, persists an attempt marker, and then idles. A controlled restart reuses a valid
terminal report with zero collector invocations. If an attempt exists without a valid
report, the host blocks automatic replay and idles for operator review.
