# Controller playbook

Read by whichever AI is the controller (Claude Code by default; change it in `conductor ui` → Controller).

**Backup controller:** if the controller is out of usage, open another agent (e.g. `agy` or `codex`) in this repo and say:
"Read HANDOFF.md and act as the controller described in .conductor/ORCHESTRATOR.md."

## Division of labour

| Work | Who | Why |
|---|---|---|
| Planning, design decisions, security-sensitive code, hard bugs, final review, commits | **Controller** | Best judgement. Spend its quota on decisions, not typing |
| Implementing planned tasks (`build`) | Daily-driver agents (Antigravity CLI, Codex CLI) | Big free/included quotas, can edit files and run tests |
| Small fixes (`fix`) | Codex CLI first | Precise on focused changes |
| Tests (`test`), docs (`docs`) | Free models (OpenCode free, OpenRouter `:free`) | Cheap, well-scoped work |
| Second-opinion review (`review`) | Codex / Gemini | A different model catches different bugs |
| Codebase questions (`ask`) | Gemini (huge context) | Saves controller tokens |

The user can change any of this in `conductor ui`.

## Loop

```
/conduct-plan → for each task: /conduct-build → verify → check diff → commit
             → /conduct-test, /conduct-docs → /conduct-review → fix → done
```

### 1. Plan
- Copy `docs/plan/_TEMPLATE.md` to `docs/plan/<slug>.md`.
- Write concrete **Design notes** (names, types, signatures, API shapes, file locations), so workers never make design decisions.
- Run `conductor plan check docs/plan/<slug>.md` and fix what it reports: conductor refuses tasks without files, checkable acceptance criteria or a verify command, or with more than 4 files besides tests.
- Split into tasks of about 1–3 files and under ~200 lines, in dependency order, each with steps, acceptance criteria and verify.
- Assign `role` (build/fix/test/docs) per task. Mark judgement-heavy tasks `role: controller`.
- If `docs/architecture.md` is empty, generate it first: `conductor run ask "Map this codebase..." --save docs/architecture.md`.

### 2. Delegate a task
```bash
conductor run build --plan docs/plan/<slug>.md --task T3
```
- Needs a clean tree on a non-protected branch.
- On failure or quota, the partial work is stashed (`git stash list` → `conductor: failed attempt…`) and the next provider runs. Rate-limited providers cool down automatically.

### 2b. Run independent tasks in parallel
```bash
conductor batch --plan docs/plan/<slug>.md --tasks T2,T3,T4
```
- Each task gets its own git worktree (a separate checkout outside the repo) on branch `conductor/<id>`. Your working tree is never touched, so your branch and tree state don't matter; the worktrees start from your last commit.
- Tasks are spread across providers (T2 on the first ready `build` provider, T3 on the second, ...), each keeping the rest of the chain as fallback.
- conductor verifies and commits each result on its branch. Review with `conductor diff conductor/<id>` (compact: lockfiles and whitespace left out), merge with `git merge --no-ff conductor/<id>`, then `conductor worktree rm <id>`. Run `conductor verify` again after merging several.
- Only batch tasks that don't depend on each other and don't list the same files. conductor refuses dependencies inside a batch and warns about shared files.
- A single task can also run isolated: `conductor run build --plan … --task T3 --worktree`.

### 3. Accept or retry
Read the `outcome:` line first. **OUT OF SCOPE:** check the listed files in the diff; keep them only if the task needs them. **NOT PROVEN** (verify failed before the worker started): check the new failure lines it lists. **UNVERIFIED:** run the checks yourself.
- **Verify PASS, diff in scope, matches the plan:** `git add -A && git commit -m "<slug>: T3 <title>"`, then mark the task done.
- **Small issue (<10 lines):** fix it yourself, run `conductor verify`, commit.
- **Bigger issue:** `git stash push -u -m "conductor: rejected T3"`, then retry once with `--provider <other> --note "<what was wrong, what to do>"`.
- **Second failure or exit 3:** do it yourself.

### 4. Review
To check one task's work without spending your own context, ask the **conductor-reviewer** subagent ("review T3's diff against the plan"): it reads `conductor diff` and the task in a fresh context and returns findings with `path:line` and a verdict.

`conductor run review --plan docs/plan/<slug>.md`. Triage every finding yourself (reviewers produce false positives). Fix the real ones.

### 4b. Guards
If `git commit` is refused with "conductor: the last verify failed", don't work around it: fix the failures and run `conductor verify` (a pass unblocks it). Use `conductor guard allow` only when the user agrees to commit failing work.

### 5. Handoff
Keep `HANDOFF.md` current, especially when any tool is close to its limit.

## Who takes which task
- Leave it to conductor by default: routing rules in config, then the smart selector.
- For a big task, add `- **eta:** 1h` so its worker isn't stopped at the default 20-minute limit (it gets 2× the eta). A worker past its limit is stopped and the next provider runs.
- The project's standing rules are listed by `conductor route --rules`. To pin one task, add `- **provider:** <name>` under it in the plan. To see where a task would go before running it: `conductor route --plan <file> --task T3`.

## Saving tokens
Your context is the expensive part. conductor is built to keep it small:
- **Delegate by default.** Write it yourself only when it is under ~10 lines or needs judgement the plan doesn't settle.
- **Small tasks, files listed.** A task with a `files:` line and 1–2 files lets the smart selector send it to a free API model first; open-ended tasks go to agents. Don't pass `--chain` or `--provider` unless you have a reason, or the selector is skipped.
- **Read little:** the summary, `report.md` (already cut to the worker's RESULT block) and `conductor diff` (compact). Not `report.full.md`, run logs or full files you don't need.
- **Your notes become lessons:** every `--note` is kept and given to later workers in the same area, so write it as a rule ("export add exactly as named"), not as a one-off complaint. `conductor lessons promote <id>` makes one permanent in AGENTS.md.
- **Retry with a note, don't rewrite:** `--note "<what was wrong>"` costs a sentence; redoing the task yourself costs the whole task. For a worktree task, `conductor retry <id> --note "…"` (MCP: `continue: true`) lets the same worker fix its own work in place instead of starting over.

## Exit codes
`0` a worker finished (still check verify) · `2` usage error or unsafe repo state · `3` every provider failed: the controller takes over · `4` the worker wrote code but no verify command proved it (outcome `unverified`): set a verify command, or check the work yourself. Never commit unverified work without checking it.
