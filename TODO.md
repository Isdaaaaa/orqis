# TODO

## Current focus

Finish Phase 2 by adding the specialist-agent adapter registry contract in core/runtime boundaries.

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

- [x] Add tunnel adapter abstraction with Cloudflare-first strategy and ngrok fallback
  - Acceptance criteria: CLI can launch at least one tunnel provider and returns public URL with provider metadata.
  - Summary: Replaced the tunnel package placeholder with provider adapters and an ordered fallback strategy, then wired `orqis init` to start tunnel sessions, emit `public_url`, and report provider metadata.
  - Summary (follow-up): Removed synthesized tunnel-domain success paths so tunnel startup now fails fast unless a provider URL is explicitly discovered/supplied.
  - Changed: `packages/tunnel/src/index.ts`, `packages/tunnel/test/scaffold.test.ts`, `apps/cli/src/cli.ts`, `apps/cli/test/init.test.ts`, `README.md`, `TODO.md`.

- [x] Add bootstrap smoke test for `orqis init`
  - Acceptance criteria: automated test verifies config generation, runtime boot, and URL output contract.
  - Summary: Added an end-to-end `orqis init` smoke test that validates config bootstrap, runtime startup, and CLI URL/status output contract lines in one flow.
  - Changed: `apps/cli/test/init.test.ts`, `TODO.md`.

#### Hardening before Phase 2

Must finish before Phase 2:
- [x] Split the scaffold web runtime into a dedicated process before tunnel-provider lifecycle management lands
  - Summary: Updated `orqis init` to launch the web scaffold in a managed child process with readiness messaging, graceful stop handling, and source-mode fallback when runtime process artifacts are not built.
  - Changed: `apps/cli/src/cli.ts`, `apps/cli/test/init.test.ts`, `apps/cli/test/fixtures/web-runtime-ready.mjs`, `apps/cli/test/fixtures/web-runtime-start-error.mjs`, `apps/web/src/runtime-process.ts`, `apps/web/test/runtime-process.test.ts`.
- [x] Implement managed `cloudflared`/`ngrok` process lifecycle and automatic URL discovery (remove manual `ORQIS_*_PUBLIC_URL` requirement)
  - Summary: Replaced static env-only tunnel adapters with managed `cloudflared`/`ngrok` process launch/stop flows, automatic public URL discovery, clear missing-binary diagnostics, and deterministic fallback coverage.
  - Changed: `packages/tunnel/src/index.ts`, `packages/tunnel/test/scaffold.test.ts`, `apps/cli/test/init.test.ts`, `README.md`, `TODO.md`.
- [x] Tighten ngrok public URL discovery to fail when API tunnels do not target the requested local runtime address (avoid falling back to unrelated tunnels)
  - Summary: Restricted ngrok API URL selection to tunnels whose `config.addr` matches the requested local runtime target, eliminating fallback to mismatched API tunnels.
  - Changed: `packages/tunnel/src/index.ts`, `packages/tunnel/test/scaffold.test.ts`, `TODO.md`.

Safe to defer while Phase 2 starts:
- [x] Fix `orqis init` config schema-version mismatch for reruns against existing `schemaVersion: 2` configs
  - Summary: Bumped default supported config schema to v2 with an explicit built-in `1 -> 2` migration path, added rerun migration coverage, and documented local non-global CLI usage via `pnpm orqis:init`.
  - Changed: `apps/cli/src/config.ts`, `apps/cli/test/init.test.ts`, `package.json`, `README.md`, `TODO.md`.
- [x] Fix Cloudflare tunnel public URL discovery to ignore disclaimer/documentation links
  - Summary: Tightened Cloudflare URL extraction to accept only tunnel hostnames (`*.trycloudflare.com` / `*.cfargotunnel.com`) and added regression coverage for the disclaimer-output ordering that previously produced non-tunnel URLs.
  - Changed: `packages/tunnel/src/index.ts`, `packages/tunnel/test/scaffold.test.ts`, `TODO.md`.
- [ ] Add ngrok tunnel-discovery regression coverage for valid local-host aliases (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) so strict target matching does not reject equivalent local runtime addresses
- [ ] Tighten `orqis init --health-timeout-ms` validation to reject non-numeric suffix input (for example `10abc`)
- [ ] Add CLI regression coverage that asserts `--health-timeout-ms` rejects non-numeric suffix input (for example `10abc`)
- [ ] Add signal-shutdown test coverage for `waitForRuntimeShutdown` (listener cleanup and runtime stop invocation)
- [ ] Harden the `orqis init` smoke test against reserved-port race conditions (avoid probe-release-then-bind assumptions)
- [ ] Add an integration test that runs the real `apps/web/src/runtime-process.ts` entrypoint and asserts IPC ready/start-error messages plus graceful shutdown on parent disconnect
- [ ] Add tunnel stop lifecycle regression coverage for the race where a child process exits between `hasExited` checks and stop-listener attachment

## Phase 2: Projects and persistent workspaces

- [x] Create project/workspace schema and migrations
  - Acceptance criteria: schema includes projects, workspaces, messages, tasks, approvals, runs, and audit events.
  - Acceptance criteria: tasks support explicit state + lock ownership metadata (run-linked checkout/execution correlation fields) and parent-task lineage.
  - Acceptance criteria: approvals persist lifecycle + decision metadata (`pending`, `approved`, `rejected`, `revision_requested`, `resubmitted`).
  - Acceptance criteria: audit events are append-only with actor/entity/run correlation fields and indexed timeline queries.
  - Summary: Added first-pass Drizzle table contracts plus an initial SQL migration for projects, workspaces, messages, tasks, approvals, runs, and append-only audit events with timeline indexes.
  - Summary (follow-up): Added migration-contract tests that validate lifecycle/lock fields, approval statuses, correlation indexes, and audit append-only triggers.
  - Changed: `packages/db/src/schema.ts`, `packages/db/migrations/0001_project_workspace_schema.sql`, `packages/db/src/migrations.ts`, `packages/db/src/index.ts`, `packages/db/test/migrations.test.ts`, `packages/db/test/scaffold.test.ts`, `packages/db/package.json`, `pnpm-lock.yaml`, `TODO.md`.

- [x] Build project creation flow in UI
  - Acceptance criteria: user can create/list/select projects and each project resolves to one persistent workspace.
  - Summary: Added persisted project create/list APIs plus a project-first timeline UI flow that supports creating projects, selecting active projects, and posting timeline messages through the mapped workspace.
  - Changed: `apps/web/src/index.ts`, `apps/web/src/persistence.ts`, `apps/web/test/runtime.test.ts`, `apps/web/test/timeline-persistence.test.ts`, `TODO.md`.

- [x] Build workspace group chat timeline with persistence
  - Acceptance criteria: messages survive restarts and reload in chronological order per workspace.
  - Summary: Added a persistent SQLite-backed workspace timeline store with migration bootstrap, chronological per-workspace message queries, and append APIs in the web runtime.
  - Summary (follow-up): Replaced the landing scaffold with a minimal timeline UI that can post/reload messages through the new workspace timeline endpoints.
  - Changed: `apps/web/src/index.ts`, `apps/web/src/persistence.ts`, `apps/web/src/node-sqlite.d.ts`, `apps/web/test/runtime.test.ts`, `apps/web/test/timeline-persistence.test.ts`, `TODO.md`.

- [x] Redesign workspace UI shell into a Discord-style double-sidebar layout
  - Acceptance criteria: left icon-only project rail supports selecting existing projects and quick project creation.
  - Acceptance criteria: project-scoped workspace navigation sidebar includes `Main Chat`, `Files`, `Agent Threads`, and `Assigned Agents`, with role-based thread entries under `Agent Threads` (`PM -> Frontend Agent`, `PM -> Backend Agent`, `PM -> Reviewer`).
  - Acceptance criteria: main panel renders the selected section/thread, keeps the timeline as the visual focus for chat/thread views, and shows a fixed bottom composer for chat/thread views.
  - Acceptance criteria: existing project list/create/select and workspace message persistence flows remain functional after the shell redesign.
  - Summary: Replaced the single-card timeline page with a Discord-style double-sidebar workspace shell featuring an icon-only project rail, project-scoped navigation channels, role-based agent thread entries, section/thread-aware main panel rendering, and a fixed bottom composer for timeline views.
  - Summary (follow-up): Preserved the existing project list/create/select plus workspace timeline persistence API flows and added landing-page runtime assertions for the new shell navigation labels.
  - Changed: `apps/web/src/index.ts`, `apps/web/test/runtime.test.ts`, `TODO.md`.

- [x] Add basic local session auth
  - Acceptance criteria: protected routes require login and session persistence works across refresh.
  - Summary: Added local browser-session auth with a dedicated sign-in page, `HttpOnly` session cookies, protected web/API routes, and logout support in the workspace shell.
  - Summary (follow-up): Added runtime regression coverage for unauthenticated route protection, login/session creation, refresh persistence with the same cookie, and authenticated project/timeline API flows.
  - Changed: `apps/web/src/index.ts`, `apps/web/test/runtime.test.ts`, `README.md`, `TODO.md`.

- [ ] Add specialist-agent adapter registry contract in core/runtime boundaries
  - Acceptance criteria: adapter type registry supports execution + environment validation hooks and rejects unknown adapter types for task execution.

#### Additional fixes discovered during Phase 2

- [x] Fix migration-level workflow integrity gaps from schema review
  - Summary: Enforced `project_id`/`workspace_id` pair integrity in `runs`, `messages`, `tasks`, `approvals`, and `audit_events` via composite foreign keys.
  - Summary (follow-up): Removed mutable-entity foreign keys from `audit_events` (`run_id`, `task_id`, `approval_id`) so append-only triggers no longer conflict with parent-row cleanup.
  - Summary (follow-up): Added executable in-memory migration behavior tests for cross-project mismatch rejection and append-only audit-event enforcement during parent cleanup.
  - Changed: `packages/db/src/schema.ts`, `packages/db/migrations/0001_project_workspace_schema.sql`, `packages/db/test/migrations.test.ts`, `packages/db/package.json`, `pnpm-lock.yaml`, `TODO.md`.

- [x] Enforce same-project/workspace linked reference invariants for `run_id`/`task_id`
  - Summary: Added migration-level validation triggers that reject `messages`, `tasks`, and `approvals` inserts/updates when linked `run_id`/`task_id` values point to a different project/workspace.
  - Summary (follow-up): Added executable regression coverage for cross-workspace `run_id`, `checkout_run_id`, `execution_run_id`, `task_id`, and `approvals.run_id` mismatches.
  - Changed: `packages/db/migrations/0001_project_workspace_schema.sql`, `packages/db/src/schema.ts`, `packages/db/test/migrations.test.ts`, `TODO.md`.

- [x] Guard run/task ownership-key updates from orphaning linked workspace references
  - Summary: Added migration-level update guards that block `runs.project_id/workspace_id` and `tasks.project_id/workspace_id` changes when linked `messages`, `tasks`, or `approvals` rows would be left with mismatched project/workspace ownership.
  - Summary (follow-up): Added executable regression coverage for orphaning update attempts on runs and tasks.
  - Changed: `packages/db/migrations/0001_project_workspace_schema.sql`, `packages/db/test/migrations.test.ts`, `TODO.md`.

- [x] Enforce same-project/workspace parent lineage invariants for `parent_task_id` and `parent_message_id`
  - Summary: Added composite self-reference constraints for `messages` and `tasks` so parent-thread lineage cannot cross project/workspace boundaries.
  - Summary (follow-up): Kept parent-delete nulling semantics while adding regression coverage for cross-project parent-link rejection.
  - Changed: `packages/db/src/schema.ts`, `packages/db/migrations/0001_project_workspace_schema.sql`, `packages/db/test/migrations.test.ts`, `TODO.md`.

- [x] Restore web timeline persistence compatibility with Node 20 baseline
  - Summary: Replaced runtime usage of `node:sqlite` with `better-sqlite3` so workspace timeline persistence runs on the existing Node 20 engine/CI baseline without changing version requirements.
  - Summary (follow-up): Added `sqlite:doctor`/`sqlite:bootstrap` recovery scripts, startup preflight validation, and concise README recovery steps for missing native bindings.
  - Changed: `apps/web/src/persistence.ts`, `apps/web/src/node-sqlite.d.ts` (removed), `apps/web/scripts/sqlite-doctor.mjs`, `apps/web/scripts/sqlite-bootstrap.mjs`, `apps/web/package.json`, `package.json`, `README.md`, `pnpm-lock.yaml`, `TODO.md`.

- [x] Fix dedicated runtime-process persistence path and startup timeout regressions
  - Summary: Propagated the resolved `--config-dir` into dedicated runtime-process startup so SQLite defaults stay scoped to the active Orqis config directory instead of falling back to `~/.orqis`.
  - Summary (follow-up): Aligned dedicated runtime-process readiness timeout with the effective `--health-timeout-ms` and raised the default timeout window to absorb first-run SQLite migration startup cost.
  - Summary (follow-up): Added regression fixtures/tests for config-dir propagation and runtime-process delayed-ready timeout behavior, then widened web runtime/persistence test timeouts to reduce false failures under worker contention.
  - Changed: `apps/cli/src/cli.ts`, `apps/cli/test/init.test.ts`, `apps/cli/test/fixtures/web-runtime-ready-requires-config-dir.mjs`, `apps/cli/test/fixtures/web-runtime-delayed-ready.mjs`, `apps/web/test/runtime.test.ts`, `apps/web/test/timeline-persistence.test.ts`, `README.md`, `TODO.md`.

- [x] Fix workspace smoke CI failures from skipped native dependency build scripts
  - Summary: Configured pnpm workspace install policy to allow required build scripts for `better-sqlite3` and `esbuild`, matching the web runtime/test dependency requirements on GitHub Actions.
  - Changed: `package.json`, `TODO.md`.

#### Hardening before Phase 3

Must finish before Phase 3:
- [ ] Enforce task claim/ownership invariants at service level (single active execution lock per task and deterministic conflict errors)
- [ ] Add regression tests proving guarded task/run transitions are blocked until required approvals are resolved
- [ ] Add regression tests proving all task/approval/run mutations emit audit events with actor and run correlation metadata

Unclassified:
- [ ] Add migration regression coverage for `messages`/`tasks`/`approvals` update-path guards so same-project/workspace linked ref triggers are verified on updates, not only inserts
- [ ] Add migration regression coverage proving `parent_task_id` and `parent_message_id` are nulled on parent delete after composite lineage constraints
- [ ] Add web-runtime API regression coverage for `GET/POST /api/workspaces/:workspaceId/messages` (validation errors, project/workspace conflict responses, and chronological payload ordering)
- [ ] Add web-runtime auth regression coverage for session lifecycle edges (`DELETE /api/session` cookie clearing, authenticated `GET /login` redirect, and unauthorized `GET/POST /api/workspaces/:workspaceId/messages`)
- [ ] Harden local session cookie/auth response headers for tunnel exposure (`Secure` cookie behavior when request origin is HTTPS and `Cache-Control: no-store` on auth-sensitive HTML/API responses)
- [ ] Harden web-runtime shutdown to close keep-alive connections promptly so `runtime.stop()` does not block for multi-second idle timeouts after request traffic
- [ ] Persist selected project, section, and thread in URL/local state so refresh restores workspace context
- [ ] Add keyboard/a11y navigation coverage for project rail and workspace channel list (focus order, `aria-current`, and section/thread activation)
- [ ] Add responsive sidebar-collapse behavior and regression coverage so the fixed composer does not obscure timeline content on narrow viewports
- [ ] Add browser regression coverage for workspace-shell script initialization and quick-project popover visibility (prevent parse-time JS failures and clipped rail popover interactions)

Move to later phase:
- [ ] Add query helpers for issue/task-centric run history so timeline and run drill-down share one contract (Phase 4 timeline/read-model hardening)

## Phase 3: Project Manager planning and task approvals

- [ ] Implement Project Manager planner service (`goal -> plan -> task list`)
  - Acceptance criteria: planner persists plan and emits visible plan message in workspace chat.

- [ ] Implement task assignment records and specialist role mapping
  - Acceptance criteria: each task has owner role, state, run linkage, and timestamps.
  - Acceptance criteria: assignment + checkout flow is lock-safe and rejects competing ownership attempts deterministically.

- [ ] Implement user approval/reject loop for task outputs
  - Acceptance criteria: user action updates approval status, audit event is written, and PM receives the decision.
  - Acceptance criteria: flow supports revision request and agent resubmission without losing prior decision history.
  - Acceptance criteria: PM cannot advance guarded tasks/runs while related approvals are unresolved.

- [ ] Add first run lifecycle states (`planned`, `running`, `waiting_approval`, `done`, `failed`)
  - Acceptance criteria: run state transitions are validated and invalid transitions are rejected.

## Phase 4: Workflow hardening and integration

- [ ] Add implementation/review/integration workflow commands in PM logic
  - Acceptance criteria: PM can route tasks into phase-specific workflows and post explicit status updates.

- [ ] Add audit timeline view
  - Acceptance criteria: key actions (task create/assign, approval, run status changes) are traceable in UI.
  - Acceptance criteria: timeline supports filtering by actor, entity, and run/task correlation.

- [ ] Add browser e2e checks for bootstrap + project + workspace + approval happy path
  - Acceptance criteria: Playwright suite covers one full user journey and runs in CI.

## Later: Parallel execution and repository workflows

- [ ] Introduce dispatcher interface with serial and parallel backends
  - Acceptance criteria: parallel backend can execute independent tasks concurrently behind a feature flag.

- [ ] Add repository/GitHub integration primitives
  - Acceptance criteria: project can store repo metadata and link run/task artifacts to commits or PRs.

- [ ] Expand adapter integrations for additional external specialist runtimes
  - Acceptance criteria: new adapters conform to the same typed execution/environment contract and do not bypass approval/audit guarantees.
