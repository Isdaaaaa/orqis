# plan

## Role

You are planning one feature before implementation.

## Read first

- `AGENTS.md`
- `TODO.md`
- `DECISIONS.md`
- relevant docs
- relevant source files if they exist

## Required MCP

Default:

- `filesystem`
- `sequential-thinking`

Use when needed:

- `context7` for framework/library docs
- `github` if current branch/history/PR context matters

## File permissions

You may update planning/docs files. Do not implement product code unless the user explicitly asks.

## Goal

Produce a concrete implementation plan for one feature that is ready for implementation and aware of likely hardening follow-up.

## Tasks

1. Infer requirements from the repo, roadmap, and current architecture
2. Make only the smallest reasonable assumptions and state them
3. Define:
   - scope
   - non-scope
   - affected modules/files
   - data model implications
   - API implications
   - CLI implications
   - UI implications
   - acceptance criteria
   - branch name
   - risks
4. Break the work into the smallest safe implementation slices when useful
5. Identify likely **non-blocking hardening follow-up** items that should probably exist after this feature is implemented
6. Suggest `TODO.md` updates if relevant

## Rules

- Prefer small, testable slices
- Avoid redesign unless necessary
- Preserve current architecture unless change is justified
- Be specific enough that implementation can proceed with minimal ambiguity
- Distinguish between:
  - core implementation work needed now
  - likely hardening work that can happen later
- Do not turn every future concern into immediate implementation scope

## Hardening follow-up planning rule

If you identify likely non-blocking hardening items:

- add them as actionable checklist items in `TODO.md`
- place them under the **current phase**
- use a subsection named `Hardening before next phase`
- place that subsection **before the next phase header**
- only include items that are realistic and relevant to the planned feature
- do not overload TODO with speculative future ideas

Example placement:

### Phase 1: Runtime and bootstrap path

- [ ] Current implementation task
- [ ] Another implementation task

#### Hardening before Phase 2

- [ ] Improve startup timeout diagnostics
- [ ] Add stronger smoke validation for bootstrap path

### Phase 2: Projects and persistent workspaces

## Risk classification rule

Classify risks into:

- **Blocking now**: must be addressed in the implementation of this feature
- **Non-blocking follow-up**: should be captured in TODO as hardening work before the next phase, but should not block implementation now

## Output

1. scope
2. non-scope
3. affected areas
4. acceptance criteria
5. suggested implementation slices if needed
6. branch name
7. blocking now
8. non-blocking follow-up
9. TODO updates made or recommended
10. recommended TODO placement
