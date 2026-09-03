# Keel

A real-time multiplayer canvas for designing system architecture that flags the design flaws that cause outages.

Shapes are typed, not just boxes. Services, datastores, queues and caches carry properties, and the edges between them carry runtime semantics: sync or async, timeout, retries, circuit breaker, idempotency. Because the diagram is a structured graph rather than drawing, it can be reasoned about.

## What it does

- **Multiplayer editing.** Yjs CRDT over WebSocket, with live cursors and presence. Offline edits are kept in IndexedDB and merge on reconnect.
- **Continuous validation.** 13 rules run on every keystroke: circular sync dependencies, retries without a timeout, single points of failure, unprotected third-party calls, datastore durability, retry storms, deep call chains, high fan-out, queues without a dead-letter queue, non-idempotent consumers, shared datastores.
- **AI review.** A second opinion for the judgement calls a rule cannot express, such as dual-write inconsistency or a boundary drawn in the wrong place. Every finding must cite a real node or edge id; the server discards any that do not, so each one is clickable rather than something you have to fact-check.

## Quick start

Requires Node >= 22.22.3 and pnpm.

```bash
pnpm install
pnpm --filter @keel/shared build

# terminal 1
cd apps/server && pnpm dev

# terminal 2
cd apps/web && pnpm dev
```

Open http://localhost:4200. You are redirected to a new room; the URL is the share link. Click **Load example** for a seeded diagram that carries deliberate flaws.

AI review is optional. Copy `apps/server/.env.example` to `apps/server/.env` and set either `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`. Without one, the canvas and the rule engine work fully and only the review button is disabled.

## Canvas controls

| Action | Result |
|---|---|
| Drag | Move selection, snapped to grid |
| Alt or Cmd drag from a component | Draw a dependency |
| Space drag, middle drag, or scroll | Pan |
| Ctrl scroll or pinch | Zoom at the cursor |
| Drag on empty space | Marquee select |
| Cmd/Ctrl+Z | Undo, scoped to your own edits |

## Layout

```
packages/shared   domain model, graph algorithms, validation engine (framework free)
apps/server       Fastify, Yjs sync protocol, rooms, persistence, AI review
apps/web          Angular 22, hand-rolled Canvas 2D renderer
```

Three decisions worth knowing:

- **The renderer is hand-written**, on two stacked canvases. Content redraws only when the scene or camera changes; cursors and marquee redraw on every pointer move. Remote cursors move constantly, so without the split every mouse movement in the room would repaint the whole diagram.
- **Each node is its own `Y.Map`.** This moves the conflict boundary down to the individual field, so one person renaming a box while another drags it merges cleanly instead of one silently losing.
- **The validation engine is pure and shared.** The client runs it for instant feedback, the server runs the same code for an answer you can trust.

## Tests

```bash
pnpm -r test
```

158 tests, no network or browser required. The multiplayer tests drive a real Yjs peer against a real room, because the failures that matter in collaborative editing are protocol failures and a mock would pass while the handshake was broken.
