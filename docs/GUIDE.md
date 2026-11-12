# conductor guide

Everything you need to use conductor, in the order you'll need it.

**Reference pages** for the details:
- [Configuration](CONFIGURATION.md): every setting and field.
- [Routing](ROUTING.md): who takes which task.
- [Providers](PROVIDERS.md) and the [provider guides](providers/README.md).
- [Security](../SECURITY.md).
- [How it works](ARCHITECTURE.md).

**Contents:**
1. [What conductor is](#1-what-conductor-is)
2. [Global or project: what lives where](#2-global-or-project-what-lives-where)
3. [Install (once per machine)](#3-install-once-per-machine)
4. [Set up a project (once per project)](#4-set-up-a-project-once-per-project)
5. [Daily workflow](#5-daily-workflow)
6. [Controllers](#6-controllers)
7. [Skills: one library for every controller and worker](#7-skills-one-library-for-every-controller-and-worker)
8. [CLI and UI side by side](#8-cli-and-ui-side-by-side)
9. [conductor's files and git](#9-conductors-files-and-git)
10. [Limits, time limits and fallback](#10-limits-time-limits-and-fallback)
11. [tmux and editors](#11-tmux-and-editors)
12. [Cloud, CI and servers](#12-cloud-ci-and-servers)
13. [Update and uninstall](#13-update-and-uninstall)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. What conductor is

One **controller** (Claude Code by default; or Antigravity, Codex or OpenCode) plans and reviews. **Workers** (other agents, free or cheap API models, local models) do the typing. conductor sits between them: it picks the worker, falls back when one hits a limit, sandboxes it, runs your tests and checks the worker's claims against git.

You use conductor in three ways, and they all do the same things:

| Way | For |
|---|---|
| **Your controller**: `/conduct-plan`, `/conduct-run` (commands or skills) | Normal work: you talk to Claude (or Gemini, Codex…) and it uses conductor |
| **The CLI**: `conductor …` | Setup, checks, and running tasks yourself |
| **The UI**: `conductor ui` | The same setup and history in the browser |

The controller reaches conductor through its **MCP server** (`conductor mcp`). Its tools:
- `conductor_run`, `conductor_batch`, `conductor_retry`: run tasks.
- `conductor_diff`, `conductor_runs`: review what ran.
- `conductor_plan_check`, `conductor_route`, `conductor_skills`, `conductor_status`: check a plan and see how work will be handled.
- `conductor_verify`: run your checks.

Each tool also takes an optional `project` path.

---

## 2. Global or project: what lives where

conductor reads **built-in defaults → your global settings → the project's settings**. The project wins.

| Where | Path | Holds |
|---|---|---|
| **Global** (all projects) | `~/.config/conductor/` | `config.json`: providers, roles, settings. `secrets.env`: API keys, mode 600. `skills/`: your skill library. Also run usage, cooldowns, task worktrees |
| **Project** | `<project>/.conductor/` | `config.json`: controller, project overrides (roles, routing rules, verify, skills switched off). `skills/`: project-only skills. `runs/`: history |
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
  - routing rules (`conductor route --add starter` saves to the project);
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
That one line checks Node, installs conductor and runs `conductor setup`. You can also install with `npm install -g github:KevalParikh22/conductor-ai`, then run:
```bash
conductor setup
```
Setup does the following:
- Finds the agents and API keys you already have and turns them on.
- **Never turns on your controller as a worker** (that would spend the quota conductor saves).
- Skips local models that are too small to code (under 7B).
- Offers a free provider.

`conductor setup --yes` does the same without questions.

**Workers (install the ones you'll use):**

| Worker | Install | Sign in |
|---|---|---|
| Antigravity CLI (`agy`) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | run `agy` once (Google) |
| Codex CLI | `npm install -g @openai/codex` | `codex login` |
| OpenCode (free models) | `curl -fsSL https://opencode.ai/install \| bash` | `opencode auth login` if your model needs it |
| Copilot, Kiro, Grok, Aider, Goose, Kimi | listed by `conductor doctor` and in the UI's Setup page | |
| Local models | Ollama / LM Studio running, then `conductor local --enable` | |

**API providers (optional):** `conductor providers --free` lists 45. `conductor add groq` then asks for the key (hidden input), lets you pick a model, tests it and adds it to the roles. To manage keys: `conductor keys`, or the UI's **API keys** page.

**Plugin (recommended for Claude Code and Antigravity):** it brings the `conduct-*` skills, conductor's MCP tools and a startup check, in one install per machine. You still need the CLI installed, since the plugin calls it.

| Tool | Install |
|---|---|
| Claude Code | `/plugin marketplace add KevalParikh22/conductor-ai`, then `/plugin install conductor-ai@conductor-ai`. On Claude Code 2.1.275 or later, one step: `/plugin install conductor-ai --marketplace KevalParikh22/conductor-ai` |
| Antigravity | `agy plugin install "$(npm root -g)/conductor-ai"` (or the path of a clone) |

Notes:
- In Claude Code, plugin skills are namespaced: `/conductor-ai:conduct-plan`. The project's own `/conduct-plan` from `conductor init` works too.
- With the plugin, Antigravity needs no `agy mcp add` step.
- The startup check tells you when the CLI is missing or the project isn't set up.

**Check:** `conductor doctor --live` sends one tiny prompt to each enabled provider.
- ✓ ready.
- ○ optional (add a key to use it).
- ✗ needs a fix, and the line says how.

---

## 4. Set up a project (once per project)

The sequence:

| # | Command | What it does |
|---|---|---|
| 1 | `git init` + one commit (if new) | Write roles need git. Workers never write on `main`/`master`, so work on a branch |
| 2 | `conductor init` (or `--controller antigravity`, `codex-cli`, `opencode`) | Writes the rules file, the controller's commands or skills, the MCP entry, the plan template, and **adds conductor's files to `.gitignore`** (section 9). Detects your Verify command. Syncs your skills |
| 3 | Check `AGENTS.md` | The **Verify** line was detected (e.g. `npm run test`, `vendor/bin/phpunit`); correct it if needed. Fill in section 1: stack, folders, conventions |
| 4 | `conductor route --add starter` | Routing starter set: security and database work to your strongest agent; docs and small edits to free models |
| 5 | Register MCP if your controller needs it | Antigravity: `agy mcp add conductor conductor mcp`. Codex: `codex mcp add conductor -- conductor mcp`. Once per machine; init tells you when it's missing |
| 6 | `conductor doctor --live` | Everything ready? |
| 7 | `git add .gitignore && git commit -m "conductor: ignore local files"` | conductor's own files stay out of git; only `.gitignore` changes |

Running `conductor init` again is safe: it refreshes conductor's files and never overwrites yours.

---

## 5. Daily workflow

In your controller, inside the project:

| Step | In your controller | What to do |
|---|---|---|
| 1. Plan | `/conduct-plan add password reset` | Answer the plan's **open questions**. Keep tasks small (1–3 files) with files, acceptance and a verify line. Add `- **eta:** 1h` to big tasks |
| 2. Run | `/conduct-run docs/plan/password-reset.md` | Independent tasks run **in parallel**, each in its own worktree on branch `conductor/<id>`, spread across workers |
| 3. Review | `conductor diff conductor/T3` | The compact diff: lockfiles and whitespace left out. Check verify passed |
| 4a. Good | `git merge --no-ff conductor/T3`, then `conductor worktree rm T3` | |
| 4b. Close but wrong | `conductor retry T3 --note "what to fix"` | **The same worker fixes its own work** in place, on the same branch |
| 4c. Wrong | `conductor worktree rm T3 --force`, then rerun with `--provider <other>` | |
| 5. End of day | `/conduct-handoff` | Updates `HANDOFF.md` so any controller can continue tomorrow |

**From the terminal instead:**
- `conductor build --plan docs/plan/x.md --task T1 --worktree`
- `conductor batch --plan docs/plan/x.md --tasks T1,T2,T3`
- `conductor review`

**What makes the biggest difference, in order:**
1. A correct Verify command.
2. Small tasks with files listed.
3. Accurate project facts in AGENTS.md.
4. Retrying with a note instead of rewriting the work yourself.
5. Routing rules.

---

## 6. Controllers

| Controller | Commands | conductor's MCP tools | One-time step |
|---|---|---|---|
| **Claude Code** | `/conduct-*` in `.claude/commands` (or the plugin's skills) | from `.mcp.json` or the plugin | Approve the "conductor" server when Claude asks, or install the plugin |
| **Antigravity** (Gemini) | `conduct-*` skills in `.agents/skills` (or the plugin's skills) | only from agy's own config or a plugin | Install the plugin (section 3), or `agy mcp add conductor conductor mcp` |
| **Codex** | `conduct-*` skills in `.agents/skills` | only from `~/.codex/config.toml` | `codex mcp add conductor -- conductor mcp` |
| **OpenCode** | `conduct-*` skills in `.agents/skills` | from `opencode.json` | none |

**To switch a project's controller:**
- CLI: `conductor init --controller <name>`.
- UI: **Settings → Controller → "Switch this project to …"**.

Workers read `AGENTS.md` whatever the controller.

---

## 7. Skills: one library for every controller and worker

A skill is a folder with a `SKILL.md`: a name, a description, and instructions. It's the format Claude Code, Antigravity, Codex and OpenCode all read. You keep **one library in conductor**, and conductor delivers it everywhere:
- **Controllers:** the active skills are copied into `.claude/skills/` and `.agents/skills/`, so each tool loads them natively, on demand.
- **Workers:** each task gets only the skills that match it. Agents get the skill's name, description and path, and open what they need. API models get the text, up to about 6,000 characters.

**Where skills live:**
- `~/.config/conductor/skills/<name>/`: **every project** (the universal set).
- `.conductor/skills/<name>/`: **this project only**. Wins over a global skill with the same name.

**Thinning out per project:** every global skill is on by default. Switch off the ones a project doesn't need; the choice is saved in that project's `.conductor/config.json` → `skills.off`.

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
| See the library and what's on here | `conductor skills` | the list, with on/off toggles |
| Create | `conductor skills new php-conventions --description "…" --files "*.php" [--project]` | **New skill** |
| Add an existing skill folder | `conductor skills add ./path/to/skill [--project]` | put it in the library folder, then **Sync now** |
| Switch off/on for this project | `conductor skills off <name>` / `on <name>` | the toggle |
| Edit | edit its `SKILL.md`, then `conductor skills sync` | **Edit** → Save (syncs) |
| Remove from the library | `conductor skills rm <name>` | **Remove from library** |
| Copy into the controller folders now | `conductor skills sync` | **Sync now** |

**Notes:**
- Changes from the CLI or the UI sync straight away, and `conductor init` syncs too.
- conductor only replaces or removes skill folders it created. A skill you put in `.claude/skills/` yourself is left alone.
- Each run's summary has a `skills:` line naming the skills the worker got.

---

## 8. CLI and UI side by side

| Task | CLI | UI |
|---|---|---|
| Overview: controller, ready providers, role chains | `conductor status` | **Overview** |
| Check providers | `conductor doctor [--live]` | **Providers** → Test |
| Add a provider | `conductor add <name>` | **Providers → Add provider** |
| API keys | `conductor keys [set NAME]` | **API keys** |
| Local models | `conductor local [--enable]` | **Providers** → Local models panel |
| Role chains (fallback order) | edit `roles` in config | **Roles** |
| Routing rules | `conductor route --templates / --add / --rules / --rm` | **Roles → Routing** |
| Preview where a task goes | `conductor route "task" --files a.ts` | **Roles → Routing → Preview** |
| Skills | `conductor skills …` | **Skills** |
| Controller | `conductor init --controller <name>` | **Settings → Controller** |
| Settings (limits, budget, verify) | config file | **Settings** |
| Run history and usage | `conductor runs`, `conductor usage` | **Runs** |
| Machine checks and install help | `conductor setup` | **Setup** |

---

## 9. conductor's files and git

`conductor init` keeps conductor's files **out of git** by adding a marked block to `.gitignore`, creating the file if needed:
```
# >>> conductor: local files, not committed (conductor init --share keeps them in git)
.conductor/
docs/plan/
.claude/commands/conduct-*
.agents/skills/conduct-*/
AGENTS.md
…
# <<< conductor
```
**What goes in the block:**
- conductor's folders (`.conductor/`, plans, its own commands and skills).
- The files **it created** (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `HANDOFF.md`, `docs/architecture.md`, MCP configs). A file you already had before `init` is never added.
- If something was already committed, `init` prints the `git rm --cached` line to stop tracking it.
- Synced copies of your skills are hidden through `.git/info/exclude`, which is local to your clone and never committed. So adding or switching a skill doesn't change `.gitignore`.

**Workers still see these files.** conductor copies them into each task's worktree. Because git can't see changes to ignored files, conductor keeps its own copy during a run and **puts back** any it finds a worker changed, with a warning.

**To share conductor's files with your team** (commit `AGENTS.md`, plans and skills): `conductor init --share` removes the block.

---

## 10. Limits, time limits and fallback

- **Rate limits.** A rate-limited model first falls back to the provider's next model (`fallbackModels`). Then the provider cools down and the next provider in the chain runs. Free API providers find fallback models themselves.
- **Time limits.**
  - A worker is stopped at 20 minutes, or 2× a task's `eta:`, or the `--timeout` you give. Everything it started is stopped too, and the next provider runs.
  - Free API routes give up after 90 seconds, since they sometimes hang.
- **If every worker fails:** exit code 3. The controller does the task itself.
- **Measure it: `conductor eval`.** A suite of fixed tasks (bug fixes, features, test-writing) with hidden tests the worker never sees. `conductor eval run` runs them with your routing (or `--provider` / `--chain`), scores each against the hidden tests, and compares conductor's verdict with reality: the key number is **"done" but wrong**. `--compare last` shows the change since the previous run. `conductor eval check` proves every task is fair without any LLM. `conductor stats --failures` lists why work failed, biggest cause first.
- **Acceptance criteria are run:** a line like `` `add(2, 3)` returns `5` `` or `` `parse('x')` throws SyntaxError `` is turned into a check conductor runs itself after the worker (JavaScript for now). A failure makes the task partial, whatever the worker claimed.
- **Failed work is handed on, with the error:** if verify fails, conductor writes a short brief (failing tests, error, file:line) and gives the work once to the next provider in the chain, which fixes it in place. The brief is also in the summary (`why:`) for your `--note`.
- **Edits are guarded:** a worker's changed files are syntax-checked, and any function or class the task names in `code` must exist afterwards; otherwise the attempt is rejected and the next provider runs. Chat models (no tools) get a project map and, if they answer without files, one repair turn.
- **Plans are checked before work starts:** `conductor plan check <plan>` (also run automatically, and the MCP tool `conductor_plan_check`). A write task needs `files:`, acceptance criteria a check can confirm, a verify command and at most 4 files besides tests; otherwise conductor refuses it and says what is missing. `--allow-weak-plan` overrides.
- **Acceptance is answered, not assumed:** the task's criteria are repeated at the end of the worker's prompt, and the worker must answer each one with evidence in an `## Acceptance` section. A DONE that leaves any unanswered or unmet is **partial**.
- **Checks before and after a task:**
  - **The starting commit is checked first.** conductor runs verify on the commit the worker starts from (once per commit). If it already fails, the worker is told, and the result says which failure lines are new.
  - **Scope:** when a task lists `files:`, changing other files (beyond their tests, lockfiles and snapshots) makes the outcome **out of scope**, with the files listed. `--allow-scope` accepts it.
- **No proof, no "done":** code a worker wrote counts as done only when the verify command ran and passed. Without a verify command the outcome is **unverified** and the exit code is 4. Set one with `conductor init --verify "<cmd>"` (or the Verify line in AGENTS.md). `--no-verify` and `--allow-unverified` accept unverified work on purpose.
- **If the controller runs out:** run `/conduct-handoff` while you still can. Then open another agent and say: *"Read HANDOFF.md and act as the controller described in .conductor/ORCHESTRATOR.md."*

Details: [Configuration](CONFIGURATION.md#time-limits-and-model-fallback).

---

## 11. tmux and editors

**tmux** (long and parallel runs: the controller on the left, live runs and a shell on the right):
```bash
tmux new-session -d -s conductor -c "$PWD" 'claude' \; split-window -h -c "$PWD" 'while :; do clear; conductor runs --limit 15; sleep 5; done' \; split-window -v -c "$PWD" \; select-pane -t 0 \; attach
```
**Notes:**
- Replace `claude` with your controller.
- Detach with `Ctrl-b d` and come back with `tmux attach -t conductor`; workers keep going.
- Run the UI in a pane with `conductor ui --no-open`. On a server, tunnel it first: `ssh -L 4545:127.0.0.1:4545 host`.

**VS Code:**
- **Claude Code extension:** it reads the same `.mcp.json` and `/conduct-*` commands as the terminal.
- **Copilot agent mode** (and other MCP extensions): `conductor init --vscode` writes `.vscode/mcp.json`. It does this automatically when the project already has a `.vscode/` folder. Then ask the agent, e.g. *"use conductor_run with role test to add tests for src/auth"*.
- **Cursor:** reads `.cursor/mcp.json` in the `.mcp.json` shape.
- **Review as you go:** keep Source Control open. Workers never commit on your branch, and parallel tasks appear as `conductor/<id>` branches.
- **"command not found" from an editor:** editors started from the dock often lack your shell's PATH. Use the full path from `which conductor` as `command` in the MCP entry.

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
4. Commit what the cloud session needs: run `conductor init --share`, or commit the specific files. With the default `.gitignore` block, a fresh clone doesn't have conductor's files.

**GitHub Actions:** see [`examples/github-action.yml`](../examples/github-action.yml). A standalone docs refresh on free models:
```yaml
- run: |
    git switch -c docs/auto-${{ github.run_id }}
    conductor run docs "Update the README usage section" --files src/cli.js,README.md --chain kilo-free,openrouter-free
```

**Mixed chains** work anywhere: `"test": ["ollama", "opencode", "kilo-free"]` uses Ollama on your laptop and falls through to Kilo in CI.

---

## 13. Update and uninstall

**Update:** install again, then refresh each project.
```bash
npm install -g github:KevalParikh22/conductor-ai
```
```bash
conductor init
```

**Remove from a project:**
1. Delete conductor's files:
   ```bash
   rm -rf .conductor .claude/commands/conduct-*.md .agents/skills/conduct-*
   ```
2. Remove the `<!-- conductor:… -->` blocks from `CLAUDE.md`, `GEMINI.md` and `AGENTS.md`.
3. Remove the `conductor` MCP entry and the conductor block in `.gitignore`.

**Remove from the machine:**
```bash
npm uninstall -g conductor-ai
```
Your settings, keys and skill library are kept in `~/.config/conductor`; delete that folder too if you want them gone.

---

## 14. Troubleshooting

| Problem | Fix |
|---|---|
| `working tree is dirty` | Commit or stash first; that's what makes stash-on-failure safe. After `init`, commit `.gitignore` |
| `on protected branch "main"` | `git switch -c feat/<name>`. Workers never write on main |
| Controller doesn't see conductor's tools | Section 6: approve it (Claude), or register it once (Antigravity, Codex) |
| `/conduct-*` or `conduct-*` skills missing | Open the controller in the project folder, or run `conductor init` again |
| Antigravity attempt `denied: command`, or the warning "refused N action(s)" | agy needed a shell command that has no allow rule; headless runs can't ask. Add it to `allowCommands` in Settings (the verify command and common build/test commands are allowed already) |
| `conductor: command not found` inside the controller | Install globally so its shell finds it (`which conductor`) |
| A worker always fails | Its log is `.conductor/runs/<run>/<provider>.log`: usually a login, or changed CLI flags |
| A free route hangs | It gives up after 90 seconds and tries another model, then the next provider (section 10) |
| A skill isn't loaded | `conductor skills` shows whether it's on; `conductor skills sync` copies it again |
| UI says wrong token | Open the full URL printed by `conductor ui` (the token is after `#t=`) |
