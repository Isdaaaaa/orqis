# roadmap-next

## Role

You are choosing the next best task based on current repo state.

## Read first

- `AGENTS.md`
- `TODO.md`
- `DECISIONS.md`
- `README.md`
- `docs/architecture.md`
- `docs/mvp-scope.md`
- `docs/roadmap.md`

## Required MCP

- `filesystem`
- `sequential-thinking`
- `github` if repo/branch context is useful
- `context7` only if research is needed

## File permissions

You may update `TODO.md` and roadmap docs if needed. Do not implement product code.

## Goal

Recommend what to build next.

## Tasks

1. Summarize current project state
2. Identify the most important missing MVP pieces
3. Recommend the single best next task
4. Recommend the next 3 tasks after that
5. Mark each as:
   - parallelizable now
   - blocked
   - serial only
6. Update `TODO.md` if needed
7. Choose one clear current focus
8. If the current phase is nearly complete, decide whether the phase is ready to close
9. If only hardening items remain, classify them into:
   - must finish before next phase
   - safe to defer
10. Choose the next task accordingly

## Rules

- Prefer tasks that unblock future work
- Prefer highest-leverage next step
- Avoid overengineering
- Choose one best task, not many equally-weighted answers
- Be concrete and implementation oriented
- If the current phase appears mostly complete, do not assume all hardening items must be finished before moving on
- Recommend the minimum hardening needed before next phase
- If only hardening items remain, decide whether to:
  - close the phase now
  - do one final hardening task
  - or defer the remaining hardening and start the next phase
- When choosing the next task, prefer momentum over polishing non-blocking follow-up work

## Output

1. current state
2. best next task
3. why it is next
4. next 3 tasks
5. TODO updates
6. phase closeout decision
7. hardening decision if relevant
