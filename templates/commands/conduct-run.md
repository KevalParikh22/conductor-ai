---
description: Execute a whole plan with worker LLMs (independent tasks in parallel), then test, document and review
argument-hint: <plan-file> [from-task-id]
disable-model-invocation: true
allowed-tools: Read, Edit, Bash(conductor:*), Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git log:*), Bash(git merge:*), Bash(git stash push:*), Bash(git stash list), Bash(git switch -c:*)
---

You are the controller (see `.conductor/ORCHESTRATOR.md`). Execute `$ARGUMENTS` (from the given task id, if one is given).

Work in **waves**. A wave is every `status: todo` task whose `depends on` tasks are all done.

- **Wave with one task, or a `controller` task:** follow `.claude/commands/conduct-build.md` exactly (delegate in the background, check the diff, commit, retry once with another provider, then take over). Do controller tasks yourself.
- **Wave with two or more delegable tasks that don't list the same files:** run them in parallel, in the background:
  `conductor batch --plan <plan> --tasks T2,T3,T4`
  Each task runs in its own git worktree on branch `conductor/<id>`, spread across different providers, and conductor commits the result on that branch. When the batch finishes, for each ✓ task:
  1. `conductor diff conductor/<id>`: in scope? matches the Design notes and acceptance criteria? Check its verify result.
  2. Good: `git merge --no-ff conductor/<id> -m "<slug>: <id> <title>"`, then `conductor worktree rm <id>` and set `status: done`.
  3. Fixable: `conductor retry <id> --note "<what to fix>"`. The same worker continues in that worktree, keeps what is right and commits the fix on the same branch; add `--provider <other>` to hand it to someone else. Then review again.
  4. Wrong from the start: `conductor worktree rm <id> --force`, then `conductor run <role> --plan <plan> --task <id> --worktree --provider <different> --note "<what was wrong>"`, or do it yourself.
  For each ✗ or ⚠ task, `conductor retry <id> --note "…"` first; start over only when the work is unusable. If a merge conflicts, resolve it yourself, or abort and retry that task after the others are merged.
- If tasks in a wave list the same file, run them one after another instead.

While running:
- Keep your context small: read the summaries, `report.md` and `conductor diff`, never `report.full.md` or run logs. Use plain `git diff -- <file>` only for a file the compact diff cut short.
- After each task, report one line: `T3 ✓ antigravity-cli · verify PASS · a1b2c3d`.
- **Stop and ask** if a task needs a design decision the plan doesn't cover, a worker leaves its scope twice, or verify fails for reasons outside the task.
- If exit code 3 happens on two waves in a row (everything rate-limited), stop, update `HANDOFF.md`, and report what is left.

When all tasks are done:
1. `conductor verify` on the merged result (parallel tasks were verified separately).
2. `conductor run review --plan <plan>` (background). Triage each finding yourself and fix the real ones (small ones yourself, larger ones with `conductor run fix "<finding>"`), then commit.
3. `conductor worktree` should list nothing; remove leftovers.
4. Update `HANDOFF.md` and summarise: tasks per provider, review verdict, leftovers.
