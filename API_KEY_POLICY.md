# API Key Policy

This app must keep API key integration stable across releases.

## Storage

- Do not commit API keys to Git.
- Runtime key file: `CONFIG_DIR/traffic_api_keys.local.json`
- Render persistent default: `/var/data/config/traffic_api_keys.local.json`
- Local default: `config/traffic_api_keys.local.json`
- Environment variables override the saved file when present.

## Supported Keys

- `DATA_GO_KR_SERVICE_KEY`
- `NAVER_CLIENT_ID`
- `NAVER_CLIENT_SECRET`
- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`

`DATA_GO_KR_SERVICE_KEY` is an environment-only secret. Store it in Render's
service Environment page and never in the admin key form, a local JSON file,
an endpoint URL, logs, reports, or Git. The legacy aliases
`KTO_DATA_GO_KR_SERVICE_KEY` and `KTO_TOURISM_SERVICE_KEY` remain read-only
compatibility fallbacks; new deployments must use `DATA_GO_KR_SERVICE_KEY`.

## Release Rule

Future V2 releases must keep the same key names and the same `CONFIG_DIR` based storage path.
Code can change, but key storage must remain outside the deployed source directory.
Blank key fields in the admin UI must preserve the existing saved key instead of clearing it.

## Data Usage

- SearchAd API is used for monthly PC/mobile search volume, click estimate, CTR, and competition.
- Naver DataLab API is used for relative trend index only.
- DataLab does not provide absolute search volume, so it must not replace SearchAd volume.

## Verification

- `POST /api/settings/traffic-keys/verify` performs a live authentication test.
- "Configured" only means a key is saved.
- "Verified" means the saved key successfully authenticated against the upstream API.
