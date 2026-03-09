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

Default:

- `filesystem`
- `sequential-thinking`

Use when needed:

- `github` for repo/branch/PR context
- `context7` for technical research

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
9. If hardening items remain, inspect the current phase’s `Hardening before Phase X+1` section
10. Classify any items under `Unclassified` into:

- `Must finish before Phase X+1`
- `Safe to defer`
- `Move to later phase`

11. Choose the next task accordingly

## Rules

- Prefer tasks that unblock future work
- Prefer highest-leverage next step
- Avoid overengineering
- Choose one best task, not many equally-weighted answers
- Be concrete and implementation-oriented
- If the current phase appears mostly complete, do not assume all hardening items must be finished before moving on
- Recommend the minimum hardening needed before the next phase
- If only hardening items remain, decide whether to:
  - close the phase now
  - do one final hardening task
  - or defer the remaining hardening and start the next phase
- When choosing the next task, prefer momentum over polishing non-blocking follow-up work
- Follow the TODO classification rules in `AGENTS.md`
- `roadmap-next` is the main classifier for items in `Hardening before Phase X+1 > Unclassified`

## Output

1. current state
2. best next task
3. why it is next
4. next 3 tasks
5. TODO updates
6. phase closeout decision
7. hardening classification if relevant
