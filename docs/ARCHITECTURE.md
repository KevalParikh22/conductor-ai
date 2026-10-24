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
4. **Chain.** Each provider is checked (enabled? installed or key set? cooling down?) and skipped with a reason if it isn't ready.
5. **Attempt.** On failure, the reason is classified (`quota`, `timeout`, `exit N`, `auth`, `empty output`…). Quota failures set a cooldown. Write-role failures stash partial work, so the next provider starts clean and nothing is lost.
6. **Success.** The report is saved, the changed files listed, protected-file edits flagged, and verify run.
7. **Summary.** The controller gets a short text block (or JSON with `--json`, or the MCP tool result) and only reads the full report when it needs to.

Everything for a run lives in `.conductor/runs/<timestamp>-<role>-<task>/`: the prompt, each provider's log, the report, `verify.log` and `summary.json`. That folder is gitignored.

## Safety model

| Risk | Mitigation |
|---|---|
| Worker breaks main | Write roles refuse protected branches |
| Failed worker leaves a mess | Clean-tree requirement + automatic `git stash push -u` per failed attempt |
| Worker rewrites the rules or plan | Agents are told not to; chat output is filtered by path (`AGENTS.md`, `CLAUDE.md`, `docs/plan/`, `.claude/`, `.conductor/`, `.git/`, `.env*`, `node_modules/`); changes are flagged in the summary |
| Path traversal from model output | File blocks must resolve inside the repo |
| "Read-only" worker edits files | The tree is hashed before and after, with a warning in the summary |
| Fake success | Verify runs independently of the worker's claim, and the controller reviews `git diff` |
| Keys leaking | Keys only in env or `secrets.env` (0600); config stores env var *names* |
| Settings UI abused by other sites | Binds 127.0.0.1 only, Host-header check (anti DNS rebinding), per-launch token required for the API |

## Inspiration

conductor borrows proven ideas:

- **PAL MCP server** (formerly Zen MCP): a key-gated provider registry, and `clink`, which runs other CLIs as isolated sub-agents and returns only their final answer.
- **Task Master AI:** assigning models to roles (main / research / fallback) in config.
- **Aider's architect/editor mode:** a strong model plans while a cheaper model edits.
- **claude-code-router:** ordered fallbacks and routing by task type.
- **Claude Squad:** isolating each agent's work (here with git stash, rather than worktrees).

What conductor adds: a controller that stays in charge of quality (plan → delegate → verify → review), mixed agent and chat providers in the same chain, rate-limit cooldowns shared across projects, and per-project setup for several controllers.

## Extending

- **New provider type:** add a `run<Type>` function in `providers.js` and wire it into `runProvider`.
- **New role:** add it to `ROLES` and `DEFAULT_ROLES` in `presets.js` and add `src/prompts/<role>.md`.
- **New controller:** add it to `CONTROLLERS` and handle its command format and MCP registration in `init.js`.
