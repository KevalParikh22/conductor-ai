# Providers

There are two kinds of provider:

- **Agents** (`type: "cli"`) run on your machine. They read the repo, edit files and run tests themselves, which makes them best for `build` and `fix`.
- **Chat APIs** (`type: "openai"` or `"anthropic"`) receive the task, `AGENTS.md`, the plan's design notes and the task's listed files. They return whole files in a `<<<FILE path … FILE>>>` format, which conductor writes, refusing paths outside the repo and protected files. They're best for `docs`, `test`, `ask` and `review`. conductor runs your verify command for them.

## All providers and their setup guides

conductor knows **45 chat APIs** and **10 coding agents**. Each one has a step-by-step guide (key link, one command, manual config, troubleshooting): **[docs/providers](providers/README.md)**.

The quickest way in:
```bash
conductor setup            # finds installed agents and keys you already have, adds a free provider, tests
```
```bash
conductor providers        # everything you can add, with status
```
```bash
conductor add groq         # key (hidden input), model, test and role chains in one command
```
Or open `conductor ui` → Providers → **Add a provider**.

Enabled out of the box: `antigravity-cli`, `codex-cli`, `opencode` (agents; each needs installing and signing in), and `kilo-free` (no key), `openrouter-free` and `gemini-api` (free keys). Model ids change often: `conductor models <provider>` lists any API provider's current models, and the **Models** button on a provider's card in the UI loads them into its model list.

## Permissions: what each agent may do

Every CLI agent runs with permission rules that conductor passes **for that run only**. conductor never edits your own CLI settings (`~/.gemini/antigravity-cli/settings.json`, `~/.codex/config.toml`, `opencode.json`…), and your own deny rules still apply on top.

Rules for every agent (where the CLI supports them; the table says which do):
- **Write roles** (`build`, `fix`, `test`, `docs`) may edit files inside the project (or its worktree) only. Nothing outside it. No `git push`, `git commit`, `git reset`, `git checkout`, `git switch`, `git rebase`, `git stash`, `git clean` or `sudo`: conductor commits, and the controller merges and pushes. No permission prompts, and no "skip all permissions" flags.
- **Read roles** (`review`, `ask`) cannot edit files. They may run read-only commands (`git diff/log/show/status/blame/grep`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `pwd`).
- **Secrets:** keys conductor loads from `secrets.env` or `.conductor/.env` are removed from a CLI's environment, except the ones that CLI needs itself (`passEnv`). Variables you set in your own shell are left alone.

| Agent | Write roles | Read roles | Read-only enforced? |
|---|---|---|---|
| Antigravity (`agy`) | `--mode accept-edits --sandbox`: shell commands run in agy's terminal sandbox without asking (no network; home folder read-only; only the project and temp folders writable). Build, lint and test commands (`npm test`, `npx tsc`, `npx jest`, `npx expo lint`, `pytest`, `go test`…, plus your verify command and `settings.allowCommands`) are allowed without a prompt, since a headless run can't answer one. `.git`, `.env`-type files and conductor's own secrets, config, state and usage files are denied. | `--sandbox` with `write_file(<project>)` denied | ✓ |
| Codex | `--sandbox workspace-write`, `approval_policy="never"`, network off. Codex keeps `.git` read-only. | `--sandbox read-only` | ✓ |
| OpenCode (2.x) | `--standalone --auto` with `external_directory: deny` and the git/sudo commands denied. Its shell is **not** OS-sandboxed: OpenCode blocks outside paths it can detect in a command, not all of them | `edit: deny`, `webfetch: deny`, `external_directory: deny`, shell denied except read-only commands | ✓ |
| Claude Code | `--permission-mode acceptEdits`; the git/sudo commands disallowed; other commands that would ask are refused in `-p` mode | `Edit`, `Write`, `NotebookEdit` disallowed | ✓ |
| GitHub Copilot CLI | `-p --allow-all-tools` with `--deny-tool shell(git push)` (and the other git/sudo commands) and `write(.env)`; deny beats allow. File tools only reach the project, temp and conductor's prompt folder. Its shell is **not** OS-sandboxed (Copilot's `--sandbox` needs bubblewrap on Linux; turn it on in your Copilot settings if you have it) | `--deny-tool write --deny-tool shell`: only its read and search tools run | ✓ |
| Aider | edits files in the repo only; `--no-suggest-shell-commands` (no shell at all), `--no-auto-commits`, and `--env-file` set to an empty file so the project `.env` is never loaded | `--dry-run`: shows changes, writes nothing | ✓ |
| Grok Build (xAI) | `--sandbox strict` (kernel-enforced: writes only in the project and temp; no network for commands on Linux), `--always-approve` with `Bash(git push*)`… and `Bash(sudo*)` denied (deny wins), web tools off | `--sandbox read-only`, `--permission-mode dontAsk`, only `read_file`, `grep`, `list_dir` | ✓ |
| Kiro CLI | `--no-interactive --sandbox --trust-all-tools`: commands in Kiro's OS sandbox with network blocked; the run fails rather than go unsandboxed; Kiro refuses `.git` writes headless. `git commit`/`reset` can't be denied per run (Kiro keeps deny rules in `~/.kiro/settings/permissions.yaml`); conductor warns if a worker commits | `--trust-tools=read_file,grep_search`; anything that would ask is denied headless | ✓ |
| Goose | **none**: `GOOSE_MODE=auto` runs any command; goose has no per-command or path rules | `GOOSE_MODE=chat`: no tools at all (conductor inlines the project context) | ✓ |
| Kimi | **none**: print mode can run any command | prompt only | ✗ |
| Custom CLI | whatever its args say | whatever its args say | ✗ unless you declare `permissions` |

`conductor doctor` and the Providers page in `conductor ui` show these for each enabled agent. When a read role runs on an agent that can't be held to read-only, the run summary warns you. conductor also warns if any read-only run changed files, and in worktree runs if files appeared in your main checkout.

conductor's own guards apply to every provider too: write roles need a clean tree on a non-main branch (or a worktree), failed attempts are stashed, and changes to `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/plan/`, `.claude/`, `.gemini/`, `.agents/` and your `protectedPaths` are reverted.

### Antigravity CLI (agy)

Install and sign in once (headless runs reuse the cached login):
```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```
```bash
agy
```

How conductor drives it (tested with agy 1.4.11, Nov 2026):
- `--settings '<json>'` applies conductor's rules for this session only; they are never saved. The run log in `.conductor/runs/` shows the exact JSON.
- Deny rules use the project's **absolute path**, e.g. `write_file(/path/to/project)`. A bare `write_file(*)` also blocks agy's own working folder (`~/.gemini/antigravity-cli/brain`) and breaks the run.
- Read roles do **not** use `--mode plan`: plan mode writes its answer to a plan file and prints only a link to it. That was the cause of agy's flaky reviews in conductor 0.3.
- When a command needs to leave the sandbox (network, files outside the project), a headless run can't approve it: agy skips it and says so in its answer, which ends up in the run report for the controller to read.
- `--sandbox` needs Linux namespaces or macOS `sandbox-exec`. agy's docs say the flag has no effect where the sandbox is unavailable; the deny rules still apply then, but shell commands are no longer contained. Your own `~/.gemini/antigravity-cli/settings.json` needs nothing from conductor.
- Gemini CLI is no longer supported: Google stopped serving personal accounts in it on 18 June 2026, and agy replaced it. Configs that still name `gemini-cli` keep loading; it is left out of the chains and `conductor doctor` says so. The Gemini **API** (`gemini-api`) is unaffected.

## Free options at a glance

| Option | Cost | Limits (Nov 2026) | Notes |
|---|---|---|---|
| OpenCode agent free models (`opencode/*-free`, `big-pickle`) | Free | "Free for a limited time" | Only inside the OpenCode app, so use the `opencode` agent. The OpenCode Zen **API** needs credits |
| Kilo Gateway (`kilo-free`) | Free, **no key** | 200 req/hour per IP | Free routes may log prompts. A free `KILO_API_KEY` raises limits |
| OVHcloud AI Endpoints (`ovh`) | Free, **no key** | 2 req/min per model (400 with a key) | Hosted in Europe |
| OpenRouter `:free` models | Free | 50 req/day (1000/day after a one-time $10 credit) | The list changes weekly |
| Groq · Cerebras | Free tier | About 30 req/min, 1000+/day (per model) | Very fast; open models |
| Gemini API free tier | Free | Shown in AI Studio | Free-tier prompts are used to improve Google products |
| NVIDIA NIM · Cohere trial · Hugging Face credits · Cloudflare (10k Neurons/day) · Scaleway (1M tokens) | Free | See each guide | |
| Mistral free mode | Free | Rate-limited | Prompts may be used for training |
| Ollama · LM Studio · llama.cpp · vLLM · LocalAI · Jan | Free | Your hardware | Fully private |

## How each CLI is called

| Preset | Write mode | Read mode |
|---|---|---|
| antigravity | `agy [--model M] --mode accept-edits --sandbox --settings '<rules>' --print-timeout 0 -p "<prompt>"` | `agy [--model M] --sandbox --settings '<read-only rules>' --print-timeout 0 -p "<prompt>"` |
| codex | `codex exec --skip-git-repo-check --sandbox workspace-write -c approval_policy="never" -c sandbox_workspace_write.network_access=false [-m M] -o OUT -` | `--sandbox read-only -c approval_policy="never"` |
| opencode | `opencode run --standalone --auto [-m M] -f PROMPT_FILE "…"` with `OPENCODE_CONFIG_CONTENT` holding the write rules | without `--auto`, with the read-only rules |

OpenCode needs `--standalone` (OpenCode 2.x): without it, `opencode run` hands the job to OpenCode's background service, which ignores the per-run rules. conductor 0.3 had this problem, so its OpenCode workers ran with whatever rules the service had. OpenCode 1.x has no `--standalone`; override `write`/`read` without it if you're still on 1.x.
| kimi | `kimi [-m M] -p "<prompt>"` | same (read-only is only asked for in the prompt) |
| claude | `claude -p [--model M] --permission-mode acceptEdits --disallowedTools "Bash(git push:*)" …` (stdin) | `--permission-mode default --disallowedTools Edit Write NotebookEdit` |

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

Tokens: `{prompt}` (full prompt text; prompts over 100 KB are replaced by a pointer to the prompt file), `{promptFile}` (path to it), `{outFile}` (where the CLI may write its final answer), `{modelArgs}` (expands to `modelArgs` with `{model}` filled in, or nothing), `{sessionSettings}` (`sessionSettings.write` or `.read` as one JSON argument). Set `"stdin": true` to pipe the prompt.

Other per-mode fields: `modeEnv` (`{"write": {...}, "read": {...}}`, environment variables; objects are sent as JSON), `passEnv` (secret names this CLI may see) and `permissions` (`{"write": "...", "read": "...", "readOnlyEnforced": true}`, shown in doctor and the UI). In `sessionSettings` and `modeEnv`, `{cwd}` is the worker's folder and `{conductorHome}` is conductor's own folder.

If you override `read` for a built-in agent, conductor no longer assumes it stays read-only, unless you also set `permissions` with `"readOnlyEnforced": true`.

## Adding your own

**Any OpenAI-compatible API** that isn't in the catalog (a company gateway, a new provider…):
```json
{ "providers": { "together-api": { "type": "openai", "enabled": true, "baseUrl": "https://api.together.xyz/v1", "apiKeyEnv": "TOGETHER_API_KEY", "model": "..." } } }
```
Add `"apiKeyOptional": true` when the endpoint also works without a key (like Kilo).

**Another CLI agent:**
```json
{ "providers": { "aider": { "type": "cli", "enabled": true, "bin": "aider", "write": ["--yes-always", "--message-file", "{promptFile}"], "read": ["--dry-run", "--message-file", "{promptFile}"],
  "permissions": { "write": "edits files without asking", "read": "--dry-run: shows changes, writes nothing", "readOnlyEnforced": true } } } }
```
Only declare `readOnlyEnforced` when the CLI itself refuses edits in read mode.

Then add the name to a role chain, either in the UI or in `roles`.

## Rate-limit detection

- **APIs:** HTTP 429 or 402 count as `quota` (honouring `Retry-After`), 401/403 as `auth`, 5xx as `server`. OpenRouter's 200-with-error responses are detected too.
- **CLIs:** a non-zero exit whose output matches `settings.quotaPattern`, or a short exit-0 reply that is only a limit message.
- A `quota` result puts the provider on cooldown, so later runs skip it straight away.
