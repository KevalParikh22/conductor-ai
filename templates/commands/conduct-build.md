---
description: Delegate one plan task to a worker LLM with fallback, then verify and commit
argument-hint: <plan-file> <task-id> [provider]
disable-model-invocation: true
allowed-tools: Read, Edit, Bash(conductor:*), Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*), Bash(git stash push:*), Bash(git stash list), Bash(git switch -c:*)
---

You are the controller (see `.conductor/ORCHESTRATOR.md`). Arguments: `$ARGUMENTS` = plan file, task id, optional provider.

1. Read only that task in the plan. If its role is `controller`, do it yourself and go to step 4. Otherwise its role (build/fix/test/docs) is the conductor role.
2. Make sure the tree is clean and you are not on main. Then run it **in the background** (Bash `run_in_background: true`):
   `conductor run <role> --plan <plan> --task <id> [--provider <provider>]`
   When it finishes, read the CONDUCTOR RESULT summary.
3. Check it yourself. Don't trust the report: `conductor diff` (in scope? matches the Design notes and acceptance criteria? no invented APIs or shortcuts?) and the verify line.
4. Decide:
   - **Good:** `git add -A && git commit -m "<slug>: <id> <title>"`, then set `status: done` in the plan.
   - **Small issue (<10 lines):** fix it, run `conductor verify`, commit.
   - **Bigger issue:** `git stash push -u -m "conductor: rejected <id>"`, then retry once with `--provider <different> --note "<what was wrong; what to do>"`.
   - **Outcome OUT OF SCOPE:** look at the files it lists in the diff. Keep them only if the task really needs them; otherwise revert them (`git checkout -- <files>`) before committing.
   - **Outcome NOT PROVEN** (verify already failed on the starting commit): judge by the new failure lines it lists, not by the verify status.
   - **Outcome UNVERIFIED (exit 4):** nothing proved it works. Run the project's checks yourself before committing, and ask the user for a verify command (`conductor init --verify "<cmd>"`).
   - **Second failure, or exit code 3:** do it yourself.
5. Tell the user in 2–3 lines: who did it, verify result, commit, any concern.
