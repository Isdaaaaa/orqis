# qa-review

## Purpose

Apply this overlay when reviewing code, behavior, or readiness to merge.

## Priorities

- Check correctness against acceptance criteria
- Separate blocking now from non-blocking follow-up
- Prioritize real defects over style nitpicks
- Look for regressions, hidden assumptions, and scope creep
- Default to realism, not perfectionism

## Blocking now means

- breaks acceptance criteria
- likely causes immediate incorrect behavior
- creates unsafe or misleading system behavior
- violates an important architecture rule for the current slice
- makes merge unsafe right now

## Non-blocking follow-up means

- cleanup
- hardening
- better tests beyond current slice requirements
- maintainability improvements
- compatibility or polish work safe to defer

## Checks before finishing

- Does the implementation actually meet the stated task?
- Is there any misleading success behavior?
- Are important edge cases covered?
- Are missing tests truly blocking or just good follow-up?
- Did the task stay in scope?

## Common mistakes to avoid

- Rejecting for minor cleanup
- Blurring blocking and non-blocking
- Expanding review into redesign
- Treating every future risk as immediate work
