# backend

## Purpose

Apply this overlay when the task mainly affects business logic, services, APIs, orchestration, approvals, or state transitions.

## Priorities

- Keep contracts explicit and stable
- Make state transitions clear and enforceable
- Prefer deterministic, testable logic
- Handle failure paths and invalid states explicitly
- Preserve architecture and avoid accidental scope expansion
- Keep the surface area of change small

## Checks before finishing

- Are all state transitions valid and enforced?
- Are failure cases handled clearly?
- Is the logic understandable without relying on chat history?
- Are approvals, ownership, and status changes explicit where needed?
- Did this avoid unnecessary UI churn?

## Common mistakes to avoid

- Hidden state transitions
- Truthy-looking but unenforced rules
- Weak error handling
- Mixing architecture changes into a narrow task
