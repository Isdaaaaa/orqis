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
2. CLI prepares local config, starts the web runtime, and waits for `/health` to report ready.
3. CLI starts a tunnel adapter (Cloudflare Tunnel first, ngrok fallback).
4. CLI prints a local URL and public URL.
5. User configures providers, models, and agent roles in the web UI.
6. User creates projects and enters per-project workspaces.
7. User submits a goal from Main Chat and the Project Manager persists a first-pass plan plus visible task list in the workspace timeline.
8. Project Manager agent then assigns tasks, requests approvals, and records outputs in later workflow slices.

## Repo docs

- `README.md`: product and stack overview.
- `TODO.md`: active execution checklist and current focus.
- `DECISIONS.md`: architecture and stack decisions.
- `docs/architecture.md`: system boundaries and flows.
- `docs/mvp-scope.md`: MVP in/out scope and success criteria.
- `docs/roadmap.md`: phased delivery plan and dependency order.

## Workspace scaffold

Current monorepo layout:

- `apps/cli`
- `apps/web`
- `packages/core`
- `packages/db`
- `packages/tunnel`

Common commands:

- `pnpm install`
- `pnpm -r build`
- `pnpm -r test`
- `pnpm -r typecheck`
- `pnpm orqis:init` (runs the built local CLI; global `orqis` install is not required yet)
- `pnpm run orqis:web:sqlite:doctor` (checks whether `better-sqlite3` native bindings can load)
- `pnpm run orqis:web:sqlite:bootstrap` (rebuilds `better-sqlite3` and runs the doctor check)

Current runtime behavior:

- `node apps/cli/dist/cli.js init` launches the local web runtime as a dedicated child process and keeps serving until interrupted.
- `orqis init` prints `local_url`, `health_url`, `public_url`, and tunnel provider metadata after the CLI confirms runtime and tunnel readiness.
- Tunnel startup uses an ordered provider strategy (`cloudflare` first, `ngrok` fallback) based on `config.tunnel.providers`.
- Tunnel adapters now manage `cloudflared`/`ngrok` child-process lifecycle directly and auto-discover public URLs; manual `ORQIS_*_PUBLIC_URL` values are optional overrides instead of required inputs.
- `orqis init` requires tunnel binaries on `PATH` (`cloudflared` and/or `ngrok`), and supports `ORQIS_CLOUDFLARED_BIN` / `ORQIS_NGROK_BIN` when custom binary paths are needed.
- `orqis init` now uses a 15-second default startup/health timeout window; use `--health-timeout-ms <ms>` to override it.
- The web runtime now serves local session-auth endpoints at `GET /login` and `GET/POST/DELETE /api/session`.
- Workspace shell and project/timeline APIs are protected: unauthenticated requests to `/`, `GET/POST /api/projects`, and `GET/POST /api/workspaces/:workspaceId/messages` require a login session.
- Login issues an `HttpOnly` local session cookie (`SameSite=Lax`) that persists across browser refreshes while the runtime stays up.
- Session state is in-memory for now, so restarting the web runtime requires signing in again.
- The `Assigned Agents` section now exposes persistent provider/model/agent-role configuration backed by SQLite and served through `GET/PUT /api/settings/agent-configuration`.
- Provider/model/role settings are seeded with durable defaults on first run, survive restarts, and must retain the reserved `project_manager` role key so PM planning stays valid.
- Main Chat now exposes a `Create plan` action backed by `POST /api/workspaces/:workspaceId/planner/runs`, which stores the user goal, a PM planning run, role-owned task records, matching `task_assignments` role snapshots, and the visible PM plan message together.
- The web runtime now serves task APIs at `GET /api/workspaces/:workspaceId/tasks`, returning persisted task state, role-mapped assignment snapshots, and current checkout/execution lock metadata for the workspace.
- Authenticated task checkout/release flows are available at `POST /api/workspaces/:workspaceId/tasks/:taskId/checkout` and `POST /api/workspaces/:workspaceId/tasks/:taskId/release`, enforcing assigned-role claims, coupling `ownerType: "run"` to the submitted `runId`, and returning deterministic conflict codes for competing ownership attempts.
- The web runtime now serves project APIs at `GET/POST /api/projects`, creating one persistent workspace mapping per project.
- The landing UI supports project creation, project selection, and timeline loading for the selected project's workspace.
- The web runtime now persists workspace timeline messages in SQLite (`orqis.db`) and serves timeline APIs at `GET/POST /api/workspaces/:workspaceId/messages`.
- Timeline writes auto-provision workspace/project records when missing, and timeline reads return chronological message history scoped to one workspace.
- When launched by `orqis init`, the runtime SQLite file defaults to the resolved Orqis config directory (including `--config-dir`), instead of always using `~/.orqis`.
- Set `ORQIS_WEB_RUNTIME_DB_PATH` to override the SQLite file path used by the web runtime.
- Web runtime startup now preflights `better-sqlite3` bindings and returns recovery commands when bindings are unavailable.

SQLite binding recovery:

- If startup reports unavailable `better-sqlite3` bindings, run `pnpm install` first.
- Then run `pnpm run orqis:web:sqlite:bootstrap` and retry `pnpm orqis:init`.

## First implementation target

Vertical slice: `orqis init` boots a local web runtime, starts a tunnel adapter, verifies reachability, and returns a usable public URL.

This target is foundational, MVP-critical, and unblocks all browser-based product work.
