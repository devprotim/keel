# Data handling (draft)

Status: **draft for review.** It describes what the code does today, as of 2026-09-29. The wording a user sees (a privacy page, a notice at sign-in) is not written yet, and the retention periods marked *to decide* are open questions, not commitments.

## What Keel stores

| Data | Where | How long | Who can read it |
|---|---|---|---|
| Diagram content: component names, kinds, technology, notes, runtime names, dependency settings | Postgres (`rooms`, `room_updates`) when `DATABASE_URL` is set, otherwise server memory until restart | Until an owner of its workspace deletes it, which removes the content and leaves only the room id and deletion time, so offline copies are not synced back. A link room has no one who may delete it, so it stays indefinitely. *Retention to decide.* | Anyone with the room link |
| The same diagram, a local copy | The browser's IndexedDB (`keel:<roomId>`), for offline editing | Until the user clears site data | That browser's user |
| Approvals (the baseline) | In the room document, with the approver's display name and time for each field, plus the element's name, notes and position at approval (so a rejected deletion can be restored) | As long as the room | Anyone with the room link |
| Observations (replica counts, request rates, latencies, error rates, config flags) | In the room document, one set per source, replaced on each push | As long as the room. Sets older than 24h stop being applied but are not deleted. | Anyone with the room link |
| Tuning: rule settings, real/noise labels (with the labeller's display name and time), and when each finding opened and resolved | In the room document | Settings and labels as long as the room; finding history up to 1000 records, resolved ones dropped after 30 days | Anyone with the room link |
| Observation history (what each push changed: counts, settings, components appearing or vanishing, error rates crossing 5%) | In the room document, as an event log | The last 500 events, and none older than 7 days | Anyone with the room link |
| Presence: display name, avatar URL, cursor, selection | Relayed between open tabs in memory, **never persisted** | Until the tab closes | Others in the room at that moment |
| Session cookie: provider user id, name, avatar URL | The user's browser only (a signed token, nothing stored server-side) | 30 days, or until sign-out | The server, to verify it |
| Guest name and theme | Browser `localStorage` | Until cleared | That browser |
| Signed-in users: provider user id, display name, avatar URL | Postgres (`users`), refreshed on each visit | Indefinitely. *To decide.* | Members of any workspace the user belongs to see the name and avatar |
| Workspaces, membership and roles, diagram names | Postgres (`workspaces`, `workspace_members`, `room_workspaces`) | Until removed | Members of the workspace |
| Invite links, collector tokens | Postgres, **as SHA-256 hashes only** | Invites 7 days; tokens until revoked or the room is made open | Nobody can read them back |
| Alert destinations: Slack webhook URL, PagerDuty integration key, thresholds | Postgres (`room_alert_configs`), never in the room document | Until alerting is turned off for the room | The server only. The API returns them masked. |
| Open alerts: finding title, detail, cited ids, first and last seen | Postgres (`room_alert_state`) | Until the alert resolves | The server. The API returns titles and severities. |
| Billing: plan, subscription status, Stripe customer, subscription and item ids, period end | Postgres (`workspace_billing`), written only by Stripe's webhook | As long as the workspace | The server. Owners see the plan and status. Card details never reach Keel: payment happens on Stripe's hosted pages. |
| Request logs: method, URL (room ids replaced by a one-way tag), client IP | The host's log stream (Render) | The host's log retention. *To decide.* | Operators |

Keel does not store passwords, email addresses, or OAuth access tokens. GitHub sign-in asks only for `read:user`, and the access token is used once to read the public profile, then discarded.

## What leaves Keel

- **AI review** sends the diagram (names, kinds, technology, notes, and dependency settings, but not positions, approvals or observations) to Anthropic or Google, whichever key is configured. That happens only when someone presses Review. The provider's API data policy applies. By default neither Anthropic's nor Google's paid API trains on API inputs, but *confirm against the current terms before publishing this.* The server keeps the last 100 results in memory, keyed by a fingerprint of the diagram, and they are gone on restart.
- **Drift alerts**, when a room has them configured, send the finding's title and detail (which quote component names and observed values) to that room's Slack webhook or PagerDuty service, along with a **link to the room**. That link is the room's edit capability, so everyone in the Slack channel or on the PagerDuty service can open and edit the diagram.
- **Fonts** load from Google Fonts and Fontshare, and **avatars** from GitHub's and Google's CDNs, so those hosts see the viewer's IP address.
- Nothing else. The app has no analytics, error reporting, or third-party scripts. (The `analytics` key in `apps/web/angular.json` is Angular CLI usage reporting for whoever runs `ng`. It is not part of the app.)

## What users should know

- **A link room's link is the key.** Anyone who has it can see and change the diagram. Treat these links like shared documents, not like private files.
- **A room moved into a workspace** opens only for the workspace's members. Signing in alone doesn't make a room private: someone has to move it.
- **Diagrams sent for review go to a third party.** Don't put secrets (credentials, internal hostnames you consider sensitive) in notes.

## Gaps before this can be published

1. **Deletion.** Owners can delete a workspace room (task 7), and browsers drop their offline copy when they next open it. Nobody can delete a link room, since nobody owns one; asking for one to be deleted still needs an operator procedure (delete through `PostgresDocStore.delete`, which keeps the tombstone). Decide whether link rooms should be deletable, for example by moving them into a workspace first.
2. **Retention.** Decide how long an untouched room lives. `rooms.updated_at` already records last activity, so a scheduled purge is straightforward once a period is chosen.
3. **Backups.** Render Postgres backups are plan-dependent. Whatever the plan keeps is also how long "deleted" data survives. State it once chosen.
4. **Approver names.** Approvals record a display name per field. For a guest that is a random name. For a signed-in user it is their GitHub name, which stays in the room after they leave. Decide whether that needs saying at sign-in.
5. **Subprocessors.** List the hosting provider (Render), the AI providers (Anthropic, Google), Stripe (billing, when enabled), and the font and avatar CDNs, with links to their terms.
