# Architecture decisions

Short records of the decisions made in the November 2026 production review. Earlier design decisions (truncation keeps the real status, idempotent ingest, keyset pagination, LISTEN/NOTIFY fan-out) are in the README's Design decisions section.

## ADR-1 · Keep the stack

**Decision.** Go engine, Fastify/TypeScript API, PostgreSQL 16, React dashboard, no new frameworks or services.

**Why.** Every part was tested and fit for purpose. The gaps were in hardening, product features and verification, not in technology choice. The only dependency added is `@playwright/test` for browser tests (development only).

## ADR-2 · One admin token, secure by default, instead of user accounts

**Decision.** Keep the single `ADMIN_TOKEN`, but make the API refuse to serve an open dashboard on a non-loopback address, require 16+ characters, and rate-limit failed attempts.

**Why.** paychaos is a team tool that runs beside a sandbox, usually on a laptop or in CI. Accounts (password storage, sessions, invitations, recovery) would add more attack surface than the data warrants today. The roadmap (F6) describes accounts via OIDC for when there is a hosted offering. Proposed to the product owner as the recommended option; switching to accounts later does not require undoing any of this.

**Consequence.** No per-person audit trail. Documented as a limitation.

## ADR-3 · Rate-limit failures, not requests

**Decision.** Count only failed authentications per client address (20 a minute), then block that address for the rest of the window, even for a correct token.

**Why.** A busy engine sends a batch every 500 ms and must never be throttled; attackers produce failures. Blocking correct tokens during the window means a guesser cannot learn from responses. Per-instance memory, capped at 10,000 addresses: a distributed limiter is not needed for 256-bit tokens.

## ADR-4 · Settle idle operations instead of capping records

**Decision.** The auditor releases an operation once it has been idle for `-settle-after` (default 30 minutes), after judging it with exactly the end-of-run rules.

**Alternatives.** A hard cap on records (drops evidence arbitrarily); spilling records to disk (complex, still unbounded on disk); streaming-only mode (makes the dashboard mandatory).

**Why.** Retries happen within seconds or minutes, so an operation idle for half an hour will not change verdict. Findings stay identical (tested), memory stays flat (tested with 50,000 operations), and short CI runs are unaffected. The report counts settled requests so totals stay right.

## ADR-5 · Project health is derived, not stored

**Decision.** `/api/projects/:id/health` computes status, trend, recurring codes and the change since the previous run on each request from existing tables, with two new indexes.

**Why.** No new write paths, nothing to keep consistent, and the query reads at most 100 runs. A materialised summary can come later if projects reach thousands of runs.

## ADR-6 · Fix guides live in the dashboard

**Decision.** The explanation and fix for each finding code is static content in `web/src/guides.ts`, with a unit test that fails if the engine gains a code without a guide.

**Why.** It is documentation, versioned with the UI that shows it; serving it from the API would add an endpoint and a schema for no gain. The test keeps the engine and the guides in step.

## ADR-7 · Exports reuse the engine's formats

**Decision.** `GET /api/runs/:id/export?format=json|junit|markdown` produces the same shapes as the engine's `-report`, `-junit` and `-markdown`.

**Why.** CI systems and people already know those formats. Downloads go through `fetch` with the token in a header, so the token never appears in a URL, browser history or server logs.

## ADR-8 · No UI framework; a small design system in one stylesheet

**Decision.** Design tokens (colour, radius, shadow, spacing), components and responsive rules in `web/src/styles.css`; a handful of React primitives in `components/ui.tsx` (Section, PageHeader, Crumbs, Skeleton, Empty, ErrorBox, ConfirmDialog, Toast, HealthBadge).

**Why.** The dashboard has about ten screens. A component library would triple the bundle and fight the strict CSP (several inject styles at runtime). Chart colours for severity were checked with a palette validator for colour-vision deficiency separation in both themes, and severity is always also written as text.

## ADR-9 · Static asset caching

**Decision.** Hashed files under `/assets/` are `immutable` for a year; `index.html` is `no-cache`; unknown asset paths are 404, never the SPA shell.

**Why.** Prevents the "blank page after deploy" failure and makes repeat visits instant.

## ADR-10 · Money in minor units, per currency, never converted

**Decision.** Amounts are stored as integer minor units (`bigint`) with an ISO currency code, parsed strictly from PayPal's decimal strings (JPY, HUF and TWD have no decimals). Totals are per currency; nothing is ever added across currencies or converted.

**Why.** Floating point loses cents, and an exchange rate would put a guess inside a number people act on. The amount comes from PayPal's response when the request committed (what actually moved), otherwise from the request (what was attempted). A finding's amount is the payment it puts at risk; for an unsafe retry that is the duplicate.

**Consequence.** A run in two currencies shows two totals ("50.00 USD + 3.00 EUR"). Runs stored before this change show "—", not "none".

## ADR-11 · Problems are keyed by code and operation, and only the default branch moves them

**Decision.** A problem's identity is `code|operation` (or `code|path` with ids removed, for requests outside the audited operations). Runs on the project's default branch (learned from CI, editable) move status: new, open, fixed, regressed. Pull-request runs never do. A problem is marked fixed only if the run sent the same operation under a fault that could have shown it; otherwise it stays open and the verdict calls it "not retested".

**Why.** Without the exercised-fault rule, a run that simply did not hit the failing path would "fix" everything, and the next run would show it as regressed: noise that teaches people to ignore the tool. Keeping pull requests out of issue status means a branch experiment cannot close or reopen the team's problems.

**Consequence.** A problem whose code is unknown to the trigger table is never auto-fixed; it must be fixed by a run that reports cleanly after the table learns it. Runs outside CI (no branch) still move status, so the dashboard is useful before CI is set up.

## ADR-12 · The pull-request verdict is computed by the API, posted by the engine

**Decision.** `GET /api/ingest/runs/:id/verdict` compares a finished run with the latest finished non-PR run on its base branch. The engine fetches it and posts or edits one pull-request comment (found by a hidden marker) with the CI job's own `GITHUB_TOKEN`.

**Why.** The API has the history; the CI job has the credential. paychaos never stores a GitHub token, needs no GitHub App, and works unchanged on GitHub Enterprise (`GITHUB_API_URL`). One edited comment instead of one per push keeps the pull request readable.

**Consequence.** No comment on GitLab merge requests (the verdict goes to the job log and JUnit). The `new-*` fail policies fall back to "any HIGH" when the verdict cannot be fetched, so an outage fails loudly rather than passing silently.

## ADR-13 · Sandbox behaviour is measured into a profile, not hard-coded

**Decision.** `paychaos verify-sandbox` measures six PayPal behaviours the mock had to guess and writes them to a versioned JSON profile; `-mock-profile` makes the mock answer the same way. Only the PayPal sandbox hosts over HTTPS are allowed, credentials come from the environment and are never written, and the rate-limit answer is not measured.

**Why.** PayPal's behaviour differs by API and changes over time; a profile is evidence with a date on it, and keeps the mock deterministic for CI. Flooding the sandbox to see a 429 would be abuse of a shared service.

**Consequence.** Until someone runs it against a real sandbox app, the mock's defaults remain best guesses (documented in the README).

## ADR-14 · Spill files describe themselves

**Decision.** A spill file starts with a header line (run id and run metadata) and ends with a finish line (final findings) when the run ended. Upload replays them through the normal idempotent ingest endpoints with batch numbers from a reserved range (1,000,000+), skips provisional findings when a finish line exists, and deletes the file only after the API stored everything. The engine uploads finished files (or files idle for 10 minutes) at start; `paychaos upload-spill` does it by hand.

**Why.** A file that needs the original process's memory to be understood cannot be recovered later. Reusing the ingest endpoints means no new server code path and the same deduplication, so resending is harmless. Files from older versions (no header) are refused and kept, never guessed at.
