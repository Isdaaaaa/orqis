# MVP Scope

## MVP objective

Deliver a usable local-first Orqis experience where users can start the platform from CLI, access it via a tunnel URL, create projects, collaborate in persistent project workspaces, and run a first Project Manager planning and approval loop.

## In scope (MVP)

- CLI-first startup via `orqis init`.
- Local runtime boot and tunnel URL handoff.
- Basic auth/session handling.
- Provider/model/agent configuration in web UI.
- Multi-project creation and management.
- One persistent workspace/group chat per project.
- Persistent storage for projects, messages, tasks, approvals, runs, and settings.
- First Project Manager planning flow (`goal -> plan -> tasks`).
- First task assignment and user approval loop.
- Visibility of planning, assignment, progress, and approvals in shared chat/workspace timeline.
- Audit trail for key actions.

## Explicitly out of scope (MVP)

- Full autonomous coding with repository mutation and PR automation.
- Advanced multi-user permissions and team RBAC.
- Distributed agent workers and high-scale queue infra.
- Deep IDE integrations and desktop app packaging.
- Production cloud hosting productization.
- Rich plugin ecosystem.
- Complex billing/metering features.

## MVP quality bar

- Core flows are reliable across restarts.
- Key actions are traceable with actor and timestamp metadata.
- System favors deterministic transitions over opaque agent behavior.
- Errors are surfaced with actionable remediation in CLI or UI.

## MVP success criteria

MVP is considered usable when all criteria below are true:

1. User can run `orqis init` and receive a working public URL.
2. User can sign in and configure at least one provider/model and at least two agent roles.
3. User can create at least two projects, each with isolated persistent workspace history.
4. User can request work in a workspace and get a PM-generated plan with task records.
5. User can approve or reject task outputs and see follow-up behavior change.
6. User can inspect an audit timeline of key workflow actions.
7. Restarting Orqis preserves projects, workspace history, tasks, approvals, and run state.
