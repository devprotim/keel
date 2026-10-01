# Keel project plan

The Render deploy is done, and sign-in stays GitHub-only for now, so neither is listed as a task. Every human decision is kept in the plan and marked as later.

## Delegation modes

- **AI-led:** AI builds it, human reviews and approves.
- **Collaborative:** human judgment shapes the work, AI builds, and both iterate.
- **Human-led:** human does the work, AI assists.

## Phase 1: Foundation

**Done when:** data survives restarts, security has been audited, and CI is green.

| # | Task | Mode | AI owns | Human decision (later) | Depends on |
|---|---|---|---|---|---|
| 1 | Postgres storage | AI-led | `PostgresDocStore`, migrations, contract tests, compaction under failure | Retention and backup policy, hosting cost | none |
| 2 | Security and data handling | Collaborative | Code audit, tighter Zod bounds, draft of the data-handling doc | Which risks are acceptable, privacy wording, sign-off | 1 |
| 3 | Testing (runs through every phase) | AI-led | Tests for each feature, fixing the e2e flake | Which user journeys matter most | none |

## Phase 2: The core loop (connect to production)

**Done when:** a real cluster feeds the diagram, drift raises an alert, and PRs get checked.

| # | Task | Mode | AI owns | Human decision (later) | Depends on |
|---|---|---|---|---|---|
| 4 | Observation adapters (K8s, OTel) | Collaborative | Controller, exporter, mapping onto the observations schema | Which integration comes first, testing on a real cluster | 1 |
| 5 | Drift alerts | Collaborative | Background worker, dedup, Slack and PagerDuty integrations | What deserves a 3am page, alert thresholds | 1, 4 |
| 6 | CI integration (GitHub Action) | AI-led | The Action, PR comments, docs, example workflows | Blocking vs. warning by default, publishing to the Marketplace | none |

## Phase 3: Team features

**Done when:** teams own persistent workspaces and review changes like a PR.

| # | Task | Mode | AI owns | Human decision (later) | Depends on |
|---|---|---|---|---|---|
| 7 | Workspaces and access control | Collaborative | ACL schema, middleware, UI, permission tests | Ownership rules, what anonymous users keep, migrating link rooms | 1 |
| 8 | Review mode (diff UI) | Collaborative | Diff logic, rendering, approve or reject per field, e2e tests | Whether the diff reads clearly and feels trustworthy | 7 |

## Phase 4: What sets Keel apart

**Done when:** SREs choose Keel during incidents and findings stay trusted.

| # | Task | Mode | AI owns | Human decision (later) | Depends on |
|---|---|---|---|---|---|
| 9 | Incident mode | Collaborative | Live topology overlay, recent-changes timeline, performance | What on-call looks at first, drawn from SRE interviews | 4 |
| 10 | Tuning to cut noise | Collaborative | Severity settings, suggested nodes, measuring how often findings fire | What counts as noise, labeling real findings | 4, 5 |

## Phase 5: Go to market

**Done when:** design partners are active, pricing is live, and the landing page converts.

| # | Task | Mode | AI owns | Human decision (later) | Depends on |
|---|---|---|---|---|---|
| 11 | User validation (starts in Phase 2) | Human-led | Interview scripts, note synthesis, grouping into themes | Recruiting design partners, running the interviews | 4 |
| 12 | Landing page and onboarding | Collaborative | Copy options, page build, docs | Brand voice, final message, demo story | 11 |
| 13 | Pricing and billing | Human-led | Stripe integration, tier limits, competitor research, pricing scenarios | Price points, packaging | 7, 11 |

## Delegation summary

- **AI-led (3):** Postgres storage, CI integration, testing.
- **Collaborative (8):** security, adapters, alerts, workspaces, review mode, incident mode, noise tuning, landing page.
- **Human-led (2):** user validation and pricing.

## Critical path

Postgres (1) → adapters (4) → alerts (5) and incident mode (9). The CI Action (6) and testing (3) don't depend on anything else and can run in parallel from the start.
