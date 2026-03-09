# AGENTS.md

## Purpose

This repository uses a phase-command workflow so the user can issue short commands instead of rewriting long prompts.

Supported phase commands:

- `bootstrap: [project description]`
- `roadmap-init`
- `roadmap-next`
- `narrow: [area]`
- `plan: [feature or system change]`
- `implement: [task]`
- `review: [branch, PR, or task]`
- `integrate: [milestone, branches, or completed tasks]`

When a phase command is used:

1. Read this file first
2. Read the matching file in `prompts/`
3. Read the relevant project files and source files
4. Perform only the work for that phase unless the user explicitly asks for more

## Phase routing

- `bootstrap:` -> `prompts/bootstrap.md`
- `roadmap-init` -> `prompts/roadmap-init.md`
- `roadmap-next` -> `prompts/roadmap-next.md`
- `narrow:` -> `prompts/narrow.md`
- `plan:` -> `prompts/plan.md`
- `implement:` -> `prompts/implement.md`
- `review:` -> `prompts/review.md`
- `integrate:` -> `prompts/integrate.md`

## Required reading order

Before acting, read these when they exist and are relevant:

1. `AGENTS.md`
2. the phase file in `prompts/`
3. `TODO.md`
4. `DECISIONS.md`
5. `README.md`
6. relevant files in `docs/`
7. relevant source files for the task

If a file does not exist yet, proceed without it and create or update it only if the current phase allows that.

## File creation and editing permissions

### Phases that may create and edit files

- `bootstrap`
- `implement`
- `integrate`

### Phases that may update planning/docs files but should not implement product code unless explicitly asked

- `roadmap-init`
- `roadmap-next`
- `narrow`
- `plan`

### Phases that should not edit code unless explicitly asked

- `review`

The `review` phase may update planning files when needed, especially:

- `TODO.md` for non-blocking follow-up items
- optionally `DECISIONS.md` if the user explicitly asks for review-driven decision notes

The review phase must not change source code, tests, or runtime configs unless explicitly asked.

## Git workflow

- Never work directly on `main`
- For `bootstrap`, `implement`, and `integrate`, create a task-scoped branch if one is not already active
- Use a clear branch name based on the task
- Make focused commits with clear messages
- If GitHub access is available, open or update a PR
- If PR creation is not available, prepare:
  - branch name
  - commit summary
  - PR title
  - PR body
- Do not merge unless the user explicitly asks

## Global workflow rules

- Keep changes tightly scoped to the requested task
- Avoid unrelated refactors
- Prefer the simplest correct implementation
- Preserve future extensibility without overengineering
- Preserve existing architecture unless a change is clearly justified
- If architecture changes, update `DECISIONS.md`
- If setup, usage, or developer workflow changes, update `README.md`
- If a task is completed, update `TODO.md`
- Under completed TODO items, add a short nested summary of what changed
- Add or update tests when appropriate
- For UI behavior changes, validate with the default browser-testing approach when appropriate
- If a task is too small and obvious, implementation may proceed without a deeper planning pass
- If a task affects schema, orchestration, approvals, auth, CLI lifecycle, shared architecture, or a critical user flow, prefer using `plan:` first

## Bootstrap behavior

The starter kit may contain only:

- `AGENTS.md`
- `prompts/*`

The `bootstrap` phase is responsible for creating project-specific files if they are missing, including:

- `README.md`
- `TODO.md`
- `DECISIONS.md`
- `docs/architecture.md`
- `docs/roadmap.md`
- `docs/mvp-scope.md`

If these files already exist, bootstrap should update them carefully instead of blindly overwriting them.

## MCP routing defaults

Use only the tools relevant to the current phase and task.

### bootstrap

Default:

- `filesystem`
- `sequential-thinking`

Use when needed:

- `context7` for framework/library research
- `github` for repo, branch, and PR operations

### roadmap-init / roadmap-next / narrow / plan

Default:

- `filesystem`
- `sequential-thinking`

Use when needed:

- `context7` for technical research
- `github` for repo history, branch, or PR context

### implement — UI tasks

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

### implement — backend, API, orchestration, tasks, approvals, CLI, auth

Default:

- `filesystem`
- `github`
- `context7`

Use when needed:

- `sequential-thinking` if logic is complex
- `laravel-boost` only if the project stack is Laravel

### implement — mixed full-stack tasks

Default:

- `filesystem`
- `github`
- `context7`

Use when needed:

- the project’s chosen UI MCP
- `playwright`
- `sequential-thinking`

### review

Default:

- `github`
- `filesystem`
- `sequential-thinking`

Use when needed:

- `playwright` if UI or browser behavior changed

### integrate

Default:

- `github`
- `filesystem`
- `sequential-thinking`

### memory

Use only for durable project preferences or long-lived workflow preferences, not temporary task state.

## Output expectations by phase

### bootstrap

- create missing core project docs
- choose defaults
- define MVP direction
- define first implementation target

### roadmap-init

- define phases, milestones, MVP, dependencies, and first focus

### roadmap-next

- choose the best next task
- explain why
- update TODO if needed

### narrow

- choose one concrete task from a broader area
- define acceptance criteria
- decide whether a deeper planning pass is needed

### plan

- define scope
- define non-scope
- define acceptance criteria
- identify affected areas
- identify risks
- decide branch name

### implement

- create branch
- implement the change
- add or update tests when appropriate
- validate behavior when appropriate
- update docs/TODO if needed
- commit focused changes
- open or prepare a PR

### review

- inspect branch or diff
- prioritize correctness, missing tests, architecture drift, real risks, and scope creep
- approve or reject
- classify every finding into blocking now vs non-blocking follow-up
- reject only if blocking issues exist
- if non-blocking follow-up items exist, add them directly to `TODO.md` under the current phase in `Hardening before next phase`
- if rejected, identify the smallest blocking fix set only

### integrate

- inspect compatibility across completed work
- identify conflicts, hidden coupling, and merge order
- apply integration fixes if requested
- update docs/TODO/decisions if needed
- open or prepare a PR

## Definition of done

A task is done when:

- the requested change is implemented or the requested planning/review output is complete
- the work is scoped and coherent
- tests were added or updated when appropriate
- relevant docs were updated when needed
- TODO was updated if the task is complete
- a task branch exists for implementation/integration work
- commits are focused and clear
- a PR is opened if possible, otherwise a PR draft is prepared
- the final response includes, when relevant:
  - branch name
  - summary of changes
  - changed files
  - tests added or updated
  - validation performed
  - PR status
  - follow-up risks or next steps

## Fallback behavior

- If a phase file is missing, say so and proceed with the closest sensible default for that phase
- If a project doc is missing and the current phase is allowed to create it, create it
- If the user’s request is ambiguous, make the smallest reasonable assumption and state it
- If the task is blocked by missing architecture decisions, prefer `plan:` or `roadmap-next` before implementation
