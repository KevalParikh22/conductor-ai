# Changelog

## Unreleased

- **Idle limit per agent.** Codex is stopped after 10 minutes without output (its `--json` mode prints an event for every step, so silence that long means it hangs) and the next provider runs; agents that print only at the end (agy) keep no idle limit. A provider's `idleTimeoutMin` (`0` = never) and the global `idleTimeoutSec` still win.
- **UX checklist run (15 of 18 checks; the other 3 need a clean Claude Code, VS Code and Copilot).** Fixed what it found:
  - **Lost run:** two runs of one task started in the same second shared a run folder, so one was lost (also possible with `--samples` and race mode). Each run now gets its own folder; an exact run id still finds its run.
  - **Python Verify:** detected only when `pytest` was on the global PATH. Now the project venv, a pytest config (`pyproject.toml`, `pytest.ini`, `setup.cfg`, `tox.ini`, `conftest.py`) or a `tests/` folder gives `pytest` (or `python -m pytest`).
  - **Local model not installed:** adding Ollama (UI gallery or `conductor add`) set a model the server didn't have, without a word. It now switches to an installed model of a usable size, or says what to pull.
  - **doctor vs status:** a provider cooling down after a rate limit was ✗ in `status` and ready in `doctor`. Both now show `~ cooling down until … (reason)` with `conductor cooldown --clear <name>`, and the UI shows an amber "cooling down" pill.
  - **Fresh install:** optional API keys, a project not set up yet and agents you don't use were shown in red on API keys and Setup; red is now only for what conductor needs (git, Node).
  - **80 columns:** on a terminal, long lines wrap at words and continue under their text column (help, tables, status); piped output and `--json` are unchanged.
  - **Typos:** `lessons`, `stats`, `guard`, `rules`, `eval` and `plan` now get a suggestion; a tie names both (`runz` → run or runs); a swapped pair of letters counts as one edit (`stauts`).
  - **Phone width:** the rule library on Roles and folder paths on Skills widened the page; they wrap now.
  - `worker: x ((default))` → `worker: x (its default model)`.
  - **CI:** a `plugin` job runs `claude plugin validate .` (passes locally with Claude Code 2.1.317).
- **B2 benchmark tasks are ready** (`bench/b2/`): five bigger, multi-file tasks on a bookshop library (cart with stock rules, a discount engine, CSV product import with an error report, an order state machine with a refund window, checkout totals that need the cart and discounts), specified to the cent, with hidden tests written before any run and a reference solution. `node bench/run.mjs check --suite b2` proves each task fails on the start and passes on the solution; the plan passes `conductor plan check`. `bench/run.mjs` takes `--suite pilot|b2`. Not run yet: it needs Claude quota.
- **Local models that don't fail silently (V13).** Measured on Ollama 0.40: a model runs with a 4,096-token window unless told otherwise (the model itself supported 262,144), and a longer prompt is cut without an error: 59,000 characters reached the model as 2,050 tokens, status 200.
  - **Window check:** before a local chat call conductor asks the server for the window the model really runs with (Ollama `/api/show` and `/api/ps`, loading the model first if needed, which also keeps it loaded for 10 minutes; LM Studio `/api/v0/models`). A prompt that won't fit is not sent: the attempt fails with `context too small: …` and a fix (`OLLAMA_CONTEXT_LENGTH=16384`, or a Modelfile with `num_ctx`; the LM Studio load setting), and the next route runs.
  - **Cut detection:** when the server counts far fewer prompt tokens than were sent, the run warns that the prompt was cut (any server, window known or not).
  - **Smaller prompt for local models:** no project map, a shorter AGENTS.md and context pack, at most 20 KB of files (`localPromptProfile: false` keeps the full one).
  - **One call at a time per local server**, from any number of parallel tasks (a provider's own `maxParallel` wins).
  - **`doctor --live`** shows each local model's window, with the fix when it is under 8,192 tokens. A provider's `location` setting overrides the guess from its address.
- **Each step of a run is timed (V12).** The run record has `timings` (seconds for context, base, guard, verify, checks, repro, isolate, review); the summary shows a `time:` line, and the checklist (`conductor runs show`, the run page) shows each check's time. Measured on eval tasks: the checks take 0.1–0.2 s each and the workers 9–75 s per attempt (95%+ of a run); the project map and context pack take 10–75 ms, and base verify is already cached per commit, so nothing else was worth caching.
- **`src/core.js` split by concern (V12):** 1,129 → 784 lines; plan parsing, outcomes, reply files and evidence, the summary text and cooldowns moved unchanged into their own files and are re-exported from `core.js`, so no importer changed.
- **A clean npm package (V10).** The eval reference solutions (used only by `conductor eval check`, which now says to run it from a clone) are no longer published: 147 files instead of 163; the hidden tests and mutants that score `eval run` still ship. `scripts/check-package.mjs` runs `npm pack --dry-run` and fails on anything outside package.json `files` or anything for development only (tests, the benchmark, solutions, plans, conductor state, roadmaps, logs, secrets); a test runs it in every CI job.
- **Any controller, not just Claude (V11).** The README, package description and `conductor --help` now say "your coding agent plans and reviews" and name all four controllers. The quick start has one row per controller (Claude Code, Codex CLI, Antigravity CLI, OpenCode, or your own via `conductor controller add`) with its setup command and how to start, so a Codex-only or Antigravity-only user doesn't read Claude steps.
- **Race mode (V9, opt-in).** `--race` (or `settings.race` for small write tasks) starts the two fastest routes that have no per-token price (free APIs, agents on your subscriptions; never a paid API or the controller's own CLI) in their own worktrees. The first attempt that passes every check (verify, acceptance checks, scope, guard) wins; the other is stopped at once: its process group is killed and its API call aborted. A fast but wrong attempt doesn't win. It saves waiting, not tokens. Live: OpenCode passed 3/3 checks in 17 s and kilo-free was stopped. Cancelled calls are left out of the speed stats; the summary shows `race:` with the winner and what was stopped.
- **A free API call can no longer hang a task.** In an eval, one call to a free route stayed open for 1 h 40 min after its abort fired (a stalled TLS connection). Every API call and model-list request now has a hard deadline (its time limit + 5 s) and returns `timeout`, so conductor moves on even if `fetch` never settles.
- **Controllers as data (V6).**
  - **One entry per controller** (`CONTROLLERS` in `src/presets.js`) says where it reads its instructions, commands, skills, rules and reviewer subagent, how it registers MCP, and its hook file. Each format names one writer in `src/controllers.js` or `src/guard.js`. `init`, `rules sync`, the commit guard, skill sync and the doctor checks now all read the entries instead of checking controller names.
  - **No behaviour change:** for all four controllers, the 98 files `init`, `rules sync` and `guard on` write are byte-for-byte the same as before.
  - **Add your own:** `conductor controller add <name> --like <existing>` copies the formats of a controller that reads the same files (most read AGENTS.md and `.agents/skills`). It is stored under `controllers` in your config; `conductor controller list | check`, and `doctor` reports an entry that names a format conductor can't write. A tool with a new format still needs its writer and a real test.
  - **[docs/CONTROLLERS.md](docs/CONTROLLERS.md)** is generated from the entries; a test keeps it in step, and another checks every generated file is kept out of git.
- **One feature set in the CLI, MCP and UI (V3).**
  - **One registry** (`src/surfaces.js`) lists every action and where it lives. An action left out of a surface says why (secrets never pass through a model; a controller can't switch off its own guard; long evals run in the terminal). A test checks it against the real CLI commands, MCP tools and UI routes, so a new feature can't land in one surface and be forgotten in the others. [docs/SURFACES.md](docs/SURFACES.md) is generated from it.
  - **MCP gained** `conductor_stats` (quality, failure causes, usage), `conductor_doctor` (with `live`), `conductor_rules`, and remove/promote in `conductor_lessons`.
  - **The UI gained** a **Lessons & rules** page (add, remove, promote; lessons seen 3+ times are highlighted), and on Overview the first-try accept rate with the alpha gate, and the commit guard with an on/off switch.
  - **Shared code:** doctor's checks moved to `src/doctor.js` and guard switching to `switchGuards`, so the CLI, MCP and UI do exactly the same thing.
- **Lessons you can check (V1).**
  - **Resolved, not held against forever:** when a provider passes a kind of work in an area where it failed before, its earlier failures there are marked resolved and stop moving it to the back of the chain. The guidance stays in prompts, because it is still true for the project.
  - **Offered as rules:** a lesson seen 3 times shows a `promote?:` line in the run summary and `[promote?]` in `conductor lessons`, with the command. Promoting stays the user's call.
  - **Cleaner lessons (found by the first A/B):** a module that fails to load made every acceptance check fail with the same error, and that was saved as a wrong-value lesson; it is now one `load` lesson with the error. A worker whose work was handed on now gets the concrete failed check as its lesson, not the empty "its acceptance checks failed".
  - **A/B in the eval:** `conductor eval run --lessons <file>` carries lessons from one run to the next, task by task (each eval task is a fresh repo, so they were lost before); `--no-lessons` is the control. The report shows which tasks had lessons in their prompt and how the same tasks did in the compared run.
- **Antigravity (agy) under pressure (V8).** Checked against agy 1.5.8 with a real quota.
  - **Real reset times:** a rate limit now cools a provider down until the time it reports ("Resets in 118h3m13s", "try again in 30s", "retry after 120 seconds"), capped at a week, instead of 30 minutes every time. Cooldowns that end on another day show the date.
  - **Another model family on quota:** agy's model families have separate quotas, so when its Gemini quota is used up conductor tries its Claude or GPT-OSS models (from `agy models`, cached for a day) before giving up. Live: Gemini out of quota for 46 h → `claude-sonnet-4-6` did the task. When two models report the same reset time, the quota is the account's: conductor stops trying models and cools agy down until then.
  - **One agy task at a time** by default (`maxParallel: 1`, any provider can set its own): batch spreads past it, and calls from parallel tasks wait their turn.
  - **Permission check in `doctor --live`:** each agent that answers is asked to run `npm test` in a throwaway repo. A refusal is reported with the exact fix (`settings.allowCommands`).
- **"Done" means validated, and every run has its own page (V4).**
  - **A checklist per run** (`src/rungates.js`): plan gate, worker, code guard, acceptance answered, acceptance checks, verify, scope and repro, each with pass / fail / waived / skipped / missing and its evidence (command, numbers, files, log path). The starting-commit verify and the independent review are shown as information.
  - **The rule:** a run is `done` only when every required check passed or was waived on purpose. A test runs over 4,000 combinations of results to prove the outcome and the checklist always agree, so the UI can't show done for a run whose verify didn't run.
  - **The plan gate result is now saved** on each run (`planGate`), so the checklist can show it.
  - **Where it shows:** `conductor runs show <run>` (and `--json` for the full page data), the MCP `conductor_runs` tool with a run id, and a new **run page** in the UI: open any run from the Runs list to see the checklist, attempts with tokens and next steps, the changed files, the report, logs, the diff of a kept branch, and the commands to merge or discard it. Its link (`#p=runs&run=<id>`) opens it directly.
  - **Safe by design:** the new `/api/run` reads only the project's own run files; a path outside the project is never read.
- **Every failure says what to do next (V2).** Each failed or skipped worker now carries a `next` step written for its exact reason: the install and sign-in command for a missing CLI, `conductor keys set NAME` (with where to get the key) for a missing key, `conductor cooldown --clear NAME` for a cooldown, the `settings.allowCommands` fix for a refused command, the worker log to read for an error exit, and so on.
  - **Where it shows:** `fix:` lines in the run summary (so MCP replies too), in `conductor runs`, and on the UI's Runs page. A failed attempt's tooltip shows its reason and step.
  - **When nothing won,** every provider gets its line. **When another worker won,** only problems that stay until someone acts (install, key, auth, refused command, disabled, wrong model) are shown.
  - **New table:** `src/nextsteps.js`. A test scans `src/` for reason strings and fails if one has no step.
- **Worker token counts for Codex and OpenCode.** Both used to show 0, so `conductor usage`, `conductor stats` and the benchmark only knew agy's share.
  - **Codex** now runs with `--json`; the tokens come from its `turn.completed` events, summed over turns (reasoning counts as output). The answer still comes from `-o`.
  - **OpenCode** now runs with `--format json`, which gives the answer and the session id but no tokens. conductor then reads them with `opencode session export --standalone <id>` (about 0.6 s; cache reads and writes count as input).
  - **Failed attempts keep their token counts too** (timeouts, exit codes, empty output).
  - Older CLIs that print plain text still work: the output is used as before, without token counts.

- **Faster plans: routing by measured speed.**
  - **Speed-aware order:** for small tasks, the selector orders workers of the same kind by their measured median time on that role, among those that succeed at least 60% of the time. Big tasks keep your order.
  - **Batch spreads a wave** by expected finish time, with at most `maxParallelPerProvider` (2) tasks per provider.
  - **Hang cool-down:** a free route that times out twice cools down (`hangCooldownMin`, 15).
  - **Review only when needed:** `/conduct-run` skips the extra end-of-plan review when every task passed its checks the first time.
  - **Pilot C:** 623 s → **137 s**, with the same 6/6 and the same Claude cost ([docs/BENCHMARK.md](docs/BENCHMARK.md)).
  - **No cold start:** a provider with no history yet (a new one, or a fresh account) counts as average for its group (the median of the measured ones), not last, so it gets tried and its speed gets measured. A measured provider that fails often still goes last.
- **Fix:** a worker report mentioning `Math.ceil` or `user.name` no longer counts as a changed file. A dotted word counts only with a real file extension, or when it exists.
- **`conductor stats`: is it delivering?** Shows, for this project's write tasks:
  - how many were accepted **on the first try** (done, one worker, no hand-off or retry);
  - how many were done in the end, and where the rest ended;
  - fallbacks, hand-offs and retries;
  - worker tokens, cost and minutes, and the context kept out;
  - the **alpha gate**: at least 70% accepted first try over at least 10 write tasks.

  `--failures` still lists the causes.
- **First pilot results ([docs/BENCHMARK.md](docs/BENCHMARK.md)).** Six tasks, hidden tests, Claude Code on Sonnet. With conductor, Claude used **56% less** (72% fewer tokens) and the result was equally correct (6/6 in both). On tasks this small it was **5.8× slower**, because the workers take minutes where Claude takes seconds. It's labelled a pilot: one repo, one run each.
- **Pilot benchmark harness (`bench/`).** Six tasks in a small Node library with hidden tests and a reference solution. `node bench/run.mjs check | A | C` compares Claude Code alone with Claude Code as conductor's controller, measuring Claude's tokens and cost from `claude -p --output-format json`.
- **Fix: the export check held a task to other tasks' exports.** The plan's Design notes describe every module, and the check read all of them, so a pagination task was told to export `slugify`. Only Design-notes lines that mention the task's own files count now. Found by the pilot's dry run.
- **Guard hooks (opt-in): no commit while verify fails.**
  - `conductor guard on` (or `init --guards`) installs a hook in the controller. While the last `conductor verify` in this checkout failed, the controller's `git commit` is blocked, with the reason and what to do: fix it and `conductor verify` again, or `conductor guard allow` for a one-time exception.
  - Verify results from `conductor verify`, the MCP verify tool and runs in the main checkout are recorded for this. On Claude Code, Stop also shows a reminder of task branches waiting for review.
  - **Claude Code:** `.claude/settings.local.json`, your personal settings, not the team's. **Antigravity:** `.agents/hooks.json`.
  - Checked with real runs: both tools blocked the commit and passed conductor's reason to the model, and normal commands kept running.
  - In agy, an empty hook answer denies the command, so the guard answers "ask" for everything else; that defers to agy's own permission rules, which a hook can never loosen. Codex is not supported yet: its project hooks need a trusted project and approval in `/hooks`.
  - `conductor guard [status] | on | off | allow`. Your own hooks in those files are kept, and a file with invalid JSON is never overwritten.
- **The edit guard checks exports.**
  - For JavaScript and TypeScript `build` and `fix` tasks, a function or class the acceptance checks call (`slugify(…)`, `new LRUCache(…)`), or that the plan says to export ("exporting `toQuery(params)`"), must be exported **by that name**.
  - An `export default` or an unexported function doesn't count, because `import { slugify }` would still fail.
  - Such an attempt is rejected straight away (stashed, next provider) instead of failing later in verify. In the last eval this was the cause of 3 of 4 failures.
  - Methods such as `keys()` are never required as exports. `contractCheck: false` turns it off with the other contract checks.
- **Workers start with the facts, not a blank page (context pack).**
  - Before a write task, conductor gathers, with no model involved: the task's files (new or existing, size, the names each defines); **where that code is used elsewhere**, so callers keep working; the verify command; and the sections of `docs/architecture.md` that mention those files.
  - Agents get it compact: callers grouped per file with line numbers, plus a project map of the task's area. Chat models get the actual calling code lines (imports left out, source before tests), since they can't open files.
  - `contextPack: false` turns it off; `contextPackBytes` (4000) caps it.
- **Per-provider prompt addition:** `providers.<name>.promptExtra` adds a note to that provider's prompts only, for guidance a small or free model needs. It goes before the recited acceptance criteria, which stay last.
- **Each controller gets its files in its own format.**
  - **Project rules:** write a rule once in `.conductor/rules/<name>.md`, optionally for certain `paths`. conductor writes it where each controller reads it:
    - Claude Code: `.claude/rules/`, with `paths:`.
    - Antigravity: `.agents/rules/`, with `trigger: glob` or `always_on`, since agy silently drops a rule with the wrong frontmatter.
    - Codex and OpenCode: a block in AGENTS.md.
    - Workers get the rules matching their files in their prompt.
  - **`conductor-reviewer` subagent:** reviews a worker's diff against its plan task in a fresh context, so the controller saves its own. Formats: `.claude/agents/`, `.agents/agents/`, `.codex/agents/*.toml`, `.opencode/agents/` (OpenCode 2 permissions: edits and shell denied except `conductor diff` and git reads). Checked with the real CLIs: agy lists it, OpenCode runs it, and Codex reads the rules.
  - **`conductor doctor`** now checks the files controllers read:
    - Antigravity rule frontmatter (a bad `trigger` is silently ignored by agy);
    - skill descriptions;
    - AGENTS.md size limits (Codex reads 32 KiB);
    - JSON configs;
    - whether Codex trusts the project, without which it ignores `.codex/`.
  - **Commands:** `conductor rules [list] | new <name> [--paths] | sync`. `init` writes the rules and the reviewer for its controller, and keeps them out of git.
- **Lessons: the team remembers.**
  - conductor keeps what earlier work taught in this project. That covers every failure it diagnoses (failed acceptance check, function under the wrong name, wrong test, out-of-scope edits, missing regression test, syntax error, no files in a reply) and every `--note` the controller writes on a retry.
  - Later work in the same folder and role gets up to 5 matching lessons in its prompt.
  - A provider that failed the same kind of work there twice moves to the back of the chain. It isn't removed, and never when you give `--provider` or `--chain`.
  - `conductor lessons` lists them; `add`, `rm`, and `promote <id>` (which makes one a rule in AGENTS.md for every controller and worker). There's also an MCP tool, `conductor_lessons`.
  - Stored in the repository's git folder, so it never shows up as a change. `lessons: false` turns it off.
- **Independent review for risky work.**
  - After a write task passes every check, a model from a **different family** than the worker's (OpenAI, Google, Anthropic, Qwen, DeepSeek…) reviews the diff against the task.
  - It runs when the work is risky: over `reviewLines` (150) changed lines, security-related files (auth, tokens, payments, SQL, uploads…), or `- **review:** yes` in the plan.
  - Findings that don't point at a changed line are dropped. The rest are shown with severity and `path:line`.
  - **Advisory:** it never overrides passing checks; the controller triages.
  - `--review` / `--no-review`, MCP `review`, settings `autoReview`, `reviewLines`, `reviewers`.
- **Fix: acceptance checks failed for project functions named `check`, `show`, `inspect` or `out`.** Those names clashed with conductor's own helpers in the generated check script; its names are now prefixed.
- **A wrong test no longer gets correct code broken.**
  - When verify fails but every acceptance check passes, conductor runs the project's original tests against only the worker's code changes, in a temporary checkout of the starting commit.
  - If they pass, the failures come only from tests the worker added or changed. The summary says "the code looks right, check those tests first", and the hand-off tells the next worker to fix the test, not the code.
  - Only with at least one acceptance check, since without one conductor doesn't guess. `suspectTests: false` turns it off.
- **Test:** the batch parallelism test compares the workers' own start and end times instead of the batch's wall clock, so a slow CI machine can't fail it.
- **`--samples N`: best of several attempts.**
  - Runs a write task on N different providers in parallel, each in its own worktree and through every gate (verify, scope, edit guard, acceptance checks, repro).
  - conductor picks by results, not by a model's opinion: a `done` attempt first, then the most acceptance checks and criteria met, then the smallest diff. The chosen attempt's changes land in your working tree (or stay on its branch with `--worktree`); the others are removed.
  - The summary lists every attempt. Also `settings.samples`, MCP `samples` and `conductor eval run --samples N`. Off by default (1).
- **Fixes start from the bug.**
  - A `fix` task can name a `repro:` command. conductor runs it before the worker, and it must fail (otherwise the task is refused: the bug isn't reproduced). It runs it again after the fix, and it must pass.
  - Without `repro:`, the worker must add a regression test. conductor checks out the original commit in a temporary folder, adds only the worker's new tests, and runs verify there: the tests must **fail** on the old code, or they prove nothing.
  - A fix that misses either is **partial**, and the work is handed on with what is missing. `--allow-no-repro` runs a task whose repro already passes; `requireRepro: false` turns the test check off.
- **Scope:** test files named after a listed file (`paginate.regression.test.js` for `src/paginate.js`) are in scope.
- **Acceptance criteria are run, not just answered.**
  - Lines like `` `slugify('alpha beta', { maxLength: 6 })` returns `'alpha'` ``, `` `f(x)` throws TypeError `` or `` `load(-1)` rejects with RangeError `` become a small test that conductor writes and runs itself after the worker. No model is involved, so a confident but wrong `[x]` can't pass.
  - A failing check makes the outcome **partial**. The summary shows each failure with what came back (`✗ add(2, 3) → returned -1 (expected 5)`), and the work is handed to the next provider with that brief.
  - A function the plan calls that no file exports is a failed check. Lines that use helpers the plan never defines are skipped, never guessed.
  - When every check passes but verify fails, the summary hints that the failing test may itself be wrong.
  - Applies to `build` and `fix` tasks on JavaScript files for now. `runAcceptance: false` turns it off. `conductor eval check` also runs each task's checks against its reference solution.
- **Eval: unreachable providers don't count.** A task where no model could be reached (DNS, offline) is an `error`, left out of the pass rate and the verdicts, instead of looking like a failure conductor caught.
- **Failed verify comes with a fix brief.** A failing verify is condensed into what a worker needs: the failing tests, the error (e.g. `-1 !== 5`) and where (`test/add.test.js:2`). It is shown in the summary as `why:` and written to be pasted into `--note` (node:test, pytest, PHPUnit and similar output).
- **Work that fails verify is handed on once.** Instead of stopping, conductor gives the work to the next provider in the chain with the brief. In a normal run that worker fixes it in the same checkout; in a worktree it continues on the task branch. Every attempt stays in the summary (`handed on: X's work failed verify → Y took it over`). There is no hand-off when the failures were already there before the worker started.
  - `escalateRounds` (1) sets how many hand-offs; `escalate: false`, `--no-escalate` or MCP `no_escalate` turns it off.
- **Chat models get instructions made for them** (found by the eval baseline).
  - API workers (no tools) now get their own prompt: everything inlined, a project map (files and the names each defines), no "read the files" steps, and "reply now with the file blocks". The shared agent prompt had told them to read files, so some answered "Let me check the project first" and changed nothing.
  - A reply with no file blocks gets **one repair turn** that shows the model what it said and asks for the files. Both turns' tokens are counted.
  - Chat logs show the answer and the model's hidden reasoning in full, with their sizes, instead of raw JSON cut at 4,000 characters.
- **Edit guard: broken or misnamed work is rejected before verify.**
  - Changed files are syntax-checked: JavaScript (`node --check`), JSON, PHP (`php -l`) and Python, whichever is available.
  - **Contract check:** a function or class the task names in a code span (`` `toQuery(…)` ``, `` `new LRUCache(2)` ``) must be defined somewhere in the project after the change. The eval baseline caught a worker that "finished" under a name of its own while its own tests passed.
  - A rejected attempt is stashed and the next model or provider runs. `syntaxCheck: false` and `contractCheck: false` turn the checks off.
- **`conductor eval`: measure conductor itself.**
  - 10 tasks in `evals/` (bug fixes, features, test-writing), each with a starting project, a plan, hidden tests the worker never sees and a reference solution. Test-writing tasks are scored by planted bugs the worker's tests must catch.
  - `conductor eval run [--tasks …] [--provider p | --chain a,b] [--label x] [--compare last]` runs them the way a user would, scores each against the hidden tests and reports pass rate, cost, and conductor's verdict against reality ("done" and right, **"done" but wrong**, caught, false alarm). Results are saved in `~/.config/conductor/evals/`.
  - `conductor eval check` proves every task is fair with no LLM: it fails on the starting project and passes with the reference solution. It runs in CI.
- **`conductor stats --failures`** groups failed attempts and runs by cause, biggest first, so the top cause is fixed first.
- **Tests and verify run in a clean environment** (`NODE_TEST_CONTEXT` removed), so a project's `node --test` can't misreport when conductor itself runs under a test runner.
- **Plan check: vague tasks never reach a worker.**
  - `conductor plan check <plan>` (and the MCP tool `conductor_plan_check`) lists each task as ready or not, with exactly what is missing. The same check runs before `run` and `batch` hand out a task.
  - A write task needs: `files:`, acceptance criteria a check can confirm (not "works" or "done"), a verify command (the task's or the project's), and at most `maxTaskFiles` (4) files besides tests.
  - `--allow-weak-plan` (MCP `allow_weak_plan`, setting `planGate: false`) overrides. The `conduct-plan` skill now runs the check and fixes the plan before offering to run it.
- **Acceptance criteria are answered with evidence.**
  - The task's criteria are repeated at the end of the worker's prompt, and the worker answers each in an `## Acceptance` section (`[x]` with evidence, or `[ ]` with why).
  - A DONE that leaves any criterion unanswered or unmet is **partial**, and the summary lists which. `requireAcceptance: false` records the answers without affecting the outcome.
- **Chat models no longer report PARTIAL just because they can't run checks.** conductor runs verify after applying their files, and their prompt now says so. Found in a real free-model run, where finished work with passing tests came back PARTIAL.
- **The starting commit is checked before a worker is blamed.**
  - Before a write task, conductor runs verify on the commit the worker starts from (cached per commit and command, shared by parallel tasks; `checkBase: false` turns it off).
  - If it already fails, the worker is told which failures were already there, the summary shows a warning, and a failing verify afterwards reads **NOT PROVEN** with the failure lines that are new.
- **Scope gate.**
  - When a task lists `files:`, changes to other files make the outcome **out-of-scope**, listing them. Tests of the listed files, lockfiles and snapshots are always fine; `scopeAllow` adds globs.
  - `--allow-scope` (MCP `allow_scope`, setting `allowScope`) accepts it. A batch counts out-of-scope tasks separately and doesn't treat them as done.
- **Antigravity: refused actions are no longer missed.**
  - In headless mode, agy exits 0 and reports `SUCCESS` even when it was refused an action it needed (for example a shell command without an allow rule). conductor now runs it with `--output-format json` and reads the `denied_actions` list (checked against agy 1.5.3).
  - Refused with no answer: the attempt fails with `denied: command (add an allow rule …)` and the next provider runs. Refused but answered: the answer is kept, with a warning that it may have skipped steps such as running tests.
  - A non-`SUCCESS` status fails the attempt. Older agy versions without JSON output still work as before.
  - agy runs now record real token counts.
- **Codex and OpenCode flags checked against their current versions** (Codex 0.166, OpenCode 2.0.32). No retired Codex flags are used. OpenCode 2 converts conductor's permission rules and MCP entry correctly; tests now lock the rule order that OpenCode 2's "last match wins" depends on.
- **No proof, no "done".**
  - Code a worker writes counts as done only when the verify command ran and passed.
  - Without a verify command, the outcome is the new **unverified**, and `conductor run` exits with **4**. A batch counts it separately (`?`) and exits 3.
  - `--no-verify`, `--allow-unverified` (or the `allowUnverified` setting) accept it on purpose; the outcome still says unverified.
  - `conductor init --verify "<cmd>"` sets the Verify line in AGENTS.md, and `init` warns when the project has no verify command.
  - The Runs page, `conductor runs` and the MCP tools show it.
- **Claude Code and Antigravity plugin.**
  - **What it brings:** in one install, the 9 `conduct-*` skills, conductor's MCP server and a startup check that says when the CLI is missing or the project isn't set up.
  - **Claude Code:** `/plugin install conductor-ai --marketplace KevalParikh22/conductor-ai`.
  - **Antigravity:** `agy plugin install "$(npm root -g)/conductor-ai"`. This replaces the manual `agy mcp add` step.
  - **Checked:** both tools' validators pass, and both installed it in a clean config.
  - **Kept in sync:** the skills are generated from the same command templates as `init` (`node scripts/gen-plugin.mjs`), and a test keeps them in sync.
- **More MCP tools.**
  - `conductor_retry` (a worker fixes its own task), `conductor_diff` (compact diff), `conductor_route` (preview), `conductor_runs` (history and one run in full), `conductor_skills`.
  - Every tool takes an optional `project` path, for controllers that start conductor outside the project.
- **Skill headers are valid YAML.** `[--plan <file>]`-style argument hints are now quoted; Antigravity skipped that skill before.


## 0.10.0 (2026-11-08)

### Skills, git and docs

- **One skill library for every controller and worker.**
  - **Where skills live:** in conductor, in `~/.config/conductor/skills/` (all projects) or `.conductor/skills/` (one project). The format is the standard SKILL.md.
  - **Controllers:** the active skills are copied into `.claude/skills` and `.agents/skills`, so Claude Code, Antigravity, Codex and OpenCode load them natively.
  - **Workers:** each worker gets only the skills that match its task (optional `metadata`: roles, files, text). Agents get paths; API models get the text.
  - **Per project:** each project can switch any skill off.
  - **CLI and UI alike:** `conductor skills` (list, new, add, on/off, rm, sync) and a **Skills** page.
  - **Checked for real:** Antigravity received a skill and followed it.
- **conductor's files stay out of git.**
  - `conductor init` adds a marked block to `.gitignore`, creating the file if needed. It lists conductor's folders and the files it created, never a file you already had. `--share` opts out.
  - Workers still see these files: conductor copies them into each task's worktree. Because git can't see changes to ignored files, conductor puts back any a worker changes, with a warning.
  - Task branches contain only the real changes.
- **One guide.** [docs/GUIDE.md](docs/GUIDE.md) replaces the install, editors and cloud pages. It covers:
  - global vs project setup;
  - the setup and daily command sequences;
  - controllers;
  - skills;
  - CLI and UI side by side;
  - git, editors, cloud and troubleshooting.

### Controllers

- **Switching the controller works in the UI.** Picking one in Settings no longer goes through the save bar. Saving to the global config was silently overridden by the project's own setting, so the choice snapped back. The button now says "Switch this project to …" and does it in one step.
- **Every controller gets its commands where it reads them.** Checked against each tool:
  - **Claude Code:** `.claude/commands`, plus `.mcp.json`, which Claude asks you to approve on first run.
  - **Antigravity, Codex and OpenCode:** the `/conduct-*` commands are skills in `.agents/skills/`. Codex and OpenCode used to get prompts in `.conductor/commands/`, which no tool reads. OpenCode loads the skills and conductor's MCP tools from the project.
- **Antigravity and Codex only load MCP servers from their own global config.** `init` now says so, with the one command to run (`agy mcp add conductor conductor mcp` or `codex mcp add conductor -- conductor mcp`), unless conductor is already registered. It never edits those configs itself.

### UI and CLI

- **UI keeps your page on reload.** The open page is in the address (`#…&p=roles`), and back/forward move between pages. Before, every reload went to Overview.
- **One rule for "optional" providers.** A default provider with no key yet shows as ○ / grey "optional · add key" in the UI, `conductor status` and `doctor` alike, never as red. Overview counts "4 of 4 ready + 2 optional".
- **Setup page:** your controller's CLI is shown as off as a worker, and the step for the Verify command says it's detected now. Settings shows the detected verify command.
- **CLI:**
  - A typo gets a suggestion ("Did you mean: conductor build?").
  - Output uses colour at a terminal (✓ green, ✗ red, ⚠ yellow, ○ dim), but never for pipes, `NO_COLOR`, `--no-color`, `--json` or the MCP server.
  - `conductor providers` cuts descriptions at a word to fit the terminal.

### First run and reliability

- **Setup never turns on your controller as a worker.** With Claude Code as the controller, `claude-cli` stays off, and setup says why: work sent to it spends the quota conductor is meant to save. Routing rules never pick it either. You can still turn it on in the UI.
- **Too-small local models aren't picked.** Models under 7B (read from the name, e.g. `qwen3.5:2b`) fail or produce junk on coding tasks. `conductor local` and setup list them and suggest a coding model to pull.
- **Hanging free routes fail over fast.**
  - Free API providers give up after 90s (`freeApiTimeoutSec`), down from 5 minutes.
  - After one timeout, one more model is tried on that provider; a second timeout moves the chain on.
  - The fallback model list is fetched with a short wait, and an older list is reused when the provider can't list its models.
  - In a real check, Kilo's default free route hung and the task finished on another free Kilo model in 96s.
- **`init` fills in the Verify command** in AGENTS.md from the project's scripts. PHP projects are now detected (`composer test`, `vendor/bin/phpunit`).
- **Honest labels.** The savings figure is now "context kept out (estimate)" everywhere: run summaries (`context:`), `conductor diff`, `conductor usage` and the Runs page. It is counted from characters, not measured Claude usage. The README no longer quotes a one-sample "40% smaller diff".
- **The Runs page and `conductor runs` show the real outcome:** done, partial, verify failed or failed.
- **A fresh `doctor` isn't red.** A default provider with no key yet shows as ○ "optional: add a key". It's a problem (✗) only when you turned it on yourself.

## 0.9.1 (2026-11-06)

- **A worker can fix its own work.**
  - `conductor retry T3 --note "what to fix"` continues task T3 in its existing worktree. By default it goes to the same worker, which keeps what is right, fixes what the note asks and commits on the same branch.
  - `--provider` hands the fix to someone else.
  - Also available as `--continue` on `run`, and as `continue: true` in the MCP tool, which also takes `timeout`.
  - A failed retry keeps the earlier work.
  - Before, the only option was to start the task over, which threw the work away.
- **Antigravity no longer gives up when it runs unattended.**
  - It was denied conductor's whole folder, and task worktrees live inside that folder, so it was locked out of its own files. Now only conductor's `secrets.env`, `config.json`, `state.json` and `usage.jsonl` are denied.
  - Usual build, lint and test commands run without a permission prompt that nobody could answer: `npx tsc`, `npx jest`, `npx expo lint`, `npm test`, `pytest`, `go test` and others, plus your verify command and `settings.allowCommands`. They still run inside agy's sandbox, with no network.

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
