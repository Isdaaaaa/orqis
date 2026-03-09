# implement

## Role

You are implementing one scoped task.

## Read first

- `AGENTS.md`
- `TODO.md`
- `DECISIONS.md`
- relevant docs
- relevant source files

## Required MCP selection

Choose the right tool set for the task.

### UI tasks

Default:

- `filesystem`
- `github`
- `context7`

Use the repo’s chosen UI MCP:

- `shadcn` if the project uses shadcn
- `heroui-react` if the project uses HeroUI

Use when needed:

- `playwright` for browser validation
- `puppeteer` only if specifically needed instead of Playwright

### Backend, API, orchestration, tasks, approvals, CLI, auth

Default:

- `filesystem`
- `github`
- `context7`

Use when needed:

- `sequential-thinking` if logic is complex
- `laravel-boost` only if the project stack is Laravel

### Mixed full-stack tasks

Default:

- `filesystem`
- `github`
- `context7`

Use when needed:

- the project’s chosen UI MCP
- `playwright`
- `sequential-thinking`

## File permissions

You may create and edit code, tests, configs, and docs needed for the task.

## Git behavior

- Never work directly on `main`
- Create a task-scoped branch if not already on one
- Decide a clear branch name if the user did not provide one
- Make focused commits with clear messages
- Open or update a PR if GitHub access is available
- Otherwise prepare:
  - PR title
  - PR body
  - merge notes

## Goal

Implement the requested task cleanly and with minimal scope.

## Tasks

1. Understand the requested task
2. Decide an appropriate branch name if not provided
3. Implement the change
4. Add or update tests when appropriate
5. Validate behavior when appropriate
6. Update `TODO.md` if the task is completed
7. Add a short nested summary under the completed TODO item
8. If additional completed fixes are discovered during implementation that were not explicitly on the roadmap, record them under `Additional fixes discovered during Phase X`
9. If unfinished follow-up work is discovered, add it to `TODO.md` under `Hardening before Phase X+1 > Unclassified`
10. Update `README.md` or `DECISIONS.md` only if needed

## Rules

- Keep the change tightly scoped
- Avoid unrelated refactors
- Prefer the simplest correct implementation
- Preserve future extensibility without overengineering
- If the task touches schema, orchestration, approvals, auth, CLI lifecycle, or shared architecture, stay aligned with the architecture docs and existing decisions
- If the task is too large or ambiguous to implement safely, stop and recommend `plan:` first
- Do not automatically fix non-blocking follow-up items in the same slice unless the user explicitly asks
- Only blocking issues should prevent completion of the current slice
- Follow the TODO classification rules in `AGENTS.md`
- Do not place newly discovered follow-up work directly into:
  - `Must finish before Phase X+1`
  - `Safe to defer`
  - `Move to later phase`
    unless it was already classified by planning or roadmap triage

## Required issue classification

At the end, classify all remaining concerns into:

- **Blocking now**: must be fixed before merge because they break acceptance criteria, correctness, safety, or the current slice
- **Non-blocking follow-up**: safe to defer to a later slice or hardening pass

## TODO placement rule

When updating `TODO.md`, follow the structure from `AGENTS.md`.

Use:

- `Additional fixes discovered during Phase X` for extra fixes already completed during the slice
- `Hardening before Phase X+1 > Unclassified` for newly discovered unfinished follow-up work

Do not use a flat `Hardening before next phase` list.

## Output

1. branch name
2. summary of changes
3. changed files
4. tests added or updated
5. validation performed
6. blocking now
7. non-blocking follow-up
8. TODO updates made
9. PR status
10. follow-up risks or next steps
