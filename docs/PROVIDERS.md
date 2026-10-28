# Providers

There are two kinds of provider:

- **Agents** (`type: "cli"`) run on your machine. They read the repo, edit files and run tests themselves, which makes them best for `build` and `fix`.
- **Chat APIs** (`type: "openai"` or `"anthropic"`) receive the task, `AGENTS.md`, the plan's design notes and the task's listed files. They return whole files in a `<<<FILE path … FILE>>>` format, which conductor writes, refusing paths outside the repo and protected files. They're best for `docs`, `test`, `ask` and `review`. conductor runs your verify command for them.

## Built-in providers

| Name | Kind | Where it runs | Default model | Enabled |
|---|---|---|---|---|
| `antigravity-cli` | agent | local (`agy`, your Google AI Pro login) | CLI default | ✓ |
| `codex-cli` | agent | local (ChatGPT login or OpenAI key) | CLI default | ✓ |
| `opencode` | agent | local (free models) | `opencode/big-pickle` | ✓ |
| `kimi-cli` | agent | local (Kimi login) | CLI default | |
| `claude-cli` | agent | local (spends Claude quota) | CLI default | |
| `gemini-cli` | agent | local (`GEMINI_API_KEY` or Code Assist licence only) | CLI default | |
| `gemini-api` | chat | cloud | `gemini-3.8-flash` | ✓ |
| `openrouter-free` | chat | cloud | `openrouter/free` (auto-picks a free model) | ✓ |
| `kilo-free` | chat | cloud (Kilo Gateway, **no key needed**) | `kilo-auto/free` (auto-picks a free model) | ✓ |
| `opencode-zen` | chat | cloud (OpenCode Zen API, `OPENCODE_API_KEY`) | `deepseek-v4.1-flash-free` | ✓ |
| `openai-api` | chat | cloud | `gpt-6-luna` | |
| `kimi-api` | chat | cloud (Moonshot) | `kimi-latest` | |
| `deepseek-api` | chat | cloud | `deepseek-chat` | |
| `groq-api` | chat | cloud (free tier) | (set one) | |
| `cerebras-api` | chat | cloud (free tier) | (set one) | |
| `mistral-api` | chat | cloud (free Experiment plan) | `codestral-latest` | |
| `nvidia-nim` | chat | cloud (free developer access) | (set one) | |
| `claude-api` | chat | cloud (Anthropic) | `claude-sonnet-5-5` | |
| `ollama` | chat | local model, `localhost:11434` | `qwen3-coder` | |
| `lmstudio` | chat | local model, `localhost:1234` | (set one) | |

Model ids change often. Pick current ones in `conductor ui` → Providers. "Load current free models" fetches the live OpenRouter list. From the terminal, `conductor models` lists OpenRouter's free models and `conductor models <provider>` lists any API provider's (e.g. `conductor models kilo-free`, `conductor models groq-api --all`).

## Gemini CLI → Antigravity CLI

Google stopped serving personal accounts (Free, Google AI Pro, Ultra) in Gemini CLI on 18 June 2026; its successor is the Antigravity CLI, `agy`. conductor's default chains use `antigravity-cli`. `gemini-cli` stays available but disabled, for people who run Gemini CLI with an API key or a Gemini Code Assist licence.

Install and sign in once (headless runs reuse the cached login):
```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```
```bash
agy
```

Notes:
- Write roles run `agy --dangerously-skip-permissions`, the same trust level as Gemini CLI's old `--approval-mode yolo`. conductor still requires a clean tree on a non-main branch and stashes failed attempts. For narrower rights, remove that flag in config and allow commands in `~/.gemini/antigravity-cli/settings.json` (e.g. `command(regex:npm run (build|lint|test))`).
- Read roles run `agy --mode plan`. agy can read files there, but shell commands are refused unless allowed, and **the first refused command ends agy's turn with no answer**. conductor reports that as `empty output` and moves to the next provider. Allowing read-only commands in `~/.gemini/antigravity-cli/settings.json` helps a lot:
  ```json
  { "permissions": { "allow": [
    "command(regex:^git (diff|log|show|status|blame)( [^;&|<>$`]*)?$)",
    "command(regex:^(ls|cat|head|tail|grep|rg|wc)( [^;&|<>$`]*)?$)"
  ] } }
  ```
  The character class blocks chaining and redirection (`; & | < > $` and backticks). `find` is left out on purpose, because `-delete` and `-exec` change files.
  Even with these rules, agy (1.4.9, tested Oct 2026) sometimes reaches for another command (`node -v`, `npm test`) and gives up, roughly half of review runs in testing. That's why `review` ends with `kilo-free` as a fallback. `build` and `fix` are not affected.
- Early `agy` builds printed nothing when stdout was not a terminal. If `conductor doctor --live` shows `antigravity-cli: empty output`, update `agy`.

## Free options at a glance

| Option | Cost | Limits (Oct 2026) | Notes |
|---|---|---|---|
| OpenCode free models (`opencode/*-free`, `big-pickle`) | Free | "Free for a limited time" | Data retention varies by model; check opencode.ai/docs/zen |
| Kilo Gateway free models (`kilo-free`) | Free, **no key** | About 200 req/hour per IP | Free routes may log prompts. A free `KILO_API_KEY` raises limits |
| OpenCode Zen API (`opencode-zen`) | Free `-free` models | Per account | The same models as the OpenCode CLI, as an API. Key from opencode.ai/zen |
| OpenRouter `:free` models | Free | 20 req/min; 50 req/day (1000/day after a one-time $10 credit) | The list changes weekly |
| Groq · Cerebras | Free tier | About 30 req/min, 1000+/day (per model) | Very fast; open models |
| Mistral (Codestral) | Free Experiment plan | About 1 req/s | Prompts may be used for training |
| NVIDIA NIM | Free developer access | About 40 req/min | Many open models; logged |
| Gemini API free tier | Free | Shown in AI Studio | Daily reset at midnight Pacific |
| Ollama / LM Studio | Free | Your hardware | Fully private |

## How each CLI is called

| Preset | Write mode | Read mode |
|---|---|---|
| antigravity | `agy [--model M] --dangerously-skip-permissions --print-timeout 0 -p "<prompt>"` | `--mode plan` instead of skipping permissions |
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

Tokens: `{prompt}` (full prompt text; prompts over 100 KB are replaced by a pointer to the prompt file), `{promptFile}` (path to it), `{outFile}` (where the CLI may write its final answer), `{modelArgs}` (expands to `modelArgs` with `{model}` filled in, or nothing). Set `"stdin": true` to pipe the prompt.

## Adding your own

**Any OpenAI-compatible API** (Together, Fireworks, LLM7, a company gateway, vLLM…):
```json
{ "providers": { "together-api": { "type": "openai", "enabled": true, "baseUrl": "https://api.together.xyz/v1", "apiKeyEnv": "TOGETHER_API_KEY", "model": "..." } } }
```
Add `"apiKeyOptional": true` when the endpoint also works without a key (like Kilo).

**Another CLI agent:**
```json
{ "providers": { "aider": { "type": "cli", "enabled": true, "bin": "aider", "write": ["--yes-always", "--message-file", "{promptFile}"], "read": ["--dry-run", "--message-file", "{promptFile}"] } } }
```

Then add the name to a role chain, either in the UI or in `roles`.

## Rate-limit detection

- **APIs:** HTTP 429 or 402 count as `quota` (honouring `Retry-After`), 401/403 as `auth`, 5xx as `server`. OpenRouter's 200-with-error responses are detected too.
- **CLIs:** a non-zero exit whose output matches `settings.quotaPattern`, or a short exit-0 reply that is only a limit message.
- A `quota` result puts the provider on cooldown, so later runs skip it straight away.
