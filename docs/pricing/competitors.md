# Competitor pricing

Task 13 research. Every page was read on 2026-09-29 from the vendor's own pricing page unless marked otherwise. Prices are USD unless marked. Where a vendor's page didn't show a figure, it says so rather than estimating. Prices move: re-check before quoting any of this in a sales conversation.

## Diagramming

| Product | Plans and price | Unit / billing | Free tier | Upgrade gates | Enterprise signal |
|---|---|---|---|---|---|
| **Lucidchart** | **Not confirmed from the primary source.** The pricing page renders prices client-side. Third-party sites (unverified) list Individual about $9/mo and Team about $10/user/mo | Per user, per month | Unverified: 3 documents, 60 shapes | Not confirmed | Individual, Team, Enterprise (custom) |
| **Miro** | Free $0. Starter $8. Business $20. Enterprise custom | Per member per month, billed yearly ("save 20%" over monthly; monthly figure not shown). Paid plans start at 2 members | 3 editable boards, 10 AI credits/mo, 250+ integrations | Private boards need Starter. SAML SSO and two-way Jira/Linear/Azure integrations need Business | "Custom pricing, from 30 members" |
| **Excalidraw+** | Free $0. Plus $6/user/mo monthly, about 14% off annually | Per user | Full editor, 1 scene, unlimited collaborators, PNG/SVG/JSON export | Unlimited scenes, cloud storage, workspaces, comments, presentations, PDF/PPTX export | No SSO or enterprise tier listed |
| **tldraw** (SDK licence) | Commercial licence price not published ("value-based"). Startup licence discounted. Hobby free | Annual licence | 100-day trial. Free Hobby licence for non-commercial use | Production use needs a commercial licence | "Talk to sales" |
| **Eraser.io** | Free $0. Starter $15 annual / $20 monthly. Business $45 annual / $60 monthly. Enterprise custom | Per member per month | 3 files, 3 AI diagrams, 7-day history. GitHub/Notion/Confluence/VS Code integrations on every tier. Unlimited free guests | Private and unlimited files need Starter. SAML SSO and unlimited history need Business | "Call us" |
| **IcePanel** | Free $0. Growth $40. Scale $80. Enterprise custom | Per **editor** per month, billed annually | Up to 5 editors, unlimited viewers, 100 model objects, 1 landscape | Unlimited objects and webhooks need Growth. SSO: 1 domain on Growth, unlimited on Scale. Audit logs need Scale | Data residency, single tenant, customer-held keys |
| **Structurizr** | **Cloud service is end of life.** Server prebuilt binaries: £300/mo (1-20 users), £600 (21-50), £900 (51-100), £1,200 (101-250), £1,500 (251-500), £1,800 (501-1,000), £2,400 (1,001+) | Per installation, in bands of unique users per year (viewers count). Annual | Open core, free built from source. 14-day trial licence | SAML/LDAP, RBAC, S3/Azure storage, admin API | Email for a quote |
| **Cloudcraft (Datadog)** | Included free with any Datadog subscription | No standalone price | Unlimited users and diagrams, inside Datadog | The Datadog subscription | Datadog sales |
| **Hava.io** | Professional $59/mo. Teams $249/mo. Enterprise custom | **Flat per account, plus per source** (cloud account): 3 on Professional, 10 on Teams, +$15/mo each extra. 20% off annually | 2-week trial (exports disabled) | Professional 1 user, Teams unlimited. History 3 / 6 / 12 months | 100+ sources, SaaS or self-hosted |
| **Multiplayer.app** | **No longer an architecture-diagram product** (now a debugging agent). Pricing page redirects to the homepage | Not confirmed | Not confirmed | Not confirmed | Not confirmed |

## Service catalog / internal developer portal

| Product | Plans and price | Unit / billing | Free tier | Upgrade gates | Enterprise signal |
|---|---|---|---|---|---|
| **Cortex** | Not public | Per seat, "scales with org size" | None listed | Custom quote only | Contact sales |
| **OpsLevel** | Standard and Enterprise, prices not public | **Per developer**, volume discounts | Demo only | Standard up to 50 users. Enterprise unlimited users, CSM | "Get pricing" form |
| **Port** | Free $0. Basic $30. Standard $40. Enterprise custom | Per seat per month, billed annually | 15 seats, 10k entities, 400 automation runs | Basic up to 50 seats. Standard 200 seats, SSO, dynamic permissions. Enterprise SCIM, Private Link, SLA | Contact sales |
| **Roadie** (hosted Backstage) | Teams $24/dev/mo. Growth custom. Enterprise custom | **Per developer**. Teams 50 to 150 devs | None listed. Non-coders log in free | Scorecards extra on Teams | Request a demo |

## Incident / reliability

| Product | Plans and price | Unit / billing | Free tier | Upgrade gates | Enterprise signal |
|---|---|---|---|---|---|
| **incident.io** | Basic free. Team $15 annual / $19 monthly, on-call +$10. Pro $25, on-call +$20. Enterprise custom | Per user per month | 1 team on-call, 1 status page, 2 integrations, 1 workflow | Unlimited integrations and API need Team. SAML needs Pro. SCIM needs Enterprise | Contact sales |
| **FireHydrant** | Free. Pro $25. Enterprise custom | **Per responder** per month, annual. Alerting billed separately by volume | Up to 10 responders, 2 runbooks, 1 status page, 3 integrations | Service catalog and SSO need Pro. Enterprise adds unlimited integrations, SCIM, audit logs, viewer licences | Contact sales |
| **Rootly** | Incident Response Essentials $20. On-Call Essentials $20. Enterprise by quote | Per user per month | Trial about two weeks. Up to 50% startup discount | SSO on Essentials. SCIM, private incidents, audit logs need Enterprise | Contact for quote |
| **PagerDuty** | **No Business tier any more.** Free (5 users). Professional $21 annual / $25 monthly. Platform bundles: Starter $2,800/yr (10 seats), Essential $12,000/yr (20), Plus $48,000/yr (40), Ultimate custom (500) | Per user, or annual bundles | 5 users, 1 schedule, 100 SMS/calls a month | SSO on Professional. ITSM and AI need bundles | Ultimate custom |

## Observability anchors

| Product | Pricing | Free tier |
|---|---|---|
| **Datadog** | APM $31 annual / $36 monthly. APM Pro $35/$42. APM Enterprise $40/$48. Infrastructure Pro $15/$18, Enterprise $23/$27. All **per host per month** | Up to 5 hosts, 1-day metric retention |
| **Grafana Cloud** | Pro: $19/mo platform fee plus usage. Visualization users $8, IRM users $20 (active). Traces/logs $0.05/GB process + $0.40/GB write + $0.10/GB retain. App Observability about $18 per host a month. Enterprise from $25,000/yr | 10k metric series, 50 GB each of logs/traces/profiles, 14-day retention, 3 users |

## What it says about packaging

**Units by category.** Diagramming charges per seat, and several soften it by charging editors only (IcePanel, Eraser and Miro guests, Roadie's non-developers). Tools that sync with live infrastructure charge for what they watch: Hava per cloud source, Cloudcraft inside Datadog's per-host bill. Developer portals charge per developer with minimums, and often hide prices. Incident tools charge $15 to $25 per user or responder, with on-call as an add-on. Observability charges per host or per GB.

**Where free tiers stop.** Diagramming caps what you make (3 boards or files, 1 scene, 100 objects). Portals and incident tools cap people and connections (15 seats, 10 responders, 2 to 3 integrations). SSO or SAML sits one or two tiers up almost everywhere; SCIM, audit logs and data residency are held for Enterprise.

**For Keel.** Keel spans all three. The canvas and rules fit the diagramming pattern: per editor, free viewers, a cap on diagrams. The collector and drift alerts behave like monitoring, where buyers expect to pay per monitored service or source, a cost that grows with the system rather than the team. Incident and review mode reach people who don't edit, which argues for free viewers. A per-workspace fee with a monitored-service meter on top would line up with these norms; gating SSO and the number of integrations follows the market default.

## Sources (all read 2026-09-29)

- Lucidchart: https://lucid.app/pricing/lucidchart (prices render client-side). Unverified secondary: https://costbench.com/software/diagramming/lucidchart/
- Miro: https://miro.com/pricing/
- Excalidraw+: https://plus.excalidraw.com/pricing
- tldraw: https://tldraw.dev/pricing
- Eraser: https://www.eraser.io/pricing
- IcePanel: https://icepanel.io/pricing
- Structurizr: https://structurizr.com/ , https://docs.structurizr.com/cloud , https://docs.structurizr.com/server/pricing
- Cloudcraft: https://www.cloudcraft.co/pricing
- Hava: https://www.hava.io/pricing
- Multiplayer: https://www.multiplayer.app/
- Cortex: https://www.cortex.io/pricing
- OpsLevel: https://www.opslevel.com/pricing
- Port: https://www.port.io/pricing
- Roadie: https://roadie.io/pricing/
- incident.io: https://incident.io/pricing
- FireHydrant: https://firehydrant.com/pricing/
- Rootly: https://rootly.com/pricing
- PagerDuty: https://www.pagerduty.com/pricing/
- Datadog: https://www.datadoghq.com/pricing/
- Grafana Cloud: https://grafana.com/pricing/
