# Changelog

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
