#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, findProjectRoot, validateConfig, GLOBAL_CONFIG, GLOBAL_SECRETS, projectConfigPath, readScope } from '../src/config.js';
import { dispatch, formatSummary, UsageError, clearCooldowns, getCooldowns } from '../src/core.js';
import { runBatch, formatBatch } from '../src/batch.js';
import { listWorktrees, removeWorktree } from '../src/worktree.js';
import { statusReport, statusData } from '../src/status.js';
import { runVerify } from '../src/verify.js';
import { initProject, setupGlobal } from '../src/init.js';
import { startMcpServer } from '../src/mcp.js';
import { testProvider } from '../src/providers.js';
import { listFreeModels, listProviderModels } from '../src/models.js';
import { CLI_PRESETS, ROLES, CONTROLLERS } from '../src/presets.js';
import { VERSION } from '../src/version.js';
import { which } from '../src/util.js';

const HELP = `conductor-ai ${VERSION}: one controller (Claude by default), many worker LLMs.

Setup
  conductor setup                      first-time global setup (~/.config/conductor)
  conductor init [--controller <c>]    add conductor to the current project
                                       controllers: ${Object.keys(CONTROLLERS).join(', ')}
  conductor ui [--port 4545] [--no-open]   settings page: providers, roles, controller, keys
  conductor doctor [--live]            check installs and keys (--live pings each provider)

Work (normally called by the controller)
  conductor run <role> [task text] [options]
     roles: ${Object.entries(ROLES).map(([r, m]) => `${r}${m.mode === 'read' ? '(ro)' : ''}`).join(' ')}
     --plan <file> --task <id>   take the task from a plan file
     --provider <name>           try this provider first
     --chain a,b,c               use exactly this fallback chain
     --note "<feedback>"         extra instructions (use on retries)
     --files a,b                 context files for API (chat) providers
     --base <ref> --focus "..."  review options
     --save <file>               ask: save the answer
     --worktree [--replace]      run in its own checkout on branch conductor/<id> and commit there
                                 (write roles; lets several tasks run at the same time)
     --no-verify --allow-dirty --json
  conductor <role> ...                 shortcut for: conductor run <role> ...
  conductor batch --plan <file> --tasks T1,T2,T3 [--concurrency 4] [--role r] [--provider p] [--replace] [--json]
                                       run independent tasks in parallel, one worktree each,
                                       spread across different providers
  conductor worktree [list]            conductor/* worktrees and whether they are merged
  conductor worktree rm <id>|--all [--force]   remove worktrees (unmerged branches need --force)
  conductor verify                     run the project's verify command
  conductor status [--json]            providers, chains and repo state
  conductor models [provider] [--all]  list free models (OpenRouter by default, or any API provider)
  conductor cooldown [--clear [name]]  show or clear rate-limit cooldowns
  conductor config path                show config file locations
  conductor mcp                        run as an MCP server (stdio)

Exit codes: 0 ok · 2 usage/unsafe state · 3 every provider failed (controller takes over)`;

function parseArgs(argv) {
  const opts = { _: [] };
  const flags = new Set(['no-verify', 'allow-dirty', 'json', 'live', 'no-open', 'no-mcp', 'all', 'clear', 'global', 'help', 'version', 'worktree', 'replace', 'force']);
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
  const argv = process.argv.slice(2);
  let cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'help';
  const o = parseArgs(argv);
  if (o.version) { console.log(VERSION); return 0; }
  if (o.help || cmd === 'help') { console.log(HELP); return 0; }
  if (ROLES[cmd]) { o._.unshift(cmd); cmd = 'run'; }

  switch (cmd) {
    case 'setup': {
      console.log('Global setup:');
      setupGlobal().forEach((l) => console.log(l));
      console.log(`\nAdd API keys to ${GLOBAL_SECRETS} (or use: conductor ui → Keys).`);
      console.log('Next: cd into a project and run  conductor init');
      return 0;
    }
    case 'init': {
      const root = findProjectRoot();
      const controller = o.controller || 'claude-code';
      setupGlobal();
      const { lines, notes } = initProject(root, { controller, mcp: !o['no-mcp'] });
      console.log(`conductor init → ${root}  (controller: ${CONTROLLERS[controller].label})`);
      lines.forEach((l) => console.log(l));
      notes.forEach((n) => console.log('\n' + n));
      console.log(`\nNext:
  1. Fill in section 1 of AGENTS.md (stack + Verify command)
  2. conductor ui         choose providers, models and fallback order
  3. conductor doctor     check every provider is ready
  4. In ${CONTROLLERS[controller].label}: /conduct-status, then /conduct-plan <feature>`);
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
        save: o.save, noVerify: o['no-verify'], allowDirty: o['allow-dirty'], worktree: o.worktree, replace: o.replace,
        onEvent: o.json ? undefined : (e) => {
          const m = { worktree: `working in ${e.dir} (branch ${e.branch})`, try: `trying ${e.provider} (${e.kind})…`, skip: `skip ${e.provider}: ${e.reason}`, fail: `${e.provider} failed: ${e.reason}`, ok: `${e.provider} finished`, verify: 'running verify…' }[e.type];
          if (m) process.stderr.write(`conductor: ${m}\n`);
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
        planPath: o.plan, tasks, role: o.role, provider: o.provider, concurrency: o.concurrency, noVerify: o['no-verify'], replace: o.replace, note: o.note,
        onEvent: o.json ? undefined : (e) => {
          const m = { start: `starting (first choice: ${e.provider})`, try: `trying ${e.provider}…`, fail: `${e.provider} failed: ${e.reason}`, ok: `${e.provider} finished`, verify: 'running verify…', done: 'done' }[e.type];
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
    case 'cooldown': {
      if (o.clear) { clearCooldowns(o._[0] || (typeof o.clear === 'string' ? o.clear : undefined)); console.log('cooldowns cleared'); return 0; }
      const c = getCooldowns();
      if (!Object.keys(c).length) console.log('no providers cooling down');
      for (const [n, v] of Object.entries(c)) console.log(`${n.padEnd(18)} until ${new Date(v.until).toLocaleTimeString()}  (${v.reason})`);
      return 0;
    }
    case 'config': {
      const root = findProjectRoot();
      if (o._[0] === 'show') { console.log(JSON.stringify(o.global ? readScope('global', root) : readScope('project', root), null, 2)); return 0; }
      console.log(`global config:  ${GLOBAL_CONFIG}\nglobal secrets: ${GLOBAL_SECRETS}\nproject config: ${projectConfigPath(root)}`);
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${cmd}". Run: conductor help`);
  }
}

async function doctor(o) {
  const cfg = loadConfig();
  console.log(`conductor ${VERSION} · node ${process.version} · ${os.platform()}`);
  console.log(`project: ${cfg.root}\n`);
  let problems = 0;
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (!p.enabled) continue;
    if (p.type === 'cli') {
      const preset = { ...CLI_PRESETS[p.preset], ...p };
      if (!which(preset.bin)) { problems++; console.log(`✗ ${name.padEnd(16)} not installed\n    install: ${preset.install}\n    login:   ${preset.login}`); continue; }
    } else if (p.apiKeyEnv && !process.env[p.apiKeyEnv]) {
      problems++; console.log(`✗ ${name.padEnd(16)} ${p.apiKeyEnv} not set (add to ${GLOBAL_SECRETS} or conductor ui → Keys)`); continue;
    }
    if (o.live) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-doctor-'));
      const t = await testProvider(name, p, cfg.root, dir);
      fs.rmSync(dir, { recursive: true, force: true });
      if (!t.ok) problems++;
      console.log(`${t.ok ? '✓' : '✗'} ${name.padEnd(16)} ${t.reason}${t.ok ? '' : `: ${t.sample.replace(/\s+/g, ' ').slice(0, 120)}`}`);
    } else console.log(`✓ ${name.padEnd(16)} ready (use --live to test a real call)`);
  }
  const errs = validateConfig(cfg);
  errs.forEach((e) => console.log(`✗ config: ${e}`));
  console.log(problems + errs.length ? `\n${problems + errs.length} problem(s). Disabled providers are ignored; toggle them in conductor ui.` : '\nAll enabled providers look good.');
  return 0;
}

main().then((code) => { if (code !== null) process.exitCode = code; })
  .catch((e) => { console.error(`conductor: ${e.message}`); process.exitCode = e instanceof UsageError ? 2 : 1; });
