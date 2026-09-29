# User validation kit

Task 11 of the project plan. The interviews are yours to recruit and run; this folder is everything around them: who to talk to, what to ask, how to take notes, and how the notes become decisions.

## Why these interviews

Most features in Keel shipped with a provisional default and a note that a person should decide. Each open decision below is answerable by talking to the people who would use it, and every question in the interview guide is tagged with the decision it informs. Run the interviews to settle these, not to collect general feedback.

| ID | Decision | Where the default lives | Current default |
|---|---|---|---|
| D1 | What on-call looks at first during an incident | `INCIDENT_THRESHOLDS` and `lookFirst` ranking in `packages/shared/src/incident.ts` | Down before degraded, then blast radius, then traffic. 5% errors is degraded, 50% is down, p99 at 80% of timeout is degraded. |
| D2 | What counts as noise | Labels and the Rules tab (task 10) | Anyone can dismiss a finding as noise; nothing is muted by default |
| D3 | What deserves a page at 3am | `apps/server/src/alerts/config.ts` | Only reality checks and observed findings alert; unapproved diagram edits never do |
| D4 | Should the CI check block merges | `packages/action/action.yml` | Report only (`fail-on: never`) |
| D5 | Which integration comes first | `apps/collector` | Kubernetes and OpenTelemetry |
| D6 | Who may make a room private, and what anonymous users keep | `apps/server/src/access/policy.ts` | Anyone who can edit a link room may move it into a workspace |
| D7 | Does the review diff read clearly and feel trustworthy | Review mode (task 8) | Field-level diff with approve or reject |
| D8 | Which user journeys matter most | `e2e/tests` | Drawing, findings, live data, review, incident |
| D9 | Price, packaging, and who pays | Task 13 | None yet |
| D10 | The words people use for the problem, for the landing page | Task 12 | None yet |

## The files

- [screener.md](screener.md): who to recruit, the outreach message, screening questions.
- [interview-guide.md](interview-guide.md): the 45-minute script, with a version for each role.
- [notes-template.md](notes-template.md): copy one per interview. Tag observations with the decision IDs above.
- [synthesis.md](synthesis.md): how notes become themes, and themes become a decision.
- `tally.mjs`: counts tagged evidence across note files, as a first pass before reading them properly: `node docs/research/tally.mjs docs/research/notes/*.md`.

Keep raw notes in `docs/research/notes/`, one file per interview, named `YYYY-MM-DD-role-company.md`. They contain things people said in confidence, so the folder is git-ignored; share them deliberately, and use roles, not names, even there. Readouts (`docs/research/readouts/`) quote without names and are fine to commit.

## How many

Five per role before deciding anything, and stop a line of questioning once three in a row give the same answer. A decision needs at least three independent sources pointing the same way; two against three is a split, and a split means keep the default and ask again.
