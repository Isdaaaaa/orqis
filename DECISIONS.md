# DECISIONS

This file records early architecture and product decisions for Orqis.

## D-001: Use TypeScript end-to-end

- Status: Accepted
- Date: 2026-03-09

Decision:

- Use TypeScript across CLI, web app, orchestration engine, and shared packages.

Why:

- Maximizes development velocity for solo iteration.
- Shared contracts reduce integration mistakes between CLI and web runtime.
- Aligns with Codex-assisted vibecoding and fast refactors.

Tradeoffs:

- Node ecosystem coupling.
- Requires strict project conventions to avoid type drift.

## D-002: Use `pnpm` workspaces with app/package boundaries

- Status: Accepted
- Date: 2026-03-09

Decision:

- Structure repo as a workspace with:
  - `apps/cli`
  - `apps/web`
  - `packages/core`
  - `packages/db`
  - `packages/tunnel`

Why:

- Keeps MVP modular without overengineering.
- Supports future parallel task execution and isolated testing.
- Provides clean ownership boundaries for role-based agents.

Tradeoffs:

- Slightly higher initial setup overhead than a single package.

## D-003: Use Next.js as the initial web app/runtime host

- Status: Accepted
- Date: 2026-03-09

Decision:

- Use Next.js (App Router) for the web control center and initial API surface.

Why:

- Fastest path to a usable product surface with one primary runtime.
- Strong DX for building chat-heavy, stateful dashboards quickly.
- Supports incremental extraction of domain logic into `packages/core`.

Tradeoffs:

- Runtime concerns can become coupled to UI if boundaries are not enforced.
- Background execution will eventually need dedicated worker processes.

## D-004: Use SQLite + Drizzle for MVP persistence

- Status: Accepted
- Date: 2026-03-09

Decision:

- Persist all MVP data in SQLite with typed Drizzle schema and migrations.

Why:

- Zero external services needed for local-first startup.
- Structured entities provide deterministic state beyond chat transcripts.
- Easy backup/restore and predictable behavior for solo/small-team local usage.

Tradeoffs:

- Write concurrency limits compared with Postgres.
- Will likely need migration path for larger team deployments.

## D-005: Start with serial task execution but design a dispatcher abstraction

- Status: Accepted
- Date: 2026-03-09

Decision:

- MVP executes tasks serially in-process while persisting run/task state.
- Introduce an execution dispatcher interface from day one.

Why:

- Delivers a working orchestrator quickly.
- Avoids queue/distributed complexity early.
- Preserves a clean path to parallel workers later.

Tradeoffs:

- Throughput is limited in MVP.
- Long-running tasks must be managed carefully to keep UI responsive.

## D-006: First implementation target is `orqis init` runtime + tunnel vertical slice

- Status: Accepted
- Date: 2026-03-09

Decision:

- Build CLI bootstrap flow before project/workspace features.

Why:

- It is the primary entry point and core product promise.
- It unblocks all browser-based iteration from any device.
- It creates the operational spine needed for every later workflow.

Tradeoffs:

- Defers early visible PM-agent collaboration features by one step.

## Open questions

- Which auth mode is best for MVP: local owner account only, or lightweight multi-user support?
- Should tunnel default be Cloudflare only at first, or Cloudflare + ngrok immediately?
- At what threshold should persistence migrate from SQLite to Postgres for larger deployments?
