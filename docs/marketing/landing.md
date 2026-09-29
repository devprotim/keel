# Landing page: message options

Task 12. Brand voice, the final message and the demo story are yours to decide; this lays out the options, built and switchable, so the choice can be made on the real page instead of in a document.

## How to compare them

All three are live. Open the landing page with `?pitch=reality`, `?pitch=prevent` or `?pitch=incident`. The one visitors see is `CHOSEN_PITCH` in `apps/web/src/app/landing/pitches.ts`; changing that one line ships a different message. The steps under the hero change with the pitch; the six feature cards do not.

## The three directions

### A. Reality (the current default)

> **The architecture diagram that checks itself against production**
>
> Keel reads what is really running from Kubernetes and your traces, and shows where the diagram, the approved design and production disagree, before the difference pages someone.

- **Bets on:** the thing no one else does. Drawing tools don't know what's running; observability tools don't know what was intended. Keel is the only place the two meet.
- **Risk:** asks the visitor to care about drift, which many teams don't think about until it bites. Needs a collector before it shows its value, so the example link matters most here.
- **Favoured if** interviewees describe stale diagrams or "we didn't know that was still running" unprompted (decision D10, tags like `#theme/stale-diagrams`).

### B. Prevent

> **Find the outage in the design, before it ships**
>
> Keel is a shared canvas for system architecture that knows what a timeout is. Draw your services together, and it flags the single points of failure, missing timeouts and retry storms that turn into incidents.

- **Bets on:** the easiest idea to grasp in five seconds, and the value you get with no setup: draw, get findings.
- **Risk:** sounds like a linter, and invites comparison with free diagram tools plus a checklist. Undersells live data and incident mode.
- **Favoured if** the people you talk to are mostly architects and design reviewers, or if first-session activation (drawing, then reading a finding) turns out to be the bottleneck.

### C. Incident

> **When it breaks, know where to look and what changed**
>
> Keel turns your architecture diagram into a live map of what is healthy, what is failing and what depends on it, next to everything that changed in production and in the design in the last day.

- **Bets on:** the strongest emotional pull for on-call engineers, and the moment a team is most willing to try something.
- **Risk:** it promises reliability during the worst hour, from a product the visitor has never used. Puts Keel next to incident tools with years of integrations.
- **Favoured if** the on-call interviews show the first minutes of an incident are spent working out dependencies and recent changes (D1), and if that is who you sell to first.

## Recommendation

Lead with **A (Reality)**, and keep B's language in the feature cards. It is the claim a competitor can't copy by adding a feature, and the "See it on an example" button removes its main weakness (no value before setup) by showing a room with production already reporting in. Revisit after the first five platform-engineer interviews: if nobody mentions drift or stale diagrams, switch to B.

## The demo story

"See it on an example" opens a new room with the example checkout system, approved three days ago, and production reporting in (`apps/web/src/app/core/demo.ts`):

1. The design was approved with three Catalog instances.
2. Twenty minutes ago the cluster scaled Catalog down to one.
3. The gateway's calls to Catalog now run close to their 2 second timeout, and 8% fail.
4. Checkout has started calling Catalog directly, which nobody drew.

What each mode shows: findings flag Catalog as drifted from the approved design (an accident, not a rollout), incident mode ranks Catalog first and the gateway's calls second, and the timeline shows the scale-down that started it.

Alternatives worth considering for the story, if interviews point elsewhere:

- **A deploy removed a timeout.** Closer to the "what changed" question; shows the CI Action catching it on the pull request.
- **A retry storm.** One slow dependency, aggressive retries, and a single instance: the most visual failure on the canvas, and a rule catches it before production does.

## Brand voice, as the page is written now

Plain, specific, a little dry. Short declarative sentences; no exclamation marks, no "supercharge", no "AI-powered" in headlines. Name real failures (timeouts, retry storms, single points of failure) rather than abstractions (resilience, observability). This matches DESIGN.md's "precise, trustworthy, calm" mood; change both together if the voice changes.

## Onboarding

New rooms show a **Get started** checklist (top right, out of the way of the inspector) that ticks itself off as the person places components, connects them, reads a finding, approves the design, connects live data (with a ready-to-run command for that room) and shares the room. It can be hidden for good. The step order is the activation path to test in interviews (decision D8).
