# Keel repository instructions

Use these instructions for work anywhere in this repository. Keep this file focused on durable workflow and architectural constraints; put detailed product or subsystem explanations in the relevant docs and link them here.

## Before changing code

- Read the workspace README and inspect nearby source and tests before changing a subsystem.
- For any visual or UI decision, read `DESIGN.md` first. Treat its tokens and documented typography, spacing, color, layout, and motion rules as the source of truth.
- Read `CLAUDE.md` for the fuller architecture map and subsystem-specific contracts. It is useful project documentation, but this file is the Codex entry point.
- Check `PROJECT_PLAN.md` when work affects project status, sequencing, or an unresolved human decision. Do not make a human-owned product decision on the user's behalf.

## Repository shape and boundaries

- This is a pnpm monorepo. Node must be at least `22.22.3`; the package manager is pnpm `10.32.0`.
- `packages/shared` owns the framework-free domain model, graph algorithms, validation, and shared record readers. Keep shared behavior here rather than duplicating it in the Angular client or Fastify server.
- `apps/server` owns HTTP/WebSocket behavior, room lifecycle, persistence, alerts, and AI review. `apps/web` owns the Angular UI and canvas. `apps/collector` collects runtime observations. `packages/action` is the GitHub Action.
- Build `@keel/shared` before typechecking or building consumers (`apps/server`, `apps/web`); they use its generated `dist` declarations.
- Preserve the contracts documented in `CLAUDE.md` and the relevant subsystem README/docs. In particular, keep validation deterministic and shared between client and server; keep Yjs document reads/writes behind the existing collaboration abstractions; and ground AI findings in real graph element IDs.

## Change and context maintenance

- When a change establishes or changes an architectural boundary, protocol, data contract, invariant, operational command, or design-system decision, update the closest authoritative documentation in the same change. Update `CLAUDE.md` only when its architecture map or workflow guidance changes; update `DESIGN.md` for design-system decisions; update `PROJECT_PLAN.md` for project status or sequencing; update user or subsystem docs for behavior and usage.
- Keep this `AGENTS.md` concise and procedural. Do not copy the full architecture guide into it. Add or revise instructions here only when a rule should apply to future Codex work across the repository.
- Treat generated outputs as source-controlled artifacts only where the repo already does so. The GitHub Action's `packages/action/dist` bundle must be rebuilt after source changes; CI checks that it is current.
- Before finishing, inspect `git diff` and summarize changed behavior, docs, and any checks run. Do not claim a check passed unless it was run and succeeded.

## Commands

Run from the repository root. For checks that depend on shared package declarations, build shared first.

```bash
pnpm install
pnpm --filter @keel/shared build
pnpm -r lint
pnpm -r typecheck
pnpm -r test
pnpm test:e2e
```

Use the narrowest relevant check during iteration. End-to-end tests require Playwright Chromium. CI runs lint, typecheck, unit/contract tests, verifies the Action bundle, and runs end-to-end tests.

