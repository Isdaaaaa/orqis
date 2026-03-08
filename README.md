# Orqis

Orqis is a CLI-launched, tunnel-accessible multi-agent software-building platform for solo builders and small teams.

The user runs `orqis init`, gets a public URL, opens the web app from any device, and works inside project workspaces where a Project Manager agent coordinates specialist agents across planning, implementation, review, and integration.

## Product goals

- Make project setup and access CLI-first and fast.
- Support multiple software projects in one local Orqis runtime.
- Give each project a persistent workspace/group chat.
- Keep the user in control through explicit approvals and redirects.
- Preserve durable, auditable project state beyond raw chat logs.

## Recommended stack

Chosen stack for MVP:

- Language/runtime: TypeScript on Node.js (single language across CLI, web, and orchestration).
- Workspace: `pnpm` workspaces.
- Web app: Next.js (App Router) + React + Tailwind CSS.
- CLI: Node.js + `commander` + `execa`.
- Database: SQLite + Drizzle ORM + SQL migrations.
- Realtime updates: Server-Sent Events first, WebSocket upgrade path later.
- Validation and tests: Zod, Vitest, Playwright.
- Logging/audit: Pino + persisted `audit_events`.

Strong alternative (not selected for initial MVP): Fastify backend + Vite frontend + Postgres/Redis from day one.

Why the chosen stack:

- Fastest solo build loop with minimal operational overhead.
- One language and shared types improve Codex-assisted iteration speed.
- SQLite removes external infra friction while preserving structured persistence.
- Next.js keeps early architecture simple while still supporting a clean domain layer.
- SSE gives simple realtime behavior now and keeps room for later parallel workers.

## MVP workflow summary

1. User runs `orqis init`.
2. CLI prepares local config and starts the web runtime.
3. CLI starts a tunnel adapter (Cloudflare Tunnel first, ngrok fallback).
4. CLI prints a local URL and public URL.
5. User configures providers, models, and agent roles in the web UI.
6. User creates projects and enters per-project workspaces.
7. Project Manager agent plans work, assigns tasks, and requests approvals.
8. Agent outputs and key decisions are tracked in structured state plus chat.

## Repo docs

- `README.md`: product and stack overview.
- `TODO.md`: active execution checklist and current focus.
- `DECISIONS.md`: architecture and stack decisions.
- `docs/architecture.md`: system boundaries and flows.
- `docs/mvp-scope.md`: MVP in/out scope and success criteria.
- `docs/roadmap.md`: phased delivery plan and dependency order.

## First implementation target

Vertical slice: `orqis init` boots a local web runtime, starts a tunnel adapter, verifies reachability, and returns a usable public URL.

This target is foundational, MVP-critical, and unblocks all browser-based product work.
