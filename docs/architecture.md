# Orqis Architecture (MVP Baseline)

## Intent

Define a deterministic, auditable multi-agent system where chat is the main UX but structured state is the source of truth.

## System parts

## 1) CLI bootstrap (`apps/cli`)

Responsibilities:

- `orqis init` command entrypoint.
- Local config bootstrap and validation.
- Start/monitor web runtime lifecycle.
- Start/monitor tunnel provider via adapter interface.
- Print local/public URLs and runtime status.

Key boundary:

- CLI does not own project/task business logic. It only boots, monitors, and reports runtime state.
- The scaffold web runtime now runs in a dedicated child process so CLI orchestration and tunnel lifecycle management can evolve independently.

## 2) Web control center (`apps/web`)

Responsibilities:

- Auth/session management.
- Project list/create/manage views.
- Workspace/group chat UI per project.
- Provider/model/agent configuration UI.
- Task/approval and run status views.

Key boundary:

- UI reads/writes through application services; domain rules live in shared core modules.

## 3) Domain and orchestration core (`packages/core`)

Responsibilities:

- Project Manager workflow logic.
- Role-based task assignment logic.
- Approval state transitions.
- Run lifecycle state machine.
- Audit event generation.

Key boundary:

- Core does not depend on UI framework details.

## 4) Persistence layer (`packages/db`)

Responsibilities:

- Drizzle schema and migrations.
- Repository-style data access for projects, workspaces, messages, tasks, approvals, runs, and settings.
- Transaction boundaries for important multi-entity updates.

Key boundary:

- Database schema is the durable truth for operational state.

## 5) Tunnel abstraction (`packages/tunnel`)

Responsibilities:

- Provider-neutral tunnel interface (`start`, `stop`, `status`).
- Cloudflare adapter (primary), ngrok adapter (fallback).
- Standardized tunnel metadata returned to CLI/web.

Key boundary:

- No business/domain rules in tunnel package.

## Core entities (structured state)

- `users`
- `sessions`
- `projects`
- `workspaces` (1:1 with projects for MVP)
- `messages`
- `agent_profiles`
- `tasks`
- `task_assignments`
- `approvals`
- `runs`
- `run_steps`
- `provider_configs`
- `model_configs`
- `audit_events`

## Critical flows

## Flow A: Bootstrap and access

1. User runs `orqis init`.
2. CLI initializes config and starts web runtime.
3. CLI starts tunnel adapter and validates public URL.
4. CLI returns URLs and status.
5. User opens control center from any device.

## Flow B: Project request to planned tasks

1. User posts a request in project workspace chat.
2. PM agent creates a run and planning steps.
3. PM persists plan and task records.
4. PM posts planning summary to workspace chat.

## Flow C: Task output and user approval

1. Specialist agent submits task output artifact.
2. System marks task `waiting_approval`.
3. User approves/rejects in UI.
4. Approval decision persists and emits audit event.
5. PM agent continues or replans based on decision.

## Determinism and auditability rules

- All important workflow transitions write explicit state and audit records.
- Chat messages are UX artifacts, not sole workflow truth.
- Invalid lifecycle transitions are rejected by core state machines.
- Every run/task/approval mutation has actor metadata (`user`, `agent`, or `system`).

## Expansion points

- Parallel task execution backend behind dispatcher abstraction.
- Repository/GitHub integrations for branch/PR-aware workflows.
- Richer approval gates (per-task, per-phase, policy-based).
- Multi-user collaboration model for small teams.
