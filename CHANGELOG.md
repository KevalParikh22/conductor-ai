# Changelog

## 0.9.0 (2026-11-05)

- **Time limits that stop hung workers.**
  - When a worker runs past its limit, conductor now stops its whole process group: the worker and every helper it started. Before, only the agent itself was killed, and a helper holding its output open could keep conductor waiting for hours.
  - The stopped attempt is stashed and the next provider runs. Its reason shows as `timeout (20m)`.
- **Setting the limit:**
  - A plan task can set `- **eta:** 1h`; it is stopped at 2× the eta (`timeoutFactor`).
  - `--timeout 45m` works on `run` and `batch`.
  - Each provider can have its own `timeoutMin`, also in the UI.
  - Optional `idleTimeoutSec` / `idleTimeoutMin` stop a worker that prints nothing for that long.
  - Antigravity gets the same limit as `--print-timeout` instead of `0`.
  - Stopping conductor (Ctrl-C) also stops the workers it started.
- **Fallback models on the same provider.**
  - With `fallbackModels`, a rate-limited model (or, for APIs, one that stalls or answers nothing) is followed by the next model on that provider before the chain moves on. Only the limited model cools down.
  - Works for API providers and for agents that take a model (OpenCode, Codex…).
  - Free and auto-picked API providers find fallbacks from their own model list.
  - Summaries show the model per attempt, and the UI has a Fallback models field.
- **Antigravity can read linked dependency folders in worktrees.** A worktree's `node_modules`, `vendor` or `.venv` links point back into the main checkout. When that checkout sits outside agy's sandbox (another drive, for example), tests failed with missing modules. Each link target is now allowed for reading, not writing.
- **Batches report honestly.**
  - A task whose verify fails is ✗.
  - A task whose worker reports `RESULT: PARTIAL`, `BLOCKED` or `FAILED` is ⚠ partial.
  - The result line reads `2 done, 1 partial, 1 failed`, and the batch exits non-zero unless everything is done.
  - A single run's summary adds an `outcome:` line in those cases.
- **Fewer false changed-file warnings.** The report's "Files changed" list now handles:
  - markdown links (`[a.ts](file:///…/a.ts)`);
  - absolute paths inside the worktree;
  - `src/{a,b}.ts`;
  - `a.ts:12`;
  - several backticked paths on one line.

  Lines that are prose ("No changes to the API") are ignored.
- **Review findings stay in `report.md`.** When a reviewer writes its findings before the `VERDICT` line, they are kept. A bare `CHANGES_REQUESTED` with nothing after it gets the end of the output before it. `report.full.md` is always written when the two differ.
- **Overriding an agent's read args no longer drops the read-only guarantee** when the override keeps the preset's sandbox flags (changing only the model or time limit). `doctor` names the flag an override dropped.
- **Provider gallery filter fixed.** Category chips and search updated the count but hid nothing, because the cards' layout style overrode the `hidden` attribute.

## 0.8.1 (2026-11-04)

- **Rule library for routing.** 12 ready-made rules:
  - **to your strongest agent:** security-sensitive code, database and migrations, CI and infrastructure, backend code, reviews;
  - **to a free or local model:** small edits, docs files, translations, the docs role, questions;
  - **to an agent that runs tests:** test files;
  - **to an agent good at UI:** frontend.

  Each rule's providers are filled in from the ones you have enabled.
- **Managing rules from the terminal:**
  - `conductor route --add starter` adds the six starter rules (or `--add <id,id>` for others).
  - `--templates` lists the library, `--rules` shows your rules and `--rm <n>` removes one.
  - Rules are saved to the project unless you add `--global`.
- **In the UI** (Roles → Routing):
  - A "How it works" explainer and a link to the routing guide.
  - The rule library, with **Add starter set**, **Add** and **Customize** (copies a rule into the form).
  - Help text next to the Add rule button.
- **New guide:** [docs/ROUTING.md](docs/ROUTING.md). Also new: `templates/routes.example.json`, with every library rule.

## 0.8.0 (2026-11-04)

- **Choose who takes which task.**
  - **Per task:** a plan task can name its provider with `- **provider:** codex-cli`.
  - **By rule:** `routes` in config send matching tasks to a provider first, matched on files (globs), task text (regex) and role.
  - **Precedence:** `--chain` > `--provider` > the plan line > routes > the smart selector.
  - **In batches:** `conductor batch` keeps routed tasks on their provider.
  - **Preview:** `conductor route` (and Roles → Routing in the UI) shows where a task would go and why, before it runs.
  - **Visibility:** summaries have a `route:` line, and the Runs page shows why each worker went first.
- **Local models.** `conductor local` finds Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan and LiteLLM on their default ports. It lists their models and picks the best one for coding, skipping embedding and other non-chat models, and says what to do when one isn't running or has no chat model. `--enable` turns them on. `conductor setup`, the Providers page (with an Enable button) and the Setup page show the same.
- **Tokens saved, measured.** Each estimate counts characters kept out of a model's context, at about 4 characters per token, and covers:
  - the compact diffs the controller reads;
  - trimmed reports;
  - compact review diffs;
  - tasks the selector moved to a free model.

  It shows in each run's summary (`tokens:`), in `conductor diff`'s footer, in `conductor usage` and on the Runs page.
- **Provider search** in the UI now covers every category and shows how many providers match.

## 0.7.0 (2026-11-03)

**Saving tokens**
- **Smart selector.** Before each run, conductor reorders the role's chain for the task. It never adds or removes providers.
  - Small tasks with known files (and reviews of small diffs) try free API models first.
  - Larger or open-ended tasks try agents first.
  - Paid APIs go last.
  - A provider whose last three attempts all failed (not counting rate limits) moves to the end.
  - The summary shows a `selector:` line when the order changed.
  - Off with `--chain`, `--provider` or `"smartSelect": false`.
- **`conductor diff`.** A compact diff for the controller to review:
  - Whitespace-only changes, lockfiles, build output and source maps are listed, not shown.
  - 2 lines of context; long files are cut (`--lines`).
  - New files are included, and it reports how much of the full diff it showed.
  - `conductor diff conductor/T3` shows a parallel task's branch.
  - Review workers get the same compact diff.
- **Shorter reports.** `report.md` now starts at the worker's `## RESULT` line, so tool transcripts printed before it never reach the controller. The full output is in `report.full.md`.
- **The `/conduct-*` commands and the controller playbook** use `conductor diff` and say what to read and what not to. There's a new "Saving tokens" section.
- **API providers time out after 5 minutes** (`apiTimeoutSec`) and fall back, instead of holding the chain for the 20-minute agent timeout when a free route stalls.

**Simpler UI and CLI**
- **New look:** a favicon, an icon for each section, and a sun/moon theme toggle.
- **Seven sections:** Controller moved into Settings.
- **Providers** is a compact list: one row per provider, enabled ones by default, and details on click. The 45-provider gallery and custom providers open from **Add provider**.
- **Roles** is a two-column grid with short status labels (the full reason on hover).
- **API keys** shows only keys that are set or in use. **Setup** collapses the agent table and the update steps.
- **Phone width** works without a squeezed header.
- **`conductor --help`** is one screen; `conductor help all` has everything.
- **`conductor doctor`** prints one line per provider; `--details` adds each agent's permissions.

## 0.6.0 (2026-11-03)

- **Five more coding agents:** GitHub Copilot CLI, Grok Build (xAI), Kiro, Aider and Goose. There are now ten in all, each with a guide in docs/providers. Every flag was checked against the CLI's own `--help`, source or reference docs.
  - **Copilot:**
    - Deny rules for the git and sudo commands, which win over `--allow-all-tools`.
    - Built-in GitHub MCP tools and web access are off, so it can't push through the API.
    - Read mode denies writes and the shell.
  - **Grok Build:** kernel-enforced `strict` / `read-only` sandboxes.
  - **Kiro:** commands run in its sandbox, and read mode trusts only read and search tools.
  - **Aider:**
    - Never commits or runs shell commands.
    - Never loads the project `.env`.
    - Read mode is `--dry-run`.
  - **Goose:** write mode is marked as not contained. Read mode is tool-less chat with the project context inlined.
- **conductor warns when a worker makes git commits itself.**
- **API providers with no model set now work:** conductor picks the best one from the provider's live list when it runs (coding models first; classifiers, embeddings and speech models skipped) and remembers it for a day.
- **Guides now explain conductor-chosen key names.** Where a provider's docs name no environment variable, the guide says the name is conductor's own and how to use another.
- **45 chat APIs, each a one-command add.** A provider catalog (`src/catalog.js`) covers:
  - free and no-key options (Kilo, OVHcloud, Gemini, Groq, Cerebras, NVIDIA, Cohere)
  - gateways (OpenRouter, Requesty, Vercel, Hugging Face, Cloudflare, Poe, AI/ML API)
  - model makers (OpenAI, Anthropic, xAI, Mistral, DeepSeek, Kimi, Qwen, GLM, MiniMax)
  - fast hosts (SambaNova, Together, Fireworks, DeepInfra, Nebius, Baseten and more)
  - Azure OpenAI and Bedrock
  - local servers (Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan, LiteLLM proxy)

  Every endpoint was checked against the provider's own docs in November 2026. Built-in provider names (`groq-api`, `kilo-free`…) are unchanged.
- **`conductor add <provider>`.** Shows where to get the key, asks for it with hidden input, picks a model from the live list (coding and free models first; classifiers, embeddings and speech models skipped), sends a test prompt and adds the provider to the `docs`, `test`, `review` and `ask` roles. Only the chains it changes are written to your config. `--yes` for scripts.
- **`conductor providers`** lists everything you can add, grouped, with what's on and which keys are set (`--free`, `--search`, `--json`).
- **Guided `conductor setup`.** Checks Node, git and PATH, finds installed agents and API keys you already have and turns them on, offers to add a free provider, and tests what's enabled. `--yes` (and the installer) runs it without questions.
- **`conductor keys`** lists keys and where they come from. `keys set NAME` takes hidden input or stdin; `keys rm NAME` removes one. Placeholder values such as `YOUR_API_KEY` count as not set everywhere.
- **`conductor doctor --json`**, and a "next:" line for every failing provider (e.g. `conductor add groq`).
- **A setup guide for every provider:** [docs/providers](docs/providers/README.md). It has 45 API guides and the agent guides, generated from the catalog and checked by a test, so they can't drift.
- **UI:** an "Add a provider" gallery with search and filters (Free, Gateways, Model makers, Fast hosts, Cloud, Local), inline key entry and a guide link on every card. API provider cards get a **Models** button that loads the provider's current model list.
- **Changed defaults:**
  - `kilo-free` now uses Kilo's documented endpoint, `https://ai-gateway.kilo.ai/api/v1`.
  - `opencode-zen` is off by default and out of the `docs` chain. OpenCode's docs say its free models only work inside the OpenCode app (use the `opencode` agent for those).
  - Default model ids are updated for OpenAI, DeepSeek and Kimi.

- **Security: git hooks and config are restored after every worker.** `.git/config` and `.git/hooks` are snapshotted before each attempt and put back right after it, before conductor runs git again, with a warning. Before this, a worker could plant a hook or an `fsmonitor` program that ran outside its sandbox on the next git command. conductor's own git calls now also run with `core.fsmonitor=false`. Hook folders in the repo (`.husky/`, `.githooks/`, `core.hooksPath`) are protected files.
- **Security: secrets files are never sent to API models as context** (`.env*`, `auth.json`, `secrets.env`, `.npmrc`, SSH keys, `*.pem`/`*.key`, `protectedPaths`), even when a task lists them with `--files`.
- **Security: verify runs without conductor's API keys** in its environment.
- **SECURITY.md rewritten** for users: what is protected, what isn't (verify runs worker-written code; agents can read what you can read; free routes may log prompts), and a checklist for sensitive projects.
- **VS Code.** `conductor init --vscode` writes `.vscode/mcp.json` (merged, never replaced), so Copilot agent mode and other VS Code MCP extensions can call conductor. It is written automatically when the project already has a `.vscode/` folder.
- **New guide: [tmux and editors](docs/EDITORS.md).** A three-pane tmux layout (controller, live runs, shell), VS Code with Claude Code or Copilot, Cursor, VS Code tasks, and the PATH fix for editors that can't find `conductor`.
- **Install & setup page rewritten** (`conductor ui`). It checks this machine (Node, git, conductor version, project initialised, installed agents, free keys set) and has real install commands with the actual repo, not a placeholder. It shows a free path (kilo-free with no key, OpenRouter, OpenCode Zen, Gemini, Groq, Cerebras, Ollama) next to the subscription agents, a read-only free test run, install and sign-in per agent with copyable single commands, and how to update or remove conductor.
- The API keys page lists every free provider with its signup link, and warns that free routes may log prompts.
- API providers that return 200 with empty content (Kilo and OpenRouter free routers do this now and then) are asked once more before falling back.

## 0.5.0 (2026-11-02)

- **Evidence check.** After a write task, the worker's "Files changed" list is compared with what git shows. conductor warns about files it claims but didn't change, changes it didn't report, and "DONE" with no changes. Files already modified before the run are not counted.
- **Open questions gate.** Plans get a `## Open questions` section. Write tasks (and `conductor batch`) are refused while an item is unchecked, so workers never guess at decisions. `/conduct-plan` settles questions first and asks you the rest. Override with `--allow-open-questions`.
- **Usage and budgets.** Every attempt is logged to `~/.config/conductor/usage.jsonl` with time, tokens and cost (for API providers with a `price`, or marked `free`). `conductor usage` shows totals per provider. `settings.dailyBudgetUSD` (or per provider) skips paid APIs once today's spend reaches the cap. Run summaries show tokens and cost.
- **Run history.** `conductor runs` and `conductor runs show <run>`, plus a Runs page in `conductor ui` that refreshes while open and shows usage by provider and today's spend.
- **One-line installer**: `scripts/install.sh` checks Node 20+, installs from GitHub and runs setup. `llms.txt` describes the repo for AI tools.
- The README no longer has a comparison table.

## 0.4.1 (2026-11-02)

- Fix (macOS): CLI workers got `PWD` and agy's deny rules with the unresolved project path. Through a symlink (`/var` → `/private/var` on macOS) that path differs from the one the process runs in, so agy's project rules might not match. conductor now uses the resolved path. This was also why CI failed on macOS.
- New README: logo, badges, diagram, screenshots of the settings page and a permissions table.
- `SECURITY.md`, issue templates for bugs and provider requests, and repository links in `package.json`.
- CI runs every OS and Node combination to the end instead of cancelling on the first failure, with current GitHub Actions versions.

## 0.4.0 (2026-11-02)

- **Permissions for every agent, per run.** conductor passes each CLI its own rules for that run and never edits your CLI settings. Write roles may edit only the project (no `git push/commit/reset/checkout/switch/rebase/stash/clean`, no `sudo`); read roles cannot edit. `conductor doctor` and the Providers page show what each agent may do. Details in docs/PROVIDERS.md.
  - **Antigravity:** no more `--dangerously-skip-permissions`. Write roles run `--mode accept-edits --sandbox --settings <rules>`: commands run in agy's sandbox (no network, home read-only), `.git`, `.env`-type files and conductor's folder are denied. Read roles deny writes to the project. Read roles no longer use `--mode plan`, which answered with a link to a plan file and caused the flaky reviews.
  - **Codex:** `approval_policy="never"` and no network made explicit.
  - **OpenCode:** runs with `--standalone`. Without it OpenCode 2 handed the run to its background service, which ignored conductor's rules (so `npm test` could be refused and read-only wasn't enforced). Read roles are now enforced (`edit: deny`, shell limited to read-only commands, no web, nothing outside the project), not just asked for in the prompt. Write roles deny folders outside the project and the git/sudo commands.
  - **Claude Code (worker):** read roles disable the edit tools instead of plan mode; write roles disallow the git/sudo commands.
  - **Kimi** and custom CLIs are marked as not read-only; read runs on them warn.
- **Secrets stay with their provider.** Keys loaded from `secrets.env` / `.conductor/.env` are no longer passed to every CLI worker, only the ones it needs (`passEnv`).
- **Gemini CLI removed** (preset, provider and controller). Configs that still name `gemini-cli` keep loading: it is dropped from the chains, the controller switches to `antigravity`, and `conductor doctor` says so. The Gemini API provider is unchanged.
- New preset fields: `sessionSettings`, `modeEnv`, `passEnv`, `permissions`; new arg token `{sessionSettings}`.
- `conductor doctor` no longer reports `apiKeyOptional` providers (Kilo) as missing a key.

## 0.3.0 (2026-10-30)

- **Parallel tasks.** `conductor run <role> --worktree` runs a write task in its own git worktree on branch `conductor/<id>` and commits the result there. `conductor batch --plan p.md --tasks T2,T3,T4` runs independent tasks at the same time, spread across different providers. It refuses tasks that depend on each other and warns when tasks share files.
- `conductor worktree [list]` and `conductor worktree rm <id>|--all [--force]`.
- MCP: new `conductor_batch` tool; `conductor_run` takes `worktree` and `replace`.
- `/conduct-run` works in waves and batches independent tasks; `/conduct-plan` and the plan template record `depends on`.
- Worktree runs keep the worker's prompt file outside the repo, use the task's own `verify:` line from the plan, and warn if files appear in the main checkout during the run.
- Fix: CLI workers now get `PWD` set to their working directory. OpenCode takes the project folder from `$PWD`, so before this fix it worked in whatever folder conductor was started from.

## 0.2.0 (2026-10-28)

- **Antigravity CLI (`agy`)** is a new agent preset (`antigravity-cli`) and controller (`conductor init --controller antigravity`, which writes `.agents/skills/conduct-*` and `.agents/mcp_config.json`). It replaces Gemini CLI in the default chains, since Gemini CLI stopped serving personal Google accounts on 18 June 2026. `gemini-cli` stays available, disabled, for API-key and Code Assist users.
- New free API providers: `kilo-free` (Kilo Gateway, works without a key), `opencode-zen` (OpenCode Zen API), `cerebras-api`, `mistral-api` (Codestral) and `nvidia-nim`. `kilo-free` and `opencode-zen` join the `test`, `docs` and `ask` chains.
- `apiKeyOptional` provider field for endpoints that also work without a key.
- `conductor models <provider>` lists the models of any OpenAI-compatible provider.
- Prompts over 100 KB are passed to argv-only CLIs as a pointer to the prompt file.
- When the controller's file is `GEMINI.md` or `AGENTS.md`, the controller block is marked as controller-only so workers reading the same file ignore it.
- `.agents/` is protected from worker edits.
- A CLI that exits 0 with nothing on stdout now counts as `empty output` (with the stderr reason) and falls through to the next provider.
- Review and ask prompts tell workers they don't need shell commands.

## 0.1.0 (2026-10-24)

First release.

- Controller-agnostic orchestration: Claude Code (default), Gemini CLI, Codex CLI or OpenCode as controller
- Roles `build`, `fix`, `test`, `docs`, `review`, `ask` with per-role fallback chains
- Providers: Gemini CLI, Codex CLI, OpenCode, Kimi CLI and Claude Code (agents); Gemini API, OpenRouter, OpenAI, Kimi/Moonshot, DeepSeek, Groq, Anthropic, Ollama, LM Studio and any OpenAI-compatible API (chat)
- Rate-limit detection with shared cooldowns, stash-on-failure, protected files, verify gate
- `conductor ui` settings page, `conductor init` per-project setup, MCP server, `doctor --live`
