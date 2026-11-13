#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, findProjectRoot, validateConfig, GLOBAL_CONFIG, GLOBAL_SECRETS, projectConfigPath, readScope, providerPermissions, readOnlyEnforced, readOverrideMissing, optionalNoKey } from '../src/config.js';
import { dispatch, formatSummary, UsageError, clearCooldowns, getCooldowns, chooseChain, extractTask, taskFiles, parseDuration } from '../src/core.js';
import { runBatch, formatBatch } from '../src/batch.js';
import { listWorktrees, removeWorktree, readWorktreeMeta } from '../src/worktree.js';
import { listSkills, setSkillOn, newSkill, addSkill, removeSkill, syncSkills, globalSkillsDir, projectSkillsDir } from '../src/skills.js';
import { statusReport, statusData } from '../src/status.js';
import { runVerify, detectVerify } from '../src/verify.js';
import { checkPlan, formatPlanCheck } from '../src/plancheck.js';
import { listEvals, checkEvals, runEvals, formatEvals, loadResult } from '../src/evals.js';
import { failureStats, formatFailureStats, qualityStats, formatQualityStats } from '../src/stats.js';
import { readLessons, addLesson, removeLesson, promoteLesson, GUIDANCE, promotable, PROMOTE_AT } from '../src/lessons.js';
import { readRules, newRule, syncControllerFiles, checkControllerFiles, rulesDir } from '../src/controllers.js';
import { runHook, recordVerify, setGuards, guardsOn, allowCommit, readVerifyState, GUARD_SUPPORTED } from '../src/guard.js';
import { readBlock, writeBlock } from '../src/localfiles.js';
import { initProject, setupGlobal } from '../src/init.js';
import { startMcpServer } from '../src/mcp.js';
import { testProvider, testPermissions } from '../src/providers.js';
import { listFreeModels, listProviderModels } from '../src/models.js';
import { CLI_PRESETS, ROLES, CONTROLLERS, controllerWorker } from '../src/presets.js';
import { VERSION } from '../src/version.js';
import { which, keyValue, untilText } from '../src/util.js';
import { usageReport, formatUsage, recordSaving } from '../src/usage.js';
import { listRuns, readRun, formatRuns, runDetail, runGates, formatGates } from '../src/runs.js';
import { CATALOG, CATEGORIES, urlFields } from '../src/catalog.js';
import { runAdd, catalogStatus, detect, enableDetected, enableLocal, keyList, interactive, askSecret, confirm, choose } from '../src/setup.js';
import { detectLocal } from '../src/local.js';
import { writeSecrets, writeScope } from '../src/config.js';
import { ROUTE_TEMPLATES, resolveTemplate, addTemplates, starterIds, describeRoute, routeErrors } from '../src/routing.js';
import { compactDiff } from '../src/diffview.js';

const HELP = `conductor ${VERSION}: Claude (or any controller) plans and reviews; cheaper models do the work.

Start
  conductor setup                 guided setup: finds your agents and keys, adds a free provider
  conductor add <provider>        add one of ${Object.keys(CATALOG).length} chat APIs (see: conductor providers)
  conductor init                  set up the current project
  conductor ui                    settings page
  conductor doctor [--live]       check everything

Work
  conductor <role> "task"         roles: ${Object.keys(ROLES).join(', ')}
  conductor <role> --plan <file> --task T1
  conductor batch --plan <file> --tasks T1,T2   parallel, one worktree each
  conductor diff [branch]         compact diff to review (lockfiles hidden, whitespace ignored)
  conductor runs                  what ran, who did it, verify results
  conductor retry <task> --note … the same worker fixes its task in place
  conductor skills                your skill library: one set for every controller and worker

All commands and options: conductor help all`;

const HELP_ALL = `conductor-ai ${VERSION}: one controller (Claude by default), many worker LLMs.

Setup
  conductor setup [--yes]              guided first-time setup: finds your agents and keys, adds a free provider, tests
  conductor providers [--free] [--search x] [--json]   every provider conductor can add (${Object.keys(CATALOG).length}), with status
  conductor add <provider> [--model m] [--yes] [--project]   add one: key, model, test, role chains
  conductor keys [set NAME | rm NAME]  list, set (hidden input or stdin) or remove API keys
  conductor local [--enable]           find local model servers (Ollama, LM Studio, llama.cpp…) and turn them on
  conductor init [--controller <c>] [--verify "<cmd>"] [--guards] [--vscode] [--no-mcp] [--share]   add conductor to the current project (its files go in .gitignore unless --share)
                                       controllers: ${Object.keys(CONTROLLERS).join(', ')}
  conductor ui [--port 4545] [--no-open]   settings page
  conductor doctor [--live] [--details] [--json]   check installs and keys (--live sends a test prompt)

Work (normally called by the controller)
  conductor run <role> [task text] [options]      (or just: conductor <role> ...)
     roles: ${Object.entries(ROLES).map(([r, m]) => `${r}${m.mode === 'read' ? '(ro)' : ''}`).join(' ')}
     --plan <file> --task <id>   take the task from a plan file
     --provider <name>           try this provider first
     --chain a,b,c               use exactly this chain (no smart reordering)
     --note "<feedback>"         extra instructions (use on retries)
     --files a,b                 context files for API (chat) providers
     --base <ref> --focus "..."  review options
     --save <file>               ask: save the answer
     --worktree [--replace]      run in its own checkout on branch conductor/<id> and commit there
     --continue                  keep working in the task's existing worktree (same worker by default; add --note)
     --timeout 45m               stop a worker after this and try the next (default: settings.timeoutSec, or 2× the task eta)
     --samples N                 run N attempts on different providers in parallel and keep the best (by checks, not opinion)
     --review / --no-review      force or skip the independent review (default: only for risky work)
     --no-verify --no-escalate --allow-no-repro --allow-unverified --allow-scope --allow-weak-plan --allow-dirty --allow-open-questions --json
                                 exit 4 = the worker wrote code but no verify command proved it (--allow-unverified accepts it)
  conductor batch --plan <file> --tasks T1,T2,T3 [--concurrency 4] [--role r] [--provider p] [--replace] [--json]
  conductor diff [branch | A..B] [--lines 200]   compact diff for review (default: working tree, new files included)
  conductor route "task" [--role r] [--files a,b] | --plan f --task T1   which providers would take a task, and why
  conductor route --rules | --templates | --add starter|<id,id> | --rm <n> [--global]   list, add or remove routing rules
  conductor plan check <file> [--task T1,T2]   is each task ready for a worker? (files, checkable acceptance, verify, size)
  conductor eval [list] | check | run [--tasks a,b] [--provider p | --chain a,b] [--samples N] [--label x] [--compare last|<file>] [--keep] [--lessons <file> | --no-lessons]
                                       measure conductor on fixed tasks with hidden tests (check = prove the tasks are fair, no LLM)
  conductor stats [--failures] [--days 30]   first-try accept rate and the alpha gate; --failures: why work fails, biggest cause first
  conductor rules [list] | new <name> [--paths "src/api/**"] | sync   project rules, written in each controller's own format
  conductor guard [status] | on | off | allow   block the controller's git commit while the last verify failed (Claude Code, Antigravity)
  conductor lessons [list] | add "text" [--files a,b] [--role r] | rm <id> | promote <id>   what earlier work taught (in later prompts and routing)
  conductor verify                     run the project's verify command
  conductor skills [list] | new <name> | add <path> | on|off <name> | rm <name> | sync   one skill library for every controller and worker
  conductor retry <task> --note "…" [--provider p]   the task's worker continues in its worktree with your note
  conductor worktree [list] | rm <id>|--all [--force]

Inspect
  conductor runs [--limit 20] [--json] | runs show <run>
  conductor usage [--days 7] [--json]  runs, tokens and cost per provider
  conductor status [--json]            providers, chains and repo state
  conductor models [provider] [--all]  current models of an API provider
  conductor cooldown [--clear [name]]  rate-limit cooldowns
  conductor config path                config file locations
  conductor mcp                        run as an MCP server (stdio)

Exit codes: 0 ok · 2 usage/unsafe state · 3 every provider failed (controller takes over)`;

/** conductor skills [list] | new <name> | add <path> | on|off <name> | rm <name> | sync: one skill library for every controller. */
function skillsCmd(o) {
  const root = findProjectRoot();
  const [sub = 'list', name] = o._;
  const scope = o.project ? 'project' : 'global';
  const synced = () => { const r = syncSkills(root); const n = (r.added.length + r.updated.length) / 2; console.log(`synced: ${n} active skill${n === 1 ? '' : 's'} → .claude/skills and .agents/skills${r.removed.length ? ` (${r.removed.length / 2} removed)` : ''}`); r.skipped.forEach((s) => console.log(`- not synced: ${s}`)); };
  const need = () => { if (!name) throw new UsageError(`usage: conductor skills ${sub} <name>`); };
  switch (sub) {
    case 'list': case 'ls': {
      const all = listSkills(root);
      if (o.json) { console.log(JSON.stringify(all, null, 2)); return 0; }
      if (!all.length) {
        console.log(`No skills yet. Your library: ${globalSkillsDir()} (all projects) and ${path.relative(root, projectSkillsDir(root)) || '.'} (this project).`);
        console.log('Make one:   conductor skills new php-conventions --description "How PHP is written here" --files "*.php"');
        console.log('Or add one: conductor skills add ./path/to/skill-folder');
        return 0;
      }
      console.log('Skills for this project (✓ on, ○ off). Controllers load them natively; workers get the ones that match their task.\n');
      for (const s of all) {
        const when = Object.entries(s.when).filter(([k]) => ['roles', 'files', 'text'].includes(k)).map(([k, v]) => `${k} ${v}`).join(' · ') || 'every task';
        console.log(`  ${s.on ? '✓' : '○'} ${s.name.padEnd(24)} ${s.scope.padEnd(8)} ${fit(s.description, termWidth() - 50)}`);
        console.log(`    ${''.padEnd(24)} ${''.padEnd(8)} workers: ${when}`);
      }
      console.log('\nSwitch for this project: conductor skills off <name> | on <name>   Edit: open the SKILL.md, then conductor skills sync');
      return 0;
    }
    case 'new': {
      need();
      const dir = newSkill(root, name, { scope, description: o.description, files: o.files, roles: o.roles, text: o.text });
      console.log(`✓ created ${path.join(dir, 'SKILL.md')} (${scope}). Write the instructions in it, then: conductor skills sync`);
      synced(); return 0;
    }
    case 'add': {
      need();
      const r = addSkill(root, name, { scope, name: o.name });
      console.log(`✓ added ${r.name} to the ${scope} library (${r.dir})`);
      synced(); return 0;
    }
    case 'on': case 'off': {
      need();
      if (!listSkills(root).some((s) => s.name === name)) throw new UsageError(`no skill "${name}" (see: conductor skills)`);
      setSkillOn(root, name, sub === 'on');
      console.log(`✓ ${name} ${sub} for this project`);
      synced(); return 0;
    }
    case 'rm': case 'remove': {
      need();
      const s = removeSkill(root, name, { scope: o.global ? 'global' : o.project ? 'project' : undefined });
      console.log(`✓ removed ${name} from the ${s.scope} library`);
      return 0;
    }
    case 'sync': synced(); return 0;
    default: throw new UsageError('usage: conductor skills [list] | new <name> [--project] [--description …] [--files …] [--roles …] | add <path> [--project] | on|off <name> | rm <name> | sync');
  }
}

/** conductor route --rules | --templates | --add | --rm: manage routing rules (project scope unless --global). */
function routeRules(cfg, o) {
  const scope = o.global ? 'global' : 'project';
  const where = scope === 'global' ? GLOBAL_CONFIG : projectConfigPath(cfg.root);
  if (o.templates) {
    const have = new Set((cfg.routes || []).map((r) => r.from).filter(Boolean));
    console.log('Rule library (★ = in the starter set). Add with: conductor route --add <id>   or   --add starter\n');
    for (const t of ROUTE_TEMPLATES) {
      const r = resolveTemplate(t, cfg.providers, { exclude: [controllerWorker(cfg.controller)] });
      console.log(`${t.starter ? '★' : ' '} ${t.id.padEnd(13)} ${t.label}${have.has(t.id) ? '   [added]' : ''}`);
      console.log(`  ${''.padEnd(13)} ${describeRoute(r.route).replace(/ → .*/, '')} → ${r.missing ? `(${r.missing})` : [].concat(r.route.provider).join(', ')}`);
      console.log(`  ${''.padEnd(13)} ${t.why}`);
    }
    console.log('\nGuide: docs/ROUTING.md');
    return 0;
  }
  if (o.add || o.rm) {
    const data = readScope(scope, cfg.root);
    let routes = Array.isArray(data.routes) ? data.routes : scope === 'project' && Array.isArray(cfg.routes) ? [...cfg.routes] : [];
    if (o.rm) {
      const n = Number(o.rm);
      if (!Number.isInteger(n) || n < 1 || n > routes.length) throw new UsageError(`--rm takes a rule number from 1 to ${routes.length} (see conductor route --rules${o.global ? ' --global' : ''})`);
      const [gone] = routes.splice(n - 1, 1);
      console.log(`✓ removed rule ${n}: ${describeRoute(gone)}`);
    } else {
      const ids = String(o.add).split(',').map((x) => x.trim()).filter(Boolean).flatMap((x) => (x === 'starter' ? starterIds() : [x]));
      const r = addTemplates(routes, ids, cfg.providers, { exclude: [controllerWorker(cfg.controller)] });
      routes = r.routes;
      for (const id of r.added) console.log(`✓ added ${id}: ${describeRoute(routes.find((x) => x.from === id))}`);
      for (const s of r.skipped) console.log(`- skipped ${s.id}: ${s.why}`);
      if (!r.added.length) return r.skipped.some((s) => s.why === 'no such template') ? (console.log('See the ids with: conductor route --templates'), 1) : 0;
    }
    const errors = routeErrors(routes, cfg.providers);
    if (errors.length) throw new UsageError(errors.join('; '));
    writeScope(scope, cfg.root, { ...data, routes });
    console.log(`saved to ${where}. Try one: conductor route "fix the login form" --files src/Login.tsx`);
    return 0;
  }
  const routes = cfg.routes || [];
  if (!routes.length) { console.log('No routing rules. The smart selector orders each chain.\nStart with: conductor route --add starter   (see the list: conductor route --templates)'); return 0; }
  console.log('Routing rules, first match wins:');
  routes.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${describeRoute(r)}${r.from ? `   (${r.from})` : ''}`));
  return 0;
}

const COMMANDS = ['skills', 'setup', 'providers', 'add', 'keys', 'local', 'route', 'diff', 'init', 'ui', 'mcp', 'status', 'doctor', 'verify', 'run', 'models', 'batch', 'worktree', 'runs', 'usage', 'cooldown', 'config', 'retry', 'help'];
/** The command closest to a typo (edit distance ≤ 2), or null. */
function closest(word, options) {
  const d = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) { const t = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
    }
    return row[b.length];
  };
  const best = options.map((o) => [o, d(word.toLowerCase(), o)]).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= 2 ? best[0] : null;
}

// Colour for people at a terminal: ✓ green, ✗ red, ⚠ and WARNING yellow, ○ dim. Off for pipes, NO_COLOR, --no-color
// and TERM=dumb, so logs and controllers reading the output get plain text.
const useColor = () => (!!process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0')
  || (process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' && !process.argv.includes('--no-color'));
function colorize(s) {
  return s.replace(/✓/g, '\x1b[32m✓\x1b[39m').replace(/✗/g, '\x1b[31m✗\x1b[39m').replace(/⚠/g, '\x1b[33m⚠\x1b[39m')
    .replace(/○/g, '\x1b[2m○\x1b[22m').replace(/^(WARNING:|next:)/gm, (m) => (m === 'next:' ? `\x1b[36m${m}\x1b[39m` : `\x1b[33m${m}\x1b[39m`))
    .replace(/^(={5,}.*={5,})$/gm, '\x1b[1m$1\x1b[22m');
}

const termWidth = () => (process.stdout.isTTY && process.stdout.columns) || 120;
/** Shorten text to max characters at a word boundary, with "…" when cut. */
function fit(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (max < 12 || t.length <= max) return max < 12 ? '' : t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max / 2 ? cut.lastIndexOf(' ') : cut.length).replace(/[\s,;:(—–-]+$/, '')}…`;
}

/** --timeout 45m / 2h / 90 (minutes) → ms, or undefined. */
function timeoutOpt(o) {
  if (o.timeout === undefined) return undefined;
  const ms = parseDuration(o.timeout);
  if (!ms) throw new UsageError(`--timeout: can't read "${o.timeout}" (try 45m, 2h or 1h30m)`);
  return ms;
}

function parseArgs(argv) {
  const opts = { _: [] };
  const flags = new Set(['no-verify', 'allow-dirty', 'json', 'live', 'no-open', 'no-mcp', 'all', 'clear', 'global', 'help', 'version', 'worktree', 'replace', 'force', 'allow-open-questions', 'vscode', 'yes', 'free', 'project', 'details', 'enable', 'rules', 'templates', 'continue', 'share', 'allow-unverified', 'allow-scope', 'allow-weak-plan', 'keep', 'failures', 'no-escalate', 'allow-no-repro', 'review', 'no-review', 'guards', 'no-lessons']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { opts.help = true; continue; }
    if (a === '-v') { opts.version = true; continue; }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (flags.has(k)) opts[k] = inline === undefined ? true : inline !== 'false';
      else { const v = inline ?? argv[++i]; if (v === undefined) throw new UsageError(`--${k} needs a value`); opts[k] = v; }
    } else opts._.push(a);
  }
  return opts;
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== '--no-color');
  let cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'help';
  const o = parseArgs(argv);
  // never colour machine output: the MCP protocol and --json
  if (useColor() && cmd !== 'mcp' && !o.json) { const log = console.log; console.log = (...a) => log(...a.map((x) => (typeof x === 'string' ? colorize(x) : x))); }
  if (o.version) { console.log(VERSION); return 0; }
  if (o.help || cmd === 'help') { console.log(o._[0] === 'all' || o.all ? HELP_ALL : HELP); return 0; }
  if (ROLES[cmd]) { o._.unshift(cmd); cmd = 'run'; }
  if (cmd === 'retry') {
    // conductor retry T3 --note "…": the task's worker continues in its existing worktree with your note
    const id = o._.shift();
    if (!id) throw new UsageError('usage: conductor retry <task id> --note "what to fix" [--provider p] [--role fix]');
    if (!o.note) throw new UsageError('retry needs --note "what to fix", so the worker knows what you found');
    const m = readWorktreeMeta(findProjectRoot(), id);
    if (!m && !(o.plan && o.role)) throw new UsageError(`no record of a worktree task "${id}". Use: conductor run <role> --plan <file> --task ${id} --continue --note "…"`);
    o._ = [o.role || m.role];
    o.plan ||= m?.plan || undefined; o.task = m?.task || id; o.continue = true; o.worktreeId = id;
    cmd = 'run';
  }

  switch (cmd) {
    case 'setup': return setup(o);
    case 'providers': return providers(o);
    case 'add': {
      const id = o._[0];
      if (!id) throw new UsageError('usage: conductor add <provider>   (list them with: conductor providers)');
      const e = CATALOG[id];
      const fields = Object.fromEntries((e ? urlFields(e) : []).map((f) => [f, o[f.toLowerCase().replaceAll('_', '-')]]).filter(([, v]) => v));
      const r = await runAdd(findProjectRoot(), id, { model: o.model, baseUrl: o['base-url'], fields, yes: o.yes, scope: o.project ? 'project' : 'global' });
      console.log(`\n✓ ${r.name} added${r.provider.model ? ` (model ${r.provider.model})` : ''}${r.roles.length ? `, now in: ${r.roles.join(', ')}` : ''}.`);
      if (o.yes || !interactive() || await confirm('Test it now (sends a one-word prompt)?')) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-add-'));
        const t = await testProvider(r.name, r.provider, findProjectRoot(), dir);
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(t.ok ? `✓ ${r.name} answered.` : `✗ ${r.name}: ${t.reason}${t.sample ? `: ${t.sample.replace(/\s+/g, ' ').slice(0, 120)}` : ''}\n  See docs/providers/${id}.md → Troubleshooting.`);
        if (!t.ok) return 1;
      }
      return 0;
    }
    case 'keys': return keys(o);
    case 'local': {
      const root = findProjectRoot();
      const local = await detectLocal();
      if (o.json) { console.log(JSON.stringify(local, null, 2)); return 0; }
      const seen = local.filter((l) => l.running || l.installed);
      if (!seen.length) { console.log('No local model servers found. Easiest start: install Ollama (https://ollama.com/download), then: ollama pull qwen3-coder'); return 0; }
      for (const l of seen) {
        console.log(`${l.running ? '●' : '○'} ${l.label.padEnd(18)} ${l.running ? `running at ${l.baseUrl} · ${l.models.length} model${l.models.length === 1 ? '' : 's'}${l.best ? ` · best for code: ${l.best}` : ''}` : 'installed, not running'}`);
        if (l.next) console.log(`    next: ${l.next}`);
      }
      const ready = local.filter((l) => l.running && l.best);
      if (ready.length && o.enable) console.log(`\n✓ enabled: ${enableLocal(root, local).join(', ') || 'already on'}`);
      else if (ready.length) console.log('\nTurn them on (free, private, in the docs/test/review/ask roles): conductor local --enable');
      return 0;
    }
    case 'skills': case 'skill': return skillsCmd(o);
    case 'hook': {
      // called by a controller's hook config with JSON on stdin; never fails loudly: a broken guard must not block work
      let raw = '';
      try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
      const kind = o._[0] || '';
      let r;
      try { r = runHook(kind, raw.trim() ? JSON.parse(raw) : {}, findProjectRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd())); }
      catch { r = kind === 'agy-pretool' ? { stdout: JSON.stringify({ decision: 'ask' }), stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 }; }
      if (r.stdout) process.stdout.write(r.stdout + '\n');
      if (r.stderr) process.stderr.write(r.stderr + '\n');
      return r.code;
    }
    case 'guard': case 'guards': {
      const cfg = loadConfig();
      const root = cfg.root, controller = cfg.controller || 'claude-code';
      const sub = o._[0] || 'status';
      if (sub === 'allow') { allowCommit(root); console.log('commits on the current HEAD are allowed once, even though the last verify failed'); return 0; }
      if (sub === 'status') {
        const st = readVerifyState(root);
        console.log(`guards for ${CONTROLLERS[controller]?.label || controller}: ${GUARD_SUPPORTED[controller] ? (guardsOn(root, controller) ? `on (${GUARD_SUPPORTED[controller]})` : 'off (conductor guard on)') : 'not available for this controller yet'}`);
        console.log(`last verify: ${st ? `${st.status}${st.cmd ? ` (${st.cmd})` : ''} at ${st.at}` : 'none recorded (conductor verify)'}`);
        return 0;
      }
      if (sub !== 'on' && sub !== 'off') throw new UsageError('usage: conductor guard [status] | on | off | allow');
      const r = setGuards(root, controller, sub === 'on');
      if (r.unsupported) { console.log(`Guards are not available for ${CONTROLLERS[controller]?.label || controller} yet: only Claude Code and Antigravity, whose hooks were tested. (Codex runs project hooks only in trusted projects after you approve them in /hooks.)`); return 1; }
      // keep the hook file out of git, like conductor's other local files (unless the project shares them)
      const block = readBlock(root);
      if (sub === 'on' && block.length && !block.includes(r.file)) writeBlock(root, [...block, r.file]);
      console.log(r.changed ? `guards ${sub} (${r.file})${sub === 'on' ? ': a `git commit` by the controller is blocked while the last conductor verify failed' : ''}` : `guards already ${sub}`);
      return 0;
    }
    case 'rules': case 'rule': {
      const cfg = loadConfig();
      const root = cfg.root, controller = cfg.controller || 'claude-code';
      const sub = o._[0] || 'list';
      if (sub === 'list') {
        const rs = readRules(root);
        if (!rs.length) { console.log(`No project rules yet. Add one: conductor rules new <name> [--paths "src/api/**"]  (stored in ${path.relative(root, rulesDir(root))}/)`); return 0; }
        for (const r of rs) console.log(`${r.name.padEnd(24)} ${(r.paths.join(', ') || 'all files').padEnd(30)} ${r.description}`);
        console.log(`\n${rs.length} rule(s), written for ${CONTROLLERS[controller]?.label || controller} by: conductor rules sync. Workers get the ones matching their files.`);
        return 0;
      }
      if (sub === 'new') {
        const f = newRule(root, o._[1] || '', { description: o.description || '', paths: o.paths || '' });
        console.log(`created ${path.relative(root, f)}: write the rule, then run conductor rules sync`); return 0;
      }
      if (sub === 'sync') {
        const lines = syncControllerFiles(root, controller);
        console.log(lines.length ? lines.map(([w, p]) => `  ${w.padEnd(8)} ${p}`).join('\n') : `  up to date for ${CONTROLLERS[controller]?.label || controller}`);
        return 0;
      }
      throw new UsageError('usage: conductor rules [list] | new <name> [--paths "a/**, *.ts"] [--description "..."] | sync');
    }
    case 'plan': {
      if (o._[0] !== 'check' || !o._[1]) throw new UsageError('usage: conductor plan check <plan-file> [--task T1,T2]');
      const cfg = loadConfig();
      const file = o._[1];
      const abs = path.resolve(cfg.root, file);
      if (!fs.existsSync(abs)) throw new UsageError(`plan not found: ${file}`);
      const rows = checkPlan(fs.readFileSync(abs, 'utf8'), { ids: o.task ? String(o.task).split(',').map((x) => x.trim()).filter(Boolean) : undefined, verifyCmd: detectVerify(cfg.root, cfg.settings), maxFiles: cfg.settings.maxTaskFiles || 4 });
      if (!rows.length) throw new UsageError(`no tasks found in ${file} (expected headings like "### T1: title")`);
      console.log(o.json ? JSON.stringify(rows, null, 2) : formatPlanCheck(file, rows));
      return rows.some((r) => r.problems.length) ? 1 : 0;
    }
    case 'eval': case 'evals': {
      const sub = o._[0] || 'list';
      const ids = o.tasks ? String(o.tasks).split(',').map((x) => x.trim()).filter(Boolean) : undefined;
      if (sub === 'list') {
        const all = listEvals();
        for (const t of all) console.log(`${t.id.padEnd(24)} ${String(t.role).padEnd(6)} ${String(t.difficulty || '').padEnd(7)} ${t.title}`);
        console.log(`\n${all.length} tasks. conductor eval run   runs them all with your routing (uses your providers; one at a time)`);
        return 0;
      }
      if (sub === 'check') {
        const rows = await checkEvals({ ids });
        for (const r of rows) console.log(`${r.problems.length ? '✗' : '✓'} ${r.id}${r.problems.length ? `\n    - ${r.problems.join('\n    - ')}` : ''}`);
        console.log(`\n${rows.filter((r) => !r.problems.length).length}/${rows.length} tasks are fair (fail before, pass with the reference solution).`);
        return rows.some((r) => r.problems.length) ? 1 : 0;
      }
      if (sub !== 'run') throw new UsageError('usage: conductor eval [list | check | run]');
      const rep = await runEvals({
        ids, samples: o.samples ? Number(o.samples) : undefined, provider: o.provider, chain: o.chain ? String(o.chain).split(',').map((x) => x.trim()).filter(Boolean) : undefined, keep: o.keep, label: o.label || '', lessons: o['no-lessons'] ? 'off' : o.lessons || undefined,
        onEvent: o.json ? undefined : (e) => {
          const m = { start: 'starting', wait: `waiting for ${e.provider} (one task at a time on it)…`, try: `trying ${e.provider}…`, fail: `${e.provider} failed: ${e.reason}`, ok: `${e.provider} finished`, verify: 'running verify…', isolate: 'checking the code alone against the original tests…', escalate: `verify failed: handing ${e.from}'s work to ${e.provider}…`, repair: `${e.provider} sent no files: asking once more…`, scored: `${e.pass ? 'PASS' : 'FAIL'} (conductor said: ${e.outcome})` }[e.type];
          if (m) process.stderr.write(`eval [${e.task}]: ${m}\n`);
        },
      });
      const prev = o.compare ? loadResult(o.compare, rep.file) : null;
      console.log(o.json ? JSON.stringify(rep, null, 2) : formatEvals(rep, prev));
      return 0;
    }
    case 'lessons': case 'lesson': {
      const root = findProjectRoot();
      const sub = o._[0] || 'list';
      if (sub === 'list') {
        const all = readLessons(root);
        if (!all.length) { console.log('No lessons yet. conductor records them from failed checks and from your --note on retries; add one with: conductor lessons add "<text>"'); return 0; }
        for (const l of all.slice().reverse()) console.log(`${l.id}  ${(l.source === 'auto' ? l.kind : l.source).padEnd(16)} ${String(l.provider || '-').padEnd(16)} ×${String(l.count || 1).padEnd(3)} ${l.promoted ? '[rule] ' : (l.count || 1) >= PROMOTE_AT ? '[promote?] ' : ''}${l.resolvedAt ? '[resolved] ' : ''}${l.dirs?.length ? `[${l.dirs.join(',')}] ` : ''}${l.text || GUIDANCE[l.kind] || ''}`.slice(0, 220));
        console.log(`\n${all.length} lesson(s). Matching ones go into later prompts; a provider with 2+ failures on the same kind of work moves to the back, until it passes that work here again ([resolved]). promote <id> makes one a rule in AGENTS.md.`);
        const pr = promotable(all);
        if (pr.length) console.log(`Seen ${PROMOTE_AT}+ times, worth a rule: ${pr.map((l) => `conductor lessons promote ${l.id}`).join(' · ')}`);
        return 0;
      }
      if (sub === 'add') {
        const text = o._.slice(1).join(' ').trim();
        if (!text) throw new UsageError('usage: conductor lessons add "<text>" [--files a,b] [--role build]');
        const l = addLesson(root, { source: 'manual', text, role: o.role || null, files: o.files ? String(o.files).split(',').map((x) => x.trim()) : [] });
        console.log(`added ${l.id}: ${l.text}`); return 0;
      }
      if (sub === 'rm' || sub === 'remove') { const g = removeLesson(root, o._[1] || ''); if (!g) throw new UsageError(`no lesson "${o._[1] || ''}" (see conductor lessons)`); console.log(`removed ${g.id}`); return 0; }
      if (sub === 'promote') { const r = promoteLesson(root, o._[1] || ''); if (!r) throw new UsageError(`no lesson "${o._[1] || ''}" (see conductor lessons)`); console.log(`added to AGENTS.md: ${r.bullet}`); return 0; }
      throw new UsageError('usage: conductor lessons [list] | add "<text>" | rm <id> | promote <id>');
    }
    case 'stats': {
      if (!o.failures) {
        const q = qualityStats({ root: findProjectRoot(), days: Number(o.days) || 30 });
        console.log(o.json ? JSON.stringify(q, null, 2) : formatQualityStats(q));
        return 0;
      }
      const st = failureStats({ root: findProjectRoot(), days: Number(o.days) || 30 });
      console.log(o.json ? JSON.stringify(st, null, 2) : formatFailureStats(st));
      return 0;
    }
    case 'route': {
      const cfg = loadConfig();
      if (o.rules || o.templates || o.add || o.rm) return routeRules(cfg, o);
      // preview: which providers would take this task, in what order, and why (nothing runs)
      let section = '', role = o.role;
      const files = o.files ? o.files.split(',').map((x) => x.trim()).filter(Boolean) : [];
      if (o.plan && o.task) {
        section = extractTask(fs.readFileSync(path.resolve(cfg.root, o.plan), 'utf8'), o.task);
        if (!section) throw new UsageError(`task "${o.task}" not found in ${o.plan}`);
        role ||= (section.match(/\*\*role:\*\*\s*(\w+)/i) || [])[1];
        files.push(...taskFiles(section));
      }
      role ||= 'build';
      if (!ROLES[role]) throw new UsageError(`unknown role "${role}"`);
      const r = chooseChain(cfg, role, { section, body: o._.join(' '), files, provider: o.provider });
      if (o.json) { console.log(JSON.stringify({ role, how: r.how, note: r.note, chain: r.chain.map((c) => ({ name: c.name, skip: c.skip || null })) }, null, 2)); return 0; }
      console.log(`role ${role} · ${{ chain: 'chain given', provider: '--provider', plan: 'set by the plan', route: 'routing rule', selector: 'smart selector', role: "role's chain" }[r.how]}${r.note ? `: ${r.note}` : ''}`);
      r.chain.forEach((c, i) => console.log(`  ${c.skip ? '-' : String(i + 1) + '.'} ${c.name.padEnd(18)} ${c.skip ? `skipped: ${c.skip}` : 'ready'}`));
      return 0;
    }
    case 'diff': {
      const t = o._[0];
      const d = compactDiff(findProjectRoot(), { ...(t ? { range: t.includes('..') ? t : `HEAD...${t}` } : {}), maxFileLines: Number(o.lines) || 200 });
      if (d.empty) { console.log(t ? `no changes in ${t}` : 'no changes'); return 0; }
      console.log(d.text.trimEnd());
      recordSaving({ source: 'diff', chars: d.fullChars - d.chars, project: path.basename(findProjectRoot()) });
      if (d.fullChars > d.chars) console.log(`\n[compact: ${d.chars.toLocaleString()} of ${d.fullChars.toLocaleString()} characters of the full diff, ~${Math.round((d.fullChars - d.chars) / 4).toLocaleString()} tokens kept out of review (estimate); full: ${t ? `git diff ${t.includes('..') ? t : `HEAD...${t}`}` : 'git diff, plus new files'}]`);
      return 0;
    }
    case 'init': {
      const root = findProjectRoot();
      const controller = o.controller || 'claude-code';
      setupGlobal();
      if (o.verify === true || (o.verify !== undefined && !String(o.verify).trim())) throw new UsageError('usage: conductor init --verify "<command>" (e.g. --verify "npm test")');
      const { lines, notes } = initProject(root, { controller, mcp: !o['no-mcp'], vscode: o.vscode || undefined, share: !!o.share, verify: o.verify ? String(o.verify).trim() : undefined });
      if (o.guards) { const g = setGuards(root, controller, true); lines.push(g.unsupported ? `  skipped  guards (not available for ${controller} yet)` : `  ${g.changed ? 'added' : 'kept'}    ${g.file} (guards: commit blocked while verify fails)`); if (!g.unsupported && !o.share) { const b = readBlock(root); if (b.length && !b.includes(g.file)) writeBlock(root, [...b, g.file]); } }
      console.log(`conductor init → ${root}  (controller: ${CONTROLLERS[controller].label})`);
      lines.forEach((l) => console.log(l));
      notes.forEach((n) => console.log('\n' + n));
      console.log(`\nNext:
  1. Fill in section 1 of AGENTS.md (stack; check the Verify command)
  2. conductor ui         choose providers, models and fallback order
  3. conductor doctor     check every provider is ready
  4. ${controller === 'claude-code'
    ? 'In Claude Code: /conduct-status, then /conduct-plan <feature> (approve the "conductor" MCP server when Claude asks)'
    : `In ${CONTROLLERS[controller].label}: use the conduct-* skills (in .agents/skills), e.g. ask it to run conduct-status, then conduct-plan <feature>`}`);
      if (!which('conductor')) console.log('\nNOTE: "conductor" is not on your PATH. Install globally so controllers can call it: npm install -g .');
      return 0;
    }
    case 'ui': {
      const { startUi } = await import('../src/ui/server.js');
      await startUi({ port: Number(o.port || 4545), open: !o['no-open'], cwd: process.cwd() });
      return null; // keep running
    }
    case 'mcp': startMcpServer(); return null;
    case 'status': {
      const cfg = loadConfig();
      if (o.json) console.log(JSON.stringify(statusData(cfg), null, 2)); else console.log(statusReport(cfg));
      const errs = validateConfig(cfg);
      if (errs.length) console.log('\nconfig problems:\n  ' + errs.join('\n  '));
      return 0;
    }
    case 'doctor': return doctor(o);
    case 'verify': {
      const cfg = loadConfig();
      const v = await runVerify(cfg.root, cfg.settings);
      recordVerify(cfg.root, v); // the commit guard (conductor guard) reads this
      console.log(`verify: ${v.status}${v.cmd ? ` (${v.cmd})` : ''}${v.note ? `, ${v.note}` : ''}`);
      if (v.tail) console.log(v.tail);
      return v.status === 'FAIL' ? 1 : 0;
    }
    case 'run': {
      const role = o._.shift();
      if (!role) throw new UsageError('usage: conductor run <role> [task] [--plan f --task T1]');
      const cfg = loadConfig();
      const errs = validateConfig(cfg);
      if (errs.length) throw new UsageError('config problems:\n  ' + errs.join('\n  '));
      const s = await dispatch(cfg, {
        role, task: o._.join(' ') || undefined, planPath: o.plan, taskId: o.task, provider: o.provider,
        chain: o.chain ? o.chain.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
        note: o.note, files: o.files ? o.files.split(',').map((x) => x.trim()) : [], base: o.base, focus: o.focus,
        save: o.save, noVerify: o['no-verify'], allowUnverified: o['allow-unverified'], allowScope: o['allow-scope'], allowWeakPlan: o['allow-weak-plan'], noEscalate: o['no-escalate'], allowNoRepro: o['allow-no-repro'], samples: o.samples ? Number(o.samples) : undefined, review: o.review, noReview: o['no-review'], allowDirty: o['allow-dirty'], worktree: o.worktree, continue: o.continue, worktreeId: o.worktreeId, timeoutMs: timeoutOpt(o), replace: o.replace, allowOpenQuestions: o['allow-open-questions'],
        onEvent: o.json ? undefined : (e) => {
          const m = { worktree: `working in ${e.dir} (branch ${e.branch})`, wait: `waiting for ${e.provider} (one task at a time on it)…`, try: `trying ${e.provider} (${e.kind})…`, skip: `skip ${e.provider}: ${e.reason}`, fail: `${e.provider} failed: ${e.reason}`, ok: `${e.provider} finished`, verify: 'running verify…', repro: 'running the repro…', review: 'independent review by another model family…', isolate: 'verify failed: checking the code alone against the original tests…', base: 'checking the starting commit (verify, cached per commit)…', escalate: `verify failed: handing ${e.from}'s work to ${e.provider}…`, repair: `${e.provider} sent no files: asking once more…` }[e.type];
          if (m) process.stderr.write(`conductor${e.sample ? ` [attempt ${e.sample}]` : ''}: ${m}\n`);
        },
      });
      console.log(o.json ? JSON.stringify(s, null, 2) : formatSummary(s));
      return s.exitCode;
    }
    case 'models': {
      if (o._[0] && o._[0] !== 'openrouter-free') {
        const name = o._[0];
        const cfg = loadConfig();
        const p = cfg.providers[name];
        if (!p || p.type === 'cli') { console.error(`"${name}" is not an API provider. API providers: ${Object.entries(cfg.providers).filter(([, x]) => x.type !== 'cli').map(([k]) => k).join(', ')}`); return 2; }
        const r = await listProviderModels(p, { freeOnly: !o.all });
        if (r.error) { console.error(`${name}: ${r.error}`); return 1; }
        for (const m of r.models) console.log(`${String(m.id).padEnd(55)} ${m.context ? 'ctx ' + String(m.context).padStart(7) : ''}${m.free ? '  free' : ''}`);
        console.log(`\n${r.models.length} models${o.all ? '' : ' marked free (use --all for every model; providers with a free tier mark none)'}. Set one in conductor ui → Providers → ${name} → model.`);
        return 0;
      }
      const models = await listFreeModels({ all: o.all });
      if (!models.length) { console.log('no models returned (network?)'); return 1; }
      for (const m of models) console.log(`${m.id.padEnd(55)} ctx ${String(m.context || '?').padStart(7)}  ${m.tools ? 'tools' : ''}`);
      console.log(`\n${models.length} models. Use one in conductor ui → Providers → openrouter-free → model.`);
      return 0;
    }
    case 'batch': {
      const cfg = loadConfig();
      const errs = validateConfig(cfg);
      if (errs.length) throw new UsageError('config problems:\n  ' + errs.join('\n  '));
      const tasks = (o.tasks || o._.join(',')).split(',').map((x) => x.trim()).filter(Boolean);
      const b = await runBatch(cfg, {
        planPath: o.plan, tasks, role: o.role, provider: o.provider, concurrency: o.concurrency, noVerify: o['no-verify'], allowUnverified: o['allow-unverified'], allowScope: o['allow-scope'], allowWeakPlan: o['allow-weak-plan'], noEscalate: o['no-escalate'], allowNoRepro: o['allow-no-repro'], review: o.review, noReview: o['no-review'], timeoutMs: timeoutOpt(o), replace: o.replace, note: o.note, allowOpenQuestions: o['allow-open-questions'],
        onEvent: o.json ? undefined : (e) => {
          const m = { start: `starting (first choice: ${e.provider})`, wait: `waiting for ${e.provider} (one task at a time on it)…`, try: `trying ${e.provider}…`, fail: `${e.provider} failed: ${e.reason}`, ok: `${e.provider} finished`, verify: 'running verify…', base: 'checking the starting commit…', escalate: `verify failed: handing ${e.from}'s work to ${e.provider}…`, repair: `${e.provider} sent no files: asking once more…`, done: 'done' }[e.type];
          if (m) process.stderr.write(`conductor [${e.task}]: ${m}\n`);
        },
      });
      console.log(o.json ? JSON.stringify(b, null, 2) : formatBatch(b));
      return b.exitCode;
    }
    case 'worktree': case 'worktrees': {
      const root = findProjectRoot();
      const sub = o._[0] || 'list';
      if (sub === 'list') {
        const items = listWorktrees(root);
        if (!items.length) { console.log('no conductor worktrees'); return 0; }
        for (const w of items) console.log(`${w.id.padEnd(14)} ${w.merged ? 'merged      ' : `${w.ahead} commit(s)`}${w.dirty ? ' · uncommitted changes' : ''}  ${w.branch}  ${w.dir}`);
        return 0;
      }
      if (sub === 'rm' || sub === 'remove') {
        const ids = o.all ? listWorktrees(root).map((w) => w.id) : o._.slice(1);
        if (!ids.length) throw new UsageError('usage: conductor worktree rm <id> [<id>…] | --all [--force]');
        for (const id of ids) removeWorktree(root, id, { force: o.force }).forEach((l) => console.log(`${id}: ${l}`));
        return 0;
      }
      throw new UsageError('usage: conductor worktree [list] | rm <id>|--all [--force]');
    }
    case 'runs': {
      const root = findProjectRoot();
      if (o._[0] === 'show') {
        const r = o._[1] && readRun(root, o._[1]);
        if (!r) throw new UsageError(`usage: conductor runs show <run>   (no single run matches "${o._[1] || ''}"; see conductor runs)`);
        console.log(o.json ? JSON.stringify(runDetail(root, r.id), null, 2) : `run: ${r.id}${formatSummary(r.summary)}\n\n${formatGates(runGates(r.summary))}`);
        return 0;
      }
      const rows = listRuns(root, { limit: Number(o.limit) || 20 });
      console.log(o.json ? JSON.stringify(rows, null, 2) : formatRuns(rows));
      return 0;
    }
    case 'usage': {
      const u = usageReport(Math.max(1, Number(o.days) || 7));
      console.log(o.json ? JSON.stringify(u, null, 2) : formatUsage(u, loadConfig().settings));
      return 0;
    }
    case 'cooldown': {
      if (o.clear) { clearCooldowns(o._[0] || (typeof o.clear === 'string' ? o.clear : undefined)); console.log('cooldowns cleared'); return 0; }
      const c = getCooldowns();
      if (!Object.keys(c).length) console.log('no providers cooling down');
      for (const [n, v] of Object.entries(c)) console.log(`${n.padEnd(18)} until ${untilText(v.until)}  (${v.reason})`);
      return 0;
    }
    case 'config': {
      const root = findProjectRoot();
      if (o._[0] === 'show') { console.log(JSON.stringify(o.global ? readScope('global', root) : readScope('project', root), null, 2)); return 0; }
      console.log(`global config:  ${GLOBAL_CONFIG}\nglobal secrets: ${GLOBAL_SECRETS}\nproject config: ${projectConfigPath(root)}`);
      return 0;
    }
    default:
      const guess = closest(cmd, [...COMMANDS, ...Object.keys(ROLES)]);
      throw new UsageError(`unknown command "${cmd}".${guess ? ` Did you mean: conductor ${guess}?` : ''} Run: conductor help`);
  }
}

async function doctor(o) {
  const cfg = loadConfig();
  const results = [];
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (!p.enabled) continue;
    const r = { name, kind: p.type === 'cli' ? 'agent' : 'chat', ok: true, status: 'ready', next: null, permissions: providerPermissions(p), readOnlyEnforced: readOnlyEnforced(p) };
    results.push(r);
    if (p.type === 'cli') {
      const preset = { ...CLI_PRESETS[p.preset], ...p };
      if (!which(preset.bin)) { Object.assign(r, { ok: false, status: 'not installed', next: `install: ${preset.install}\n    login:   ${preset.login}` }); continue; }
    } else if (p.apiKeyEnv && !p.apiKeyOptional && !keyValue(p.apiKeyEnv)) {
      const add = p.catalog ? `conductor add ${p.catalog}` : `conductor keys set ${p.apiKeyEnv}`;
      if (optionalNoKey(cfg, name, p)) Object.assign(r, { optional: true, status: `optional: add a key to use it (${add})` });
      else Object.assign(r, { ok: false, status: `${p.apiKeyEnv} not set${process.env[p.apiKeyEnv] ? ' (placeholder value)' : ''}`, next: add });
      continue;
    }
    if (o.live) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-doctor-'));
      const t = await testProvider(name, p, cfg.root, dir);
      fs.rmSync(dir, { recursive: true, force: true });
      Object.assign(r, { ok: t.ok, status: t.reason, sample: t.ok ? undefined : t.sample.replace(/\s+/g, ' ').slice(0, 120),
        next: t.ok ? null : p.catalog ? `see docs/providers/${p.catalog}.md → Troubleshooting` : null });
      // V8: an agent that answers may still be refused the commands workers need (headless mode can't ask)
      if (t.ok && p.type === 'cli') {
        const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-doctor-'));
        const pt = await testPermissions(name, p, pd, { allowCommands: cfg.settings.allowCommands || [] });
        fs.rmSync(pd, { recursive: true, force: true });
        r.permissionCheck = { ok: pt.ok, reason: pt.reason, denied: pt.denied };
        if (!pt.ok) Object.assign(r, { ok: false, status: `answers, but can't run build commands: ${pt.reason}`,
          next: pt.denied.length ? `add the refused command(s) to settings.allowCommands (conductor ui → Settings, or the file from conductor config path), then conductor doctor --live` : `read what it said and check its permission settings (conductor doctor --details): ${pt.sample.replace(/\s+/g, ' ').slice(0, 100)}` });
        else r.status = `${t.reason}; ${pt.reason}`;
      }
    }
  }
  const errs = validateConfig(cfg);
  const ctrlIssues = checkControllerFiles(cfg.root, cfg.controller || 'claude-code');
  const problems = results.filter((r) => !r.ok).length + errs.length + ctrlIssues.filter((c) => c.level === 'error').length;
  if (o.json) { console.log(JSON.stringify({ version: VERSION, node: process.version, project: cfg.root, notices: cfg.notices, providers: results, configErrors: errs, controllerFiles: ctrlIssues, problems }, null, 2)); return problems ? 1 : 0; }
  console.log(`conductor ${VERSION} · node ${process.version} · ${os.platform()}`);
  console.log(`project: ${cfg.root}\n`);
  for (const n of cfg.notices || []) console.log(`! ${n}`);
  for (const r of results) {
    console.log(`${r.optional ? '○' : r.ok ? '✓' : '✗'} ${r.name.padEnd(16)} ${r.optional ? r.status : r.ok && !o.live ? 'ready (use --live to test a real call)' : r.status}${r.sample ? `: ${r.sample}` : ''}`);
    if (r.next) console.log(`    next: ${r.next}`);
    if (r.permissions && o.details) {
      console.log(`    write: ${r.permissions.write || 'unknown (custom CLI): check its own permission settings'}`);
      console.log(`    read:  ${r.permissions.read || 'unknown'}${r.readOnlyEnforced ? '' : '  ⚠ read-only NOT enforced'}`);
      const missing = readOverrideMissing(cfg.providers[r.name] || {});
      if (missing.length) console.log(`           your "read" override drops ${missing.join(' ')}: put it back, or set timeoutMin / model instead of overriding the args`);
    }
  }
  errs.forEach((e) => console.log(`✗ config: ${e}`));
  // Q8: the files the controller reads (rules, skills, MCP configs, Codex trust)
  if (ctrlIssues.length) {
    console.log(`\ncontroller files (${CONTROLLERS[cfg.controller || 'claude-code']?.label || cfg.controller}):`);
    for (const c of ctrlIssues) console.log(`${c.level === 'error' ? '✗' : '!'} ${c.file}: ${c.problem}\n    fix: ${c.fix}`);
  }
  if (!o.details && results.some((r) => r.permissions)) console.log('\nWhat each agent may do: conductor doctor --details');
  const weak = results.filter((r) => r.permissions && !r.readOnlyEnforced).map((r) => r.name);
  if (weak.length) console.log(`⚠ read-only not enforced for: ${weak.join(', ')}`);
  console.log(problems ? `\n${problems} problem(s). Disabled providers are ignored; toggle them in conductor ui.` : '\nAll enabled providers look good.');
  return 0;
}

async function setup(o) {
  const ask = interactive() && !o.yes;
  console.log('Global setup:');
  setupGlobal().forEach((l) => console.log(l));
  const root = findProjectRoot();
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  console.log(`\nThis machine: node ${process.version} ${nodeOk ? '✓' : '✗ (20+ needed)'} · git ${which('git') ? '✓' : '✗ (needed)'} · conductor on PATH ${which('conductor') ? '✓' : '✗ (add "$(npm prefix -g)/bin" to PATH)'}`);

  const found = detect(loadConfig(root));
  const installed = found.agents.filter((a) => a.installed);
  console.log(`\nAgents installed: ${installed.length ? installed.map((a) => a.label).join(', ') : 'none (optional: free API providers work without one)'}`);
  console.log(`API keys found:   ${found.keys.length ? found.keys.map((k) => `${k.label} (${k.env})`).join(', ') : 'none yet'}`);
  const own = installed.find((a) => a.controller && !a.enabled);
  if (own) console.log(`                  ${own.name} stays off: it is your controller, and work sent to it would spend the quota conductor saves (turn it on in conductor ui only as a last resort)`);
  const off = [...installed.filter((a) => !a.enabled && !a.controller), ...found.keys.filter((k) => !k.enabled)];
  if (off.length && (!ask || await confirm(`Enable ${off.map((x) => x.name).join(', ')}?`))) console.log(`✓ enabled: ${enableDetected(root, found).join(', ')}`);

  const local = await detectLocal();
  for (const l of local.filter((x) => x.running || x.installed)) {
    console.log(`Local model:      ${l.label}${l.running ? ` running (${l.models.length} model${l.models.length === 1 ? '' : 's'})` : ' installed, not running'}${l.next ? `: ${l.next}` : ''}`);
  }
  if (local.some((l) => l.running && l.best) && (!ask || await confirm('Use the local models (free, private)?'))) console.log(`✓ enabled: ${enableLocal(root, local).join(', ') || 'already on'}`);

  console.log('\nkilo-free is ready now: free models, no key needed.');
  if (ask && await confirm('Add another free provider (more models, higher limits)?', false)) {
    const free = catalogStatus(loadConfig(root)).filter((c) => c.free && !c.enabled && c.category !== 'local');
    const pick = await choose(free, (c) => `${c.label.padEnd(22)} ${c.free}`, null);
    if (pick) { const r = await runAdd(root, pick.id, {}); console.log(`✓ ${r.name} added.`); }
  }
  if (ask && await confirm('Test the enabled providers now (one-word prompt each)?')) await doctor({ live: true });
  console.log(`\nNext:
  cd my-project && conductor init       set up a project (CLAUDE.md / AGENTS.md, commands, MCP)
  conductor providers                   ${Object.keys(CATALOG).length} providers you can add with: conductor add <name>
  conductor ui                          settings page`);
  return 0;
}

function providers(o) {
  const rows = catalogStatus(loadConfig()).filter((c) => (!o.free || c.free) && (!o.search || `${c.id} ${c.label} ${c.about}`.toLowerCase().includes(String(o.search).toLowerCase())));
  if (o.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  for (const [cat, label] of Object.entries(CATEGORIES)) {
    const list = rows.filter((c) => c.category === cat);
    if (!list.length) continue;
    console.log(`\n${label}`);
    for (const c of list) {
      const state = c.enabled ? '✓ on ' : c.added ? '· off' : '     ';
      const key = c.apiKeyEnv && !c.apiKeyOptional ? (c.keySet ? 'key ✓' : 'key needed') : 'no key';
      console.log(`  ${state} ${c.id.padEnd(16)} ${c.label.padEnd(26)} ${key.padEnd(11)} ${c.free ? fit(c.free, termWidth() - 64) : ''}`);
    }
  }
  console.log(`\nAdd one: conductor add <name>   Guides: docs/providers/<name>.md`);
  return 0;
}

async function keys(o) {
  const [sub, name] = o._;
  if (sub === 'set' || sub === 'rm') {
    if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new UsageError(`usage: conductor keys ${sub} NAME   (an env var name, e.g. GROQ_API_KEY)`);
    if (sub === 'rm') { writeSecrets({ [name]: null }); console.log(`removed ${name} from ${GLOBAL_SECRETS}`); return 0; }
    let value = '';
    if (process.stdin.isTTY) value = await askSecret(`${name} (hidden): `);
    else { for await (const c of process.stdin) value += c; value = value.trim(); }
    if (!value) throw new UsageError('no value given; nothing changed');
    writeSecrets({ [name]: value });
    console.log(`saved ${name} to ${GLOBAL_SECRETS} (mode 600)`);
    return 0;
  }
  const list = keyList(loadConfig());
  if (o.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
  for (const k of list) console.log(`${k.set ? '✓' : k.placeholder ? '!' : ' '} ${k.name.padEnd(22)} ${k.set ? k.source : k.placeholder ? 'placeholder value, not a real key' : 'not set'}${k.usedBy.length ? `  · ${k.usedBy.join(', ')}` : ''}`);
  console.log(`\nSet one: conductor keys set NAME   (hidden input, or pipe it: printenv X | conductor keys set NAME)`);
  return 0;
}

main().then((code) => { if (code !== null) process.exitCode = code; })
  .catch((e) => { console.error(`conductor: ${e.message}`); process.exitCode = e instanceof UsageError ? 2 : 1; });
