# conductor-ai guide

Everything you need to use conductor-ai, in the order you'll need it.

**Reference pages** for the details:
- [Configuration](CONFIGURATION.md): every setting and field.
- [Routing](ROUTING.md): who takes which task.
- [Providers](PROVIDERS.md) and the [provider guides](providers/README.md).
- [Security](../SECURITY.md).
- [How it works](ARCHITECTURE.md).

**Contents:**
1. [What conductor-ai is](#1-what-conductor-is)
2. [Global or project: what lives where](#2-global-or-project-what-lives-where)
3. [Install (once per machine)](#3-install-once-per-machine)
4. [Set up a project (once per project)](#4-set-up-a-project-once-per-project)
5. [Daily workflow](#5-daily-workflow)
6. [Controllers](#6-controllers)
7. [Skills: one library for every controller and worker](#7-skills-one-library-for-every-controller-and-worker)
8. [CLI and UI side by side](#8-cli-and-ui-side-by-side)
9. [conductor-ai's files and git](#9-conductors-files-and-git)
10. [Limits, time limits and fallback](#10-limits-time-limits-and-fallback)
11. [tmux and editors](#11-tmux-and-editors)
12. [Cloud, CI and servers](#12-cloud-ci-and-servers)
13. [Update and uninstall](#13-update-and-uninstall)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. What conductor-ai is

One **controller** (Claude Code by default; or Antigravity, Codex or OpenCode) plans and reviews. **Workers** (other agents, free or cheap API models, local models) do the typing. conductor-ai sits between them: it picks the worker, falls back when one hits a limit, sandboxes it, runs your tests and checks the worker's claims against git.

You use conductor-ai in three ways, and they all do the same things:

| Way | For |
|---|---|
| **Your controller**: `/conduct-plan`, `/conduct-run` (commands or skills) | Normal work: you talk to Claude (or Gemini, Codex…) and it uses conductor-ai |
| **The CLI**: `conductor-ai …` | Setup, checks, and running tasks yourself |
| **The UI**: `conductor-ai ui` | The same setup and history in the browser |

The controller reaches conductor-ai through its **MCP server** (`conductor-ai mcp`). Its tools:
- `conductor_ai_run`, `conductor_ai_batch`, `conductor_ai_retry`: run tasks.
- `conductor_ai_diff`, `conductor_ai_runs`: review what ran.
- `conductor_ai_plan_check`, `conductor_ai_route`, `conductor_ai_skills`, `conductor_ai_status`: check a plan and see how work will be handled.
- `conductor_ai_verify`: run your checks.
- `conductor_ai_stats`, `conductor_ai_doctor`, `conductor_ai_rules`, `conductor_ai_lessons`: quality numbers, health, project rules and lessons.

Each tool also takes an optional `project` path. Every action and where it lives (CLI, MCP, UI): [SURFACES.md](SURFACES.md).

Run reports are also **MCP resources**: `conductor-ai://runs/latest` and `conductor-ai://runs/<id>` (listed newest first) hold a run's summary, the checklist that decides "done", and the worker's report, so a controller can open one like a file instead of calling a tool.

---

## 2. Global or project: what lives where

conductor-ai reads **built-in defaults → your global settings → the project's settings**. The project wins.

| Where | Path | Holds |
|---|---|---|
| **Global** (all projects) | `~/.config/conductor-ai/` | `config.json`: providers, roles, settings. `secrets.env`: API keys, mode 600. `skills/`: your skill library. Also run usage, cooldowns, task worktrees |
| **Project** | `<project>/.conductor-ai/` | `config.json`: controller, project overrides (roles, routing rules, verify, skills switched off). `skills/`: project-only skills. `runs/`: history |
| **Project rules** | `AGENTS.md` (+ `CLAUDE.md` / `GEMINI.md`) | Stack, conventions and the **Verify** command. Every worker reads it |

**What to put where:**
- **Set once globally:**
  - providers and their models;
  - API keys (always global, never in a project);
  - your skill library;
  - time limits and budgets.
- **Set per project:**
  - the controller;
  - the Verify command;
  - routing rules (`conductor-ai route --add starter` saves to the project);
  - role tweaks for that codebase;
  - which skills are off.

**In the UI**, the **Save to** selector at the top picks where a change goes: Global (all projects) or This project.

---

## 3. Install (once per machine)

**Needs:**
- Node.js 20+ and git.
- Linux or macOS (on Windows, use WSL).
- A controller (Claude Code, Antigravity CLI, Codex CLI or OpenCode).
- At least one worker. `kilo-free` works with no install and no key.

```bash
curl -fsSL https://raw.githubusercontent.com/KevalParikh22/conductor-ai/main/scripts/install.sh | bash
```
That one line checks Node, installs conductor-ai and runs `conductor-ai setup`. You can also install with `npm install -g github:KevalParikh22/conductor-ai`, then run:
```bash
conductor-ai setup
```
Setup does the following:
- Finds the agents and API keys you already have and turns them on.
- **Never turns on your controller as a worker** (that would spend the quota conductor-ai saves).
- Skips local models that are too small to code (under 7B).
- Offers a free provider.

`conductor-ai setup --yes` does the same without questions.

**Workers (install the ones you'll use):**

| Worker | Install | Sign in |
|---|---|---|
| Antigravity CLI (`agy`) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | run `agy` once (Google) |
| Codex CLI | `npm install -g @openai/codex` | `codex login` |
| OpenCode (free models) | `curl -fsSL https://opencode.ai/install \| bash` | `opencode auth login` if your model needs it |
| Copilot, Kiro, Grok, Aider, Goose, Kimi | listed by `conductor-ai doctor` and in the UI's Setup page | |
| Local models | Ollama / LM Studio running, then `conductor-ai local --enable` | |

**API providers (optional):** `conductor-ai providers --free` lists 45. `conductor-ai add groq` then asks for the key (hidden input), lets you pick a model, tests it and adds it to the roles. To manage keys: `conductor-ai keys`, or the UI's **API keys** page.

**Plugin (recommended for Claude Code and Antigravity):** it brings the `conduct-*` skills, conductor-ai's MCP tools and a startup check, in one install per machine. You still need the CLI installed, since the plugin calls it.

| Tool | Install |
|---|---|
| Claude Code | `/plugin marketplace add KevalParikh22/conductor-ai`, then `/plugin install conductor-ai@conductor-ai`. On Claude Code 2.1.275 or later, one step: `/plugin install conductor-ai --marketplace KevalParikh22/conductor-ai` |
| Antigravity | `agy plugin install "$(npm root -g)/conductor-ai"` (or the path of a clone) |

Notes:
- In Claude Code, plugin skills are namespaced: `/conductor-ai:conduct-plan`. The project's own `/conduct-plan` from `conductor-ai init` works too.
- With the plugin, Antigravity needs no `agy mcp add` step.
- The startup check tells you when the CLI is missing or the project isn't set up.

**Check:** `conductor-ai doctor --live` sends one tiny prompt to each enabled provider.
- ✓ ready.
- ○ optional (add a key to use it).
- ✗ needs a fix, and the line says how.

---

## 4. Set up a project (once per project)

The sequence:

| # | Command | What it does |
|---|---|---|
| 1 | `git init` + one commit (if new) | Write roles need git. Workers never write on `main`/`master`, so work on a branch |
| 2 | `conductor-ai init` (or `--controller antigravity`, `codex-cli`, `opencode`) | Writes the rules file, the controller's commands or skills, the MCP entry, the plan template, and **adds conductor-ai's files to `.gitignore`** (section 9). Detects your Verify command. Syncs your skills |
| 3 | Check `AGENTS.md` | The **Verify** line was detected (e.g. `npm run test`, `vendor/bin/phpunit`); correct it if needed. Fill in section 1: stack, folders, conventions |
| 4 | `conductor-ai route --add starter` | Routing starter set: security and database work to your strongest agent; docs and small edits to free models |
| 5 | Register MCP if your controller needs it | Antigravity: `agy mcp add conductor-ai conductor-ai mcp`. Codex: `codex mcp add conductor-ai -- conductor-ai mcp`. Once per machine; init tells you when it's missing |
| 6 | `conductor-ai doctor --live` | Everything ready? |
| 7 | `git add .gitignore && git commit -m "conductor-ai: ignore local files"` | conductor-ai's own files stay out of git; only `.gitignore` changes |

Running `conductor-ai init` again is safe: it refreshes conductor-ai's files and never overwrites yours.

---

## 5. Daily workflow

In your controller, inside the project:

| Step | In your controller | What to do |
|---|---|---|
| 1. Plan | `/conduct-plan add password reset` | Answer the plan's **open questions**. Keep tasks small (1–3 files) with files, acceptance and a verify line. Add `- **eta:** 1h` to big tasks |
| 2. Run | `/conduct-run docs/plan/password-reset.md` | Independent tasks run **in parallel**, each in its own worktree on branch `conductor-ai/<id>`, spread across workers |
| 3. Review | `conductor-ai diff conductor-ai/T3` | The compact diff: lockfiles and whitespace left out. Check verify passed |
| 4a. Good | `git merge --no-ff conductor-ai/T3`, then `conductor-ai worktree rm T3` | |
| 4b. Close but wrong | `conductor-ai retry T3 --note "what to fix"` | **The same worker fixes its own work** in place, on the same branch |
| 4c. Wrong | `conductor-ai worktree rm T3 --force`, then rerun with `--provider <other>` | |
| 5. End of day | `/conduct-handoff` | Updates `HANDOFF.md` so any controller can continue tomorrow |

**From the terminal instead:**
- `conductor-ai build --plan docs/plan/x.md --task T1 --worktree`
- `conductor-ai batch --plan docs/plan/x.md --tasks T1,T2,T3`
- `conductor-ai review`

**What makes the biggest difference, in order:**
1. A correct Verify command.
2. Small tasks with files listed.
3. Accurate project facts in AGENTS.md.
4. Retrying with a note instead of rewriting the work yourself.
5. Routing rules.

**Free web chats, by hand.** DeepSeek, Kimi, Qwen, Gemini or ChatGPT in the browser (deep-research modes too) can do a task, with you carrying it there and back. conductor-ai never opens the chat, never holds cookies and never logs into an account.
1. `conductor-ai build --plan docs/plan/x.md --task T3 --provider manual` writes the whole prompt (task, design notes, files, the reply format) to the run folder, copies it to the clipboard when it can, and waits (exit 5).
2. Paste it into the chat, and save the chat's whole answer to a file.
3. `conductor-ai import <run> answer.md` (or `-` to paste on stdin) runs the answer through every check, like any worker's: file blocks applied (protected files refused), verify, acceptance checks, scope. The run page in `conductor-ai ui` does the same with Copy prompt and a paste box.
- A deep-research report: `conductor-ai import --research report.md` saves it in `docs/research/`, for `ask --files` and your controller.
- A chat with a smaller limit: add your own provider (e.g. `"deepseek-web": { "type": "manual", "enabled": true, "maxPromptChars": 60000 }`). A prompt over the limit isn't written, and the run stops there instead of spending another worker's quota.

---

## 6. Controllers

| Controller | Commands | conductor-ai's MCP tools | One-time step |
|---|---|---|---|
| **Claude Code** | `/conduct-*` in `.claude/commands` (or the plugin's skills) | from `.mcp.json` or the plugin | Approve the "conductor-ai" server when Claude asks, or install the plugin |
| **Antigravity** (Gemini) | `conduct-*` skills in `.agents/skills` (or the plugin's skills) | only from agy's own config or a plugin | Install the plugin (section 3), or `agy mcp add conductor-ai conductor-ai mcp` |
| **Codex** | `conduct-*` skills in `.agents/skills` | only from `~/.codex/config.toml` | `codex mcp add conductor-ai -- conductor-ai mcp` |
| **OpenCode** | `conduct-*` skills in `.agents/skills` | from `opencode.json` | none |

**To switch a project's controller:**
- CLI: `conductor-ai init --controller <name>`.
- UI: **Settings → Controller → "Switch this project to …"**.

Workers read `AGENTS.md` whatever the controller.

---

## 7. Skills: one library for every controller and worker

A skill is a folder with a `SKILL.md`: a name, a description, and instructions. It's the format Claude Code, Antigravity, Codex and OpenCode all read. You keep **one library in conductor-ai**, and conductor-ai delivers it everywhere:
- **Controllers:** the active skills are copied into `.claude/skills/` and `.agents/skills/`, so each tool loads them natively, on demand.
- **Workers:** each task gets only the skills that match it. Agents get the skill's name, description and path, and open what they need. API models get the text, up to about 6,000 characters.

**Where skills live:**
- `~/.config/conductor-ai/skills/<name>/`: **every project** (the universal set).
- `.conductor-ai/skills/<name>/`: **this project only**. Wins over a global skill with the same name.

**Thinning out per project:** every global skill is on by default. Switch off the ones a project doesn't need; the choice is saved in that project's `.conductor-ai/config.json` → `skills.off`.

**When a skill reaches workers:** optional `metadata` in the frontmatter, matched like routing rules. A skill without metadata goes to every task.
```markdown
---
name: php-conventions
description: How PHP modules, plugins and DI are written in this codebase
metadata:
  files: "*.php, app/code/**"
  roles: build, fix, test
---

# PHP conventions
…
```

| Task | CLI | UI (Skills page) |
|---|---|---|
| See the library and what's on here | `conductor-ai skills` | the list, with on/off toggles |
| Create | `conductor-ai skills new php-conventions --description "…" --files "*.php" [--project]` | **New skill** |
| Add an existing skill folder | `conductor-ai skills add ./path/to/skill [--project]` | put it in the library folder, then **Sync now** |
| Switch off/on for this project | `conductor-ai skills off <name>` / `on <name>` | the toggle |
| Edit | edit its `SKILL.md`, then `conductor-ai skills sync` | **Edit** → Save (syncs) |
| Remove from the library | `conductor-ai skills rm <name>` | **Remove from library** |
| Copy into the controller folders now | `conductor-ai skills sync` | **Sync now** |

**Notes:**
- Changes from the CLI or the UI sync straight away, and `conductor-ai init` syncs too.
- conductor-ai only replaces or removes skill folders it created. A skill you put in `.claude/skills/` yourself is left alone.
- Each run's summary has a `skills:` line naming the skills the worker got.

---

## 8. CLI and UI side by side

| Task | CLI | UI |
|---|---|---|
| Overview: controller, ready providers, role chains | `conductor-ai status` | **Overview** |
| Check providers | `conductor-ai doctor [--live]` | **Providers** → Test |
| Add a provider | `conductor-ai add <name>` | **Providers → Add provider** |
| API keys | `conductor-ai keys [set NAME]` | **API keys** |
| Local models | `conductor-ai local [--enable]` | **Providers** → Local models panel |
| Role chains (fallback order) | edit `roles` in config | **Roles** |
| Routing rules | `conductor-ai route --templates / --add / --rules / --rm` | **Roles → Routing** |
| Preview where a task goes | `conductor-ai route "task" --files a.ts` | **Roles → Routing → Preview** |
| Skills | `conductor-ai skills …` | **Skills** |
| Controller | `conductor-ai init --controller <name>` | **Settings → Controller** |
| Settings (limits, budget, verify) | config file | **Settings** |
| Run history and usage | `conductor-ai runs`, `conductor-ai usage` | **Runs** |
| Machine checks and install help | `conductor-ai setup` | **Setup** |

---

## 9. conductor-ai's files and git

`conductor-ai init` keeps conductor-ai's files **out of git** by adding a marked block to `.gitignore`, creating the file if needed:
```
# >>> conductor-ai: local files, not committed (conductor-ai init --share keeps them in git)
.conductor-ai/
docs/plan/
.claude/commands/conduct-*
.agents/skills/conduct-*/
AGENTS.md
…
# <<< conductor-ai
```
**What goes in the block:**
- conductor-ai's folders (`.conductor-ai/`, plans, its own commands and skills).
- The files **it created** (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `HANDOFF.md`, `docs/architecture.md`, MCP configs). A file you already had before `init` is never added.
- If something was already committed, `init` prints the `git rm --cached` line to stop tracking it.
- Synced copies of your skills are hidden through `.git/info/exclude`, which is local to your clone and never committed. So adding or switching a skill doesn't change `.gitignore`.

**Workers still see these files.** conductor-ai copies them into each task's worktree. Because git can't see changes to ignored files, conductor-ai keeps its own copy during a run and **puts back** any it finds a worker changed, with a warning.

**To share conductor-ai's files with your team** (commit `AGENTS.md`, plans and skills): `conductor-ai init --share` removes the block.

---

## 10. Limits, time limits and fallback

- **Rate limits.** A rate-limited model first falls back to the provider's next model (`fallbackModels`). Then the provider cools down and the next provider in the chain runs. Free API providers find fallback models themselves.
- **Time limits.**
  - A worker is stopped at 20 minutes, or 2× a task's `eta:`, or the `--timeout` you give. Everything it started is stopped too, and the next provider runs.
  - Free API routes give up after 90 seconds, since they sometimes hang.
- **If every worker fails:** exit code 3. The controller does the task itself.
- **Measure it: `conductor-ai eval`.** A suite of fixed tasks (bug fixes, features, test-writing) with hidden tests the worker never sees. `conductor-ai eval run` runs them with your routing (or `--provider` / `--chain`), scores each against the hidden tests, and compares conductor-ai's verdict with reality: the key number is **"done" but wrong**. `--compare last` shows the change since the previous run. `conductor-ai eval check` proves every task is fair without any LLM. `conductor-ai stats --failures` lists why work failed, biggest cause first.
- **Guards (opt-in):** `conductor-ai guard on` makes your controller's `git push` fail while the last `conductor-ai verify` failed (Claude Code and Antigravity); committing stays allowed, since a commit is local and easy to fix. Fix and `conductor-ai verify` again, or `conductor-ai guard allow` once. Claude Code also reminds you on Stop of task branches waiting for review.
- **Workers start with the facts:** before a write task, conductor-ai gives the worker its files, where that code is used elsewhere (so callers keep working), the verify command and the matching `docs/architecture.md` sections. A provider can also get its own note via `promptExtra` in its settings.
- **Project rules, one source for every controller:** `conductor-ai rules new api-errors --paths "src/api/**"` creates `.conductor-ai/rules/api-errors.md`; `conductor-ai rules sync` (and `init`) writes it in each controller's own format, and workers get the rules for their files. `init` also adds a `conductor-reviewer` subagent you can ask to review a worker's diff in a fresh context. `conductor-ai doctor` checks these files.
- **Lessons:** what failed before in this project (and every `--note` you write) goes into later workers' prompts for the same area, and a provider that keeps failing a kind of work moves to the back. `conductor-ai lessons` lists them; `promote` turns one into a rule in AGENTS.md. When that provider later passes the same kind of work here, its earlier failures are marked resolved and stop moving it back (the guidance stays). A lesson seen 3 times is offered as a rule in the run summary (`promote?:`); promoting stays your call.
- **Risky work gets a second opinion:** big changes, security-related files, or `review: yes` in the plan are reviewed by a model from a different family than the worker's. Only findings on changed lines are kept, and they're advice for the controller, never an override of passing checks.
- **Wrong tests are recognised:** if verify fails but every acceptance check passes and the code alone passes the original tests, conductor-ai says the worker's own test is the problem, and the hand-off asks for the test to be fixed, not the code.
- **Best of several attempts (`--samples N`):** the task runs on N providers in parallel, each through every check; conductor-ai keeps the best by results (done, then checks met, then smallest diff) and removes the rest. Off by default.
- **Fixes start from the bug:** a fix task's `repro:` command must fail before the worker and pass after. Without one, the worker's new test must fail on the original code (conductor-ai checks it in a temporary checkout), or the fix is partial.
- **Acceptance criteria are run:** a line like `` `add(2, 3)` returns `5` `` or `` `parse('x')` throws SyntaxError `` is turned into a check conductor-ai runs itself after the worker (JavaScript for now). A failure makes the task partial, whatever the worker claimed.
- **Failed work is handed on, with the error:** if verify fails, conductor-ai writes a short brief (failing tests, error, file:line) and gives the work once to the next provider in the chain, which fixes it in place. The brief is also in the summary (`why:`) for your `--note`.
- **Edits are guarded:** a worker's changed files are syntax-checked, any function or class the task names in `code` must exist afterwards, and in JavaScript/TypeScript the ones the acceptance checks call must be exported by that name; otherwise the attempt is rejected and the next provider runs. Chat models (no tools) get a project map and, if they answer without files, one repair turn.
- **Plans are checked before work starts:** `conductor-ai plan check <plan>` (also run automatically, and the MCP tool `conductor_ai_plan_check`). A write task needs `files:`, acceptance criteria a check can confirm, a verify command and at most 4 files besides tests; otherwise conductor-ai refuses it and says what is missing. `--allow-weak-plan` overrides.
- **Acceptance is answered, not assumed:** the task's criteria are repeated at the end of the worker's prompt, and the worker must answer each one with evidence in an `## Acceptance` section. A DONE that leaves any unanswered or unmet is **partial**.
- **Checks before and after a task:**
  - **The starting commit is checked first.** conductor-ai runs verify on the commit the worker starts from (once per commit). If it already fails, the worker is told, and the result says which failure lines are new.
  - **Scope:** when a task lists `files:`, changing other files (beyond their tests, lockfiles and snapshots) makes the outcome **out of scope**, with the files listed. `--allow-scope` accepts it.
- **No proof, no "done":** code a worker wrote counts as done only when the verify command ran and passed. Without a verify command the outcome is **unverified** and the exit code is 4. Set one with `conductor-ai init --verify "<cmd>"` (or the Verify line in AGENTS.md). `--no-verify` and `--allow-unverified` accept unverified work on purpose.
- **If the controller runs out:** run `/conduct-handoff` while you still can. Then open another agent and say: *"Read HANDOFF.md and act as the controller described in .conductor-ai/ORCHESTRATOR.md."*

Details: [Configuration](CONFIGURATION.md#time-limits-and-model-fallback).

---

## 11. tmux and editors

**tmux** (long and parallel runs: the controller on the left, live runs and a shell on the right):
```bash
tmux new-session -d -s conductor-ai -c "$PWD" 'claude' \; split-window -h -c "$PWD" 'while :; do clear; conductor-ai runs --limit 15; sleep 5; done' \; split-window -v -c "$PWD" \; select-pane -t 0 \; attach
```
**Notes:**
- Replace `claude` with your controller.
- Detach with `Ctrl-b d` and come back with `tmux attach -t conductor-ai`; workers keep going.
- Run the UI in a pane with `conductor-ai ui --no-open`. On a server, tunnel it first: `ssh -L 4545:127.0.0.1:4545 host`.

**VS Code:**
- **Claude Code extension:** it reads the same `.mcp.json` and `/conduct-*` commands as the terminal.
- **Copilot agent mode** (and other MCP extensions): `conductor-ai init --vscode` writes `.vscode/mcp.json`. It does this automatically when the project already has a `.vscode/` folder. Then ask the agent, e.g. *"use conductor_ai_run with role test to add tests for src/auth"*.
- **Cursor:** reads `.cursor/mcp.json` in the `.mcp.json` shape.
- **Review as you go:** keep Source Control open. Workers never commit on your branch, and parallel tasks appear as `conductor-ai/<id>` branches.
- **"command not found" from an editor:** editors started from the dock often lack your shell's PATH. Use the full path from `which conductor-ai` as `command` in the MCP entry.

---

## 12. Cloud, CI and servers

| Environment | CLI agents (logins) | API keys | Local models |
|---|---|---|---|
| Laptop / desktop | ✓ | ✓ | ✓ |
| Server / devbox | ✓ if installed and signed in there | ✓ | ✓ with the hardware |
| Claude Code on the web | only CLIs that take API keys | ✓ | ✗ |
| GitHub Actions | only CLIs that take API keys | ✓ | ✗ |

On your machine, use signed-in agents for `build` and APIs for docs, tests and questions. In the cloud, agents that aren't installed are skipped, so chains fall through to API providers by themselves.

**Claude Code on the web:**
1. Add `npm install -g github:KevalParikh22/conductor-ai` to the environment's setup script.
2. Provide keys as environment variables (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`…). `kilo-free` needs none.
3. Allow those hosts in the network settings.
4. Commit what the cloud session needs: run `conductor-ai init --share`, or commit the specific files. With the default `.gitignore` block, a fresh clone doesn't have conductor-ai's files.

**GitHub Actions:** see [`examples/github-action.yml`](../examples/github-action.yml). A standalone docs refresh on free models:
```yaml
- run: |
    git switch -c docs/auto-${{ github.run_id }}
    conductor-ai run docs "Update the README usage section" --files src/cli.js,README.md --chain kilo-free,openrouter-free
```

**Mixed chains** work anywhere: `"test": ["ollama", "opencode", "kilo-free"]` uses Ollama on your laptop and falls through to Kilo in CI.

---

## 13. Update and uninstall

**Update:** install again, then refresh each project.
```bash
npm install -g github:KevalParikh22/conductor-ai
```
```bash
conductor-ai init
```

**Remove from a project:**
1. Delete conductor-ai's files:
   ```bash
   rm -rf .conductor-ai .claude/commands/conduct-*.md .agents/skills/conduct-*
   ```
2. Remove the `<!-- conductor-ai:… -->` blocks from `CLAUDE.md`, `GEMINI.md` and `AGENTS.md`.
3. Remove the `conductor-ai` MCP entry and the conductor-ai block in `.gitignore`.

**Remove from the machine:**
```bash
npm uninstall -g conductor-ai
```
Your settings, keys and skill library are kept in `~/.config/conductor-ai`; delete that folder too if you want them gone.

---

## 14. Troubleshooting

| Problem | Fix |
|---|---|
| `working tree is dirty` | Commit or stash first; that's what makes stash-on-failure safe. After `init`, commit `.gitignore` |
| `on protected branch "main"` | `git switch -c feat/<name>`. Workers never write on main |
| Controller doesn't see conductor-ai's tools | Section 6: approve it (Claude), or register it once (Antigravity, Codex) |
| `/conduct-*` or `conduct-*` skills missing | Open the controller in the project folder, or run `conductor-ai init` again |
| Antigravity attempt `denied: command`, or the warning "refused N action(s)" | agy needed a shell command that has no allow rule; headless runs can't ask. Add it to `allowCommands` in Settings (the verify command and common build/test commands are allowed already) |
| `conductor-ai: command not found` inside the controller | Install globally so its shell finds it (`which conductor-ai`) |
| A worker always fails | Its log is `.conductor-ai/runs/<run>/<provider>.log`: usually a login, or changed CLI flags |
| A free route hangs | It gives up after 90 seconds and tries another model, then the next provider (section 10) |
| A skill isn't loaded | `conductor-ai skills` shows whether it's on; `conductor-ai skills sync` copies it again |
| UI says wrong token | Open the full URL printed by `conductor-ai ui` (the token is after `#t=`) |
