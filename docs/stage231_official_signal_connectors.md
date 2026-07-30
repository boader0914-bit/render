# Stage 231 official signal connector runtime

## Runtime boundary

The official adapters are disabled by default. No adapter is constructed and no credential is read unless all of these gates are satisfied:

1. `V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED=true` and its auth/fresh-observation dependencies are effective.
2. The provider-specific flag is true.
3. The provider id is present in `V2_INTEGRATION_SIGNAL_REAL_PROVIDERS` (comma-separated exact ids).
4. `V2_INTEGRATION_SIGNAL_TRANSPORT=fetch` is set explicitly.
5. Every provider-specific credential below is present.
6. The provider-specific approved daily and monthly call caps below are positive and at least `callsPerRun`.

There is no legacy `NAVER_*`, Cluster secret, browser credential, fixture fallback, or second signal contract. Only `scripts/integration/contracts/insights.cjs` live signals are committed. Tests inject a transport and make zero actual network calls.

The client submits only `clientRequestId`, `providerId`, `companyId`, `periodMonth`, and optionally a tenant id for server-side mismatch verification. Region, tenant ownership, signal kinds, retry, timeout, quota, and cost are derived by the server. Unknown fresh companies are 404, tenant mismatch is 403, and neither case persists a job.

## Exact environment variables

Common gates:

- `V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED=false` by default
- `V2_INTEGRATION_SIGNAL_REAL_PROVIDERS=` by default; supported ids are `naver-trend`, `tourism`, and `naver-searchad`
- `V2_INTEGRATION_SIGNAL_TRANSPORT=` by default; the only live value is `fetch`

NAVER DataLab Search Trend:

- `V2_CONNECTOR_NAVER_TREND_REAL_ENABLED=false`
- `V2_CONNECTOR_NAVER_DATALAB_CLIENT_ID`
- `V2_CONNECTOR_NAVER_DATALAB_CLIENT_SECRET`
- `V2_CONNECTOR_NAVER_TREND_APPROVED_DAILY_CALL_CAP`
- `V2_CONNECTOR_NAVER_TREND_APPROVED_MONTHLY_CALL_CAP`
- `V2_CONNECTOR_NAVER_TREND_APPROVED_DAILY_COST_CAP_KRW=0`
- `V2_CONNECTOR_NAVER_TREND_APPROVED_MONTHLY_COST_CAP_KRW=0`

Korea Tourism Organization TourAPI:

- `V2_CONNECTOR_TOURISM_REAL_ENABLED=false`
- `V2_CONNECTOR_TOURAPI_SERVICE_KEY`
- `V2_CONNECTOR_TOURISM_APPROVED_DAILY_CALL_CAP`
- `V2_CONNECTOR_TOURISM_APPROVED_MONTHLY_CALL_CAP`
- `V2_CONNECTOR_TOURISM_APPROVED_DAILY_COST_CAP_KRW=0`
- `V2_CONNECTOR_TOURISM_APPROVED_MONTHLY_COST_CAP_KRW=0`

NAVER SearchAd keyword tool:

- `V2_CONNECTOR_NAVER_SEARCHAD_REAL_ENABLED=false`
- `V2_CONNECTOR_NAVER_SEARCHAD_API_KEY`
- `V2_CONNECTOR_NAVER_SEARCHAD_SECRET_KEY`
- `V2_CONNECTOR_NAVER_SEARCHAD_CUSTOMER_ID`
- `V2_CONNECTOR_NAVER_SEARCHAD_APPROVED_DAILY_CALL_CAP`
- `V2_CONNECTOR_NAVER_SEARCHAD_APPROVED_MONTHLY_CALL_CAP`
- `V2_CONNECTOR_NAVER_SEARCHAD_APPROVED_DAILY_COST_CAP_KRW=0`
- `V2_CONNECTOR_NAVER_SEARCHAD_APPROVED_MONTHLY_COST_CAP_KRW=0`

SNS remains unavailable. `V2_CONNECTOR_SNS_REAL_ENABLED` does not construct an adapter because no approved official contract and credential boundary has been selected. The scheduler also remains stopped: its enable API fails closed until an approved target manifest and periodic slot runner exist. Manual jobs still have durable retry/backoff, resume, cancel, quota reservation, and kill-switch controls.

## Official contracts and allowlists

NAVER DataLab Search Trend uses only `POST https://openapi.naver.com/v1/datalab/search`, with `X-Naver-Client-Id`, `X-Naver-Client-Secret`, JSON content type, and the documented date/month and keyword-group request. Its daily ratios are averaged into the existing `trend.index` scale. Official contract: [NAVER DataLab search trend API](https://developers.naver.com/docs/serviceapi/datalab/search/search.md).

TourAPI uses only these HTTPS GET routes on `apis.data.go.kr`:

- `/B551011/DataLabService/metcoRegnVisitrDDList` → `tourism.visitors`
- `/B551011/AreaTarResDemService/areaTarSvcDemList` → `tourism.resource-demand`
- `/B551011/AreaTarDivService/areaTouDivList` → `tourism.diversity`

The public-data catalog documents a free development allowance of 1,000 calls and says production traffic increases require review. That catalog figure is not treated as our approved quota: Stage 224 keeps runtime quota at zero until the exact environment caps are explicitly approved. Official catalogs: [regional visitor counts](https://www.data.go.kr/data/15101972/openapi.do), [regional tourism resource demand](https://www.data.go.kr/data/15152138/openapi.do), and [regional tourism diversity](https://www.data.go.kr/data/15151365/openapi.do).

NAVER SearchAd uses only `GET https://api.searchad.naver.com/keywordstool` with `hintKeywords`, `showDetail=1`, and the documented `X-Timestamp`, `X-API-KEY`, `X-Customer`, and HMAC-SHA256 `X-Signature` headers. Monthly PC and mobile query counts are combined and normalized into the existing `search.volume` index. NAVER documents account/IP-specific throttling and longer backoff for 429 responses, so the approved cap remains explicitly required. Official documentation: [NAVER SearchAd API](https://naver.github.io/searchad-apidoc/) and [keyword-tool 429 guidance](https://naver.github.io/searchad-apidoc/notice/2020/12/18/notice/).

Every adapter validates the exact HTTPS origin, path, method, header names, and query names before transport. Credentials and credential-bearing URLs never enter signals, audit rows, diagnostics, or public errors. Provider request ids and targets are hashed by the existing live-signal normalizer.

## Insights read bridge

Completed connector signals remain in the Stage 231 store. Stage 229 insights receives the connector repository as a read-only source after the existing company/tenant access check, selects only `synthetic=false` and `dataMode=live`, and merges with its canonical signals by `signalId`. It does not copy, migrate, backfill, project, or dual-write rows. Fixture and synthetic connector rows contribute zero production inputs.

## Verification

- `npm run test:signal-connectors`
- `npm run typecheck:ui`
- `npm run test:ui`
- `npm run build:ui`

The official-adapter tests use injected transports only. They verify exact allowlists, schemas, HMAC signing, credential failure, secret redaction, external call accounting, target/tenant mutation-zero behavior, server policy injection, retry queue draining, and the connector-to-insights live read bridge. Actual provider traffic remains zero until an operator supplies and approves every runtime gate above.
