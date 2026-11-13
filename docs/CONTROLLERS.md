# Controllers

Generated from `CONTROLLERS` in `src/presets.js` by `node scripts/gen-controller-docs.mjs`; a test keeps it in step.

The controller is the tool you talk to (it plans and reviews); conductor writes its files in the format each one reads.

| Controller | Instructions | Commands | Skills | Rules | Reviewer subagent | MCP | Commit guard |
|---|---|---|---|---|---|---|---|
| **Claude Code** (`claude-code`) | `CLAUDE.md` imports `@AGENTS.md` | commands in `.claude/commands` | `.claude/skills` | `.claude/rules` (claude) | `.claude/agents/conductor-reviewer.md` | `.mcp.json` | `.claude/settings.local.json` |
| **Antigravity CLI** (`antigravity`) | `GEMINI.md` imports `@./AGENTS.md` | skills in `.agents/skills` | `.agents/skills` | `.agents/rules` (agy) | `.agents/agents/conductor-reviewer.md` | `.agents/mcp_config.json` | `.agents/hooks.json` |
| **Codex CLI** (`codex-cli`) | `AGENTS.md` | skills in `.agents/skills` | `.agents/skills` | a block in `AGENTS.md` | `.codex/agents/conductor-reviewer.toml` | register once with `codex mcp add …` | not yet |
| **OpenCode** (`opencode`) | `AGENTS.md` | skills in `.agents/skills` | `.agents/skills` | a block in `AGENTS.md` | `.opencode/agents/conductor-reviewer.md` | `opencode.json` | not yet |

## Adding a controller

Most coding agents read the same files as one of these (AGENTS.md, `.agents/skills`, an `mcpServers` JSON file). Then a new controller is a data entry, no code:

```bash
conductor controller add copilot --like codex-cli --label "Copilot CLI"
conductor controller check
conductor init --controller copilot
```

It is stored under `controllers` in your config (`--project` for this project only). Edit the entry when its folders differ. `conductor doctor` reports an entry that names a format conductor cannot write.

**Formats conductor can write:**

- rules: `claude`, `agy`, or `{ "block": "AGENTS.md" }`
- reviewer: `claude`, `agy`, `codex-toml`, `opencode`
- mcp: `mcpServers`, `opencode`, or a `register` note for tools that keep MCP servers in their own config
- hooks (the commit guard): `claude-settings`, `agy-hooks`
- commands: as `commands` or `skills`

A tool that reads a format not listed here needs its writer in `src/controllers.js` (or `src/guard.js` for hooks), and a test against the real tool before conductor claims it works: hook and permission formats are where tools differ most.
