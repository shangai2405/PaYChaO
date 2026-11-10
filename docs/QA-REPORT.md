# QA report: production-quality review, 10 November 2026

Scope: the PayPal build of paychaos (engine, API, database, dashboard, Docker image, CI), reviewed end to end and upgraded. Each defect below was found by reading the code, by running the application, or by one of the new automated tests; each was fixed and then verified by a test or a recorded check. Severities: **High** (security or data at risk), **Medium** (a user-visible failure or a real operational risk), **Low** (polish, hygiene, or a latent problem).

## Result

| Suite | Tests | Result |
|---|---|---|
| Engine (Go, race detector) | 99 | all pass; coverage 84% (gate 75%); `go vet`, `gofmt`, staticcheck clean |
| API (Vitest, real PostgreSQL 16) | 30 | all pass; line coverage 96.6% (gate 80%) |
| Dashboard unit (Vitest, jsdom) | 14 | all pass; TypeScript strict build clean |
| Engine → API end to end (`scripts/e2e.sh`) | 3 demo clients | pass: naive 3 HIGH, rotating-id 3 HIGH, safe 0 findings |
| Browser (Playwright, `scripts/ui-e2e.sh`) | 5 workflows + 3 layout checks | all pass on desktop (1280), tablet (820) and phone (Pixel 7) |
| Docker image | build, unsafe-config refusal, token auth, Compose healthchecks | pass; image 276 MB, runs as `node` (uid 1000) |
| Same browser suite against the Compose stack | 8 | all pass |
| Load (k6, 20 VUs, 1 min) | 11,431 requests | 0 failures; p95 batch 143.9 ms; ~34,500 events/s; 1,029/1,029 resent batches deduplicated |
| Graceful shutdown with a live SSE stream open | 1 | container stops in 0.28 s |

## Defect log

| ID | Severity | Area | Status |
|---|---|---|---|
| QA-01 | High | Security | Fixed, verified |
| QA-02 | Medium | Security | Fixed, verified |
| QA-03 | Medium | Security | Fixed, verified |
| QA-04 | Medium | Frontend | Fixed, verified |
| QA-05 | Medium | Deployment | Fixed, verified |
| QA-06 | Medium | Engine | Fixed, verified |
| QA-07 | Medium | UX | Fixed, verified |
| QA-08 | Low | UX | Fixed, verified |
| QA-09 | Low | UX | Fixed, verified |
| QA-10 | Low | Frontend | Fixed, verified |
| QA-11 | Low | Frontend | Fixed, verified |
| QA-12 | Low | Frontend | Fixed, verified |
| QA-13 | Low | Database | Fixed, verified |
| QA-14 | Low | API | Fixed, verified |
| QA-15 | Low | Operations | Fixed, verified |
| QA-16 | Low | Repository | Fixed |
| QA-17 | Medium | Process | Closed: verified for the first time |

### QA-01 · High · The container served an open dashboard to the network

- **Description.** The Docker image sets `HOST=0.0.0.0`. Without `ADMIN_TOKEN`, anyone who could reach the port could read every run, mint ingest tokens and delete projects.
- **Steps to reproduce.** `docker run -e DATABASE_URL=… -p 3000:3000 paychaos` → `curl http://<host>:3000/api/projects` answers 200.
- **Root cause.** `ADMIN_TOKEN` was optional with no check of where the API was listening.
- **Fix.** `checkStartupSecurity` (`api/src/security.ts`): on a non-loopback address the API refuses to start unless `ADMIN_TOKEN` (16+ characters) is set or `ALLOW_OPEN_DASHBOARD=true` states the port is only reachable locally. Compose sets that explicitly because it publishes on `127.0.0.1`.
- **Verification.** Unit test `startup security`; manual `docker run` prints the refusal and exits 1; CI job `docker` asserts both cases.

### QA-02 · Medium · No limit on guessing tokens

- **Description.** Ingest and admin token checks could be attempted without limit, flooding logs and the database.
- **Steps.** Loop `PUT /api/ingest/runs/<id>` with random bearer tokens: every attempt answered 401, forever.
- **Root cause.** No rate limiting on authentication failures.
- **Fix.** `AuthFailureLimiter`: 20 failures per client address per minute, then 429 for the rest of the window even with a valid token (so the answer leaks nothing). Successful requests are never counted, so streaming engines are unaffected. Bounded memory (10,000 addresses). `TRUST_PROXY` for deployments behind a reverse proxy.
- **Verification.** Tests `auth failure limiter` (unit, ingest path, admin path, memory cap).

### QA-03 · Medium · No security headers

- **Description.** Responses had no CSP, no clickjacking protection and no `nosniff`.
- **Fix.** Strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP, `Permissions-Policy`. The dashboard needs no inline script, so nothing was relaxed.
- **Verification.** API test on success and error responses; browser test `API responses carry security headers`; the whole dashboard runs under the policy in the browser suite with no console errors.

### QA-04 · Medium · Run findings clipped on phones

- **Description.** On a 390 px screen the finding cards ran off the right edge; resource ids and messages were cut off.
- **Steps.** Open any run with findings at phone width.
- **Root cause.** Long unbreakable strings (resource ids, finding codes) with no `overflow-wrap`, inside a card that scrolled horizontally instead of wrapping.
- **Fix.** Wrapping rules on finding text, codes and resources; layout grids use `minmax(0, …)` tracks.
- **Verification.** Playwright `pages fit a phone without horizontal scrolling` checks eight pages at phone, tablet and desktop widths.

### QA-05 · Medium · A deploy could leave browsers on a blank page

- **Description.** A request for a missing asset (`/assets/index-OLD.js`, as a browser with a cached `index.html` asks after a deploy) returned `index.html` with status 200 and `text/html`, so the script failed to load and the page stayed blank. Static files also had no cache policy.
- **Steps.** Rebuild the dashboard while the API is running; reload a page. Console: "Expected a JavaScript module script but the server responded with a MIME type of text/html".
- **Root cause.** The SPA fallback answered every non-API GET with `index.html`.
- **Fix.** Only page routes fall back; asset paths 404. Hashed assets are served `immutable` for a year, `index.html` with `no-cache`.
- **Verification.** API test `static dashboard`.

### QA-06 · Medium · Engine memory grew without bound on long runs

- **Description.** The auditor kept every request record (and side tables of request ids and GETs) until exit.
- **Root cause.** All end-of-run checks scanned the full record list, so nothing could be released.
- **Fix.** Operations idle for `-settle-after` (default 30 min) are judged with the same end-of-run rules and released; request-id and GET tables expire with them; totals and fault counts are carried forward.
- **Verification.** `TestSettleKeepsFindingsAndReleasesMemory` (findings identical with and without settling), `TestSettleWaitsForPendingAttempts` (an in-flight retry is never settled), `TestSettleBoundsMemoryOnLongRuns` (50,000 operations, working set stays under ~600 records).

### QA-07 · Medium · Destructive actions without confirmation

- **Description.** Revoking a token and deleting a scenario happened on a single click.
- **Fix.** Accessible confirmation dialog (focus trapped, Escape cancels, focus returns); deleting a project requires typing its name. Scenario editor warns before discarding unsaved changes.
- **Verification.** Unit test `ConfirmDialog`; browser test covers revoke-cancel, revoke, run delete and typed project delete.

### QA-08 · Low · API features with no UI

- **Description.** Runs and projects could only be deleted, and projects only named, through the API.
- **Fix.** Delete run, delete project, edit name and description in the dashboard; new `PATCH /api/projects/:id`.
- **Verification.** API test `projects: edit and health`; browser test deletes a run and a project.

### QA-09 · Low · Blank screens while loading, bare errors

- **Fix.** Skeletons on every list and page, empty states that say what to do next, error boxes with a retry button, 401 explains where to set the token, 500s include a request id that matches the server log.
- **Verification.** Visual review at three widths; API test checks the request id and that internals are not leaked.

### QA-10 · Low · Run breadcrumb said "project" instead of the project's name

- **Fix.** Breadcrumbs on every page show real names. **Verified** by the browser test.

### QA-11 · Low · Scenario page scrolled sideways on desktop Chrome

- **Found by** the new responsive browser test (308 px overflow at 1280 px).
- **Root cause.** The list of fault names was rendered as adjacent inline `<code>` elements with no whitespace, forming one unbreakable line.
- **Fix.** Rendered as a wrapping chip list. **Verified** by the same test.

### QA-12 · Low · Links to a specific fix guide opened at the top of the page

- **Found by** the browser test (`/guides#TOKEN_NOT_REFRESHED` not in view).
- **Root cause.** The app shell's scroll-to-top on navigation ran after the page had scrolled to the anchor (parent effects run after child effects).
- **Fix.** Skip the reset when the URL has a fragment. **Verified.**

### QA-13 · Low · Timeline query scanned all of a run's findings

- **Root cause.** `/api/runs/:id/operations` joins findings on `(run_id, fingerprint)`; only `(run_id, severity)` was indexed.
- **Fix.** Migration `002_hardening.sql` adds `findings_run_fingerprint`, plus a partial index for the health view's finished runs.

### QA-14 · Low · A non-JSON error page broke the dashboard's error message

- **Description.** If a reverse proxy answered with an HTML error page, the dashboard showed a JSON parse error instead of the HTTP status.
- **Fix.** The client reports the status when the body is not JSON.

### QA-15 · Low · Health checks filled the request log

- **Description.** The Compose healthcheck (added in this review) logged two lines every 5 seconds.
- **Fix.** `/api/health` logs at level `silent`.

### QA-16 · Low · Build artefact committed

- `web/tsconfig.tsbuildinfo` was tracked; removed and ignored.

### QA-17 · Medium · Docker image and load test had never been run

- The previous build documented both as unverified. The image now builds, runs as a non-root user, passes the full browser suite inside Compose, and stops cleanly in 0.28 s with live streams open. The k6 test was run and its numbers are in the README. A CI job now builds and exercises the image on every push.

## Not covered, and why

- **PayPal sandbox behaviour.** The items under "To verify in the sandbox" in the README still need a PayPal sandbox account; nothing in this environment can reach one with credentials. They remain clearly marked as assumptions.
- **Cross-browser.** The browser suite runs Chromium only. Layout uses widely supported CSS (grid, flex, custom properties) and no browser-specific APIs, but Firefox and Safari were not exercised.
- **Multi-instance load.** The k6 run used one API instance. The LISTEN/NOTIFY design supports several; their combined throughput was not measured.
- **Accessibility audit with assistive technology.** Semantics were checked in code and through Playwright's role-based queries (every workflow is driven by accessible names), not with a screen reader.
