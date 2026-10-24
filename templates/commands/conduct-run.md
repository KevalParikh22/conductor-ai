---
description: Execute a whole plan task by task with worker LLMs, then test, document and review
argument-hint: <plan-file> [from-task-id]
disable-model-invocation: true
allowed-tools: Read, Edit, Bash(conductor:*), Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git log:*), Bash(git stash push:*), Bash(git stash list), Bash(git switch -c:*)
---

You are the controller (see `.conductor/ORCHESTRATOR.md`). Execute `$ARGUMENTS` (from the given task id, if one is given).

For each task with `status: todo`, in dependency order, follow the procedure in `.claude/commands/conduct-build.md` exactly: delegate in the background, check the diff yourself, commit, retry once with another provider, then take over.

While running:
- Keep your context small: read the summary, the RESULT block and the task's `git diff`, never full logs.
- After each task, report one line: `T3 ✓ gemini-cli · verify PASS · a1b2c3d`.
- **Stop and ask** if a task needs a design decision the plan doesn't cover, a worker leaves its scope twice, or verify fails for reasons outside the task.
- If exit code 3 happens on two tasks in a row (everything rate-limited), stop, update `HANDOFF.md`, and report what is left.

When all tasks are done:
1. `conductor run review --plan <plan>` (background). Triage each finding yourself and fix the real ones (small ones yourself, larger ones with `conductor run fix "<finding>"`), then commit.
2. `conductor verify`.
3. Update `HANDOFF.md` and summarise: tasks per provider, review verdict, leftovers.
