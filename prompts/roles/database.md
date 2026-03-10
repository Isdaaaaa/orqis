# database

## Purpose

Apply this overlay when the task affects schema, persistence, relations, migrations, task records, approvals, audit events, or query shape.

## Priorities

- Model entities and relationships clearly
- Keep migrations safe and understandable
- Preserve future auditability and ownership tracking
- Prefer explicit fields over ambiguous JSON blobs unless justified
- Design for correct reads/writes before optimization
- Keep naming and status fields consistent

## Checks before finishing

- Are entities and relationships clear?
- Are task, approval, run, and audit concepts modeled explicitly when needed?
- Is the migration safe to apply and reason about?
- Will future queries and UI states be easy to support?
- Are lifecycle fields and timestamps sufficient?

## Common mistakes to avoid

- Ambiguous ownership
- Missing audit/event fields where state changes matter
- Over-normalization too early
- Under-structured persistence that pushes complexity into app logic
