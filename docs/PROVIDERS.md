# Providers

There are two kinds of provider:

- **Agents** (`type: "cli"`) run on your machine. They read the repo, edit files and run tests themselves, which makes them best for `build` and `fix`.
- **Chat APIs** (`type: "openai"` or `"anthropic"`) receive the task, `AGENTS.md`, the plan's design notes and the task's listed files. They return whole files in a `<<<FILE path … FILE>>>` format, which conductor writes, refusing paths outside the repo and protected files. They're best for `docs`, `test`, `ask` and `review`. conductor runs your verify command for them.

## Built-in providers

| Name | Kind | Where it runs | Default model | Enabled |
|---|---|---|---|---|
| `gemini-cli` | agent | local (your Google login or `GEMINI_API_KEY`) | CLI default | ✓ |
| `codex-cli` | agent | local (ChatGPT login or OpenAI key) | CLI default | ✓ |
| `opencode` | agent | local (free models) | `opencode/big-pickle` | ✓ |
| `kimi-cli` | agent | local (Kimi login) | CLI default | |
| `claude-cli` | agent | local (spends Claude quota) | CLI default | |
| `gemini-api` | chat | cloud | `gemini-3.8-flash` | ✓ |
| `openrouter-free` | chat | cloud | `openrouter/free` (auto-picks a free model) | ✓ |
| `openai-api` | chat | cloud | `gpt-6-luna` | |
| `kimi-api` | chat | cloud (Moonshot) | `kimi-latest` | |
| `deepseek-api` | chat | cloud | `deepseek-chat` | |
| `groq-api` | chat | cloud | (set one) | |
| `claude-api` | chat | cloud (Anthropic) | `claude-sonnet-5-5` | |
| `ollama` | chat | local model, `localhost:11434` | `qwen3-coder` | |
| `lmstudio` | chat | local model, `localhost:1234` | (set one) | |

Model ids change often. Pick current ones in `conductor ui` → Providers. "Load current free models" fetches the live OpenRouter list, and `conductor models` does the same from the terminal.

## Free options at a glance

| Option | Cost | Limits (Oct 2026) | Notes |
|---|---|---|---|
| OpenCode free models (`opencode/*-free`, `big-pickle`) | Free | "Free for a limited time" | Data retention varies by model; check opencode.ai/docs/zen |
| OpenRouter `:free` models | Free | 20 req/min; 50 req/day (1000/day after a one-time $10 credit) | The list changes weekly |
| Gemini API free tier | Free | Shown in AI Studio | Daily reset at midnight Pacific |
| Ollama / LM Studio | Free | Your hardware | Fully private |

## How each CLI is called

| Preset | Write mode | Read mode |
|---|---|---|
| gemini | `gemini [-m M] --approval-mode yolo -p "…"` (prompt on stdin) | `--approval-mode default` |
| codex | `codex exec --skip-git-repo-check --sandbox workspace-write [-m M] -o OUT -` | `--sandbox read-only` |
| opencode | `opencode run --auto [-m M] -f PROMPT_FILE "…"` | without `--auto` |
| kimi | `kimi [-m M] -p "<prompt>"` | same (read-only is enforced by the prompt, and conductor warns if files change) |
| claude | `claude -p [--model M] --permission-mode acceptEdits` (stdin) | `--permission-mode plan` |

If a CLI update changes its flags, override them in config without waiting for a conductor release:

```json
{
  "providers": {
    "codex-cli": {
      "write": ["exec", "--sandbox", "workspace-write", "{modelArgs}", "-o", "{outFile}", "-"],
      "read":  ["exec", "--sandbox", "read-only", "{modelArgs}", "-o", "{outFile}", "-"]
    }
  }
}
```

Tokens: `{prompt}` (full prompt text), `{promptFile}` (path to it), `{outFile}` (where the CLI may write its final answer), `{modelArgs}` (expands to `modelArgs` with `{model}` filled in, or nothing). Set `"stdin": true` to pipe the prompt.

## Adding your own

**Any OpenAI-compatible API** (Together, Fireworks, Mistral, a company gateway, vLLM…):
```json
{ "providers": { "mistral-api": { "type": "openai", "enabled": true, "baseUrl": "https://api.mistral.ai/v1", "apiKeyEnv": "MISTRAL_API_KEY", "model": "codestral-latest" } } }
```

**Another CLI agent:**
```json
{ "providers": { "aider": { "type": "cli", "enabled": true, "bin": "aider", "write": ["--yes-always", "--message-file", "{promptFile}"], "read": ["--dry-run", "--message-file", "{promptFile}"] } } }
```

Then add the name to a role chain, either in the UI or in `roles`.

## Rate-limit detection

- **APIs:** HTTP 429 or 402 count as `quota` (honouring `Retry-After`), 401/403 as `auth`, 5xx as `server`. OpenRouter's 200-with-error responses are detected too.
- **CLIs:** a non-zero exit whose output matches `settings.quotaPattern`, or a short exit-0 reply that is only a limit message.
- A `quota` result puts the provider on cooldown, so later runs skip it straight away.
