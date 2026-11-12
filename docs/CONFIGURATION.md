# Configuration

The easiest way is `conductor ui`. Everything below is what the UI edits.

## Where config lives

Effective config = **built-in defaults** ← **global** ← **project**. Later layers win.

| Layer | File | Typical use |
|---|---|---|
| Built-in | `src/presets.js` | Sensible defaults |
| Global | `~/.config/conductor/config.json` | Your providers and role order for all projects |
| Project | `<repo>/.conductor/config.json` | Per-project overrides, e.g. a different controller |
| Secrets | `~/.config/conductor/secrets.env`, `<repo>/.conductor/.env` | API keys (both gitignored or private) |

Set `CONDUCTOR_HOME` to move the global directory. The UI saves **only the differences** from the layer below, so future built-in defaults still reach you.

Merge rules: `providers` and `settings` merge field by field; each role's chain is replaced as a whole.

## Example

```json
{
  "version": 1,
  "controller": "claude-code",
  "roles": {
    "build": ["antigravity-cli", "codex-cli", "opencode"],
    "test": ["opencode", "kilo-free"],
    "docs": ["kilo-free", "openrouter-free", "gemini-api"]
  },
  "providers": {
    "openrouter-free": { "model": "openrouter/free", "fallbackModels": ["google/gemma-4-31b-it:free"] },
    "ollama": { "enabled": true, "model": "qwen3-coder" },
    "my-gateway": { "type": "openai", "enabled": true, "baseUrl": "https://llm.mycorp.dev/v1", "apiKeyEnv": "MYCORP_KEY", "model": "coder-large" }
  },
  "settings": { "verify": "pnpm lint && pnpm test", "cooldownMinutes": 20 }
}
```

## Controller

`claude-code` (default) · `antigravity` · `codex-cli` · `opencode`. (`gemini-cli` was removed; configs that name it switch to `antigravity`.) Change it in the UI (Controller → Apply to this project) or with `conductor init --controller <name>`. Applying writes that agent's instruction file, its `/conduct-*` commands and an MCP entry.

## Roles

| Role | Mode | Default chain | Good fit |
|---|---|---|---|
| `build` | write | antigravity-cli → codex-cli → opencode | Planned implementation tasks |
| `fix` | write | codex-cli → antigravity-cli → opencode | Small fixes, review follow-ups |
| `test` | write | opencode → kilo-free → openrouter-free → antigravity-cli | Writing tests (free models) |
| `docs` | write | openrouter-free → kilo-free → opencode → gemini-api → antigravity-cli | README, docs, changelogs |
| `review` | read | codex-cli → antigravity-cli → gemini-api → kilo-free | Second-opinion review of a diff |
| `ask` | read | antigravity-cli → gemini-api → kilo-free → openrouter-free | Codebase questions, research |

An empty chain means the controller does that role itself. For one run, `--provider x` tries `x` first, and `--chain a,b` replaces the chain.

## Provider fields

| Field | Applies to | Meaning |
|---|---|---|
| `type` | all | `cli`, `openai` (any OpenAI-compatible API) or `anthropic` |
| `enabled` | all | Disabled providers are skipped |
| `model` | all | Model id. Empty = the CLI's default |
| `preset` | cli | `antigravity`, `codex`, `opencode`, `kimi`, `claude` |
| `bin`, `write`, `read`, `modelArgs`, `stdin` | cli | Override the preset's command line (see PROVIDERS.md) |
| `env` | cli | Extra environment variables for that CLI |
| `baseUrl` | api | e.g. `https://openrouter.ai/api/v1` (conductor adds `/chat/completions`) |
| `apiKeyEnv` | api | Name of the env var holding the key; empty for local servers |
| `apiKeyOptional` | api | `true` = send the key if set, but run without one too (e.g. `kilo-free`) |
| `headers`, `maxTokens`, `temperature` | api | Optional request tuning |
| `fallbackModels` | api, cli | Models to try on this provider, in order, when `model` is rate-limited (APIs also switch when a model stalls or answers nothing). The limited model cools down alone; the provider is skipped only when every model is. Agents need a preset that takes a model (OpenCode, Codex, Claude, Kimi, Aider…). Free and auto-picked API providers find fallbacks from their live model list when this is unset |
| `autoFallback` | api | `false` = don't look up fallback models automatically |
| `timeoutMin` | all | Time limit for this provider, in minutes, instead of `timeoutSec` (or `apiTimeoutSec` for APIs) |
| `idleTimeoutMin` | cli | Stop this agent when it prints nothing for this long |
| `price` | api | `{ "input": 0.3, "output": 2.5 }`: dollars per 1M tokens, used for cost and budgets. Without it, cost is shown as unknown |
| `free` | api | `true` = costs nothing (set on Kilo, OpenRouter free and local models). Remove it if you switch that provider to a paid model |
| `dailyBudgetUSD` | api | Daily cap for this provider alone (needs `price`) |
| `notes` | all | Shown in the UI |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `timeoutSec` | 1200 | Max seconds per agent attempt. The worker and everything it started are stopped, the attempt is stashed and the next provider runs. `--timeout 45m` on `run` or `batch` overrides it |
| `allowCommands` | `[]` | Extra commands write workers may run without a permission prompt (Antigravity), on top of the usual build and test tools and your verify command, e.g. `["npx expo export"]` |
| `timeoutFactor` | 2 | A plan task with `- **eta:** 1h` may run eta × this (here 2h) before it is stopped; an eta never lowers the limit |
| `idleTimeoutSec` | 0 | Stop an agent that prints nothing for this long. Off by default because some agents print only at the end |
| `freeApiTimeoutSec` | 90 | Free API providers give up after this. Free routes sometimes hang; after a timeout one more model is tried on that provider, then the chain moves on |
| `apiTimeoutSec` | 300 | API (chat) providers give up after this and the next provider runs; a stalled free route shouldn't hold the chain for the agent timeout |
| `cooldownMinutes` | 30 | How long a rate-limited provider is skipped (or its `Retry-After`) |
| `protectedBranches` | `["main","master"]` | Write roles refuse to run on these |
| `protectedPaths` | `[]` | Extra regexes (repo-relative paths) workers may never write, e.g. `"^app/etc/env\\.php$"`. Built in: AGENTS/CLAUDE/GEMINI/HANDOFF.md, plans, `.claude/`, `.gemini/`, `.agents/`, `.conductor/`, `.git/`, `.env*`, `auth.json`, `node_modules/` |
| `requireCleanTree` | true | Write roles need a clean tree (enables stash-on-failure) |
| `verify` | `""` | Verify command. Empty = `AGENTS.md` Verify line, then auto-detect |
| `autoVerify` | true | Run verify after each write task |
| `planGate` | true | Refuse plan tasks a worker can't do well: no `files:`, vague or missing acceptance, no verify command, too many files (`conductor plan check`; `--allow-weak-plan` overrides) |
| `maxTaskFiles` | 4 | Most files (besides tests) one task may list |
| `requireAcceptance` | true | A DONE task must answer every acceptance criterion with evidence; otherwise the outcome is `partial` |
| `syntaxCheck` | true | Reject a worker's attempt when a changed file has a syntax error (JS, JSON, PHP, Python) |
| `contractCheck` | true | Reject it when a function or class the task names in a code span isn't defined anywhere afterwards |
| `chatRepair` | true | Give a chat model's reply with no file blocks one repair turn |
| `repoMapBytes` | 6000 | Size of the project map chat models get |
| `lessons` | true | Keep what earlier work taught (diagnosed failures, your `--note`s) for later prompts and provider order (`conductor lessons`) |
| `lessonsInPrompt` | 5 | Most lessons added to one worker's prompt |
| `demoteAfter` | 2 | Failures on the same kind of work in the same area before a provider moves to the back |
| `autoReview` | true | Risky work that passes every check gets an advisory review from a different model family |
| `reviewLines` | 150 | Changed lines above which work counts as risky (0 = size never triggers a review) |
| `reviewers` | [] | Providers to ask for that review, in order (default: the review role's chain, then any ready provider) |
| `suspectTests` | true | When verify fails but every acceptance check passes, check the code alone against the original tests; if it passes, blame the worker's own tests, not the code |
| `samples` | 1 | Attempts per write task, run in parallel on different providers; the best by checks is kept (`--samples N`) |
| `requireRepro` | true | A `fix` task without `repro:` must add a regression test that fails on the original code |
| `runAcceptance` | true | Run acceptance lines written as `` `expr` returns `value` `` / `throws Error` as checks after a build or fix task (JavaScript) |
| `escalate` | true | When a worker's code fails verify, hand it once to the next provider in the chain with a brief of what failed |
| `escalateRounds` | 1 | How many such hand-offs per task |
| `checkBase` | true | Run verify on the starting commit before a write task (cached per commit), so failures that were already there aren't blamed on the worker |
| `scopeAllow` | [] | Globs workers may change without the task listing them (lockfiles and test snapshots are always allowed) |
| `allowScope` | false | Accept changes outside a task's `files:`. Off: the outcome is `out-of-scope` |
| `allowUnverified` | false | Accept code no verify command checked. Off: such a run ends `unverified` with exit 4 (batch: exit 3) |
| `smartSelect` | true | Reorder each role's chain for the task: free API models first for small tasks with listed files, agents first for larger or open-ended ones, paid APIs last, and providers that failed 3 times in a row moved to the end. Off when you pass `--chain` or `--provider` |
| `maxReportBytes` | 8000 | `report.md` (what the controller reads) keeps only the worker's RESULT block, up to this size; the full output is saved as `report.full.md` |
| `maxDiffBytes` | 100000 | Review diffs above this are truncated (they are compacted first: see `conductor diff`) |
| `maxContextBytes` | 60000 | File content sent to chat-only (API) providers |
| `quotaPattern` | (regex) | Output that counts as a rate-limit error for CLIs |
| `dailyBudgetUSD` | 0 | Daily cap on known API spend across all providers. 0 = no cap. Providers over budget are skipped like cooled-down ones; free ones never count |

## Skills

Your skill library lives in `~/.config/conductor/skills/` (all projects) and `.conductor/skills/` (one project). A project switches skills off in its `.conductor/config.json`:
```json
{ "skills": { "off": ["php-conventions"] } }
```
Manage them with `conductor skills` or the Skills page in `conductor ui`. See [the guide](GUIDE.md#7-skills-one-library-for-every-controller-and-worker).

## Routing: which provider takes which task

Pin one plan task by adding a line under it:
```markdown
### T3: Booking date picker
- **role:** build
- **provider:** codex-cli
```
Or set rules once, in `routes` (global or per project). The first matching rule puts its providers first; the role's chain stays behind them as fallback:
```json
{ "routes": [
  { "files": "src/frontend/**", "provider": "grok-cli" },
  { "files": ["*.sql", "migrations/**"], "provider": "codex-cli" },
  { "text": "translate|copy|wording", "role": "docs", "provider": "kilo-free" }
] }
```
A rule matches when everything it names holds: `role`, `files` (globs; `**` spans folders, a bare `*.sql` matches anywhere) against the task's listed files, and `text` (a case-insensitive regex) against the task. Highest precedence first: `--chain`, `--provider`, the plan's `provider:` line, routes, then the smart selector. `conductor batch` keeps routed tasks on their provider instead of spreading them.

Check where a task would go without running it:
```bash
conductor route "add a date picker" --files src/frontend/Booking.tsx
```
```bash
conductor route --plan docs/plan/booking.md --task T3
```
For a ready-made set, run `conductor route --add starter` (or pick from the 12 library rules with `conductor route --templates`). The [routing guide](ROUTING.md) explains every rule. In `conductor ui` → Roles → Routing you can add rules from the library, write your own and preview a task. Each run's summary shows a `route:` line, and the Runs page shows why each worker went first.

## Time limits and model fallback

A worker that runs too long is stopped, with every process it started, and the next provider takes over. The limit is `timeoutSec` (20 minutes), or the provider's `timeoutMin`. Big tasks can say how long they should take:
```markdown
### T4: Migrate the order history screen
- **role:** build
- **eta:** 1h
```
That task may run 2 hours (`timeoutFactor`) before conductor stops it. `--timeout 3h` sets the limit for one command. Antigravity also gets the limit as its own `--print-timeout`.

When a model hits its rate limit, the same provider tries its next model before the chain moves on:
```json
"nvidia-nim": { "model": "qwen/qwen3-coder-480b-a35b-instruct", "fallbackModels": ["moonshotai/kimi-k2-instruct"] },
"opencode":   { "model": "opencode/big-pickle", "fallbackModels": ["opencode/glm-5.3-flash-free"] }
```
Pick model ids from `conductor models <provider>`. Only the limited model cools down. Free API providers (Kilo, OpenRouter free) and providers whose model is picked automatically find fallbacks from their own model list. The run summary shows each model tried, e.g. `nvidia-nim[qwen3-coder](quota) → nvidia-nim[kimi-k2](ok)`.

## Local models

Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan and a LiteLLM proxy are found on their default ports:
```bash
conductor local
```
It lists what's running, its models and the best one for coding (models under 7B are skipped: too small for coding tasks), or what to do next: start the server, or pull a first model (`ollama pull qwen3-coder`) when it only has embedding models. `conductor local --enable` turns the running ones on with that model. `conductor setup` and Providers in `conductor ui` offer the same. Local models are free and private, so the smart selector treats them like free API models.

## Saving tokens

Your controller's context is the expensive part, so conductor keeps what it reads small:

- **Smart selector** (`smartSelect`). Each run's summary shows a `selector:` line when it reorders a chain, e.g. `small task (1 file): free API models first`.
- **Compact diffs.** `conductor diff` (working tree, new files included), `conductor diff conductor/T3` (a parallel task's branch) or `conductor diff A..B`. Whitespace-only changes, lockfiles, build output and source maps are listed but not shown, with 2 lines of context and long files cut (`--lines`). It prints how much of the full diff it showed. Review workers get the same compact diff.
- **Trimmed reports.** `report.md` starts at the worker's `## RESULT` line, so tool transcripts printed before it never reach the controller.
- **The `/conduct-*` commands** tell the controller to read only the summary, `report.md` and `conductor diff`.
- **What it adds up to.** Each run's summary has a `context:` line, `conductor diff` prints how much it kept out, and `conductor usage` and the Runs page total them. These are estimates of context kept out of each model (about 4 characters per token), not measured Claude usage:
  - **Controller tokens:** diff and report text kept out of Claude's context.
  - **Worker tokens:** compacted review diffs.
  - **Free-model picks:** tokens spent on a free model where the role's first choice wasn't free.

## Usage and budgets

Every attempt is logged to `~/.config/conductor/usage.jsonl`: provider, model, role, project, result, time and, for API providers, tokens. Cost is known when the provider reports tokens and has a `price` (or is `free`). CLI agents run on your subscriptions, so they're counted in runs and minutes, not dollars.

```bash
conductor usage --days 7
```

Set `settings.dailyBudgetUSD` (or the field on one provider) to stop paid APIs for the rest of the day once the cap is reached; the chain then moves on to free providers and CLI agents. The UI's Runs page shows today's spend against the budget.

## Run history

Each run leaves `.conductor/runs/<time>-<role>[-task]/` in the project: the task, every provider's log, the winning report and `summary.json`. `conductor runs` lists them (newest first, with result, worker, verify and warnings), `conductor runs show <run>` prints one in full, and the UI's Runs page shows the same list, refreshing every few seconds.

## Cooldown state

Shared across projects in `~/.config/conductor/state.json`. See it with `conductor cooldown` and clear it with `conductor cooldown --clear [name]` (or from the UI Overview).
