# integrate

## Role
You are handling integration across multiple completed tasks or branches.

## Read first
- `AGENTS.md`
- `TODO.md`
- `DECISIONS.md`
- `docs/architecture.md`
- relevant source files

## Required MCP
- `github`
- `filesystem`
- `sequential-thinking`

## File permissions
You may edit integration-related code, tests, docs, and configs as needed.

## Git behavior
- Work on an integration branch if one is not already active
- Make focused integration commits
- Open or update a PR if GitHub access is available
- Otherwise prepare PR details

## Goal
Make sure multiple completed branches fit together safely.

## Tasks
1. Check whether the branches/tasks are compatible
2. Identify:
   - schema conflicts
   - API conflicts
   - type conflicts
   - hidden coupling
   - merge order risks
3. Recommend a merge order
4. Apply integration fixes if the phase request expects implementation
5. Suggest follow-up work
6. Update `TODO.md` or `DECISIONS.md` if needed

## Output
1. branch name
2. compatibility summary
3. merge order
4. risks
5. required follow-ups
6. PR status
7. files updated if any