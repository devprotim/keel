# Design System — Keel

## Product Context
- **What this is:** A real-time multiplayer canvas for designing system architecture that flags the design flaws that cause outages. Shapes are typed and edges carry runtime semantics, so the diagram is a structured graph, not just a drawing.
- **Who it's for:** Engineers and architects designing and reviewing system diagrams together, live.
- **Space/industry:** Developer tooling — sits next to canvas/diagramming tools (tldraw, Excalidraw, Figma) and technical dashboards (linters, CI checks) at once.
- **Project type:** Hybrid. A creative canvas (drawing shapes, dragging edges) fused with a dense technical dashboard (validation findings, AI review, rule violations).

## Aesthetic Direction
- **Direction:** Industrial / utilitarian, function-first. This was already true of the codebase before this document existed — `_tokens.scss` was built with real care (single neutral ramp, identity colors kept separate from severity colors, theme structure that swaps only what differs). This document formalizes what was already there and adds the one deliberate gap: typography.
- **Decoration level:** Minimal. No gradients, no illustration, no decorative texture. The diagram and the findings are the content; chrome stays quiet.
- **Mood:** Precise, trustworthy, calm under a dense information load. It should feel like a linter for architecture, not a whiteboard toy.

## Typography
- **Display — wordmark & panel section headers only:** Cabinet Grotesk, weight 700. Used for the "Keel" brand mark in the header and the Findings/Inspector panel headers. A geometric grotesque with more character than the UI face (distinct K, l terminals) without reading as playful. This is the one deliberate risk in the system — small blast radius, easy to revert.
  - Load: `https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700&display=swap` (Fontshare, free for commercial use), or self-host the woff2 from Fontshare's download page under `apps/web/src/assets/fonts/`.
- **UI / body — everything else the user reads or edits:** Geist, weights 400/500/600. Buttons, field labels, canvas node labels, finding titles, toolbar labels. Open source (SIL OFL), designed by Vercel for screen legibility at small sizes, built-in tabular figures.
  - Load: Google Fonts — `family=Geist:wght@400;500;600;700`.
- **Data / mono — identifiers and measured values:** Geist Mono, weight 400/500. Room id, node/edge id, `timeoutMs`, `retries`, rule ids (`sync-missing-timeout`), the AI review model selector. Replaces the previous generic system-mono stack. Shares Geist's design language so UI and data don't visually fight.
  - Load: Google Fonts — `family=Geist+Mono:wght@400;500;600`.
- **Fallback stacks** (keep the current system stack as the fallback, not a bare `sans-serif`):
  ```css
  --keel-font-display: 'Cabinet Grotesk', 'Geist', ui-sans-serif, system-ui, sans-serif;
  --keel-font: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --keel-font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
  ```
- **Scale:** unchanged from current usage — 11–12px for labels/meta, 12.5–13px for body/buttons, 16px for the wordmark, 18–22px for canvas node titles at default zoom.

## Color
Unchanged — documented here as the source of truth going forward, not proposed anew.
- **Approach:** Restrained. One accent, used sparingly; color elsewhere is either structural (neutrals) or semantic (severity, kind identity).
- **Neutrals:** single ramp `--keel-n-0` through `--keel-n-900`, so borders/text/surfaces stay visually related instead of drifting independently.
- **Accent:** `--keel-accent` #4f6bed (light) / #7b91f5 (dark) — selection, primary actions, focus.
- **Severity** (shared by findings panel and canvas badges): error #dc2626, warning #d97706, info #2563eb, ok #059669 (light); brightened equivalents in dark.
- **Kind identity colors** (same hue in toolbar, canvas, and inspector — not decoration, identity): service #db2777 (rose), datastore #8b5cf6, queue #e8890c, cache #0ea5e9, gateway #0d9488 (teal), job #64748b, external #94a3b8. `service` and `gateway` were changed from their original values — see Decisions Log.
- **Dark mode:** token-swap strategy — only values that differ are redefined under `:root[data-theme='dark']` and `prefers-color-scheme: dark`; structure, spacing, and radii stay theme-independent by design. Explicit choice wins in both directions.

## Spacing
Unchanged.
- **Base unit:** 4px.
- **Scale:** `--keel-space-1` 4px, `-2` 8px, `-3` 12px, `-4` 16px, `-5` 24px, `-6` 32px.
- **Density:** compact — this is a dashboard-density tool, not a marketing page.

## Layout
Unchanged.
- **Structure:** fixed header (52px) + three-column body (findings panel / canvas / inspector), panel width 320px.
- **Border radius:** `--keel-radius-sm` 6px, `--keel-radius` 10px, `--keel-radius-lg` 14px — small, functional, not the rounded-toy look.

## Motion
Unchanged.
- **Approach:** minimal-functional. Only transitions that confirm a state change (hover, active, focus) — 0.12s ease on `background-color`/`border-color`/`color`.
- **Reduced motion:** already respected globally (`prefers-reduced-motion` collapses all transition/animation durations to ~0).

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-09-04 | Created DESIGN.md documenting the existing color/spacing/motion/layout system as-is | These were already well-built in `_tokens.scss`; the gap was a written source of truth, not the tokens themselves |
| 2026-09-04 | Adopted Geist (UI) + Geist Mono (data/ids) + Cabinet Grotesk (wordmark + panel headers only) | Previous stack was bare system fonts — correct but identical to every other app on the machine. Geist/Geist Mono chosen for screen legibility and native tabular figures given how data-dense the findings panel and inspector are. Cabinet Grotesk scoped to just the wordmark and two panel headers as the one deliberate personality risk, kept small and reversible. |
| 2026-09-04 | Changed `--keel-kind-service` (was `#4f6bed`) and `--keel-kind-gateway` (was `#059669`) | Both were exact hex duplicates of another token in the same theme: `service` matched `--keel-accent`, so a selected node was indistinguishable from any service-kind node; `gateway` matched `--keel-severity-ok`, so a gateway node visually read as "healthy" regardless of its actual review status. `service` moved to rose (`#db2777`/`#f472b6`), `gateway` to teal (`#0d9488`/`#2dd4bf`) — both unused hue families in the existing kind palette. |
