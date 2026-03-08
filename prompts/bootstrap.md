# bootstrap

## Role
You are bootstrapping a brand-new repository into a usable project workspace.

## Read first
- `AGENTS.md`
- any existing repo files
- any existing files in `prompts/`

## Required MCP
Use these by default:
- `filesystem`
- `sequential-thinking`

Use these when needed:
- `context7` for framework/library research
- `github` for repo context, branch, and PR operations

## File permissions
You may create and edit project files, docs, configs, and folder structure needed for setup.

## Git behavior
- Never work directly on `main`
- If currently on `main`, create a bootstrap branch first
- Use a clear branch name, such as `chore/bootstrap-project-foundation`
- Make focused commits
- Open a PR if GitHub access is available
- If PR creation is not available, prepare:
  - PR title
  - PR body
  - commit summary

## Goal
Turn the user's project description into a clean, ready-to-build repository foundation.

## Primary tasks
1. Understand the project from the user's `bootstrap:` prompt
2. Propose the best stack, or the top 2 options if stack choice is still uncertain
3. Create missing core project files and directories
4. Fill them with project-specific content, not empty placeholders, when enough context exists
5. Choose the first implementation target
6. Initialize the active roadmap and checklist
7. Record key assumptions and architecture decisions

## Files bootstrap should create if missing
Create these if they do not exist:

- `README.md`
- `TODO.md`
- `DECISIONS.md`
- `docs/architecture.md`
- `docs/roadmap.md`
- `docs/mvp-scope.md`

Also create directories if needed:
- `docs/`

## Files bootstrap should update carefully if they already exist
If these files already exist, do not blindly overwrite them. Merge or refine them carefully:
- `README.md`
- `TODO.md`
- `DECISIONS.md`
- files in `docs/`

## What each file should contain

### `README.md`
Create a project-specific README that includes:
- project name
- short product overview
- main goals
- chosen or proposed stack
- development workflow summary
- key repo docs
- setup/run section if enough is known
- anything important for future contributors or agents

### `TODO.md`
Create a real checklist-based task board:
- `Current focus`
- MVP phases or milestones
- concrete implementation tasks
- acceptance criteria for important tasks
- completed-task format that supports nested summaries under checked items

### `DECISIONS.md`
Record the first major decisions:
- stack choice or candidate stack options
- architectural direction
- important tradeoffs
- unresolved questions if any remain

### `docs/architecture.md`
Document:
- main system parts
- major boundaries
- important flows
- where future features will plug in
- high-level architecture only

### `docs/roadmap.md`
Document:
- project phases
- MVP vs later scope
- suggested build order
- major dependencies
- future parallelization opportunities

### `docs/mvp-scope.md`
Document:
- in-scope MVP features
- clearly out-of-scope features
- success criteria for calling the MVP usable

## Planning standards
- Bias toward the fastest path to a usable MVP
- Bias toward simplicity over completeness
- Prefer a clean foundation over speculative extensibility
- Make pragmatic assumptions and record them
- Do not overengineer
- If stack is uncertain, recommend one option and explain why

## Code generation rules
- Do not implement product code unless the user explicitly asks for bootstrap to include initial scaffolding
- You may generate docs, config guidance, project structure guidance, and planning files
- If the user explicitly wants code scaffolding, keep it minimal and aligned with the chosen stack

## TODO initialization rules
`TODO.md` must:
- be immediately useful after bootstrap
- include a single clear `Current focus`
- break the MVP into phases
- avoid vague items like “build backend”
- use actionable tasks like “add project creation flow”
- support this completion format:

Example:
- [x] Create project model and migration
  - Summary: Added the initial project schema and migration for multi-project support.
  - Changed: Created the project model, migration, and base validation.

## Stack decision rules
When choosing a stack:
- judge based on the actual product needs
- compare strong realistic options
- recommend one
- explain why it is the best fit
- record the decision in `DECISIONS.md`
- reflect it in `README.md`

## First implementation target
At the end of bootstrap, choose one clear first feature to build next.
That feature should:
- be foundational
- be MVP-relevant
- unblock later work
- be small enough to implement cleanly

## Output
At the end, provide:
1. branch name
2. recommended stack
3. first implementation target
4. files created
5. files updated
6. key decisions recorded
7. PR status