# Insight connection recovery and first display

## Incident evidence

On 2026-10-23 at 13:21:50 KST, the Data Lab production process reached its approximately 1,024 MB V8 heap limit (`Reached heap limit ... JavaScript heap out of memory`) and exited with status 134. Render restarted the process and reported recovery at 13:22 KST. Insight's `/me`, `/config`, and `/reports/briefing` returned 503 during this interval. This was a central process failure, not an expired Insight login or the earlier 20-second timeout.

The last allocation or individual request that triggered the heap failure is not established by the retained logs. A code review identified a high-allocation path: an Insight company detail read parses the entire company master and observation history before selecting one company. This is distinct from proving that one particular browser request caused the crash.

## Insight safeguards

- Retry a safe upstream GET at most once for short transient transport, invalid JSON, or 502/503/504 failures, within the original deadline. Keep identity checks within 20 seconds.
- Do not automatically repeat commands, collection dispatch, login POSTs, authentication/permission denials, 429 responses, or an expired timeout.
- Respect a short `Retry-After`; do not retry an interactive request when the server requests a longer pause.
- Give each request an opaque diagnostic ID. Record only the route template, stage, attempt, response status, failure class, and duration. Never log request headers, cookies, tokens, query strings, response bodies, or customer identifiers.
- Start bootstrap reads before the remaining page assets finish. Reuse their in-memory promises rather than duplicate the requests.
- A fresh successful `/me` can restore protected saved views independently of `/config`. Signup and policy-dependent actions still require the real configuration.
- Keep the last verified view during a background check. Authentication and permission checks remain required; a stored snapshot never grants access on its own.

Short retries do not repair a central out-of-memory failure or guarantee availability through a long restart. First saved-view display time and source revalidation completion must be measured separately.

## Release validation

Use the complete customer-portal suite, including transient failure, denial, timeout, single-use bootstrap, configuration gating, cache scope, and missing-value tests. In production, measure actual competitor detail data after reload, rather than only the competitor list or an HTTP response. Record the browser's first-data display time and inspect request timing for both `/me` and background detail reads. Treat 2 seconds as the measured first-display target, not a promise independent of network and central availability.
