# Changelog

## 0.1.0 (2026-10-24)

First release.

- Controller-agnostic orchestration: Claude Code (default), Gemini CLI, Codex CLI or OpenCode as controller
- Roles `build`, `fix`, `test`, `docs`, `review`, `ask` with per-role fallback chains
- Providers: Gemini CLI, Codex CLI, OpenCode, Kimi CLI and Claude Code (agents); Gemini API, OpenRouter, OpenAI, Kimi/Moonshot, DeepSeek, Groq, Anthropic, Ollama, LM Studio and any OpenAI-compatible API (chat)
- Rate-limit detection with shared cooldowns, stash-on-failure, protected files, verify gate
- `conductor ui` settings page, `conductor init` per-project setup, MCP server, `doctor --live`
