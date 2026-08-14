# V2 live basic Place collector evidence

## Scope

- Capability: Naver accommodation Place search, organic rank, and advertisement list
- Keyword: `경남 글램핑`
- Provider request: `GET https://pcmap.place.naver.com/accommodation/list?query=<keyword>`
- Request budget: 1
- Automatic retries: 0
- Fallbacks: 0
- Operational writes: 0
- Raw Provider response stored: false

## Local live result

- Run ID: `rebuild-live-basic-place-20260814-001`
- Collected at: `2026-08-14T12:28:13.847Z`
- HTTP status: 200
- Apollo operation: `accommodationSearch`
- Provider organic total: 401
- Collected organic rows: 50
- Collected advertisement rows: 18
- Organic/advertisement Place ID overlap: 9
- Empty Place IDs: 0
- Manifest digest: `36e726d7663ae4e9c9362975fa5dc73916da6c76971471e600c1cf277c555199`

The local artifacts are isolated under
`outputs/v2-live-basic-place/rebuild-live-basic-place-20260814-001` and are
excluded from Git. The committed report contains no Provider response body,
cookies, request headers, or secret values.

## Selected evidence

| Organic rank | Place ID | Name | Booking observed | Preview rooms | Minimum price |
| ---: | --- | --- | --- | ---: | ---: |
| 1 | `37812354` | 에이원글램핑 | true | 5 | 99,000 |
| 2 | `1557159426` | 비토노을숲 글램핑 | true | 5 | 120,000 |
| 3 | `1460523479` | 피카푸 피크닉앤글램핑 진주점 | true | 5 | 99,000 |
| 12 | `35644668` | 월명 글램핑 | true | 5 | 179,000 |

For 월명 글램핑, the five values are Place search preview products, not a
verified physical room count. Full room quantity and inventory remain a later
booking-product and daily-schedule capability.

## Advertisement evidence

- Advertisement contract present: true
- Advertisement Provider total: 18
- First advertisement: Place ID `1763628760`, 노랑카라반
- Advertisement 10: Place ID `1460523479`, 피카푸 피크닉앤글램핑 진주점
- Every advertisement row has a numeric Place ID and explicit advertisement order.
- Advertisements are not removed when the same Place also appears organically.

## Artifact integrity

| File | SHA-256 |
| --- | --- |
| `organic.json` | `0dfa861c7e80e4a4d89aeaa48f537a98839409169be1c19b1282606ab6ede657` |
| `organic.csv` | `ef6dd43a3c76ce30380963048007bad42eba0a4f4cbe520686af5d77047c705f` |
| `advertisements.json` | `30feddfabf05dc0d5268f2465a13e20003516b162f04f62a7c8524bf2d35bce5` |
| `advertisements.csv` | `6f09958fa7a9f9909ef1f229698ea5310b03ef45d7ca7f03eb8a80db457a09be` |

## Render release contract

- Service type: isolated Background Worker
- Auto Deploy: Off
- Plan and instances: Starter, 1
- Disk: 1 GB mounted at `/var/data/v2-live-basic-place-collector`
- Build Command: `npm ci --ignore-scripts --audit=false --fund=false && npm run check:v2-live-basic-place && npm run test:v2-live-basic-place && npm run check:v2-live-basic-place-render && npm run test:v2-live-basic-place-render`
- Readiness Start Command: `npm run start:v2-live-basic-place-render-readiness`
- Live one-shot Start Command: `npm run start:v2-live-basic-place-render-live`
- Committed Render job digest: `7ff0f1773610e8fe683e6202c9e19285d56b9059f0e777ab8803f288563338c3`

The first deployment must use readiness-only gates. A live canary requires an
explicit outer gate, creates a durable claim before collection, commits one
terminal record, and blocks duplicate execution without another Provider call.
