# Dependency and Import Security

## Stage 207 scope

This document records the production boundary for spreadsheet output and manual CSV/text imports.

## Dependency audit and migration

| Item | Before | Stage 207 |
| --- | --- | --- |
| XLSX package | `xlsx@0.18.5` | Removed |
| Usage | Workbook creation in `scripts/gyeongnam_glamping_crawl.cjs` | Workbook creation through `scripts/spreadsheet_export.cjs` |
| Replacement | None | `write-excel-file@4.1.1` |
| Spreadsheet input | No XLSX upload or XLSX parsing route exists | Still prohibited |
| Audit result | 1 direct high vulnerability | No high or critical production vulnerability |

The application only writes collection results to `.xlsx`. It does not parse customer-provided XLSX files. The replacement therefore uses a maintained output-focused package instead of introducing a full workbook parser.

## Input boundaries

Manual Yeogi data enters through `POST /api/yeogi-import` as JSON containing pasted CSV or text. The following controls are enforced before data is merged into a run:

- Production authentication is mandatory. The import route additionally requires `ADMIN_USER`/`ADMIN_PIN`; both fall back to `APP_USER`/`APP_PIN` for backward compatibility.
- Request `Content-Type` must be `application/json`.
- Request body and source text are byte-limited.
- Optional file metadata accepts only `.csv` or `.txt` and an allow-listed text MIME type.
- NUL/binary content, oversized lines, rows, columns, cells, and cell values are rejected.
- CSV cells beginning with spreadsheet formula markers (`=`, `+`, `-`, `@`) are rejected.
- Unclosed quoted fields and structurally invalid CSV are rejected.
- Parsing runs in a worker thread and is terminated after the configured timeout.
- Client errors return a stable public code and generic message; file paths, parser names, stack traces, and operating logs are not returned.

## Default limits

| Environment variable | Default | Purpose |
| --- | ---: | --- |
| `IMPORT_MAX_BYTES` | 1,048,576 | UTF-8 source-text limit |
| `IMPORT_MAX_ROWS` | 5,000 | CSV/text line and row limit |
| `IMPORT_MAX_COLUMNS` | 64 | Maximum CSV columns |
| `IMPORT_MAX_CELLS` | 150,000 | Total CSV cell limit |
| `IMPORT_MAX_CELL_CHARACTERS` | 16,384 | Individual cell limit |
| `IMPORT_MAX_LINE_CHARACTERS` | 65,536 | Individual line limit |
| `IMPORT_PARSE_TIMEOUT_MS` | 5,000 | Worker parsing timeout |
| `ADMIN_USER` | `APP_USER` | Import operator identity |
| `ADMIN_PIN` | `APP_PIN` | Import operator credential |

Lower limits are recommended when real operating samples confirm that smaller payloads are sufficient.

## XLSX output controls

- Output paths must end in `.xlsx`.
- Workbook, sheet, row, column, and cell-length limits are applied.
- Sheet names are normalized and duplicate names are made unique.
- Scraped objects are converted to bounded text.
- All text cells are explicitly written as strings, so formula-looking scraped values cannot create formula nodes.

## Remaining risk and next migration

Stage 208 added named account sessions and server-side `company_id` ownership checks. Legacy Basic Auth now remains only for migration and should be disabled with `AUTH_ALLOW_LEGACY_BASIC=false` after named accounts are verified. File-backed sessions still require replacement before horizontal scaling.

Any future XLSX import feature is blocked from reusing the output library as a parser. It requires a separately reviewed streaming parser, ZIP expansion limits, worker isolation, MIME and magic-byte checks, formula/external-link rejection, and dedicated malicious-file fixtures before an API route can be enabled.
