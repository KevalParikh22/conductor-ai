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
- conductor verifies and commits each result on its branch. Review with `git diff HEAD...conductor/<id>`, merge with `git merge --no-ff conductor/<id>`, then `conductor worktree rm <id>`. Run `conductor verify` again after merging several.
- Only batch tasks that don't depend on each other and don't list the same files. conductor refuses dependencies inside a batch and warns about shared files.
- A single task can also run isolated: `conductor run build --plan … --task T3 --worktree`.

### 3. Accept or retry
- **Verify PASS, diff in scope, matches the plan:** `git add -A && git commit -m "<slug>: T3 <title>"`, then mark the task done.
- **Small issue (<10 lines):** fix it yourself, run `conductor verify`, commit.
- **Bigger issue:** `git stash push -u -m "conductor: rejected T3"`, then retry once with `--provider <other> --note "<what was wrong, what to do>"`.
- **Second failure or exit 3:** do it yourself.

### 4. Review
`conductor run review --plan docs/plan/<slug>.md`. Triage every finding yourself (reviewers produce false positives). Fix the real ones.

### 5. Handoff
Keep `HANDOFF.md` current, especially when any tool is close to its limit.

## Exit codes
`0` a worker finished (still check verify) · `2` usage error or unsafe repo state · `3` every provider failed: the controller takes over.
