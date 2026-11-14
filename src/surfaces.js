// V3: one feature set everywhere. Every user-facing action, and where it lives: the CLI, the MCP server (what a
// controller calls), the UI (its API route) and the controller skills/commands. An action missing from a surface
// says why (`{ na: 'reason' }`). test/surfaces.test.js checks this list against the real CLI, MCP tools and UI
// routes, and docs/SURFACES.md is generated from it (node scripts/gen-surfaces.mjs).

export const ACTIONS = [
  // ---- doing work
  { id: 'run', title: 'Hand a task to a worker', cli: 'conductor run <role> "task" (or conductor <role> …)', mcp: 'conductor_run', ui: { na: 'work is handed out by your controller or the terminal; the UI shows the result (Runs)' }, skill: '/conduct-build, /conduct-fix…' },
  { id: 'batch', title: 'Run independent plan tasks in parallel', cli: 'conductor batch --plan f --tasks T1,T2', mcp: 'conductor_batch', ui: { na: 'started by the controller; each task shows on the Runs page' }, skill: '/conduct-run' },
  { id: 'retry', title: 'Have a worker fix its own task in place', cli: 'conductor retry <task> --note "…"', mcp: 'conductor_retry', ui: { na: 'needs a note about what was wrong: the run page shows the command' } },
  { id: 'route', title: 'Preview who would take a task, and why', cli: 'conductor route "task"', mcp: 'conductor_route', ui: 'POST /api/route-preview' },
  { id: 'plan-check', title: 'Check a plan before handing it out', cli: 'conductor plan check <file>', mcp: 'conductor_plan_check', ui: { na: 'plans are files in your editor; the controller checks them' }, skill: '/conduct-plan' },
  { id: 'verify', title: "Run the project's verify command", cli: 'conductor verify', mcp: 'conductor_verify', ui: { na: 'runs project commands; use the terminal or your controller' } },
  // ---- reviewing results
  { id: 'runs', title: 'Recent runs, and one run in full (checks, attempts, report)', cli: 'conductor runs [show <run>]', mcp: 'conductor_runs', ui: 'GET /api/run' },
  { id: 'import', title: 'Import your answer from a web chat for a waiting run (or a research report)', cli: 'conductor import <run> <file>', mcp: 'conductor_import', ui: 'POST /api/import' },
  { id: 'diff', title: 'Compact diff to review', cli: 'conductor diff [branch]', mcp: 'conductor_diff', ui: 'GET /api/run' },
  { id: 'stats', title: 'Quality numbers: first-try accept rate, alpha gate, failure causes', cli: 'conductor stats [--failures]', mcp: 'conductor_stats', ui: 'GET /api/stats' },
  { id: 'usage', title: 'Runs, tokens, cost and time per provider', cli: 'conductor usage', mcp: 'conductor_stats', ui: 'GET /api/runs' },
  // ---- the team's memory
  { id: 'lessons', title: 'Lessons: list, add, remove, promote to a rule', cli: 'conductor lessons [add|rm|promote]', mcp: 'conductor_lessons', ui: 'GET /api/lessons' },
  { id: 'rules', title: 'Project rules for every controller and worker', cli: 'conductor rules [new|sync]', mcp: 'conductor_rules', ui: 'GET /api/rules' },
  { id: 'skills', title: 'Skill library: list, turn on/off, edit', cli: 'conductor skills', mcp: 'conductor_skills', ui: 'GET /api/skills' },
  // ---- setup and health
  { id: 'status', title: 'Providers, chains, controller and repo state', cli: 'conductor status', mcp: 'conductor_status', ui: 'GET /api/state', skill: '/conduct-status' },
  { id: 'doctor', title: 'Check installs, keys, live answers and permissions', cli: 'conductor doctor [--live]', mcp: 'conductor_doctor', ui: 'POST /api/test' },
  { id: 'guard', title: "Block the controller's commit while verify fails", cli: 'conductor guard [on|off|status]', mcp: { na: "a controller must not be able to switch off its own guard" }, ui: 'GET /api/guard' },
  { id: 'providers', title: 'Add a provider from the catalog', cli: 'conductor add <id> · conductor providers', mcp: { na: 'needs an API key: never through a model' }, ui: 'POST /api/providers/add' },
  { id: 'keys', title: 'Set or remove API keys', cli: 'conductor keys', mcp: { na: 'secrets never pass through a model' }, ui: 'PUT /api/secrets' },
  { id: 'models', title: "A provider's current models", cli: 'conductor models <provider>', mcp: { na: 'part of setup, not of a task' }, ui: 'POST /api/provider-models' },
  { id: 'local', title: 'Find local model servers', cli: 'conductor local', mcp: { na: 'part of setup, not of a task' }, ui: 'GET /api/local' },
  { id: 'cooldown', title: 'See and clear rate-limit cooldowns', cli: 'conductor cooldown [--clear]', mcp: { na: 'conductor_status shows them; clearing is your call' }, ui: 'POST /api/cooldowns/clear' },
  { id: 'config', title: 'Roles, routing and settings', cli: 'conductor config path · conductor ui', mcp: { na: 'changing routing is your call, not a model\'s' }, ui: 'PUT /api/config' },
  { id: 'controller', title: 'Controllers as data: list, add one like an existing one, check', cli: 'conductor controller [add|check]', mcp: { na: 'adding a controller is setup, not a task' }, ui: 'GET /api/state' },
  { id: 'init', title: 'Set up a project for a controller', cli: 'conductor init', mcp: { na: 'runs once, before the controller can use MCP' }, ui: 'POST /api/init' },
  { id: 'setup', title: 'First-time setup', cli: 'conductor setup', mcp: { na: 'runs before any controller is connected' }, ui: 'GET /api/state' },
  { id: 'worktree', title: 'List or remove task worktrees', cli: 'conductor worktree [rm]', mcp: { na: 'merging and removing branches is your call: the run page shows the commands' }, ui: { na: 'shown as commands on the run page' } },
  { id: 'demo', title: 'See conductor work end to end on a throwaway project', cli: 'conductor demo [--keep]', mcp: { na: 'a first look for a person, not a task for a controller' }, ui: { na: 'runs in the terminal, with a live table; --keep leaves the project to open in conductor ui' } },
  { id: 'eval', title: 'Score conductor on tasks with hidden tests', cli: 'conductor eval [run]', mcp: { na: 'long and spends provider quota: run it yourself' }, ui: { na: 'long-running: use the terminal' } },
];

/** CLI words that are not actions (the server itself, help, internal hooks). */
export const CLI_INTERNAL = ['ui', 'mcp', 'help', 'hook', 'worktrees', 'evals', 'lesson', 'rule', 'guards', 'skill', 'ls', 'list'];

export const na = (v) => (v && typeof v === 'object' ? v.na : null);

/** The table for docs/SURFACES.md. */
export function surfacesMarkdown() {
  const cell = (v) => (na(v) ? `— *${na(v)}*` : v ? `\`${v}\`` : '').replace(/\|/g, '\\|'); // a | would end the table cell
  const L = ['# Features in every surface', '', 'Generated from `src/surfaces.js` by `node scripts/gen-surfaces.mjs`; a test keeps it in step with the code.',
    'A dash means the action is left out of that surface on purpose, with the reason.', '',
    '| Action | CLI | MCP (controller) | UI (route) |', '|---|---|---|---|'];
  for (const a of ACTIONS) L.push(`| ${a.title} | ${cell(a.cli)} | ${cell(a.mcp)} | ${cell(a.ui)} |`);
  L.push('', 'Controller skills and commands (`/conduct-…`) call the MCP tools or the CLI; see `templates/commands/`.', '');
  return L.join('\n');
}
