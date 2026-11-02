# Configuration

The easiest way is `conductor ui`. Everything below is what the UI edits.

## Where config lives

Effective config = **built-in defaults** ← **global** ← **project**. Later layers win.

| Layer | File | Typical use |
|---|---|---|
| Built-in | `src/presets.js` | Sensible defaults |
| Global | `~/.config/conductor/config.json` | Your providers and role order for all projects |
| Project | `<repo>/.conductor/config.json` | Per-project overrides, e.g. a different controller |
| Secrets | `~/.config/conductor/secrets.env`, `<repo>/.conductor/.env` | API keys (both gitignored or private) |

Set `CONDUCTOR_HOME` to move the global directory. The UI saves **only the differences** from the layer below, so future built-in defaults still reach you.

Merge rules: `providers` and `settings` merge field by field; each role's chain is replaced as a whole.

## Example

```json
{
  "version": 1,
  "controller": "claude-code",
  "roles": {
    "build": ["antigravity-cli", "codex-cli", "opencode"],
    "test": ["opencode", "kilo-free"],
    "docs": ["kilo-free", "openrouter-free", "gemini-api"]
  },
  "providers": {
    "openrouter-free": { "model": "openrouter/free", "fallbackModels": ["google/gemma-4-31b-it:free"] },
    "ollama": { "enabled": true, "model": "qwen3-coder" },
    "my-gateway": { "type": "openai", "enabled": true, "baseUrl": "https://llm.mycorp.dev/v1", "apiKeyEnv": "MYCORP_KEY", "model": "coder-large" }
  },
  "settings": { "verify": "pnpm lint && pnpm test", "cooldownMinutes": 20 }
}
```

## Controller

`claude-code` (default) · `antigravity` · `codex-cli` · `opencode`. (`gemini-cli` was removed; configs that name it switch to `antigravity`.) Change it in the UI (Controller → Apply to this project) or with `conductor init --controller <name>`. Applying writes that agent's instruction file, its `/conduct-*` commands and an MCP entry.

## Roles

| Role | Mode | Default chain | Good fit |
|---|---|---|---|
| `build` | write | antigravity-cli → codex-cli → opencode | Planned implementation tasks |
| `fix` | write | codex-cli → antigravity-cli → opencode | Small fixes, review follow-ups |
| `test` | write | opencode → kilo-free → openrouter-free → antigravity-cli | Writing tests (free models) |
| `docs` | write | openrouter-free → kilo-free → opencode-zen → opencode → gemini-api → antigravity-cli | README, docs, changelogs |
| `review` | read | codex-cli → antigravity-cli → gemini-api → kilo-free | Second-opinion review of a diff |
| `ask` | read | antigravity-cli → gemini-api → kilo-free → openrouter-free | Codebase questions, research |

An empty chain means the controller does that role itself. For one run, `--provider x` tries `x` first, and `--chain a,b` replaces the chain.

## Provider fields

| Field | Applies to | Meaning |
|---|---|---|
| `type` | all | `cli`, `openai` (any OpenAI-compatible API) or `anthropic` |
| `enabled` | all | Disabled providers are skipped |
| `model` | all | Model id. Empty = the CLI's default |
| `preset` | cli | `antigravity`, `codex`, `opencode`, `kimi`, `claude`, `gemini` |
| `bin`, `write`, `read`, `modelArgs`, `stdin` | cli | Override the preset's command line (see PROVIDERS.md) |
| `env` | cli | Extra environment variables for that CLI |
| `baseUrl` | api | e.g. `https://openrouter.ai/api/v1` (conductor adds `/chat/completions`) |
| `apiKeyEnv` | api | Name of the env var holding the key; empty for local servers |
| `apiKeyOptional` | api | `true` = send the key if set, but run without one too (e.g. `kilo-free`) |
| `headers`, `maxTokens`, `temperature` | api | Optional request tuning |
| `fallbackModels` | openrouter | Extra models OpenRouter tries if the first is unavailable |
| `notes` | all | Shown in the UI |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `timeoutSec` | 1200 | Max seconds per attempt; then the next provider runs |
| `cooldownMinutes` | 30 | How long a rate-limited provider is skipped (or its `Retry-After`) |
| `protectedBranches` | `["main","master"]` | Write roles refuse to run on these |
| `protectedPaths` | `[]` | Extra regexes (repo-relative paths) workers may never write, e.g. `"^app/etc/env\\.php$"`. Built in: AGENTS/CLAUDE/GEMINI/HANDOFF.md, plans, `.claude/`, `.gemini/`, `.agents/`, `.conductor/`, `.git/`, `.env*`, `auth.json`, `node_modules/` |
| `requireCleanTree` | true | Write roles need a clean tree (enables stash-on-failure) |
| `verify` | `""` | Verify command. Empty = `AGENTS.md` Verify line, then auto-detect |
| `autoVerify` | true | Run verify after each write task |
| `maxDiffBytes` | 100000 | Review diffs above this are truncated |
| `maxContextBytes` | 60000 | File content sent to chat-only (API) providers |
| `quotaPattern` | (regex) | Output that counts as a rate-limit error for CLIs |

## Cooldown state

Shared across projects in `~/.config/conductor/state.json`. See it with `conductor cooldown` and clear it with `conductor cooldown --clear [name]` (or from the UI Overview).
