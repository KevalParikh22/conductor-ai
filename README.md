# conductor-ai

**One controller, many models.** Let Claude Code (or any agent you choose) plan, review and commit, while Antigravity, Codex, OpenCode, free Kilo / OpenRouter / OpenCode Zen models, Kimi, local models and more do the bulk of the coding, testing and documentation, with automatic fallback when one hits its limit.

```
                      you ──▶ Controller (Claude Code by default)
                              plans · decides · reviews · commits
                                        │  conductor run <role>   (CLI or MCP)
     ┌──────────────┬───────────────────┼──────────────────┬──────────────┐
   build           fix                test               docs        review / ask
 antigravity →   codex-cli →        opencode →        openrouter-free →  codex-cli →
 codex-cli →     antigravity →      kilo-free →        kilo-free →        antigravity →
 opencode        opencode           openrouter-free →  opencode-zen →     gemini-api
                                    antigravity        opencode → …
     └──── rate limit / failure → next provider · all failed (exit 3) → controller does it ────┘
```

**Why:** a Claude subscription runs out fast if Claude types every line. Claude is best at judgement: planning, design and catching bugs in review. Typing can be done by models you already have for free or cheap. conductor keeps Claude as the quality gate and spends its tokens only where they matter.

## Features

- **Controller you can change.** Claude Code by default; Antigravity CLI, Codex CLI, OpenCode or Gemini CLI also work. `conductor init` writes the right instruction file, slash commands and MCP entry for your controller.
- **Roles with fallback chains.** `build`, `fix`, `test`, `docs`, `review`, `ask`, each with its own ordered list of providers.
- **Local and cloud providers.**
  - **Local agents:** Antigravity CLI (`agy`), Codex CLI, OpenCode, Kimi CLI, Claude Code and Gemini CLI (API key only). They use your logins, edit files and run tests.
  - **Cloud APIs:** free tiers from Kilo Gateway (no key needed), OpenCode Zen, OpenRouter (`:free` models), Gemini API, Groq, Cerebras, Mistral (Codestral) and NVIDIA NIM; paid OpenAI, Kimi/Moonshot, Claude and DeepSeek; or any OpenAI-compatible endpoint. conductor applies the code they return.
  - **Local models:** Ollama and LM Studio.
- **Parallel tasks.** `conductor batch --plan p.md --tasks T2,T3,T4` runs independent tasks at the same time, each in its own git worktree and branch, spread across different providers. The controller reviews and merges each branch.
- **Rate-limit aware.** Detects quota errors (HTTP 429, CLI messages), cools that provider down (honouring `Retry-After`) and moves to the next one.
- **Safe by default.**
  - Write roles need a clean git tree on a non-protected branch.
  - A failed attempt is **stashed**, never lost, and the next provider starts clean.
  - Workers can't touch protected files (`AGENTS.md`, plans, `.env`, `.git`, controller config).
  - Read-only roles warn you if a worker modified anything.
- **Verify gate.** Runs your tests and lint after each write task, using the command from `AGENTS.md` or auto-detected for npm, pytest, cargo, go or make.
- **Settings UI.** `conductor ui` opens a local page to choose the controller, order providers per role, pick models (including a live list of free OpenRouter models), store API keys and test connections.
- **Works on every project.** Install once, then `conductor init` in any repo. Global settings live in `~/.config/conductor` and each project can override them.
- **Two interfaces.** A CLI (`conductor run …`) and an MCP server (`conductor mcp`), so any MCP-capable controller can call it as native tools.
- **No dependencies.** Plain Node.js 20+.

## Quick start

```bash
npm install -g github:KevalParikh22/conductor-ai
```
```bash
conductor setup
```
Install and sign in to your workers (at least one):
```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash && agy
```
```bash
npm install -g @openai/codex && codex login
```
Add conductor to a project:
```bash
cd my-app && conductor init
```
Choose providers, models, order and keys:
```bash
conductor ui
```
Check that everything responds:
```bash
conductor doctor --live
```

Then in Claude Code, inside the project:

```
/conduct-plan add password reset by email
/conduct-run docs/plan/password-reset.md
```

Full guide: **[docs/INSTALL.md](docs/INSTALL.md)**.

## How a feature gets built

1. **Plan (controller).** `/conduct-plan` writes `docs/plan/<slug>.md`: concrete design notes plus small tasks (1–3 files each), each with a role, acceptance criteria and a verify command.
2. **Delegate.** For each task, `conductor run build --plan … --task T3` sends it to the first ready provider in the `build` chain.
3. **Verify.** conductor runs your verify command and prints a summary: who did it, their `RESULT` line, changed files and verify PASS/FAIL.
4. **Controller checks.** Claude reads `git diff`, then commits, fixes small issues itself, or retries with another provider and a `--note`. If a task fails twice, Claude does it.
5. **Tests and docs.** These go to free models (`test` and `docs` roles).
6. **Review.** A second model (`review` role) reviews the branch, and Claude triages the findings.

## Commands

| In your controller | What it does |
|---|---|
| `/conduct-status` | Providers ready, missing or cooling down, plus role chains |
| `/conduct-plan <feature>` | Writes a plan of delegable tasks |
| `/conduct-run <plan>` | Executes the whole plan with workers, then review |
| `/conduct-build <plan> <task> [provider]` | Runs one task |
| `/conduct-test <what>` · `/conduct-docs <what>` | Tests and docs via free models |
| `/conduct-review [--plan f]` | Second-opinion review, triaged by the controller |
| `/conduct-ask <question>` | Codebase questions answered by a big-context model |
| `/conduct-handoff` | Updates `HANDOFF.md` so any tool can continue |

| CLI | |
|---|---|
| `conductor run <role> [task] [--plan f --task T1] [--provider p] [--chain a,b] [--note …] [--files a,b] [--json]` | Delegate with fallback |
| `conductor build\|fix\|test\|docs\|review\|ask …` | Shortcuts for `run <role>` (add `--worktree` to run isolated on branch `conductor/<id>`) |
| `conductor batch --plan f --tasks T2,T3 [--concurrency 4]` | Run independent tasks in parallel, one worktree each |
| `conductor worktree [list]` · `conductor worktree rm <id>\|--all [--force]` | See and clean up parallel-task worktrees |
| `conductor init [--controller claude-code\|antigravity\|codex-cli\|opencode\|gemini-cli]` | Set up a project |
| `conductor ui` · `conductor status` · `conductor doctor [--live]` · `conductor verify` | Manage and check |
| `conductor models [provider]` · `conductor cooldown [--clear]` · `conductor mcp` | Free model list (OpenRouter, Kilo, OpenCode Zen, …), rate-limit state, MCP server |

Exit codes: `0` ok · `2` usage or unsafe repo state · `3` every provider failed (the controller takes over).

## Docs

- [Installation guide](docs/INSTALL.md): step by step, for all projects
- [Configuration](docs/CONFIGURATION.md): roles, providers, settings, config files
- [Providers](docs/PROVIDERS.md): every supported provider, free tiers, how to add your own
- [Local, cloud and CI](docs/CLOUD.md): Claude Code on the web, GitHub Actions, servers
- [How it works](docs/ARCHITECTURE.md): design, safety model, and the projects that inspired it

## Honest limits

- Workers are weaker than Claude at judgement. That is why Claude plans in detail, tasks stay small, and every diff passes a verify gate and Claude's review.
- Chat-only API models can't run your tests; conductor runs verify for them. Prefer CLI agents for `build` and use APIs for `docs`, `test` and `ask`.
- Free tiers change often (models come and go, limits shift). `conductor models` and the UI show the live list.
- CLI flags change between versions. Each CLI's command line is a small preset you can override in config (see [Providers](docs/PROVIDERS.md)).

## License

MIT
