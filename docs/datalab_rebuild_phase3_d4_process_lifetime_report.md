# DataLab Rebuild Phase 3 D4 Process Lifetime Fix

## Scope

This local-only change addresses the early process exits observed on Render deploy
`dep-d9up7bjm8hqs73d9h2ig`. The approved commit emitted a valid
`render_diagnostic_ready` event, then exited with code zero because a pending
Promise and signal listeners did not keep the Node.js event loop active.

The V2 collector, GraphQL request envelope, parser, Provider transport, job
contract, artifacts, and operational integration are unchanged.

## Reproduction

The committed `serve` command was launched as a real child process with all live
gates disabled and external networking blocked. It emitted readiness but was no
longer alive after one second:

- readiness observed: true;
- alive after 1000 ms: false;
- exit code: 0;
- signal: none;
- Provider requests: zero.

## Fix contract

- `serve` owns one active interval handle while waiting for `SIGTERM` or `SIGINT`.
- the interval performs no collection, network, storage, retry, or fallback work;
- the selected signal clears the interval and both signal listeners;
- the process then exits normally through the existing `main` path;
- readiness-only safety gates remain unchanged and fail closed.

## Offline verification

- test the keepalive handle and listener cleanup with an isolated signal target;
- launch the real `serve` command as a child process;
- require structured readiness before the survival window;
- require at least 10 seconds of process survival without restart;
- send one controlled `SIGTERM` and require bounded shutdown;
- preload the external-network blocker in the child;
- require Provider requests, retries, fallbacks, and operational writes to remain
  zero;
- rerun all V2 booking-business recovery suites on Node 26.5.0;
- verify collector and lockfile identities before and after the change.

Verified results:

- pre-fix reproduction: readiness emitted, process dead after 1000 ms with exit
  code zero;
- post-fix real child process: readiness emitted and survival exceeded 10 seconds;
- controlled shutdown: one `SIGTERM`, bounded clean exit, no stderr;
- Render one-shot suite: 203 assertions passed;
- environment diagnostics suite: 60 assertions passed;
- V2 booking-business suite: 557 assertions passed;
- complete proposed tree passed the same suites from a synthetic depth-1
  checkout;
- actual Provider requests, retries, fallbacks, and operational writes: zero;
- collector blob: `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3`;
- frozen reference collector blob:
  `bcbe229998da3afa6f31ee04375fb0766019e56f`;
- lockfile SHA-256:
  `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2`.

## Deployment boundary

Commit, push, Render Resume, deployment, fixture execution, and Provider calls
remain prohibited until separately approved.
