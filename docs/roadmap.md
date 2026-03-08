# Roadmap

## Build strategy

- Prioritize a fast path to a usable MVP.
- Keep architecture simple but explicit about future parallelism.
- Finish one vertical slice at a time so every phase leaves a testable outcome.

## Phase 1: Bootstrap spine

Goal:

- Make `orqis init` reliable and observable.

Deliverables:

- Workspace/package scaffold.
- CLI init command.
- Web runtime launch from CLI.
- Tunnel adapter abstraction and one working provider.
- Bootstrap smoke tests.

Dependency notes:

- Blocks all browser-driven product validation until complete.

Parallelization opportunities:

- CLI config work and tunnel adapter work can proceed in parallel after workspace scaffold.

## Phase 2: Projects and persistent workspaces

Goal:

- Establish durable project and chat foundation.

Deliverables:

- Persistence schema and migrations.
- Project CRUD and project picker UI.
- Per-project workspace timeline with message persistence.
- Basic auth/session flow.

Dependency notes:

- Depends on Phase 1 runtime availability.
- Unblocks PM orchestration in real project contexts.

Parallelization opportunities:

- UI project views and DB schema work can run in parallel with clear contracts.

## Phase 3: PM planning and approvals

Goal:

- Deliver first collaborative orchestration loop.

Deliverables:

- PM planner (`goal -> plan -> tasks`).
- Task assignment with role mapping.
- Task output submission model.
- Approval/reject flow and run state transitions.
- Audit event coverage for all key transitions.

Dependency notes:

- Requires persistent projects/workspaces from Phase 2.

Parallelization opportunities:

- PM planner logic and approval UI can progress in parallel after core state contracts are fixed.

## Phase 4: Workflow hardening

Goal:

- Stabilize end-to-end software-building phases.

Deliverables:

- Planning, implementation, review, and integration workflow states.
- Strong validation and error handling around transitions.
- Browser e2e coverage for critical path.

Dependency notes:

- Depends on Phase 3 run/task/approval model.

Parallelization opportunities:

- Workflow UX improvements and e2e test coverage can run in parallel.

## Post-MVP: Parallel and repo-aware execution

Goal:

- Increase throughput and repository depth.

Deliverables:

- Parallel task dispatcher backend.
- Git/repo integration primitives.
- Richer approvals and policy gating.
- Multi-user collaboration improvements.

Dependency notes:

- Requires stable serial execution model and auditability first.

## Suggested build order checklist

1. Phase 1 bootstrap spine.
2. Phase 2 projects/workspaces.
3. Phase 3 PM planning and approvals.
4. Phase 4 workflow hardening.
5. Post-MVP parallel/repo depth.
