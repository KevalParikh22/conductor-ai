# Installation guide

About 15 minutes the first time. After that, adding conductor to another project takes one command.

## 0. Requirements

| Need | Check | Notes |
|---|---|---|
| Node.js 20+ | `node --version` | https://nodejs.org or `nvm install 22` |
| git | `git --version` | Write roles need a git repo |
| A controller | | Claude Code (default), Gemini CLI, Codex CLI or OpenCode |
| At least one worker | | Any CLI agent below, or an API key |
| OS | | Linux and macOS. Windows: use WSL |

## 1. Install conductor (once per machine)

From GitHub:
```bash
npm install -g github:YOUR-GITHUB-USER/conductor-ai
```
Or from a clone, which is better for hacking on it:
```bash
git clone https://github.com/YOUR-GITHUB-USER/conductor-ai && cd conductor-ai && npm install -g .
```
Then create `~/.config/conductor/` (config, plus a private `secrets.env`):
```bash
conductor setup
```

Check it worked: `conductor --version`.

## 2. Install and sign in to your workers

Install the ones you plan to use. Everything is optional; conductor skips what isn't installed.

**Gemini CLI** (daily driver, uses your Google account or Gemini Pro):
```bash
npm install -g @google/gemini-cli
```
Run `gemini` once and choose **Login with Google**.

**Codex CLI** (daily driver, uses your ChatGPT account or an API key):
```bash
npm install -g @openai/codex
```
```bash
codex login
```

**OpenCode** (free models such as `opencode/big-pickle`, used for tests and docs):
```bash
curl -fsSL https://opencode.ai/install | bash
```
Run `opencode auth login` if your chosen model needs it.

**Optional:** Kimi Code CLI (`kimi`, then `/login`), or Claude Code as a worker (spends Claude quota). Their install commands are listed in `conductor doctor` and in the UI under **Install & setup**.

## 3. Add API keys (optional, for cloud models)

```bash
conductor ui
```
Go to **API keys** and paste the keys you have. They're stored in `~/.config/conductor/secrets.env` (chmod 600), never in config files or git.

| Key | Where | Free? |
|---|---|---|
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey | Free tier |
| `OPENROUTER_API_KEY` | https://openrouter.ai/keys | `:free` models: 20 req/min; 50/day, or 1000/day after a one-time $10 credit |
| `MOONSHOT_API_KEY` | https://platform.moonshot.ai | Kimi API |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY` | provider dashboards | Paid or free tiers |

Real environment variables always take priority over `secrets.env`.

## 4. Set up a project (once per project)

```bash
cd my-app
```
```bash
conductor init
```
For a different controller, pass it explicitly:
```bash
conductor init --controller gemini-cli
```
Other options: `codex-cli`, `opencode`.

| File | Purpose | Overwrites yours? |
|---|---|---|
| `AGENTS.md` | Shared rules for every model | No: appends a marked block if the file exists |
| `CLAUDE.md` / `GEMINI.md` | Controller instructions (imports AGENTS.md) | No: marked block only |
| `.claude/commands/conduct-*.md` | Slash commands (Claude Code) | Owned by conductor |
| `.gemini/commands/conduct-*.toml` | Slash commands (if the controller is Gemini CLI) | Owned by conductor |
| `.mcp.json` / `.gemini/settings.json` / `opencode.json` | MCP server entry | Merged, never replaced |
| `.conductor/config.json` | Project overrides (controller, roles…) | Kept |
| `.conductor/ORCHESTRATOR.md` | Controller playbook | Owned by conductor |
| `docs/plan/_TEMPLATE.md`, `HANDOFF.md`, `docs/architecture.md` | Plan format and shared state | Kept |

Re-running `conductor init` is safe and refreshes conductor's own files.

**Then fill in section 1 of `AGENTS.md`**, especially the Verify line, for example:
```
- **Verify (must pass before any task is "done"):** `npm run lint && npm test`
```

Commit the setup on your main branch:
```bash
git add -A && git commit -m "Add conductor"
```

## 5. Check

```bash
conductor doctor --live
```
This sends one tiny request to each enabled provider and reports ✓ or ✗ with the fix. Disable providers you don't use in `conductor ui` → Providers.

## 6. Use it

In Claude Code (or your controller), inside the project:

```
/conduct-status
/conduct-ask Map this codebase for other engineers --save docs/architecture.md
/conduct-plan add a password reset flow by email
/conduct-run docs/plan/password-reset.md
```

Or straight from a terminal:
```bash
git switch -c feat/password-reset
```
```bash
conductor run build --plan docs/plan/password-reset.md --task T1
```
```bash
conductor run review --plan docs/plan/password-reset.md
```

## 7. When limits run out

| What ran out | What happens |
|---|---|
| A worker (Gemini, Codex, OpenRouter…) | Automatic: the next provider in the chain runs, and the limited one cools down (`conductor cooldown`) |
| Every worker for a role | Exit code 3: the controller does the task itself |
| **The controller** | Run `/conduct-handoff` while you still can. Then open another agent in the repo and say: *"Read HANDOFF.md and act as the controller described in .conductor/ORCHESTRATOR.md."* |

## Update and uninstall

Update by reinstalling, then refresh each project's conductor files:
```bash
npm install -g github:YOUR-GITHUB-USER/conductor-ai
```
```bash
conductor init
```

To uninstall, remove conductor's files from a project:
```bash
rm -rf .conductor .claude/commands/conduct-*.md .gemini/commands/conduct-*.toml
```
Then delete the `<!-- conductor:… -->` blocks from `CLAUDE.md`, `GEMINI.md` and `AGENTS.md`, and the `conductor` entry in `.mcp.json`. To remove it globally:
```bash
npm uninstall -g conductor-ai && rm -rf ~/.config/conductor
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `working tree is dirty` | Commit or stash first. A clean tree is what makes stash-on-failure safe. `--allow-dirty` skips the check (and the stashing) |
| `on protected branch "main"` | `git switch -c feat/<name>`. Workers never write to main |
| `/conduct-*` commands missing | Open your controller in the project folder, or re-run `conductor init` |
| `conductor: command not found` in Claude | Install globally (`npm install -g …`) so your controller's shell can find it. Check with `which conductor` |
| A CLI worker always fails | Look at its log in `.conductor/runs/<run>/<provider>.log`. Usually a login, or flags changed in a new CLI version: override `write`/`read` args in config (see PROVIDERS.md) |
| OpenRouter says `quota` | Daily free cap reached (50/day without credits). It cools down automatically; add credit or another provider |
| UI says wrong token | Open the full URL printed by `conductor ui` (the token is in the `#t=` part) |
