# Features in every surface

Generated from `src/surfaces.js` by `node scripts/gen-surfaces.mjs`; a test keeps it in step with the code.
A dash means the action is left out of that surface on purpose, with the reason.

| Action | CLI | MCP (controller) | UI (route) |
|---|---|---|---|
| Hand a task to a worker | `conductor-ai run <role> "task" (or conductor-ai <role> …)` | `conductor_ai_run` | — *work is handed out by your controller or the terminal; the UI shows the result (Runs)* |
| Run plan tasks in parallel (--all --merge: the whole plan, by depends, merged) | `conductor-ai batch --plan f --tasks T1,T2 \| --all --merge` | `conductor_ai_batch` | — *started by the controller; each task shows on the Runs page* |
| Have a worker fix its own task in place | `conductor-ai retry <task> --note "…"` | `conductor_ai_retry` | — *needs a note about what was wrong: the run page shows the command* |
| Preview who would take a task, and why | `conductor-ai route "task"` | `conductor_ai_route` | `POST /api/route-preview` |
| Check a plan before handing it out | `conductor-ai plan check <file>` | `conductor_ai_plan_check` | — *plans are files in your editor; the controller checks them* |
| Run the project's verify command | `conductor-ai verify` | `conductor_ai_verify` | — *runs project commands; use the terminal or your controller* |
| Recent runs, and one run in full (checks, attempts, report) | `conductor-ai runs [show <run>]` | `conductor_ai_runs` | `GET /api/run` |
| Import your answer from a web chat for a waiting run (or a research report) | `conductor-ai import <run> <file>` | `conductor_ai_import` | `POST /api/import` |
| Run verify again for runs that failed it | `conductor-ai runs recheck [<run>…]` | — *slow, and it rewrites run records: run it yourself, from cron or from the Runs page* | `POST /api/recheck` |
| Compact diff to review | `conductor-ai diff [branch]` | `conductor_ai_diff` | `GET /api/run` |
| Quality numbers: first-try accept rate, alpha gate, failure causes | `conductor-ai stats [--failures]` | `conductor_ai_stats` | `GET /api/stats` |
| Runs, tokens, cost and time per provider | `conductor-ai usage` | `conductor_ai_stats` | `GET /api/runs` |
| Lessons: list, add, remove, promote to a rule | `conductor-ai lessons [add\|rm\|promote]` | `conductor_ai_lessons` | `GET /api/lessons` |
| Project rules for every controller and worker | `conductor-ai rules [new\|sync]` | `conductor_ai_rules` | `GET /api/rules` |
| Skill library: list, turn on/off, edit | `conductor-ai skills` | `conductor_ai_skills` | `GET /api/skills` |
| Providers, chains, controller and repo state | `conductor-ai status` | `conductor_ai_status` | `GET /api/state` |
| Check installs, keys, live answers and permissions | `conductor-ai doctor [--live]` | `conductor_ai_doctor` | `POST /api/test` |
| Block the controller's commit while verify fails | `conductor-ai guard [on\|off\|status]` | — *a controller must not be able to switch off its own guard* | `GET /api/guard` |
| Add a provider from the catalog | `conductor-ai add <id> · conductor-ai providers` | — *needs an API key: never through a model* | `POST /api/providers/add` |
| Several signed-in accounts for one CLI (Codex, Claude Code): add, sign in, check, order | `conductor-ai accounts [add\|login\|check\|rename\|rm\|order\|on\|off]` | — *accounts are your own logins: conductor_ai_status shows them, only you change them* | `GET /api/accounts` |
| Set or remove API keys | `conductor-ai keys` | — *secrets never pass through a model* | `PUT /api/secrets` |
| A provider's current models | `conductor-ai models <provider>` | — *part of setup, not of a task* | `POST /api/provider-models` |
| Find local model servers | `conductor-ai local` | — *part of setup, not of a task* | `GET /api/local` |
| See and clear rate-limit cooldowns | `conductor-ai cooldown [--clear]` | — *conductor_ai_status shows them; clearing is your call* | `POST /api/cooldowns/clear` |
| Roles, routing and settings | `conductor-ai config path · conductor-ai ui` | — *changing routing is your call, not a model's* | `PUT /api/config` |
| Controllers as data: list, add one like an existing one, check | `conductor-ai controller [add\|check]` | — *adding a controller is setup, not a task* | `GET /api/state` |
| Set up a project for a controller | `conductor-ai init` | — *runs once, before the controller can use MCP* | `POST /api/init` |
| First-time setup | `conductor-ai setup` | — *runs before any controller is connected* | `GET /api/state` |
| List or remove task worktrees | `conductor-ai worktree [rm]` | — *merging and removing branches is your call: the run page shows the commands* | — *shown as commands on the run page* |
| See conductor-ai work end to end on a throwaway project | `conductor-ai demo [--keep]` | — *a first look for a person, not a task for a controller* | — *runs in the terminal, with a live table; --keep leaves the project to open in conductor-ai ui* |
| Score conductor-ai on tasks with hidden tests | `conductor-ai eval [run]` | — *long and spends provider quota: run it yourself* | — *long-running: use the terminal* |

Controller skills and commands (`/conduct-…`) call the MCP tools or the CLI; see `templates/commands/`.
