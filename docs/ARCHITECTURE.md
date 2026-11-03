# How it works

```
bin/conductor.js        CLI: arg parsing, commands
src/core.js             dispatch(): role → chain → attempts → verify → summary
src/providers.js        runCli / runOpenAI / runAnthropic, error classification
src/presets.js          CLI presets, default providers, roles, controllers, settings
src/config.js           layered config (defaults ← global ← project), secrets, readiness
src/git.js              clean-tree checks, stash-on-failure, diffs
src/verify.js           verify command detection and execution
src/mcp.js              MCP stdio server (conductor_run / conductor_status / conductor_verify)
src/ui/                 local settings page (server.js + index.html)
src/init.js             per-project setup for each controller
src/prompts/            worker preambles per role
templates/              AGENTS.md, controller block, playbook, plan template, slash commands
```

## A dispatch, step by step

1. **Safety (write roles).** The project must be a git repo with commits, on a non-protected branch, with a clean tree (unless `--allow-dirty`).
2. **Task.** Either a plan section (`### T3…`, cut at the next heading of the same level) or free text. Review roles build a diff against the merge-base with main, including untracked files.
3. **Prompt.**
   - Agents get: worker rules + role instructions + the task. They read `AGENTS.md` and the files themselves.
   - Chat APIs get a system prompt (rules, role and the file-block protocol) plus context: `AGENTS.md`, the plan's Design notes, and the listed files, capped by `maxContextBytes`.
4. **Chain.** Each provider is checked (enabled? installed or key set? cooling down? over its daily budget?) and skipped with a reason if it isn't ready. Plan tasks for write roles are refused while the plan has unanswered `## Open questions`.
5. **Attempt.** On failure, the reason is classified (`quota`, `timeout`, `exit N`, `auth`, `empty output`…). Quota failures set a cooldown. Write-role failures stash partial work, so the next provider starts clean and nothing is lost.
6. **Success.** The report is saved, the changed files listed, protected-file edits flagged, and verify run. The **evidence check** compares the worker's "Files changed" list with what git shows and warns on claimed-but-unchanged files, unreported changes, or "DONE" with no changes at all. Files already modified before the run are left out of that comparison.
7. **Usage.** Every attempt (failed ones too) is appended to `~/.config/conductor/usage.jsonl` with time and, for APIs, tokens and cost.
8. **Summary.** The controller gets a short text block (or JSON with `--json`, or the MCP tool result) and only reads the full report when it needs to.

## Smart selector

`src/selector.js` reorders the role's chain before a run; it never adds or removes providers. A task is **small** when it lists 1–2 files and its text is short (or, for reviews, the diff is under 40 kB), and **large** otherwise. Small tasks try free API models first, since they cost nothing and get the files in the prompt. Large ones try agents first, which find and edit files themselves instead of an API model rewriting whole files. Paid APIs come after both. A provider whose last three attempts (last 24 hours) all failed for reasons other than rate limits goes last; cooldowns already handle rate limits. The order inside each group is yours. `--chain`, `--provider` or `smartSelect: false` turn it off.

## Parallel runs (worktrees)

With `--worktree` (or `conductor batch`, which always uses it), step 1 changes: instead of checking your branch and tree, conductor creates a git worktree from your last commit on a new branch `conductor/<task-id>`. The checkout lives outside the repo, in `~/.config/conductor/worktrees/<repo>-<hash>/<id>`, so test runners and file watchers in your project never see it. Ignored dependency folders (`node_modules`, `vendor`, `.venv`, `venv`) are symlinked in, so verify works without a reinstall.

The worker, file-block writes, stash-on-failure and verify all run inside that worktree. On success conductor commits the result on the branch (with `--no-verify`, since conductor's own verify already ran). On total failure the empty worktree is removed. Plan Design notes are copied into the prompt, because the plan file may not be committed yet. The task's own `verify:` line from the plan is used when present, because the other parallel tasks' code is missing from this checkout; run the full verify after merging. Prompt files go to a folder outside the repo, workers get `PWD` set to the worktree (OpenCode reads it), and conductor compares `git status` of your main checkout before and after, warning if anything appeared there.

`conductor batch` checks the tasks first (they must exist, must not depend on each other, and shared files trigger a warning), gives task *n* of a role the *n*-th ready provider in that role's chain as its first choice, and runs up to `--concurrency` tasks at once. The controller then reviews and merges each `conductor/<id>` branch and removes the worktree with `conductor worktree rm`.

Everything for a run lives in `.conductor/runs/<timestamp>-<role>-<task>/`: the prompt, each provider's log, the report, `verify.log` and `summary.json`. That folder is gitignored.

## Safety model

| Risk | Mitigation |
|---|---|
| Worker breaks main | Write roles refuse protected branches; worktree runs write only to their own `conductor/<id>` branch |
| Parallel workers collide | Each parallel task has its own worktree and branch; the controller merges them one by one |
| Failed worker leaves a mess | Clean-tree requirement + automatic `git stash push -u` per failed attempt |
| Worker rewrites the rules or plan | Agents are told not to; chat output is filtered by path (`AGENTS.md`, `CLAUDE.md`, `docs/plan/`, `.claude/`, `.conductor/`, `.git/`, `.env*`, `node_modules/`); changes are flagged in the summary |
| Path traversal from model output | File blocks must resolve inside the repo |
| Worker runs dangerous commands | Every CLI gets permission rules for that run only (agy `--settings` + `--sandbox`, Codex OS sandbox, OpenCode `OPENCODE_CONFIG_CONTENT`, Claude `--disallowedTools`): project-only edits, no push/commit/reset/sudo, no "skip permissions" flags. See [Providers → Permissions](PROVIDERS.md#permissions-what-each-agent-may-do) |
| "Read-only" worker edits files | Enforced by the CLI where it can be (agy, Codex, OpenCode, Claude); a warning when the agent can't be held to read-only (Kimi, custom CLIs); the tree is also hashed before and after, with a warning in the summary |
| Worker reads your API keys | Keys conductor loaded from `secrets.env` / `.conductor/.env` are removed from CLI workers' environment, except the one that CLI needs (`passEnv`); agy is also denied conductor's folder and `.env`-type files |
| Fake success | Verify runs independently of the worker's claim, and the controller reviews `git diff` |
| Keys leaking | Keys only in env or `secrets.env` (0600); config stores env var *names* |
| Settings UI abused by other sites | Binds 127.0.0.1 only, Host-header check (anti DNS rebinding), per-launch token required for the API |

## Inspiration

conductor borrows proven ideas:

- **PAL MCP server** (formerly Zen MCP): a key-gated provider registry, and `clink`, which runs other CLIs as isolated sub-agents and returns only their final answer.
- **Task Master AI:** assigning models to roles (main / research / fallback) in config.
- **Aider's architect/editor mode:** a strong model plans while a cheaper model edits.
- **claude-code-router:** ordered fallbacks and routing by task type.
- **Claude Squad:** isolating each agent's work (git stash for single runs, worktrees for parallel ones).
- **Bernstein:** parallel agents in git worktrees, cost budgets, and a run view next to the terminal.
- **Ouroboros:** settle ambiguity before any code is written (here: the plan's Open questions gate), and don't take a worker's word for what it did (the evidence check).
- **llm-use:** per-run cost tracking with a breakdown by provider.

What conductor adds: a controller that stays in charge of quality (plan → delegate → verify → review), mixed agent and chat providers in the same chain, rate-limit cooldowns shared across projects, and per-project setup for several controllers.

## Extending

- **New provider type:** add a `run<Type>` function in `providers.js` and wire it into `runProvider`.
- **New role:** add it to `ROLES` and `DEFAULT_ROLES` in `presets.js` and add `src/prompts/<role>.md`.
- **New controller:** add it to `CONTROLLERS` and handle its command format and MCP registration in `init.js`.
