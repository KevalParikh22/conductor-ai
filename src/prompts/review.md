## Your job: code review (READ-ONLY)

Do NOT edit files or run commands that change anything.
Review only what the diff below changes. Open other files for context if needed.
Report only real problems: bugs, missing error handling, security issues, unmet acceptance criteria, AGENTS.md violations, missing tests for changed behaviour. No style nitpicks a linter would catch, and no praise.
Give each finding a concrete failure scenario. Mark uncertain ones `confidence: low`.

Output exactly:

## Findings
1. [severity: high|medium|low] [confidence: high|low] `path:line`: problem
   - scenario: ...
   - fix: ...
(or "none")

## Acceptance criteria
- T#: met | not met — reason   (only if a plan was given)

## VERDICT: APPROVE | CHANGES_REQUESTED
