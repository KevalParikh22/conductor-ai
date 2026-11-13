#!/usr/bin/env node
// Pilot benchmark: Claude alone (A) vs Claude + conductor (C) on the same plan, scored by hidden tests.
//
//   node bench/run.mjs check                         is the pilot fair? (no model: fails on the start, passes on the solution)
//   node bench/run.mjs A [--tasks T1,T2] [--model sonnet] [--max-cost 1.50]
//   node bench/run.mjs C [--tasks T1,T2] [--model sonnet]
//
// Every Claude call is `claude -p --output-format json`, which reports its tokens and an equivalent cost: those numbers
// are the measurement. A runs one task at a time and stops before the next task once --max-cost is reached. C lets
// Claude act as the controller with conductor (/conduct-run); worker usage comes from conductor's run summaries.
// Results go to bench/results/<date>-<condition>.json, with a table on stdout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PILOT = path.join(HERE, 'pilot');
const CONDUCTOR = path.join(HERE, '..', 'bin', 'conductor.js');
const TASKS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'];

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const condition = argv[0];
const model = opt('model', 'sonnet');
const tasks = (opt('tasks', '') || TASKS.join(',')).split(',').map((t) => t.trim()).filter(Boolean);
const maxCost = Number(opt('max-cost', '0')) || Infinity;

const sh = (cmd, args, cwd, extra = {}) => spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, ...extra });
const git = (cwd, ...a) => sh('git', ['-c', 'user.email=bench@conductor.local', '-c', 'user.name=bench', ...a], cwd);
const cleanEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };

function prepare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-pilot-'));
  fs.cpSync(path.join(PILOT, 'repo'), dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'plan'), { recursive: true });
  fs.copyFileSync(path.join(PILOT, 'plan.md'), path.join(dir, 'docs', 'plan', 'pilot.md'));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, 'init', '-q', '-b', 'main');
  // a real project has a commit identity; without one every merge fails ("unable to auto-detect email")
  sh('git', ['config', 'user.email', 'bench@conductor.local'], dir); sh('git', ['config', 'user.name', 'bench'], dir);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'pilot start'); git(dir, 'switch', '-qc', 'feat/utils');
  return dir;
}

/** Hidden tests per task: { T1: true, ... }. The test file is copied in only for scoring, then removed. */
function score(dir) {
  const h = path.join(dir, 'hidden');
  fs.mkdirSync(h, { recursive: true });
  fs.copyFileSync(path.join(PILOT, 'hidden', 'pilot.hidden.test.js'), path.join(h, 'pilot.hidden.test.js'));
  const r = sh(process.execPath, ['--test', '--test-reporter=tap', 'hidden/pilot.hidden.test.js'], dir, { env: cleanEnv() });
  fs.rmSync(h, { recursive: true, force: true });
  const out = {};
  for (const m of `${r.stdout}`.matchAll(/^(not ok|ok) \d+ - (T\d)\b/gm)) out[m[2]] = m[1] === 'ok';
  return out;
}

/** One headless Claude call; → { ok, cost, tokens: { input, output, cacheRead, cacheWrite }, seconds, turns, result } */
function claude(dir, prompt, allowed) {
  const t0 = Date.now();
  const r = sh('claude', ['-p', prompt, '--output-format', 'json', '--model', model, '--permission-mode', 'acceptEdits', '--allowedTools', ...allowed], dir, { timeout: 60 * 60_000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* not JSON */ }
  const u = j?.usage || {};
  return {
    ok: !!j && !j.is_error, cost: j?.total_cost_usd ?? null, seconds: Math.round((Date.now() - t0) / 1000), turns: j?.num_turns ?? null,
    tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 },
    result: String(j?.result || r.stderr || r.stdout || '').slice(0, 4000),
    // tool calls headless mode refused: a run that stalls on one isn't measuring conductor
    denied: (j?.permission_denials || []).map((d) => ({ tool: d.tool_name, input: JSON.stringify(d.tool_input || {}).slice(0, 300) })),
  };
}

const sum = (calls, k) => calls.reduce((t, c) => t + (k === 'cost' ? (c.cost || 0) : c.tokens[k]), 0);

function workerUsage(dir) {
  const runs = path.join(dir, '.conductor', 'runs');
  const out = { runs: 0, tokens: 0, cost: 0, providers: {} };
  let names = []; try { names = fs.readdirSync(runs); } catch { return out; }
  for (const n of names) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(runs, n, 'summary.json'), 'utf8')); } catch { continue; }
    out.runs++;
    for (const a of s.attempts || []) {
      out.tokens += (a.tokens?.input || 0) + (a.tokens?.output || 0); out.cost += a.cost || 0;
      if (!a.skipped) out.providers[a.provider] = (out.providers[a.provider] || 0) + 1;
    }
  }
  return out;
}

function check() {
  const start = prepare();
  const before = score(start);
  fs.cpSync(path.join(PILOT, 'solution'), start, { recursive: true });
  const after = score(start);
  fs.rmSync(start, { recursive: true, force: true });
  const unfair = TASKS.filter((t) => before[t] !== false || after[t] !== true);
  for (const t of TASKS) console.log(`${unfair.includes(t) ? '✗' : '✓'} ${t}: start ${before[t] ? 'passes (unfair)' : 'fails'}, solution ${after[t] ? 'passes' : 'FAILS'}`);
  return unfair.length ? 1 : 0;
}

function report(res) {
  const dir = path.join(HERE, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${res.startedAt.replace(/[:.]/g, '-')}-${res.condition}${res.dry ? '-dry' : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(res, null, 2));
  const passed = Object.values(res.hidden).filter(Boolean).length;
  console.log(`\n=== pilot ${res.condition} (${res.model}) · ${res.tasks.join(',')} ===`);
  for (const c of res.calls) console.log(`  ${(c.task || 'controller').padEnd(10)} $${(c.cost ?? 0).toFixed(4)}  in ${c.tokens.input} / out ${c.tokens.output} / cache read ${c.tokens.cacheRead} / cache write ${c.tokens.cacheWrite}  ${c.seconds}s  ${c.ok ? '' : 'ERROR ' + c.result.slice(0, 80)}`);
  console.log(`hidden tests: ${passed}/${res.tasks.length} · Claude $${res.claudeCost.toFixed(4)} · ${res.seconds}s${res.workers ? ` · workers: ${res.workers.runs} runs, ${res.workers.tokens} tokens, ${JSON.stringify(res.workers.providers)}` : ''}${res.stopped ? ` · STOPPED: ${res.stopped}` : ''}`);
  console.log(`saved: ${file}`);
}

async function main() {
  if (condition === 'check') return check();
  if (!['A', 'C'].includes(condition)) { console.error('usage: node bench/run.mjs check | A | C [--tasks T1,T2] [--model sonnet] [--max-cost 1.50]'); return 2; }
  const dir = prepare();
  const t0 = Date.now(), startedAt = new Date().toISOString();
  const calls = [];
  let stopped = null;
  if (condition === 'A') {
    for (const t of tasks) {
      const spent = sum(calls, 'cost');
      if (spent >= maxCost) { stopped = `--max-cost ${maxCost} reached ($${spent.toFixed(4)}) before ${t}`; break; }
      const c = claude(dir, `Do task ${t} from docs/plan/pilot.md: read the plan (its Design notes too), implement the task, and run \`npm test\` until it passes. Do not commit. Reply with one line when done.`,
        ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm test:*)', 'Bash(node:*)']);
      calls.push({ task: t, ...c });
      git(dir, 'add', '-A'); git(dir, 'commit', '-qm', `A: ${t}`, '--allow-empty');
      process.stderr.write(`pilot A ${t}: $${(c.cost ?? 0).toFixed(4)}, ${c.seconds}s\n`);
    }
  } else {
    // C: conductor in the project, Claude Code as the controller, the plan fixed in advance
    sh(process.execPath, [CONDUCTOR, 'init', '--controller', 'claude-code', '--no-mcp'], dir);
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'conductor init', '--allow-empty');
    const prompt = tasks.length === TASKS.length ? '/conduct-run docs/plan/pilot.md' : `/conduct-build docs/plan/pilot.md ${tasks[0]}`;
    const c = claude(dir, prompt, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(conductor:*)', 'Bash(git:*)', 'Bash(npm test:*)']);
    calls.push({ task: null, ...c });
  }
  const hidden = Object.fromEntries(Object.entries(score(dir)).filter(([t]) => tasks.includes(t)));
  const res = {
    condition, model, tasks, startedAt, seconds: Math.round((Date.now() - t0) / 1000), stopped, dir,
    claudeCost: sum(calls, 'cost'), claudeTokens: { input: sum(calls, 'input'), output: sum(calls, 'output'), cacheRead: sum(calls, 'cacheRead'), cacheWrite: sum(calls, 'cacheWrite') },
    hidden, calls, workers: condition === 'C' ? workerUsage(dir) : null, dry: argv.includes('--dry'),
  };
  report(res);
  return 0;
}

main().then((c) => { process.exitCode = c; });
