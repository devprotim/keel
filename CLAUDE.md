# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Keel: a real-time multiplayer canvas for designing system architecture that flags the design flaws that cause outages. Shapes are typed (service, datastore, queue, cache, gateway, job, external) and edges carry runtime semantics (sync/async/stream, timeout, retries, circuit breaker, idempotency), so the diagram is a structured graph that can be validated, not just drawn.

## Commands

Requires Node >= 22.22.3 and pnpm (`packageManager: pnpm@10.32.0`).

```bash
pnpm install
pnpm --filter @keel/shared build   # must run once before apps/server or apps/web will type-check against it

pnpm -r build
pnpm -r test        # 158 tests total, no network or browser required
pnpm -r typecheck
pnpm --parallel -r dev
```

Per-workspace, from the repo root or the workspace directory:

```bash
pnpm --filter @keel/shared test    # vitest run
pnpm --filter @keel/server test    # vitest run
pnpm --filter @keel/web test       # ng test -> Angular's @angular/build:unit-test (vitest-backed, not Karma)

npx vitest run src/collab/room.spec.ts   # single test file, from apps/server or packages/shared
npx vitest run -t "name substring"       # filter by test name
```

Running the app locally (two terminals, after the shared build above):

```bash
cd apps/server && pnpm dev   # Fastify on :8787, native TS via --experimental-strip-types, no ts-node/tsx
cd apps/web && pnpm dev      # Angular dev server on :4200
```

AI review is optional: copy `apps/server/.env.example` to `apps/server/.env` and set `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`. Without one, the canvas and rule engine work fully and only `/api/review` is disabled (503, not a boot failure — see `config.ts`/`app.ts`).

`pnpm -r lint` runs ESLint (flat config) in all three workspaces. `apps/server` turns off `@typescript-eslint/require-await` deliberately — `MemoryDocStore` and the AI provider test doubles implement async interfaces with synchronous bodies on purpose (see `store.ts`), so that rule is a false positive there, not a gap.

## Architecture

```
packages/shared   domain model, graph algorithms, validation engine (framework-free, no deps)
apps/server       Fastify: Yjs sync protocol, rooms, persistence, AI review
apps/web          Angular 22, hand-rolled Canvas 2D renderer
```

`packages/shared` is the contract both other workspaces import (`@keel/shared`, built to `dist/`). It must be built before `apps/server` or `apps/web` type-check, since they consume its `dist/*.d.ts`, not its source.

### Collaboration (the core mechanism)

- Each open diagram is one Yjs `Y.Doc`. **Every node and edge is its own nested `Y.Map`**, not a plain object in one map — this moves the conflict boundary to the individual field, so one person renaming a box while another drags it merges cleanly instead of one edit silently winning (`apps/web/src/app/collab/graph-doc.ts`).
- Wire protocol matches `y-websocket` framing exactly (`apps/server/src/collab/protocol.ts`): one binary channel byte (`MESSAGE_SYNC` / `MESSAGE_AWARENESS`) per frame, no JSON envelope. Sync is the standard three-step Yjs handshake; awareness carries live cursor/selection presence and is never persisted.
- `Room` (`apps/server/src/collab/room.ts`) owns one document's socket fan-out, presence, and persistence. It is the meeting point, not an arbiter — the CRDT resolves conflicts, so the room's real jobs are relaying updates to every socket but the sender, batching document updates and debounce-flushing them to storage, and compacting the update log into a snapshot every `COMPACT_AFTER_UPDATES` writes.
- `RoomManager` (`room-manager.ts`) keys on the in-flight *open promise*, not the `Room` itself, so concurrent joins to a cold room don't each build their own document. Empty rooms are evicted after `ROOM_IDLE_MS` rather than immediately, since a page refresh looks identical to a departure.
- Storage (`store/store.ts`) is an append-only Yjs update log on top of an optional snapshot (`DocStore` interface). Only `MemoryDocStore` exists today — Postgres-backed storage is the next step (see comment in `index.ts`); tests run against the real in-memory implementation of the same contract, not a mock.
- On the client, `CollabService` (`apps/web/src/app/collab/collab.service.ts`) is the only framework-aware layer: it wires `y-websocket` + `y-indexeddb` (offline edits merge on reconnect) and projects the Yjs doc into Angular signals. All merge/undo semantics live in the framework-free, separately-tested `GraphDoc`. Undo is scoped to the local client's own edits via `trackedOrigins` — an unscoped `UndoManager` would let Ctrl+Z undo a collaborator's change.
- Connection status is derived from two independent signals (socket state + `navigator.onLine`), because a stale WebSocket can report "connected" after the network is actually gone.

### Validation and AI review

- `packages/shared` runs 13 deterministic rules on every keystroke (`rules.ts`): `spof-single-instance`, `sync-missing-timeout`, `retry-without-timeout`, `external-no-circuit-breaker`, `sync-cycle`, `sync-chain-depth`, `sync-fanout`, `datastore-durability`, `queue-no-dlq`, `async-not-idempotent`, `retry-storm`, `shared-datastore`, `orphan-node`. Both the client (instant feedback) and `POST /api/validate` on the server run the identical engine, so the two never disagree.
- AI review (`apps/server/src/ai/`) is a second opinion for judgment calls a rule can't express (e.g. dual-write inconsistency, a boundary drawn in the wrong place) — not a replacement for the rules, and the system prompt explicitly tells the model not to repeat what the rule engine already covers. `ReviewProvider` is the only vendor-specific surface (Anthropic and Gemini implementations); caching (keyed on model + graph fingerprint, position-independent) and grounding live in `ArchitectureReviewer`/`review.ts` above that boundary so both providers get the same guarantees.
- **Every AI finding must cite a real node/edge id.** `groundFindings()` discards any finding citing nothing or citing an id that doesn't exist in the graph — this is what makes a finding clickable instead of something to fact-check by hand. This filter runs for every provider; don't bypass it when adding one.
- Anthropic wins if both `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` are set (`selectProvider` in `app.ts`).

### Rendering

- The canvas renderer (`apps/web/src/app/canvas/renderer.ts`) is hand-written, split across two stacked `<canvas>` elements: content (grid/edges/nodes) redraws only when the scene or camera changes, cursors/marquee redraw on every pointer move. Remote cursors move constantly, so without the split, any peer's mouse movement would repaint the whole diagram.

### Authentication

- GitHub/Google sign-in is **identity-only**: it never gates a room. Anyone with a room link can still join and edit anonymously; a successful login just replaces the client's random guest name/avatar (`apps/web/src/app/collab/presence.ts`) with the provider's real one. There are no accounts in the "protects data" sense and no per-room ACLs — this preserves the "room id is the whole sharing mechanism" design in `app.routes.ts`.
- Server side (`apps/server/src/auth/`): `@fastify/oauth2` per configured provider + a stateless, `jose`-signed JWT session cookie (`session.ts`) — no new persistence layer, since losing a session just means signing in again. `/api/auth/{github,google}` and their `/callback` routes exist only when that provider's `_CLIENT_ID`/`_CLIENT_SECRET` env pair is set; with neither set, only `/api/auth/me` exists and always reports `{ user: null }`. This mirrors `/api/review`'s "absent credentials disable the feature, never the boot" precedent. `SESSION_SECRET` and `PUBLIC_URL` (for building the OAuth callback URI) round out the config; see `.env.example`.
- Client side (`apps/web/src/app/auth/auth.service.ts`): calls `/api/auth/me` on boot and, on a real user, calls `CollabService.setIdentity()` to overwrite the guest name/avatar in awareness. Login/logout are full-page redirects, not in-app steps — there is no dedicated Angular login route.

### PWA

- `apps/web` is installable: `@angular/service-worker` (added via `ng add @angular/pwa`), `ngsw-config.json`, and a custom `manifest.webmanifest` + icon set in `public/` (a flat 3-node graph mark, matching DESIGN.md's no-gradient/no-illustration rule — not Angular's default placeholder icons). The service worker only covers app-shell caching and installability; offline editing is unrelated and already handled by `y-indexeddb` + the Yjs CRDT merge on reconnect.

### Server request boundary

- Room ids are validated against a strict allowlist regex (`RoomIdSchema` in `app.ts`) before being used as storage keys or in URLs — they're an injection/traversal boundary, not free text.
- `ArchGraphSchema` bounds graphs to 500 nodes / 1500 edges; `/api/review` forwards the graph to a paid API, so an unbounded graph is an unbounded bill.
- Config (`config.ts`) is parsed once at boot with Zod and the process refuses to start on invalid env — deliberately, so failures surface at boot rather than on the first real request.

## Routing

The room id lives in the URL and *is* the sharing mechanism (`apps/web/src/app/app.routes.ts`) — no accounts, no invitations. Visiting `/` generates a new random room id and redirects.

## Design System

Always read DESIGN.md before making any visual or UI decisions. Color, spacing, radii, and motion were already established in `apps/web/src/styles/_tokens.scss`; DESIGN.md documents them as source of truth and adds the typography system (Geist / Geist Mono / Cabinet Grotesk). Do not deviate without explicit user approval. In QA mode, flag any code that doesn't match DESIGN.md.

## Health Stack

- typecheck: pnpm -r typecheck
- lint: pnpm -r lint
- test: pnpm -r test
- deadcode: none configured (no knip)
- shell: no shell scripts to lint

## Deploy Configuration (configured by /setup-deploy)

- Platform: Render (single combined Web Service, `render.yaml` at repo root)
- Production URL: not yet created — no Render service exists yet, see below
- Deploy workflow: automatic on push to `main` (Render's own auto-deploy, once the service is connected to this repo)
- Deploy status command: HTTP health check
- Merge method: whatever this repo already uses (no restriction added)
- Project type: web app, one process serving both the API/WebSocket and the built Angular static files (same-origin, per `apps/web/src/app/core/app-config.ts`)
- Post-deploy health check: `GET /health` on the service's `*.onrender.com` URL, once assigned

### Why one service, not two

`app-config.ts`'s `defaultConfig()` assumes the client and the API/WebSocket share an origin in production — it never reads a configured API URL, only `location.origin`. `apps/server` now serves `apps/web`'s build output itself (`@fastify/static` + an SPA fallback in `app.ts`, added for this deploy) rather than the two being hosted separately. Splitting them into a Static Site + a separate Web Service later is possible but needs `app-config.ts` changed to accept an explicit production API URL, plus `CORS_ORIGINS` pointed at the static site's domain.

### Custom deploy hooks

- Pre-merge: `pnpm -r lint && pnpm -r typecheck && pnpm -r test` (already enforced by `.github/workflows/ci.yml`)
- Deploy trigger: automatic on push to `main`, once the Render service is connected to this GitHub repo
- Deploy status: poll the production URL's `/health` endpoint
- Health check: `/health`

### Not yet done — needs your Render account

Nothing above required Render credentials, so it's all done. Creating the actual service does: connecting this GitHub repo to Render, applying the `render.yaml` Blueprint, and entering `ANTHROPIC_API_KEY`/`GEMINI_API_KEY` in the dashboard (both marked `sync: false` in `render.yaml` so Render prompts for them rather than storing them in the file). That's an account-level action on Render's own dashboard.

### Not yet done — needs your GitHub/Google developer accounts

Sign-in is fully coded and degrades gracefully with zero config (see Authentication above), but making it actually work needs two OAuth apps registered on platforms a coding session can't reach: GitHub → Developer Settings → OAuth Apps, and Google → Cloud Console → OAuth consent screen + Credentials. Each needs its callback URL set to `<PUBLIC_URL>/api/auth/{github,google}/callback` (`http://localhost:8787/...` for local dev, the eventual Render URL for production). Then set `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, and `PUBLIC_URL` in `apps/server/.env` (and later in Render's dashboard, same as the AI keys).
