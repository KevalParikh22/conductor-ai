# Changelog

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
