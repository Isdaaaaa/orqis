# Roadmap

## Build strategy

- Prioritize a fast path to a usable MVP.
- Keep architecture simple but explicit about future parallelism.
- Finish one vertical slice at a time so every phase leaves a testable outcome.
- Keep scope anchored on software-project delivery (project/workspace chat + PM orchestration).

## Scope refinement (from Paperclip comparison)

Adopt now (Phase 2-4):

- Issue-style task records with explicit status and run-linked lock ownership.
- Enforced approval lifecycle for guarded workflow transitions (including revision/resubmission).
- Append-only audit event history with actor/run/entity metadata and filtered timeline views.
- Typed adapter registry boundary so local and external specialist agents share one execution contract.

Defer (after MVP unless needed sooner):

- Rich policy-driven approval matrices beyond core delivery gates.
- Broad adapter ecosystem expansion beyond initial local + pragmatic external adapters.

Explicitly avoid in current roadmap:

- Company-OS framing (org chart-first UX, executive-role modeling as primary surface).
- Budget governance and portfolio control features as delivery blockers for MVP.
- Multi-company control-plane concerns in Phase 2-4.

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

- Persistence schema and migrations, including:
  - task contract fields for status + ownership/lock metadata,
  - approval records with lifecycle + decision metadata,
  - append-only audit event tables and indexes for timeline queries.
- Project CRUD and project picker UI.
- Discord-style workspace shell with project rail + project-scoped navigation sidebar.
- Per-project workspace timeline with message persistence.
- Basic auth/session flow.

Dependency notes:

- Depends on Phase 1 runtime availability.
- Unblocks PM orchestration in real project contexts.
- Must establish state contracts before Phase 3 execution logic enforces them.

Parallelization opportunities:

- UI project views and DB schema work can run in parallel with clear contracts.

## Phase 3: PM planning and approvals

Goal:

- Deliver first collaborative orchestration loop.

Deliverables:

- PM planner (`goal -> plan -> tasks`).
- Task assignment with role mapping and lock-safe claim/release behavior.
- Task output submission model.
- Approval/reject flow plus `revision_requested` and `resubmitted` loops.
- Run/task transition guards that enforce approval state before guarded progress.
- Audit event coverage for all key transitions with run/task correlation.

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
- Audit timeline UX hardening (entity/run filters, readable transition trails).
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
- Expanded adapter integrations for additional external specialist runtimes.
- Multi-user collaboration improvements.

Dependency notes:

- Requires stable serial execution model and auditability first.

## Suggested build order checklist

1. Phase 1 bootstrap spine.
2. Phase 2 projects/workspaces.
3. Phase 3 PM planning and approvals.
4. Phase 4 workflow hardening.
5. Post-MVP parallel/repo depth.
