# cli-runtime

## Purpose

Apply this overlay when the task affects CLI behavior, local runtime startup, config bootstrap, child processes, health checks, or tunnel integration.

## Priorities

- Make command behavior truthful and explicit
- Preserve idempotency on reruns
- Prefer clear startup/shutdown flow
- Report real status, not assumed success
- Keep local developer experience predictable
- Fail clearly when dependencies are missing

## Checks before finishing

- Is output truthful?
- Does rerunning the command behave safely?
- Are config versioning and compatibility handled correctly?
- Are health and tunnel states only reported as successful when they truly are?
- Are errors actionable?

## Common mistakes to avoid

- Placeholder success states
- Fake URLs or fake readiness
- Config version mismatch
- Hidden environment assumptions
- Silent degradation without explanation
