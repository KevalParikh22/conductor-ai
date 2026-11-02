# Changelog

## Unreleased

- **VS Code.** `conductor init --vscode` writes `.vscode/mcp.json` (merged, never replaced), so Copilot agent mode and other VS Code MCP extensions can call conductor. It is written automatically when the project already has a `.vscode/` folder.
- **New guide: [tmux and editors](docs/EDITORS.md).** A three-pane tmux layout (controller, live runs, shell), VS Code with Claude Code or Copilot, Cursor, VS Code tasks, and the PATH fix for editors that can't find `conductor`.
- **Install & setup page rewritten** (`conductor ui`). It checks this machine (Node, git, conductor version, project initialised, installed agents, free keys set) and has real install commands with the actual repo, not a placeholder. It shows a free path (kilo-free with no key, OpenRouter, OpenCode Zen, Gemini, Groq, Cerebras, Ollama) next to the subscription agents, a read-only free test run, install and sign-in per agent with copyable single commands, and how to update or remove conductor.
- The API keys page lists every free provider with its signup link, and warns that free routes may log prompts.
- API providers that return 200 with empty content (Kilo and OpenRouter free routers do this now and then) are asked once more before falling back.

## 0.5.0 (2026-11-02)

- **Evidence check.** After a write task, the worker's "Files changed" list is compared with what git shows. conductor warns about files it claims but didn't change, changes it didn't report, and "DONE" with no changes. Files already modified before the run are not counted.
- **Open questions gate.** Plans get a `## Open questions` section. Write tasks (and `conductor batch`) are refused while an item is unchecked, so workers never guess at decisions. `/conduct-plan` settles questions first and asks you the rest. Override with `--allow-open-questions`.
- **Usage and budgets.** Every attempt is logged to `~/.config/conductor/usage.jsonl` with time, tokens and cost (for API providers with a `price`, or marked `free`). `conductor usage` shows totals per provider. `settings.dailyBudgetUSD` (or per provider) skips paid APIs once today's spend reaches the cap. Run summaries show tokens and cost.
- **Run history.** `conductor runs` and `conductor runs show <run>`, plus a Runs page in `conductor ui` that refreshes while open and shows usage by provider and today's spend.
- **One-line installer**: `scripts/install.sh` checks Node 20+, installs from GitHub and runs setup. `llms.txt` describes the repo for AI tools.
- The README no longer has a comparison table.

## 0.4.1 (2026-11-02)

- Fix (macOS): CLI workers got `PWD` and agy's deny rules with the unresolved project path. Through a symlink (`/var` → `/private/var` on macOS) that path differs from the one the process runs in, so agy's project rules might not match. conductor now uses the resolved path. This was also why CI failed on macOS.
- New README: logo, badges, diagram, screenshots of the settings page and a permissions table.
- `SECURITY.md`, issue templates for bugs and provider requests, and repository links in `package.json`.
- CI runs every OS and Node combination to the end instead of cancelling on the first failure, with current GitHub Actions versions.

## 0.4.0 (2026-11-02)

- **Permissions for every agent, per run.** conductor passes each CLI its own rules for that run and never edits your CLI settings. Write roles may edit only the project (no `git push/commit/reset/checkout/switch/rebase/stash/clean`, no `sudo`); read roles cannot edit. `conductor doctor` and the Providers page show what each agent may do. Details in docs/PROVIDERS.md.
  - **Antigravity:** no more `--dangerously-skip-permissions`. Write roles run `--mode accept-edits --sandbox --settings <rules>`: commands run in agy's sandbox (no network, home read-only), `.git`, `.env`-type files and conductor's folder are denied. Read roles deny writes to the project. Read roles no longer use `--mode plan`, which answered with a link to a plan file and caused the flaky reviews.
  - **Codex:** `approval_policy="never"` and no network made explicit.
  - **OpenCode:** runs with `--standalone`. Without it OpenCode 2 handed the run to its background service, which ignored conductor's rules (so `npm test` could be refused and read-only wasn't enforced). Read roles are now enforced (`edit: deny`, shell limited to read-only commands, no web, nothing outside the project), not just asked for in the prompt. Write roles deny folders outside the project and the git/sudo commands.
  - **Claude Code (worker):** read roles disable the edit tools instead of plan mode; write roles disallow the git/sudo commands.
  - **Kimi** and custom CLIs are marked as not read-only; read runs on them warn.
- **Secrets stay with their provider.** Keys loaded from `secrets.env` / `.conductor/.env` are no longer passed to every CLI worker, only the ones it needs (`passEnv`).
- **Gemini CLI removed** (preset, provider and controller). Configs that still name `gemini-cli` keep loading: it is dropped from the chains, the controller switches to `antigravity`, and `conductor doctor` says so. The Gemini API provider is unchanged.
- New preset fields: `sessionSettings`, `modeEnv`, `passEnv`, `permissions`; new arg token `{sessionSettings}`.
- `conductor doctor` no longer reports `apiKeyOptional` providers (Kilo) as missing a key.

## 0.3.0 (2026-10-30)

- **Parallel tasks.** `conductor run <role> --worktree` runs a write task in its own git worktree on branch `conductor/<id>` and commits the result there. `conductor batch --plan p.md --tasks T2,T3,T4` runs independent tasks at the same time, spread across different providers. It refuses tasks that depend on each other and warns when tasks share files.
- `conductor worktree [list]` and `conductor worktree rm <id>|--all [--force]`.
- MCP: new `conductor_batch` tool; `conductor_run` takes `worktree` and `replace`.
- `/conduct-run` works in waves and batches independent tasks; `/conduct-plan` and the plan template record `depends on`.
- Worktree runs keep the worker's prompt file outside the repo, use the task's own `verify:` line from the plan, and warn if files appear in the main checkout during the run.
- Fix: CLI workers now get `PWD` set to their working directory. OpenCode takes the project folder from `$PWD`, so before this fix it worked in whatever folder conductor was started from.

## 0.2.0 (2026-10-28)

- **Antigravity CLI (`agy`)** is a new agent preset (`antigravity-cli`) and controller (`conductor init --controller antigravity`, which writes `.agents/skills/conduct-*` and `.agents/mcp_config.json`). It replaces Gemini CLI in the default chains, since Gemini CLI stopped serving personal Google accounts on 18 June 2026. `gemini-cli` stays available, disabled, for API-key and Code Assist users.
- New free API providers: `kilo-free` (Kilo Gateway, works without a key), `opencode-zen` (OpenCode Zen API), `cerebras-api`, `mistral-api` (Codestral) and `nvidia-nim`. `kilo-free` and `opencode-zen` join the `test`, `docs` and `ask` chains.
- `apiKeyOptional` provider field for endpoints that also work without a key.
- `conductor models <provider>` lists the models of any OpenAI-compatible provider.
- Prompts over 100 KB are passed to argv-only CLIs as a pointer to the prompt file.
- When the controller's file is `GEMINI.md` or `AGENTS.md`, the controller block is marked as controller-only so workers reading the same file ignore it.
- `.agents/` is protected from worker edits.
- A CLI that exits 0 with nothing on stdout now counts as `empty output` (with the stderr reason) and falls through to the next provider.
- Review and ask prompts tell workers they don't need shell commands.

## 0.1.0 (2026-10-24)

First release.

- Controller-agnostic orchestration: Claude Code (default), Gemini CLI, Codex CLI or OpenCode as controller
- Roles `build`, `fix`, `test`, `docs`, `review`, `ask` with per-role fallback chains
- Providers: Gemini CLI, Codex CLI, OpenCode, Kimi CLI and Claude Code (agents); Gemini API, OpenRouter, OpenAI, Kimi/Moonshot, DeepSeek, Groq, Anthropic, Ollama, LM Studio and any OpenAI-compatible API (chat)
- Rate-limit detection with shared cooldowns, stash-on-failure, protected files, verify gate
- `conductor ui` settings page, `conductor init` per-project setup, MCP server, `doctor --live`
