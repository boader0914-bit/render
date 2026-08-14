# DataLab Basic Place UI Live Diagnostic

## Live attempt

- Baseline commit: `15e1a07b91641590905af14f811aa64d4e843a04`
- Branch: `recovery/v2-basic-place-ui-live-diagnostics`
- Keyword: `경남 글램핑`
- Provider route: `GET https://pcmap.place.naver.com/accommodation/list`
- External request budget: 1
- External requests consumed: 1
- Automatic retries: 0
- Fallbacks: 0
- Operational writes: 0
- Raw Provider response storage: 0

The isolated local UI server passed every gate and submitted one bounded request.
The Provider returned a non-success HTTP status, so collection stopped at the
`provider-response` stage with `V2_BASIC_PLACE_HTTP_ERROR`. The original UI
terminal retained the request count but discarded the already-available numeric
Provider status, so the exact status cannot be reconstructed from this run.

No retry was attempted. The live server was stopped after the terminal result.
The durable local usage record is `consumed=1`, `limit=1`.

## Diagnostic correction

The UI failure projection now preserves only these bounded response facts:

- numeric Provider status in the range 100 through 599;
- status class such as `4xx`;
- existing stage, code, and external request count.

The response body, response headers, cookies, authorization values, and operator
token remain excluded. The browser error message may display the numeric status
without exposing Provider payload data.

## Next live boundary

A second Provider request is not part of this run. After the diagnostic change
is committed and deployed to an isolated Render Web Service, a new approval
may enable authenticated manual-unlimited mode. Its first submission must use a
fresh idempotency key; any HTTP 403 or 429 must stop further Live requests for
that Korea calendar day.

## Manual-unlimited mode

The daily numeric request ceiling may be replaced by the explicit value
`unlimited`. This means an authenticated operator may submit an unlimited number
of manual searches; it does not create an automatic loop. The following controls
remain mandatory:

- one Provider GET per submitted search;
- concurrency fixed at one;
- at least three seconds between Provider requests;
- no automatic retry or fallback;
- HTTP 403 or 429 opens a durable circuit for the current Korea calendar day;
- a blocked circuit prevents another Provider request;
- operational database and Web import writes remain disabled.
