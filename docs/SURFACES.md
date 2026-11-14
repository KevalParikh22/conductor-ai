# Features in every surface

Generated from `src/surfaces.js` by `node scripts/gen-surfaces.mjs`; a test keeps it in step with the code.
A dash means the action is left out of that surface on purpose, with the reason.

| Action | CLI | MCP (controller) | UI (route) |
|---|---|---|---|
| Hand a task to a worker | `conductor run <role> "task" (or conductor <role> …)` | `conductor_run` | — *work is handed out by your controller or the terminal; the UI shows the result (Runs)* |
| Run independent plan tasks in parallel | `conductor batch --plan f --tasks T1,T2` | `conductor_batch` | — *started by the controller; each task shows on the Runs page* |
| Have a worker fix its own task in place | `conductor retry <task> --note "…"` | `conductor_retry` | — *needs a note about what was wrong: the run page shows the command* |
| Preview who would take a task, and why | `conductor route "task"` | `conductor_route` | `POST /api/route-preview` |
| Check a plan before handing it out | `conductor plan check <file>` | `conductor_plan_check` | — *plans are files in your editor; the controller checks them* |
| Run the project's verify command | `conductor verify` | `conductor_verify` | — *runs project commands; use the terminal or your controller* |
| Recent runs, and one run in full (checks, attempts, report) | `conductor runs [show <run>]` | `conductor_runs` | `GET /api/run` |
| Import your answer from a web chat for a waiting run (or a research report) | `conductor import <run> <file>` | `conductor_import` | `POST /api/import` |
| Compact diff to review | `conductor diff [branch]` | `conductor_diff` | `GET /api/run` |
| Quality numbers: first-try accept rate, alpha gate, failure causes | `conductor stats [--failures]` | `conductor_stats` | `GET /api/stats` |
| Runs, tokens, cost and time per provider | `conductor usage` | `conductor_stats` | `GET /api/runs` |
| Lessons: list, add, remove, promote to a rule | `conductor lessons [add\|rm\|promote]` | `conductor_lessons` | `GET /api/lessons` |
| Project rules for every controller and worker | `conductor rules [new\|sync]` | `conductor_rules` | `GET /api/rules` |
| Skill library: list, turn on/off, edit | `conductor skills` | `conductor_skills` | `GET /api/skills` |
| Providers, chains, controller and repo state | `conductor status` | `conductor_status` | `GET /api/state` |
| Check installs, keys, live answers and permissions | `conductor doctor [--live]` | `conductor_doctor` | `POST /api/test` |
| Block the controller's commit while verify fails | `conductor guard [on\|off\|status]` | — *a controller must not be able to switch off its own guard* | `GET /api/guard` |
| Add a provider from the catalog | `conductor add <id> · conductor providers` | — *needs an API key: never through a model* | `POST /api/providers/add` |
| Set or remove API keys | `conductor keys` | — *secrets never pass through a model* | `PUT /api/secrets` |
| A provider's current models | `conductor models <provider>` | — *part of setup, not of a task* | `POST /api/provider-models` |
| Find local model servers | `conductor local` | — *part of setup, not of a task* | `GET /api/local` |
| See and clear rate-limit cooldowns | `conductor cooldown [--clear]` | — *conductor_status shows them; clearing is your call* | `POST /api/cooldowns/clear` |
| Roles, routing and settings | `conductor config path · conductor ui` | — *changing routing is your call, not a model's* | `PUT /api/config` |
| Controllers as data: list, add one like an existing one, check | `conductor controller [add\|check]` | — *adding a controller is setup, not a task* | `GET /api/state` |
| Set up a project for a controller | `conductor init` | — *runs once, before the controller can use MCP* | `POST /api/init` |
| First-time setup | `conductor setup` | — *runs before any controller is connected* | `GET /api/state` |
| List or remove task worktrees | `conductor worktree [rm]` | — *merging and removing branches is your call: the run page shows the commands* | — *shown as commands on the run page* |
| See conductor work end to end on a throwaway project | `conductor demo [--keep]` | — *a first look for a person, not a task for a controller* | — *runs in the terminal, with a live table; --keep leaves the project to open in conductor ui* |
| Score conductor on tasks with hidden tests | `conductor eval [run]` | — *long and spends provider quota: run it yourself* | — *long-running: use the terminal* |

Controller skills and commands (`/conduct-…`) call the MCP tools or the CLI; see `templates/commands/`.
