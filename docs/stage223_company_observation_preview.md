# Stage 223 Company and Observation Preview

> **2026-07-29 status change:** This preview remains contract-test evidence only.
> It is not a production integration, migration, backfill, shadow-read, or
> runtime data source. The integrated product will initialize an empty store and
> collect company and observation data again through the unified collectors.

## Boundary

Stage 223 originally added a read-only projection contract from V2-shaped stores to the
RC v1 company and property-observation contracts. Stage 224 narrows execution to
synthetic fixtures under an explicitly approved fixture root; operating V2 paths are no
longer valid preview inputs. It does not port an RC persistence layer, merge IDs, modify
source files or deploy a service.

Canonical sources remain:

- `company_master/companies.json`
- `history/observations.jsonl`
- completed directories under `outputs/`

The v2 `companyId` is authoritative. The adapter never generates a replacement company ID. History or run rows that cannot be resolved to an existing v2 company ID are counted as unresolved and omitted from preview items.

## Preview APIs

| Endpoint | Required flag | Access | Default state |
| --- | --- | --- | --- |
| `GET /api/integration-preview/companies` | `V2_INTEGRATION_COMPANY_ENABLED` | Administrator only | `404` |
| `GET /api/integration-preview/observations` | `V2_INTEGRATION_OBSERVATION_ENABLED` | Administrator only | `404` |

When enabled, a B2B session receives `403`. No preview route or payload is added to the business UI.

Both preview flags are test-only and fail closed outside `NODE_ENV=test`. Setting either
environment variable to a true value in development, staging or production does not
enable the adapter and the corresponding route remains `404`. These flag names must not
be reused by the fresh-store collection runtime.

Even in `NODE_ENV=test`, both routes remain `404` unless
`V2_INTEGRATION_PREVIEW_PURPOSE=contract-preview` and
`V2_INTEGRATION_PREVIEW_FIXTURE_ROOT` identify the synthetic fixture tree. The main
server calls `integration_data_access_guard.cjs` before any company/history/output read;
paths outside that root, legacy volume roots and missing purpose are rejected.

`RENDER` or `RENDER_EXTERNAL_URL` is treated as a production-runtime signal even if
`NODE_ENV=test` is misconfigured. In that case the preview flags stay false and both
routes remain `404`. The output directory, each run directory, `manifest.json` and every
CSV path are separately canonicalized and approved, so a symlink cannot escape the
fixture root. CSV `@json-file:` secondary references are not followed by the preview.

The observation endpoint supports `companyId`, `runId`, `collectionMode`, `limit`, `runLimit` and `includeRunOutputs`. It uses a dedicated read-only manifest/CSV loader instead of the operational `loadRun()` path. Preview requests therefore cannot trigger company upserts, history appends, external traffic collection or cache writes.

## Projection Rules

Company records preserve the v2 company ID and map canonical name, aliases, region, address, external IDs, URLs, source runs, confidence and review state into the RC v1 shape.

Observation records combine existing history and in-memory projections of completed run output. They normalize `collectionMode`, `searchScope`, channel, target date, product key, lead time, inventory, reservation rate and confidence. Repeated lead-time observations remain distinct through the existing observation ID or a deterministic preview ID.

## Verification

Run:

```powershell
npm run test:contracts
npm run test:integration-preview
npm test
```

The integration-preview regression test:

1. Uses synthetic `example.invalid` fixtures only.
2. Confirms both feature flags are required.
3. Confirms B2B access is denied.
4. Confirms all projected rows retain `cmp_fixture_001`.
5. Hashes company, history, manifest and output files before and after preview requests.
6. Compares the source directory file list to reject new cache or history files.
7. Compares the enabled API payload with `test/snapshots/stage223_integration_preview_snapshot.json`.
8. Confirms a test process with flags but without the explicit purpose/root cannot read
   preview data and receives `404`.

## Prohibited Operations

- Do not write an RC `company_master.json` or `property_observations.json` file.
- Do not mutate, rename or merge v2 company IDs.
- Do not append history while serving a preview request.
- Do not alter completed output directories.
- Do not enable flags or deploy from this stage.
