# Data handling (draft)

Status: **draft for review.** It describes what the code does today, as of 2026-09-28. The wording a user sees (a privacy page, a notice at sign-in) is not written yet, and the retention periods marked *to decide* are open questions, not commitments.

## What Keel stores

| Data | Where | How long | Who can read it |
|---|---|---|---|
| Diagram content: component names, kinds, technology, notes, runtime names, dependency settings | Postgres (`rooms`, `room_updates`) when `DATABASE_URL` is set, otherwise server memory until restart | Indefinitely. There is no deletion yet. *To decide.* | Anyone with the room link |
| The same diagram, a local copy | The browser's IndexedDB (`keel:<roomId>`), for offline editing | Until the user clears site data | That browser's user |
| Approvals (the baseline) | In the room document, with the approver's display name and time for each field | As long as the room | Anyone with the room link |
| Observations (replica counts, request rates, latencies, config flags) | In the room document, one set per source, replaced on each push | As long as the room. Sets older than 24h stop being applied but are not deleted. | Anyone with the room link |
| Presence: display name, avatar URL, cursor, selection | Relayed between open tabs in memory, **never persisted** | Until the tab closes | Others in the room at that moment |
| Session cookie: provider user id, name, avatar URL | The user's browser only (a signed token, nothing stored server-side) | 30 days, or until sign-out | The server, to verify it |
| Guest name and theme | Browser `localStorage` | Until cleared | That browser |
| Request logs: method, URL (room ids replaced by a one-way tag), client IP | The host's log stream (Render) | The host's log retention. *To decide.* | Operators |

Keel does not store passwords, email addresses, or OAuth access tokens. GitHub sign-in asks only for `read:user`, and the access token is used once to read the public profile, then discarded.

## What leaves Keel

- **AI review** sends the diagram (names, kinds, technology, notes, and dependency settings, but not positions, approvals or observations) to Anthropic or Google, whichever key is configured. That happens only when someone presses Review. The provider's API data policy applies. By default neither Anthropic's nor Google's paid API trains on API inputs, but *confirm against the current terms before publishing this.* The server keeps the last 100 results in memory, keyed by a fingerprint of the diagram, and they are gone on restart.
- **Fonts** load from Google Fonts and Fontshare, and **avatars** from GitHub's and Google's CDNs, so those hosts see the viewer's IP address.
- Nothing else. The app has no analytics, error reporting, or third-party scripts. (The `analytics` key in `apps/web/angular.json` is Angular CLI usage reporting for whoever runs `ng`. It is not part of the app.)

## What users should know

- **A room link is the key.** Anyone who has it can see and change the diagram. Treat links like shared documents, not like private files.
- **Signing in does not make a room private.** It only puts the user's name and avatar on their cursor and approvals.
- **Diagrams sent for review go to a third party.** Don't put secrets (credentials, internal hostnames you consider sensitive) in notes.

## Gaps before this can be published

1. **Deletion.** There is no way to delete a room, or to ask for one to be deleted. The minimum is an operator procedure (a single `DELETE FROM rooms WHERE room_id = $1` cascades to the log). A user-facing control needs workspaces (task 7), so that "who may delete" has an answer.
2. **Retention.** Decide how long an untouched room lives. `rooms.updated_at` already records last activity, so a scheduled purge is straightforward once a period is chosen.
3. **Backups.** Render Postgres backups are plan-dependent. Whatever the plan keeps is also how long "deleted" data survives. State it once chosen.
4. **Approver names.** Approvals record a display name per field. For a guest that is a random name. For a signed-in user it is their GitHub name, which stays in the room after they leave. Decide whether that needs saying at sign-in.
5. **Subprocessors.** List the hosting provider (Render), the AI providers (Anthropic, Google), and the font and avatar CDNs, with links to their terms.
