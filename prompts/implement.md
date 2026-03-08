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
Choose the right tool set for the task:

### for UI tasks
Use:
- `filesystem`
- `github`
- `context7`
- `shadcn` if the repo uses shadcn
- `heroui-react` if the repo uses HeroUI
- `playwright` for browser validation

### for backend/API/orchestration/tasks
Use:
- `filesystem`
- `github`
- `context7`
- `sequential-thinking` if logic is complex
- `laravel-boost` only if the project stack is Laravel

### for mixed full-stack tasks
Use:
- `filesystem`
- `github`
- `context7`
- the repo’s default UI MCP
- `playwright`
- `sequential-thinking` if the flow is complex

## File permissions
You may create and edit code, tests, configs, and docs needed for the task.

## Git behavior
- Create a task-scoped branch if not already on one
- Make focused commits
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
8. Update `README.md` or `DECISIONS.md` only if needed

## Rules
- Keep the change tightly scoped
- Avoid unrelated refactors
- Prefer the simplest correct implementation
- Preserve future extensibility without overengineering
- If the task touches schema, orchestration, approvals, auth, CLI lifecycle, or shared architecture, be extra careful and stay aligned with the architecture docs

## Output
1. branch name
2. summary of changes
3. changed files
4. tests added or updated
5. validation performed
6. PR status
7. follow-up risks or next steps