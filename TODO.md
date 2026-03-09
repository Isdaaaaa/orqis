# TODO

## Current focus

Implement the `orqis init` vertical slice: local runtime boot + tunnel URL handoff.

## Completed

- [x] Bootstrap repository foundation docs
  - Summary: Added the initial product framing, architecture direction, MVP scope, and phased roadmap.
  - Changed: `README.md`, `TODO.md`, `DECISIONS.md`, `docs/architecture.md`, `docs/mvp-scope.md`, `docs/roadmap.md`.

## Phase 1: Runtime and bootstrap path

- [x] Scaffold `pnpm` workspace (`apps/cli`, `apps/web`, `packages/core`, `packages/db`, `packages/tunnel`)
  - Acceptance criteria: workspace installs cleanly, `pnpm -r test` runs, and each package has a typed build/test script.
  - Summary: Added a minimal TypeScript `pnpm` monorepo scaffold with package-local build/typecheck/test scripts, placeholder tests in each workspace package, and a filtered package smoke command.
  - Changed: `.gitignore`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `apps/cli/*`, `apps/web/*`, `packages/core/*`, `packages/db/*`, `packages/tunnel/*` (including package-local devDependencies and filtered-script smoke coverage).

- [x] Implement `orqis init` command with config bootstrap
  - Acceptance criteria: command creates local config directory and idempotently updates config without data loss.
  - Summary: Added an executable `orqis init` command that bootstraps `config.json`, merges missing defaults without overwriting existing user values, and reports created/updated/unchanged status.
  - Summary (follow-up): Added explicit schema migration hooks with a target-schema path plus a preflight migration-chain completeness guard for future schema upgrades.
  - Summary (follow-up): Added module-load validation and test coverage for the default migration chain to catch schema bumps without migrations immediately.
  - Summary (follow-up): Scoped parse-error handling to JSON parsing only and enforced restrictive config artifact permissions with regression coverage.
  - Summary (follow-up): Made config-permission hardening and permission tests cross-platform by applying POSIX mode enforcement only on POSIX environments.
  - Summary (follow-up): Fixed symlinked CLI entrypoint detection and narrowed `ENOENT` handling to initial config reads so migration errors cannot be misclassified as missing config files.
  - Changed: `apps/cli/src/cli.ts`, `apps/cli/src/config.ts`, `apps/cli/src/index.ts`, `apps/cli/test/init.test.ts`, `apps/cli/package.json`, `pnpm-lock.yaml`.

- [x] Add web runtime launcher and health checks from CLI
  - Acceptance criteria: CLI starts web runtime, confirms health endpoint, and exits with clear errors when startup fails.
  - Summary: Added a minimal HTTP web runtime scaffold with `/` and `/health`, then wired `orqis init` to launch it, poll readiness, print local runtime details, and stay alive until shutdown.
  - Summary (follow-up): Added runtime startup, health-check, and shutdown coverage across CLI and web package tests, plus a built-artifact verification pass for the default runtime loader.
  - Changed: `apps/cli/src/cli.ts`, `apps/cli/src/index.ts`, `apps/cli/test/init.test.ts`, `apps/web/src/index.ts`, `apps/web/test/runtime.test.ts`, `apps/web/package.json`, `pnpm-lock.yaml`, `README.md`, `docs/architecture.md`, `TODO.md`.

- [ ] Add tunnel adapter abstraction with Cloudflare-first strategy and ngrok fallback
  - Acceptance criteria: CLI can launch at least one tunnel provider and returns public URL with provider metadata.

- [ ] Add bootstrap smoke test for `orqis init`
  - Acceptance criteria: automated test verifies config generation, runtime boot, and URL output contract.

#### Hardening before Phase 2

- [ ] Split the scaffold web runtime into a dedicated process before tunnel-provider lifecycle management lands
- [ ] Tighten `orqis init --health-timeout-ms` validation to reject non-numeric suffix input (for example `10abc`)
- [ ] Add CLI regression coverage that asserts `--health-timeout-ms` rejects non-numeric suffix input (for example `10abc`)
- [ ] Add signal-shutdown test coverage for `waitForRuntimeShutdown` (listener cleanup and runtime stop invocation)
- [ ] Implement managed `cloudflared`/`ngrok` process lifecycle and automatic URL discovery (remove manual `ORQIS_*_PUBLIC_URL` requirement)

## Phase 2: Projects and persistent workspaces

- [ ] Create project/workspace schema and migrations
  - Acceptance criteria: schema includes projects, workspaces, messages, tasks, approvals, runs, and audit events.

- [ ] Build project creation flow in UI
  - Acceptance criteria: user can create/list/select projects and each project resolves to one persistent workspace.

- [ ] Build workspace group chat timeline with persistence
  - Acceptance criteria: messages survive restarts and reload in chronological order per workspace.

- [ ] Add basic local session auth
  - Acceptance criteria: protected routes require login and session persistence works across refresh.

## Phase 3: Project Manager planning and task approvals

- [ ] Implement Project Manager planner service (`goal -> plan -> task list`)
  - Acceptance criteria: planner persists plan and emits visible plan message in workspace chat.

- [ ] Implement task assignment records and specialist role mapping
  - Acceptance criteria: each task has owner role, state, run linkage, and timestamps.

- [ ] Implement user approval/reject loop for task outputs
  - Acceptance criteria: user action updates approval status, audit event is written, and PM receives the decision.

- [ ] Add first run lifecycle states (`planned`, `running`, `waiting_approval`, `done`, `failed`)
  - Acceptance criteria: run state transitions are validated and invalid transitions are rejected.

## Phase 4: Workflow hardening and integration

- [ ] Add implementation/review/integration workflow commands in PM logic
  - Acceptance criteria: PM can route tasks into phase-specific workflows and post explicit status updates.

- [ ] Add audit timeline view
  - Acceptance criteria: key actions (task create/assign, approval, run status changes) are traceable in UI.

- [ ] Add browser e2e checks for bootstrap + project + workspace + approval happy path
  - Acceptance criteria: Playwright suite covers one full user journey and runs in CI.

## Later: Parallel execution and repository workflows

- [ ] Introduce dispatcher interface with serial and parallel backends
  - Acceptance criteria: parallel backend can execute independent tasks concurrently behind a feature flag.

- [ ] Add repository/GitHub integration primitives
  - Acceptance criteria: project can store repo metadata and link run/task artifacts to commits or PRs.
