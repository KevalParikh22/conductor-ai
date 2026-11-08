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
[![Providers](https://img.shields.io/badge/providers-10%20agents%20%C2%B7%2045%20APIs-0ea5e9)](docs/providers/README.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-22c55e)](CONTRIBUTING.md)
[![Stars](https://img.shields.io/github/stars/KevalParikh22/conductor-ai?style=flat&color=f59e0b)](https://github.com/KevalParikh22/conductor-ai/stargazers)

[Quick start](#-quick-start) &middot; [How it works](#-how-it-works) &middot; [Routing](docs/ROUTING.md) &middot; [Security](SECURITY.md) &middot; [Providers](docs/providers/README.md) &middot; [**Guide**](docs/GUIDE.md) &middot; [Changelog](CHANGELOG.md)

</div>

> [!NOTE]
> **Early and moving fast (v0.9), solo-maintained.** 93 tests run in CI on Linux and macOS with Node 20, 22 and 24. The agents it drives change their CLI flags often; each one is a small preset you can override in config.

A Claude subscription runs out fast when Claude types every line. Claude is best at judgement: planning, design and catching bugs. **conductor-ai** keeps Claude (or any agent you choose) as the controller and quality gate, and hands the typing to Antigravity, Codex, OpenCode, free Kilo / OpenRouter / Groq / Gemini models, Kimi or local models. When one hits its limit, the next one takes over.

```bash
curl -fsSL https://raw.githubusercontent.com/KevalParikh22/conductor-ai/main/scripts/install.sh | bash
```

### 🎯 Why conductor-ai

| | Claude does everything | With conductor-ai |
|---|---|---|
| **Who types the code** | Claude, line by line | Antigravity, Codex, OpenCode, free APIs or a local model |
| **What Claude spends tokens on** | Everything | Planning, review and the hard parts |
| **When a quota runs out** | Work stops | The next provider takes over |
| **Checking the work** | You hope it's right | Your tests and lint run after every task; git is compared with the worker's report |
| **Who takes which task** | One model | Your rules: security work to your best agent, docs to a free model |

### ✨ At a glance

- **One controller, many workers.** Claude Code by default; Antigravity CLI, Codex CLI or OpenCode can be the controller too. Workers are picked per role (`build`, `fix`, `test`, `docs`, `review`, `ask`) from an ordered fallback chain.
- **Quota-aware fallback.** A rate-limited model first falls back to the provider's next model (`fallbackModels`); when none is left, the provider cools down (honouring `Retry-After`) and the next one starts on a clean tree. A worker that runs past its time limit (20 min, or 2× a task's `eta`) is stopped with everything it started. If every provider fails, the controller does the task itself.
- **Free first.** Default chains lean on Kilo Gateway (no key needed), OpenCode's free models, OpenRouter `:free`, Gemini API and other free tiers, so your paid quota goes to planning and review.
- **Every agent under its own rules.** Each CLI gets permission rules for that run: write roles edit only the project and can't push; read roles can't edit; your API keys stay out of their environment. Your own CLI settings are never touched.
- **Parallel tasks.** `conductor batch` runs independent plan tasks at the same time, each in its own git worktree and branch, spread across providers. The controller reviews and merges.
- **Trust, but check.** Your tests and lint run after every write task, and the worker's list of changed files is compared with what git shows. Plans must answer their open questions before any task is handed out.
- **Usage and budgets.** Every run is logged with time, tokens and known cost; set a daily budget and paid APIs stop when it's reached. `conductor runs` and the Runs page show who did what.
- **One skill library.** Write a skill once in conductor; every controller (Claude Code, Antigravity, Codex, OpenCode) loads it, and each worker gets the skills that match its task. Switch skills off per project. `conductor skills` or the Skills page.
- **Stays out of your git.** `conductor init` puts conductor's own files in `.gitignore`. Workers still see them in their worktrees, and edits to them are undone.
- **Works everywhere.** Install once, `conductor init` in any repo. CLI and MCP server. Settings page in the browser. Zero dependencies, no telemetry.

### 🧭 How it works

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

### 🖥️ See it

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

### ⚡ Quick start

```bash
npm install -g github:KevalParikh22/conductor-ai   # Node 20+
conductor setup                 # guided: finds your agents and keys, adds a free provider, tests
cd my-app && conductor init     # rules, commands, MCP entry
conductor add groq              # add any of 45 chat APIs: key, model, test, roles
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

Free API providers need no install: `kilo-free` works without a key; add more with `conductor add <name>` (45 chat APIs: [setup guides](docs/providers/README.md)). Full guide: [docs/GUIDE.md](docs/GUIDE.md).

</details>

<details>
<summary><b>Use a different controller</b></summary>
<br>

```bash
conductor init --controller antigravity   # GEMINI.md + skills in .agents/skills; then once: agy mcp add conductor conductor mcp
conductor init --controller codex-cli     # AGENTS.md + skills in .agents/skills; then once: codex mcp add conductor -- conductor mcp
conductor init --controller opencode      # AGENTS.md + skills in .agents/skills + opencode.json MCP entry
```

</details>

### 💸 Built to save tokens

- **Smart selector.** Every task tries the cheapest provider that can do it: free API models for small tasks with known files, agents for bigger ones, paid APIs last. Providers that keep failing drop to the end.
- **Compact diffs.** `conductor diff` is what the controller reviews: whitespace-only changes, lockfiles and build output are left out, and long files are cut. It prints how much smaller than `git diff` it was, every time.
- **Short reports.** The controller reads only the worker's RESULT block; tool transcripts stay in the run folder.
- **See what it kept out.** Every run's summary, `conductor usage` and the Runs page show an estimate of the context kept out of each model (counted from characters, not measured Claude usage).

### 🔀 You decide who does what

- **Per task:** add `- **provider:** codex-cli` to a plan task.
- **By rule:** `"routes": [{ "files": "src/frontend/**", "provider": "grok-cli" }]`, matched on files, task text or role.
- **Ready-made rules:** `conductor route --add starter` adds a starter set (security and database work to your strongest agent, docs and small edits to free models). There are 12 rules in the library; see the [routing guide](docs/ROUTING.md).
- **Preview:** `conductor route "task" --files a.tsx`, or Roles → Routing in the UI, shows where a task would go before anything runs.
- **Local models:** `conductor local` finds Ollama, LM Studio, llama.cpp and others running on your machine and turns them on.

### 🛡️ Every agent runs under its own rules

conductor passes each CLI its permission rules **for that run only**, through the CLI's own sandbox or permission system. No "skip all permissions" flags.

| Agent | Write roles (`build`, `fix`, `test`, `docs`) | Read roles (`review`, `ask`) |
|---|---|---|
| **Antigravity** (`agy`) | `--sandbox`: commands run without network, home folder read-only; build and test commands (`npx tsc`, `npx jest`, your verify command…) run without asking; `.git`, `.env` files and conductor's secrets denied | writes to the project denied |
| **Codex** | OS sandbox `workspace-write`, no network, never asks | OS sandbox `read-only` |
| **OpenCode** | edits inside the project; outside folders denied (shell not OS-sandboxed) | edits, web and mutating shell commands denied |
| **Claude Code** | edits auto-approved; other commands that would ask are refused | edit tools disabled |
| **Copilot CLI** | `--allow-all-tools` with git/sudo denied (deny wins); file tools limited to the project; shell not OS-sandboxed | write tools and shell denied |
| **Aider** | edits in the repo only; no shell, no auto-commits, project `.env` not loaded | `--dry-run` |
| **Grok Build** | kernel sandbox (`strict`): project and temp only, no network for commands on Linux; git/sudo denied | `read-only` sandbox, read tools only |
| **Kiro** | commands in its OS sandbox, network blocked; `.git` writes refused | only read and search tools |
| **Goose** | no permission control: use in a throwaway worktree | tool-less chat mode |
| **Kimi**, custom CLIs | no permission control: use in a throwaway worktree | ⚠ not enforced, runs warn |

For every agent: no `git push`, `commit`, `reset`, `checkout`, `rebase`, `stash`, `clean` or `sudo`; only the API key that CLI needs is passed to it. conductor adds its own guards on top: clean tree and non-protected branch for write roles, failed attempts stashed (never lost), and changes to `AGENTS.md`, plans and controller files reverted. Details and the exact flags: [Providers → Permissions](docs/PROVIDERS.md#permissions-what-each-agent-may-do).

**Is it safe?** Read [SECURITY.md](SECURITY.md): what conductor guards (sandboxes, scrubbed keys, git hooks and config restored after every worker, checked model output), what it can't (tests run code the worker wrote; agents can read what you can read; free routes may log prompts), and a checklist for sensitive projects.

### 🔌 Providers

| | Built in |
|---|---|
| **Local agents** | Antigravity CLI · Codex CLI · OpenCode · GitHub Copilot CLI · Grok Build · Kiro · Aider · Goose · Kimi CLI · Claude Code · any CLI you add |
| **Free APIs** | Kilo Gateway and OVHcloud (no key) · OpenRouter `:free` · Gemini API · Groq · Cerebras · Cohere trial · NVIDIA NIM · Hugging Face credits |
| **Gateways** | OpenRouter · Requesty · Vercel AI Gateway · Hugging Face · Cloudflare Workers AI · Poe · AI/ML API |
| **Model makers** | OpenAI · Claude API · Gemini · xAI · Mistral · DeepSeek · Kimi · Qwen · GLM · MiniMax |
| **Fast hosts** | Groq · Cerebras · SambaNova · Together · Fireworks · DeepInfra · Novita · Nebius · Baseten · and more |
| **Clouds** | Azure OpenAI · Amazon Bedrock · anything else through a LiteLLM proxy |
| **Local models** | Ollama · LM Studio · llama.cpp · vLLM · LocalAI · Jan |

Chat APIs can't run your tests, so conductor applies the files they return (refusing paths outside the repo) and runs verify for them. `conductor models <provider>` lists current models; free lists change weekly.

Every one has a setup guide: **[docs/providers](docs/providers/README.md)**. See them all with `conductor providers`; add one with `conductor add <name>` or the **Add a provider** gallery in `conductor ui`. Any other OpenAI-compatible endpoint works too.

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
| `conductor diff [branch]` | Compact diff to review: lockfiles and whitespace left out, new files included |
| `conductor route "task" [--files a,b]` · `conductor local [--enable]` | Where a task would go and why; find and turn on local models |
| `conductor retry <task> --note "…" [--provider p]` | The task's worker continues in its existing worktree with your note, instead of starting over |
| `conductor worktree [list]` · `conductor worktree rm <id>\|--all [--force]` | See and clean up worktrees |
| `conductor setup` · `conductor add <provider>` · `conductor providers` · `conductor keys` | Guided setup; add any of 45 chat APIs; list them; manage keys |
| `conductor init [--controller claude-code\|antigravity\|codex-cli\|opencode]` | Set up a project |
| `conductor ui` · `conductor status` · `conductor doctor [--live] [--details]` · `conductor verify` | Manage and check |
| `conductor runs [show <run>]` · `conductor usage [--days 7]` | Run history; runs, tokens and cost per provider |
| `conductor models [provider]` · `conductor cooldown [--clear]` · `conductor mcp` | Model lists, rate-limit state, MCP server |

Exit codes: `0` ok · `2` usage or unsafe repo state · `3` every provider failed (the controller takes over).

</details>

### 📚 Docs

| Page | What it covers |
|---|---|
| [**Guide**](docs/GUIDE.md) | **Start here:** install, global vs project setup, the daily workflow, controllers, skills, CLI and UI side by side, git, editors, cloud, troubleshooting |
| [Routing](docs/ROUTING.md) | Which worker takes which task: rule library and your own rules |
| [Provider guides](docs/providers/README.md) | One setup page for each of the 45 APIs and 10 agents |
| [Configuration](docs/CONFIGURATION.md) | Roles, providers, settings, config files |
| [Providers](docs/PROVIDERS.md) | Every provider, free tiers, permissions, adding your own |
| [Security](SECURITY.md) | What is protected, known limits, setup for sensitive code |
| [How it works](docs/ARCHITECTURE.md) | Design, safety model, parallel runs, inspirations |

### ⚖️ Honest limits

- Workers are weaker than Claude at judgement. That's why plans are detailed, tasks stay small, and every diff passes verify and the controller's review.
- Chat-only API models can't run your tests; prefer CLI agents for `build`, APIs for `docs`, `test` and `ask`.
- OpenCode's shell and agents without a sandbox (Kimi, custom CLIs) are only as contained as their own permission systems allow.
- Cost is only known for API providers with a `price` set; CLI agents on subscriptions are counted in runs and minutes.

### 🤝 Contributing · security · license

- 💬 **Questions and ideas:** [Discussions](https://github.com/KevalParikh22/conductor-ai/discussions).
- 🐛 **Bugs:** [open an issue](https://github.com/KevalParikh22/conductor-ai/issues/new/choose).
- 🧩 **New agent or provider:** use the provider request template, or send a PR (most are one preset in `src/presets.js` or one entry in `src/catalog.js`). See [CONTRIBUTING.md](CONTRIBUTING.md).
- 🔒 **Security problems:** report them privately as described in [SECURITY.md](SECURITY.md).

MIT licensed.

<div align="center">
<br>
<sub>If conductor-ai saves you quota, a ⭐ helps the next person find it.</sub>
</div>
