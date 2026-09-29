# From notes to decisions

Synthesis is done by reading, not counting. The tally is a map of where to read; the decision comes from the stories.

## After each interview (15 min)

1. Finish the notes file while it is fresh (see the [template](notes-template.md)).
2. Re-read the evidence lines. Make sure each has a decision tag and a theme tag, and reuse existing theme names where they fit: run the tally to see the names already in use.
3. Write one sentence at the top of the file: the single most important thing this person told you.

## After every five interviews (1 hour)

1. **Tally.** `node docs/research/tally.mjs docs/research/notes/*.md` prints, per decision, which themes came up and in how many interviews, with the quotes. Themes that appear once are not noise; they are unconfirmed.
2. **Group.** For each decision, read every quote under it, top to bottom, and move themes that say the same thing under one name (rename the tags in the notes, then re-run). Aim for three to six themes per decision.
3. **Write the readout** for any decision with enough evidence, in the shape below, and put it in `docs/research/readouts/D{n}.md`.

## A decision readout

```md
# D1: What on-call looks at first

**Evidence:** 7 interviews (4 on-call, 2 platform, 1 manager). Saw 3 of them use incident mode.

**What we heard**
- Dependencies before metrics (5 of 7): "I need to know what's calling the broken thing before I care how broken it is."
- Recent deploys first (4 of 7): ...
- Disagreement: ...

**Decision**
Rank changes (the timeline) above the health list when a deploy landed in the last 30 minutes.

**What changes in the code**
`incidentView` ranking in `packages/shared/src/incident.ts`; the panel order in `panels/incident.component.html`.

**What would change our mind**
Two more on-call engineers who start from dashboards, not changes.
```

## When the evidence is enough

- **Decide** when at least three independent interviews point the same way, and none of the rest describe a real situation where the opposite was needed.
- **Keep the default** when it's split. Write the readout anyway, marked *split*, with what to ask next.
- **Weight what people did** (`saw:` lines) over what they said. A person who says the incident panel is great and then opens their own dashboard has told you which one they trust.
- **One strong counterexample** from a real incident outweighs several opinions. Say so in the readout.

## Where each decision lands

| Decision | Change when settled |
|---|---|
| D1 | `INCIDENT_THRESHOLDS`, `lookFirst` ordering (`incident.ts`) |
| D2 | Default `ruleSettings` for new rooms, or a rule's own severity (`rules.ts`, `reality.ts`) |
| D3 | `isAlertable` and channel defaults (`apps/server/src/alerts/config.ts`) |
| D4 | `fail-on` default in `packages/action/action.yml` and its README |
| D5 | The next adapter in `apps/collector` |
| D6 | `roomAccess` in `apps/server/src/access/policy.ts` |
| D7 | Review mode copy and layout (`panels/changes.component.*`) |
| D8 | Which e2e journeys to deepen (`e2e/tests`) |
| D9 | Plan limits and prices (task 13, `apps/server/src/billing/plans.ts`) |
| D10 | Landing page copy (task 12, `apps/web/src/app/landing`) |
