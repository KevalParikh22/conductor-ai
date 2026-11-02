<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
  <img alt="conductor-ai" src="docs/assets/logo-light.svg" width="460">
</picture>

### Claude plans and reviews. Free and cheap models write the code.

[![CI](https://github.com/KevalParikh22/conductor-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/KevalParikh22/conductor-ai/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/KevalParikh22/conductor-ai?color=4f46e5&label=version)](CHANGELOG.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-4f46e5)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-818cf8)](docs/ARCHITECTURE.md)
[![License](https://img.shields.io/github/license/KevalParikh22/conductor-ai?color=blue)](LICENSE)

[Quick start](#quick-start) &middot; [How it works](#how-it-works) &middot; [Permissions](#every-agent-runs-under-its-own-rules) &middot; [Install guide](docs/INSTALL.md) &middot; [Providers](docs/PROVIDERS.md) &middot; [Changelog](CHANGELOG.md)

</div>

> **Status: early (v0.5), solo-maintained.** 41 tests, run in CI on Linux and macOS with Node 20, 22 and 24. The agents it drives change their CLI flags often; each one is a small preset you can override in config.

A Claude subscription runs out fast when Claude types every line. Claude is best at judgement: planning, design and catching bugs. **conductor-ai** keeps Claude (or any agent you choose) as the controller and quality gate, and hands the typing to Antigravity, Codex, OpenCode, free Kilo / OpenRouter / OpenCode Zen models, Kimi or local models. When one hits its limit, the next one takes over.

```bash
curl -fsSL https://raw.githubusercontent.com/KevalParikh22/conductor-ai/main/scripts/install.sh | bash
```

### At a glance

- **One controller, many workers.** Claude Code by default; Antigravity CLI, Codex CLI or OpenCode can be the controller too. Workers are picked per role (`build`, `fix`, `test`, `docs`, `review`, `ask`) from an ordered fallback chain.
- **Quota-aware fallback.** Rate limits (HTTP 429, CLI "usage limit" messages) put a provider on cooldown, honouring `Retry-After`, and the next one starts on a clean tree. If every provider fails, the controller does the task itself.
- **Free first.** Default chains lean on Kilo Gateway (no key needed), OpenCode's free models, OpenRouter `:free`, Gemini API and other free tiers, so your paid quota goes to planning and review.
- **Every agent under its own rules.** Each CLI gets permission rules for that run: write roles edit only the project and can't push; read roles can't edit; your API keys stay out of their environment. Your own CLI settings are never touched.
- **Parallel tasks.** `conductor batch` runs independent plan tasks at the same time, each in its own git worktree and branch, spread across providers. The controller reviews and merges.
- **Trust, but check.** Your tests and lint run after every write task, and the worker's list of changed files is compared with what git shows. Plans must answer their open questions before any task is handed out.
- **Usage and budgets.** Every run is logged with time, tokens and known cost; set a daily budget and paid APIs stop when it's reached. `conductor runs` and the Runs page show who did what.
- **Works everywhere.** Install once, `conductor init` in any repo. CLI and MCP server. Settings page in the browser. Zero dependencies, no telemetry.

### How it works

```mermaid
flowchart LR
  you([you]) --> C["Controller<br/>Claude Code, agy, Codex or OpenCode"]
  C -- "plan: small tasks" --> R{{"conductor<br/>role chains"}}
  R -- "build / fix" --> A["CLI agents<br/>agy, Codex, OpenCode"]
  R -- "test / docs" --> F["free APIs<br/>Kilo, OpenRouter, Zen"]
  R -- "review / ask" --> V["second opinion<br/>Codex, agy, Gemini API"]
  A --> G["verify gate<br/>your tests + lint"]
  F --> G
  V --> C
  G -- "diff + report" --> C
  R -. "429 or quota: cooldown, next provider" .-> R
```

1. **Plan.** `/conduct-plan` first settles open questions (asking you when the code can't answer them), then writes `docs/plan/<feature>.md`: design notes plus small tasks (1–3 files each), each with a role, acceptance criteria and a verify command.
2. **Delegate.** `/conduct-run` sends each task to the first ready provider in its role's chain; independent tasks run in parallel worktrees.
3. **Verify.** conductor runs your verify command, checks the worker's claimed changes against git, and reports who did the work, changed files, PASS/FAIL and any mismatch.
4. **Review and commit.** The controller reads the diff, fixes small issues, retries with another provider, or does the task itself after two failures. A second model reviews the branch at the end.

### See it

<table>
<tr>
<td align="center" width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ui-overview-dark.png">
  <img alt="Overview: controller, providers ready and the fallback chain for each role" src="docs/assets/ui-overview-light.png">
</picture>
<sub><b>Overview</b>: who does what, and which providers are ready</sub>
</td>
<td align="center" width="50%">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ui-providers-dark.png">
  <img alt="Providers: each agent with its write and read permissions, model and a Test button" src="docs/assets/ui-providers-light.png">
</picture>
<sub><b>Providers</b>: models, keys and each agent's permissions</sub>
</td>
</tr>
<tr>
<td align="center" colspan="2">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ui-runs-dark.png">
  <img alt="Runs: recent runs with worker, verify result and evidence warnings, plus usage by provider" src="docs/assets/ui-runs-light.png" width="70%">
</picture>
<br><sub><b>Runs</b>: who did what, verify results, evidence warnings and usage</sub>
</td>
</tr>
</table>

`conductor ui` opens this page on `127.0.0.1` (per-launch token, never exposed to the network).

### Quick start

```bash
npm install -g github:KevalParikh22/conductor-ai   # Node 20+
conductor setup                 # global config in ~/.config/conductor
cd my-app && conductor init     # rules, commands, MCP entry
conductor doctor --live         # a real call to each provider
```

Then, in Claude Code inside the project:

```text
/conduct-plan add password reset by email
/conduct-run docs/plan/password-reset.md
```

<details>
<summary><b>Install the worker agents</b> (at least one)</summary>
<br>

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy   # sign in with Google once
npm install -g @openai/codex && codex login
curl -fsSL https://opencode.ai/install | bash                          # free models
```

Free API providers need no install: `kilo-free` works without a key; add keys for OpenRouter, Gemini API, OpenCode Zen, Groq and others in `conductor ui` → API keys. Full guide: [docs/INSTALL.md](docs/INSTALL.md).

</details>

<details>
<summary><b>Use a different controller</b></summary>
<br>

```bash
conductor init --controller antigravity   # writes .agents/skills/conduct-* and .agents/mcp_config.json
conductor init --controller codex-cli     # AGENTS.md + prompts in .conductor/commands
conductor init --controller opencode      # AGENTS.md + opencode.json MCP entry
```

</details>

### Every agent runs under its own rules

conductor passes each CLI its permission rules **for that run only**, through the CLI's own sandbox or permission system. No "skip all permissions" flags.

| Agent | Write roles (`build`, `fix`, `test`, `docs`) | Read roles (`review`, `ask`) |
|---|---|---|
| **Antigravity** (`agy`) | `--sandbox`: commands run without network, home folder read-only; `.git`, `.env` files and conductor's folder denied | writes to the project denied |
| **Codex** | OS sandbox `workspace-write`, no network, never asks | OS sandbox `read-only` |
| **OpenCode** | edits inside the project; outside folders denied (shell not OS-sandboxed) | edits, web and mutating shell commands denied |
| **Claude Code** | edits auto-approved; other commands that would ask are refused | edit tools disabled |
| **Kimi**, custom CLIs | no permission control: use in a throwaway worktree | ⚠ not enforced, runs warn |

For every agent: no `git push`, `commit`, `reset`, `checkout`, `rebase`, `stash`, `clean` or `sudo`; only the API key that CLI needs is passed to it. conductor adds its own guards on top: clean tree and non-protected branch for write roles, failed attempts stashed (never lost), and changes to `AGENTS.md`, plans and controller files reverted. Details and the exact flags: [Providers → Permissions](docs/PROVIDERS.md#permissions-what-each-agent-may-do).

**Is it safe?** Read [SECURITY.md](SECURITY.md): what conductor guards (sandboxes, scrubbed keys, git hooks and config restored after every worker, checked model output), what it can't (tests run code the worker wrote; agents can read what you can read; free routes may log prompts), and a checklist for sensitive projects.

### Providers

| | Built in |
|---|---|
| **Local agents** | Antigravity CLI · Codex CLI · OpenCode · Kimi CLI · Claude Code · any CLI you add |
| **Free APIs** | Kilo Gateway (no key) · OpenCode Zen · OpenRouter `:free` · Gemini API · Groq · Cerebras · Mistral Codestral · NVIDIA NIM |
| **Paid APIs** | OpenAI · Claude API · Kimi / Moonshot · DeepSeek · any OpenAI-compatible endpoint |
| **Local models** | Ollama · LM Studio |

Chat APIs can't run your tests, so conductor applies the files they return (refusing paths outside the repo) and runs verify for them. `conductor models <provider>` lists current models; free lists change weekly.

<details>
<summary><b>Commands</b></summary>
<br>

| In your controller | What it does |
|---|---|
| `/conduct-status` | Providers ready, missing or cooling down, plus role chains |
| `/conduct-plan <feature>` | Writes a plan of delegable tasks |
| `/conduct-run <plan>` | Runs the whole plan in waves (parallel where possible), then review |
| `/conduct-build <plan> <task> [provider]` | Runs one task |
| `/conduct-test <what>` · `/conduct-docs <what>` | Tests and docs via free models |
| `/conduct-review [--plan f]` | Second-opinion review, triaged by the controller |
| `/conduct-ask <question>` | Codebase questions answered by a big-context model |
| `/conduct-handoff` | Updates `HANDOFF.md` so any tool can continue |

| CLI | |
|---|---|
| `conductor run <role> [task] [--plan f --task T1] [--provider p] [--chain a,b] [--note …] [--files a,b] [--json]` | Delegate with fallback |
| `conductor build\|fix\|test\|docs\|review\|ask …` | Shortcuts for `run <role>`; add `--worktree` to run on branch `conductor/<id>` |
| `conductor batch --plan f --tasks T2,T3 [--concurrency 4]` | Independent tasks in parallel, one worktree each |
| `conductor worktree [list]` · `conductor worktree rm <id>\|--all [--force]` | See and clean up worktrees |
| `conductor init [--controller claude-code\|antigravity\|codex-cli\|opencode]` | Set up a project |
| `conductor ui` · `conductor status` · `conductor doctor [--live]` · `conductor verify` | Manage and check |
| `conductor runs [show <run>]` · `conductor usage [--days 7]` | Run history; runs, tokens and cost per provider |
| `conductor models [provider]` · `conductor cooldown [--clear]` · `conductor mcp` | Model lists, rate-limit state, MCP server |

Exit codes: `0` ok · `2` usage or unsafe repo state · `3` every provider failed (the controller takes over).

</details>

### Docs

| Page | What it covers |
|---|---|
| [Install guide](docs/INSTALL.md) | Step by step, for every project |
| [Configuration](docs/CONFIGURATION.md) | Roles, providers, settings, config files |
| [Providers](docs/PROVIDERS.md) | Every provider, free tiers, permissions, adding your own |
| [tmux and editors](docs/EDITORS.md) | tmux layout, VS Code (Claude Code, Copilot agent mode), Cursor |
| [Local, cloud and CI](docs/CLOUD.md) | Claude Code on the web, GitHub Actions, servers |
| [Security](SECURITY.md) | What is protected, known limits, setup for sensitive code |
| [How it works](docs/ARCHITECTURE.md) | Design, safety model, parallel runs, inspirations |

### Honest limits

- Workers are weaker than Claude at judgement. That's why plans are detailed, tasks stay small, and every diff passes verify and the controller's review.
- Chat-only API models can't run your tests; prefer CLI agents for `build`, APIs for `docs`, `test` and `ask`.
- OpenCode's shell and agents without a sandbox (Kimi, custom CLIs) are only as contained as their own permission systems allow.
- Cost is only known for API providers with a `price` set; CLI agents on subscriptions are counted in runs and minutes.

### Contributing · security · license

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately as described in [SECURITY.md](SECURITY.md). MIT licensed.

<div align="center"><sub>If conductor-ai saves you quota, a ⭐ helps the next person find it.</sub></div>
