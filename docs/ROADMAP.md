# Product roadmap

paychaos finds the payment bugs that only appear when networks misbehave: a capture or refund that PayPal performed but whose answer never reached your code, followed by a retry that does it again. This document records where the product stands after the November 2026 review, what was improved, and where it should go next.

## 1. Who it is for and the problem it solves

**Users.** Backend engineers and QA engineers who own a PayPal REST integration (checkout, refunds, payouts), and the engineering leads accountable for payment incidents.

**Problem.** Duplicate charges, double refunds and "failed" payments that actually succeeded come from retry logic that is never exercised in testing, because local networks don't lose responses. Teams discover these bugs from customer complaints and reconciliation reports, weeks later.

**Promise.** Run your existing checkout tests through paychaos, and it tells you, with the two resource ids as evidence, every place your integration would double-move money or lose track of a payment, then shows you the fix.

## 2. Existing features (after this review)

| Area | Feature |
|---|---|
| Fault injection | Nine faults, including lost responses after commit (TCP reset), 500-after-commit, held and truncated responses, expired tokens, rate limits; seeded and reproducible. |
| Auditing | Eleven finding codes that tie a retry back to the lost original and name the duplicate resources; operation grouping by canonical body or business id. |
| Webhooks | Relay that duplicates, delays and reorders real signed PayPal webhooks. |
| Safety | Sandbox-only allowlist; secrets never leave the engine; long runs bounded in memory. |
| CI | JUnit and Markdown output; baseline comparison that fails only on new findings; GitHub Actions example. |
| Dashboard | Project health, findings-per-run trend, recurring problems, fix guides with code, retry timeline, run comparison, exports, scenario editor, live updates; phone to desktop; light and dark. |
| Platform | Stateless API (scale horizontally), idempotent ingest, keyset pagination, hardened defaults, Docker image and Compose stack, measured ingest throughput. |

## 3. Shortcomings found in the review

Fixed in this release (details in [QA-REPORT.md](QA-REPORT.md)): open dashboard on public addresses, unlimited token guessing, missing security headers, unbounded engine memory, phone layout clipping, blank-page risk after deploys, destructive actions without confirmation, missing delete/edit UI, no loading or empty states, never-built Docker image, never-run load test.

Still open:

1. **PayPal behaviour assumptions** in the mock are unverified against the sandbox (listed in the README).
2. **Single shared admin token**; no per-person accounts or audit trail of who deleted what.
3. **Findings explain, but don't yet prioritise by money**: a duplicate $5 refund and a duplicate $5,000 capture look the same.
4. **Spilled events** (when the API was unreachable) are not uploaded automatically.
5. **Only PayPal REST.** Stripe lives on an old tag; Adyen, Braintree and others are not covered.

## 4. Feature proposals

Each proposal states the problem it solves. Effort: S (days), M (1–2 weeks), L (a month or more).

| # | Feature | Problem it solves | Impact | Effort |
|---|---|---|---|---|
| F1 | **Money at risk** | Findings don't show business cost. Read `amount` from request bodies (already parsed for fingerprints) and total the value of duplicates and "succeeded but reported failed" payments per run and per project. | High: turns a test report into a number a manager acts on. | S |
| F2 | **Sandbox verification suite** | Mock behaviour is guessed in places. A `paychaos verify-sandbox` command that runs a fixed script against the user's sandbox account and records the real answers (status codes, idempotency window, capture response shape) into a profile the mock then uses. | High: removes the biggest correctness caveat. | M |
| F3 | **Pull-request bot** | CI output is a file. Post the Markdown summary and the comparison verdict as one PR comment that updates in place, linking to the run in the dashboard. | High: findings reach the developer where they work. | S |
| F4 | **Scenario recommendations** | New users don't know which faults matter. From a first clean run (which endpoints the client calls, whether it sends request ids, how it retries), suggest a scenario that targets its weak points. Deterministic rules, not a model. | Medium | M |
| F5 | **Flaky-retry detection across runs** | One run is a sample. Flag operations that are unsafe in some seeds and safe in others, and suggest a seed sweep in CI. | Medium | M |
| F6 | **Accounts, roles and audit log** | One shared token. Add sign-in (OIDC first, so teams use their existing identity provider), owner/member/viewer roles per project, and an audit log of destructive actions. | Medium for teams; required for any hosted offering. | L |
| F7 | **Automatic spill upload** | Events spilled during an API outage are left on disk. Upload them on the next start, using the existing idempotent batch endpoint. | Medium | S |
| F8 | **More providers** | The fault model is generic; the auditor's knowledge of idempotency headers and "already done" errors is per provider. Bring Stripe back as a provider profile, then Braintree and Adyen. | High for reach | L per provider |
| F9 | **Webhook handler auditing** | The relay shows duplicates and reordering but cannot see what the handler did. An optional callback (or log scrape) lets the auditor flag handlers that processed a duplicate twice. | Medium | M |
| F10 | **Explain-this-finding assistant** | Fix guides are generic. An optional LLM explanation that reads the specific request timeline and the user's language/SDK and drafts the patch. Off by default; never sends secrets (the engine already never stores them). | Medium; only worth it after F1–F3. | M |

### Where AI genuinely helps, and where it doesn't

The core verdicts (was a duplicate created, was a retry safe) must stay deterministic and explainable, because they gate CI. AI earns a place at the edges: tailoring a fix to the user's code (F10) and, later, reading a repository to point at the retry wrapper responsible. It should never decide whether a finding exists.

## 5. Technology recommendations

| Recommendation | Why | When |
|---|---|---|
| Keep Go (engine), Fastify + PostgreSQL (API), React (UI). | They fit the workload, are tested, and scale horizontally already; a rewrite buys nothing. | Now |
| OpenTelemetry traces and metrics in the API (ingest latency, batch size, SSE clients). | Operating it at scale needs more than request logs. | With F6 |
| Partition `requests` by month once a deployment holds tens of millions of rows. | Keeps deletes and vacuum cheap; queries already filter by run. | When needed |
| A shared rate limiter (PostgreSQL or Redis) if the API runs as many instances on the internet. | The per-instance limiter is enough for a team deployment. | With a hosted offering |
| Generate the API client types from one schema (zod → OpenAPI). | Removes hand-mirrored types between API and dashboard. | Next refactor |

## 6. Prioritisation

Ordered by impact over effort, and by dependency:

1. **Now (next 2–4 weeks):** F1 money at risk, F3 PR bot, F7 spill upload. Small, independent, and they make the value visible.
2. **Next (1–2 months):** F2 sandbox verification, F5 seed sweeps, F4 scenario recommendations.
3. **Later (quarter):** F6 accounts and audit log, F8 providers, F9 webhook handler auditing, F10 assistant.

## 7. Long-term vision

**The resilience test every payment integration runs before it ships.** A developer adds one CI step; every pull request gets a verdict ("this change would have double-refunded 3 customers under a lost response, here is the fix"), and the dashboard shows each team's payment resilience trending to zero. Commercially that suggests an open-source engine (adoption, trust, auditability of a tool that sits next to money) with a hosted dashboard for teams: accounts, history, PR integration, multiple providers, and a "money at risk" report for engineering leadership.
