# Keel

A real-time multiplayer canvas for designing system architecture that flags the design flaws that cause outages.

Shapes are typed, not just boxes. Services, datastores, queues and caches carry properties, and the edges between them carry runtime semantics: sync or async, timeout, retries, circuit breaker, idempotency. Because the diagram is a structured graph rather than drawing, it can be reasoned about.

## What it does

- **Multiplayer editing.** Yjs CRDT over WebSocket, with live cursors and presence. Offline edits are kept in IndexedDB and merge on reconnect.
- **Continuous validation.** 13 rules run on every keystroke: circular sync dependencies, retries without a timeout, single points of failure, unprotected third-party calls, datastore durability, retry storms, deep call chains, high fan-out, queues without a dead-letter queue, non-idempotent consumers, shared datastores.
- **Checked against reality.** Every number on the diagram is a claim. Push what the running system reports (replicas, configured timeouts, retries, latency, traffic) and the rules judge the system as it runs, not as it was typed. Traffic decides urgency: hot paths escalate, idle ones are demoted. An approved baseline records intent, so drift reads as either "approved, not rolled out yet" or "nobody approved this". See [Live data and approvals](#live-data-and-approvals).
- **Export and import.** PNG (2x, for docs and slides), SVG (vector, text stays text), or JSON that `POST /api/validate` accepts as-is, so a diagram can be checked into a repo and validated in CI. Findings badges are optional on images. JSON opens again with **Open a file** on the landing page (always into a new room) or **Import JSON** on an empty board, approved baseline included.
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

## Live data and approvals

Give each component a **Runtime name** in the inspector (its Kubernetes deployment or trace service name), then push observations into the room. One set is kept per `source`, and each push replaces that source's previous set:

```bash
curl -X POST http://localhost:8787/api/rooms/<room-id>/observations \
  -H 'content-type: application/json' \
  -d '{
    "source": "kubernetes",
    "observedAt": "2026-09-25T12:00:00Z",
    "nodes": [{ "ref": "catalog", "replicas": 1, "rps": 420 }],
    "edges": [{ "source": "checkout", "target": "orders-db", "timeoutMs": 4000, "p99Ms": 180, "rps": 300 }]
  }'
```

Node fields: `replicas`, `hasReplica`, `hasBackup`, `hasDlq`, `rps`. Edge fields: `timeoutMs` (`null` means no timeout is configured), `retries`, `circuitBreaker`, `p99Ms`, `rps`. Every open canvas re-validates live. The same JSON can be loaded by hand with **Import** in the review panel.

What that adds:

| Check | Fires when |
|---|---|
| `observed-drift` | A running value differs from the drawn one. Classified against the baseline: plain drift, an approved change not rolled out yet, or unapproved drift (an accident). |
| `unapproved-change` | The diagram differs from the approved baseline, or already runs that way without approval. |
| `timeout-below-latency` | Observed p99 is at or above the timeout, so healthy calls fail every day. |
| `undiagrammed-dependency` | Production makes a call between two drawn components that the diagram does not show. |
| `stale-evidence` | A source is older than 24 hours. Stale sets are no longer applied. |

Existing rules also run against observed values, so a stale "3 replicas" can no longer hide a retry storm. Findings raised only because of observed values carry a **LIVE** badge. "On the critical path" is still worth ticking for failover paths: traffic cannot show those, and a ticked component is never demoted for being idle.

**Approve design** in the review panel records the current diagram as the baseline, attributed to your display name. **Match running system** on a drift finding updates the diagram to the running value and approves it in one undoable step.

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
