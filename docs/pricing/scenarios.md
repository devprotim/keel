# Pricing scenarios

Task 13. Price points and packaging are yours to decide. This compares three ways to package Keel, runs each against three typical customers, and says what the code supports today. The dollar figures are **placeholders picked from the market ranges** in [competitors.md](competitors.md), there so the models can be compared. They are not proposals.

## What is already built

- Plans **Free**, **Team** and **Business**, with limits in one table: `apps/server/src/billing/plans.ts`.
- Prices live in Stripe, not in code: `STRIPE_PRICE_TEAM` and `STRIPE_PRICE_BUSINESS` name Stripe Price objects. Changing a price is a Stripe dashboard change.
- `BILLING_PER_SEAT=true` (the default) charges per **owner or editor**, and keeps the Stripe quantity in step as people join, leave or change role. Viewers are free on every plan. `false` charges a flat amount per workspace.
- Link rooms (no workspace) are free and unlimited, apart from PagerDuty alerts.
- With no Stripe keys, billing is off and nothing is limited (self-hosted, local, tests).

| Limit | Free | Team | Business |
|---|---|---|---|
| Owners and editors | 3 | 25 | unlimited |
| Viewers | unlimited | unlimited | unlimited |
| Diagrams in the workspace | 3 | 50 | unlimited |
| Collector tokens | 1 | 10 | unlimited |
| PagerDuty alerts | no | yes | yes |
| Slack alerts, CI Action, review and incident mode | yes | yes | yes |

## Three customers to test against

| | Small team | Platform team | Large org |
|---|---|---|---|
| Owners and editors | 4 | 15 | 60 |
| Viewers (on-call, reviewers) | 10 | 60 | 300 |
| Services in production | 15 | 60 | 300 |
| Diagrams | 5 | 25 | 120 |
| Collectors (clusters) | 1 | 3 | 12 |

## Model A: per editor (what the code does now)

Team at **$20** per editor a month, Business at **$40** (placeholders; the market range is $15 to $45).

| | Small | Platform | Large |
|---|---|---|---|
| Plan | Team | Team | Business |
| Monthly | $80 | $300 | $2,400 |

- **For:** the norm in diagramming and portals, so it's easy to buy and compare. Free viewers let on-call and reviewers in without a purchase decision. Already built.
- **Against:** revenue tracks the team, not the value. A 60-service system watched by 4 editors pays the same as a 5-service one. It invites keeping editors few and making everyone else a viewer.

## Model B: per workspace, metered by monitored service

A flat **$49** workspace fee, plus **$3** per service the collector reports (placeholders; Hava charges $15 per cloud source, Datadog about $31 per host).

| | Small | Platform | Large |
|---|---|---|---|
| Monthly | $94 | $229 | $949 |

- **For:** revenue grows with the system Keel watches, which is where the value is (every service is one more thing drift, alerts and incident mode cover). No seat counting, so no reason to keep people out.
- **Against:** less predictable for the buyer, and needs usage-based billing: Stripe meters, with the collector's matched refs reported daily. **Not built.** It would mean a meter in Stripe, a daily job reporting each workspace's distinct observed services, and a Price with usage-based billing.

## Model C: per editor, with services included

Team at **$25** per editor including 20 services per editor, then **$2** per extra service (placeholders).

| | Small | Platform | Large |
|---|---|---|---|
| Included services | 80 | 300 | 1,200 |
| Monthly | $100 | $375 | $1,500 |

- **For:** familiar per-seat buying for most customers; the meter only bites for a large system watched by a small team, which is exactly the case Model A underprices.
- **Against:** two numbers to explain. Needs the same metering as B, for the overage only.

## What would decide it

- **Who pays** (interview decision D9): a platform or SRE budget holder buys per service more readily; an engineering manager buying a design tool expects per seat.
- **Which pitch leads** (D10): "checks itself against production" argues for B or C, since the product is the monitoring; "find the outage in the design" argues for A.
- **The free line**: 3 editors and 3 diagrams is the tightest the market goes (Miro, Eraser). Loosen it if activation, not conversion, turns out to be the bottleneck.
- **SSO**: every comparable gates SAML one or two tiers up. Keel has GitHub sign-in only; SSO would be the natural Business gate once built.

## Recommendation for a first version

Ship **Model A** as built, with Team priced in the $15 to $25 band and Business priced by conversation, because it needs nothing new and matches how buyers compare tools. Record each paying workspace's observed service count from day one (the evidence is already in the room) so Model C can be priced from real data rather than guessed. Revisit after ten paying teams.
