# V2 live collection runtime

## Decision

The integrated app uses the V2 company identity, search, booking, inventory, price and OTA meanings as the canonical contract. Cluster behavior is limited to additive job lifecycle, retry, quota, kill-switch, audit and V3 presentation concerns.

Legacy V2 or Cluster output files, history, company databases, caches and credentials are not runtime inputs. Every accepted live response is normalized directly into the fresh integration store with `synthetic=false`, `dataMode=live`, provider provenance and a fresh run ID.

## Runtime modes

| `V2_INTEGRATION_FRESH_PROVIDER` | Production behavior |
| --- | --- |
| unset, `disabled`, `none` | Server boots with collection capability disabled; mutation returns 503 |
| `synthetic` | Disabled in production; permitted only for isolated tests |
| `v2-live`, `live` | Builds the V2 live adapter, but remains disabled until every approval gate below passes |

Existing synthetic records are preserved for audit and test reproducibility, but production company, run, insight, report and strategy projections do not expose them.

### Naver Search transport mode

`V2_INTEGRATION_LIVE_NAVER_SEARCH_MODE` is mandatory whenever a live run includes `discovery` or `quick`. It defaults to `disabled`; there is no automatic fallback between modes.

| Value | Behavior |
| --- | --- |
| `disabled` or unset | Naver Search is fail-closed and no endpoint builder or transport is used |
| `api-hub` | Uses the official NAVER API HUB Local Search contract only |
| `internal-web` | Explicit opt-in to the existing Naver web/Apollo adapter; never selected as a default or as an API HUB fallback |

The preferred fast-search configuration is:

```text
V2_INTEGRATION_LIVE_NAVER_SEARCH_MODE=api-hub
V2_INTEGRATION_LIVE_NAVER_API_HUB_KEY_ID=<Preview-only key ID>
V2_INTEGRATION_LIVE_NAVER_API_HUB_KEY=<Preview-only secret key>
V2_INTEGRATION_LIVE_NAVER_SEARCH_SORT=random
```

API HUB mode permits only `GET https://naverapihub.apigw.ntruss.com/search/v1/local` with exactly `query`, `display=5`, `start=1` and `sort=random|comment`. It sends credentials only in `X-NCP-APIGW-API-KEY-ID` and `X-NCP-APIGW-API-KEY`. The official host allowlist is code-bound and cannot be expanded through environment values. Credentials are excluded from request keys, durable quota reservations, audit data, provider results, diagnostics and errors.

Local Search titles are stripped of markup. `link`, `address`, `roadAddress`, `category`, `mapx` and `mapy` are normalized for provider-local matching. Because the official response does not provide a Naver Place ID, the adapter creates a SHA-256 identity from those public item fields under the `naver-api-hub-local` namespace; credentials are never identity input. A result's third-party `link` may contribute to that provider-local hash but is not persisted as a trusted fresh-store URL. `mapx` and `mapy` are retained as source coordinates and are not mislabeled as WGS84 latitude/longitude.

## Live approval gates

All gates are required before the UI reports that collection is available:

```text
V2_INTEGRATION_FRESH_PROVIDER=v2-live
V2_INTEGRATION_LIVE_COLLECTION_ENABLED=true
V2_INTEGRATION_LIVE_NAVER_SEARCH_MODE=api-hub
V2_INTEGRATION_LIVE_NAVER_API_HUB_KEY_ID=<configured secret reference>
V2_INTEGRATION_LIVE_NAVER_API_HUB_KEY=<configured secret reference>
V2_INTEGRATION_LIVE_APPROVAL_MANIFEST=<canonical JSON approval manifest>
V2_INTEGRATION_LIVE_APPROVAL_SHA256=<sha256 of the normalized canonical manifest>
V2_INTEGRATION_LIVE_APPROVED_PROVIDERS=naver-search,naver-booking,nol,ddnayo
V2_INTEGRATION_LIVE_REQUESTED_STAGES=discovery,quick,detail,ota
V2_INTEGRATION_LIVE_REQUESTS_PER_RUN=<approved positive integer>
V2_INTEGRATION_LIVE_REQUESTS_PER_DAY=<approved positive integer>
V2_INTEGRATION_LIVE_NAVER_SEARCH_KILL_SWITCH=false
V2_INTEGRATION_LIVE_NAVER_BOOKING_KILL_SWITCH=false
V2_INTEGRATION_LIVE_NOL_KILL_SWITCH=false
V2_INTEGRATION_LIVE_DDNAYO_KILL_SWITCH=false
```

Kill switches default open (`true`), and both request budgets default to zero. Approved HTTPS hosts are code-bound to the V2 endpoints; an environment variable cannot expand the host allowlist. The approval manifest and digest must be newly generated for Preview and must not be copied from either legacy app.

The manifest contract is `v2-live-approval-v1`. Its digest binds all of the following fields:

```json
{
  "version": "v2-live-approval-v1",
  "approvalId": "approval-unique-id",
  "issuedAt": "2026-07-30T00:00:00.000Z",
  "expiresAt": "2026-07-31T00:00:00.000Z",
  "targets": [
    {
      "targetName": "approved lodging name",
      "regionCode": "approved-region",
      "targetDates": ["2026-08-01"]
    }
  ],
  "providers": ["naver-search", "naver-booking", "nol", "ddnayo"],
  "stages": ["discovery", "quick", "detail", "ota"],
  "requestCaps": { "perRun": 100, "perDay": 100 },
  "providerCaps": {
    "naver-search": { "perRun": 100, "perDay": 100, "costMicros": 0, "stages": ["discovery", "quick", "detail"] },
    "naver-booking": { "perRun": 100, "perDay": 100, "costMicros": 0, "stages": ["detail"] },
    "nol": { "perRun": 100, "perDay": 100, "costMicros": 0, "stages": ["ota"] },
    "ddnayo": { "perRun": 100, "perDay": 100, "costMicros": 0, "stages": ["ota"] }
  },
  "cost": { "currency": "KRW", "maximumCostMicros": 0 }
}
```

The numeric values above are an illustrative upper-bound shape, not an activation approval. Runtime submission rejects a plan when its deterministic `requestEstimate` cannot fit the global/provider run and day caps or the cost ceiling. Stage 224's current real-provider quota remains zero until a separately approved manifest replaces the example.

Every outbound attempt revalidates the digest, active time window, exact target/date, provider, stage, configured run/day caps and approved cost. Submission also validates every date in a revenue-detail window, so every inclusive `checkIn..checkOut` date must appear in the target's manifest scope. A target or date not listed in the manifest is rejected before target/run mutation, quota reservation or transport. Calendar dates are strict; values such as `2026-02-31` are invalid.

Request quota is reserved atomically in the fresh repository before transport. Each reservation stores the approval ID, manifest digest, exact cap snapshot, target hash, provider, stage, request key and cost. Global run/day limits, provider run/day limits and the approval cost ceiling are durable across worker concurrency, restart and crash. A reservation remains consumed after an uncertain crash, which is the conservative fail-closed policy. A zero or missing cap, including an omitted zero-cost declaration, disables live transport.

The stored collection plan is authoritative for worker calls:

| Plan | Provider stages |
| --- | --- |
| fast | `discovery`, `quick` |
| basic DB | `discovery`, `quick`, `detail` |
| demand/location | `discovery`, `quick`, `detail` |
| revenue detail | `discovery`, `quick`, `detail`, `ota`; detail iterates the inclusive `checkIn..checkOut` window, capped at 31 dates |

`finalize` is an internal repository stage and never invokes a provider. Fast runs therefore cannot call booking detail or OTA endpoints. Basic DB and demand/location runs collect detail for one target date. Each revenue-detail date receives a distinct raw evidence key and observation provenance; a retry replays the bounded date window and repository idempotency prevents duplicate observations.

## Current provider scope

- Naver Place discovery and quick profile
- Naver booking business identity, products and date inventory
- NOL/Yanolja and Ddnayo exposure checks
- V2 company ID issuance
- fresh Raw → Observation → Derived → Business-safe persistence
- durable run lease, retry, cancel, resume and provider-call audit

In `api-hub` mode discovery uses only the bounded official Local Search request. In explicitly selected `internal-web` mode discovery uses only the exact Apollo query key requested by the run. Neither mode falls back to the other. Company selection requires an unambiguous name score of at least 80 and the requested region. Optional ranking uses a separate query and stores its condition hash and request key. OTA observations retain each channel's provider, source URL and request key. Null profile, stock or exposure values do not satisfy completeness.

The fast plan invokes only `discovery` and `quick`. Precision/detail and OTA stages remain separate provider approvals in the manifest, provider allowlist, kill switches and quota caps. Selecting API HUB search never authorizes or silently invokes Naver booking, NOL, Ddnayo or the internal web search endpoint.

The adapter has no filesystem dependency and never scans historical outputs. Test transports are injected; test fixtures do not represent user data.

## Rollback

Set `V2_INTEGRATION_LIVE_COLLECTION_ENABLED=false` or open any provider kill switch and redeploy the last verified Preview commit. Queued live runs then fail closed without falling back to synthetic or legacy data. Do not delete the fresh store; it remains the audit and restart-recovery source.

## External-call approval checkpoint

Implementation and injected-transport tests do not authorize a real request. Immediately before the first real Preview call, report and approve:

1. provider and exact endpoint family;
2. target company and target dates;
3. maximum requests per run and per day;
4. expected monetary cost and applicable provider quota;
5. rollback environment values and kill-switch action.

Until that separate approval is recorded, real external calls remain zero.
