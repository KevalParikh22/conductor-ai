// Harness eval suite (H9): measure conductor-ai itself on fixed tasks with hidden tests, so every change to prompts,
// gates or routing is judged by numbers, not impressions.
//
// evals/<id>/
//   eval.json    title, role, difficulty, tags; score: "hidden" (default) or "mutants"; protect: files the worker
//                must not change (restored before scoring)
//   plan.md      a plan with one task, T1 (passes conductor-ai plan check)
//   repo/        the starting project
//   hidden/      tests the worker never sees: copied in after it finishes (score "hidden")
//   mutants/<m>/ buggy versions of the code: the worker's own tests must fail on each (score "mutants")
//   solution/    a reference solution, used only by the self-check
//
// The self-check (`conductor-ai eval check`, also a CI test) proves each task is fair without any LLM: the score must be
// a fail on the starting project and a pass on the reference solution.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { run, GLOBAL_DIR, readJSON, writeJSON } from './util.js';
import { loadConfig } from './config.js';
import { dispatch, outcome as outcomeOf, extractTask, taskFiles } from './core.js';
import { lessonsFile, readLessons } from './lessons.js';
import { checkPlan, taskAcceptance } from './plancheck.js';
import { runAcceptanceChecks } from './acceptcheck.js';
import { VERSION } from './version.js';
import { wilson, passAtK } from './evalstats.js';

export const EVALS_DIR = fileURLToPath(new URL('../evals/', import.meta.url));
export const resultsDir = () => path.join(GLOBAL_DIR, 'evals');
const SCORE_TIMEOUT = 120_000;

export function listEvals(dir = EVALS_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => fs.existsSync(path.join(dir, n, 'eval.json'))).sort().map((n) => ({ id: n, dir: path.join(dir, n), score: 'hidden', protect: [], ...readJSON(path.join(dir, n, 'eval.json'), {}) }));
}

function pick(ids, dir) {
  const all = listEvals(dir);
  if (!ids?.length) return all;
  const out = ids.map((id) => all.find((t) => t.id === id) || (() => { throw new Error(`no eval task "${id}". Tasks: ${all.map((t) => t.id).join(', ')}`); })());
  return out;
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();

/** A fresh git project for the task, on branch eval/<id>, with its plan at docs/plan/eval.md. */
export function prepareEval(task, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(task.dir, 'repo'), dest, { recursive: true });
  fs.mkdirSync(path.join(dest, 'docs', 'plan'), { recursive: true });
  fs.copyFileSync(path.join(task.dir, 'plan.md'), path.join(dest, 'docs', 'plan', 'eval.md'));
  fs.writeFileSync(path.join(dest, '.gitignore'), 'node_modules/\n.conductor-ai/\n');
  git(dest, 'init', '-q', '-b', 'main');
  git(dest, 'config', 'user.email', 'eval@conductor-ai.local'); git(dest, 'config', 'user.name', 'conductor-ai eval');
  git(dest, 'add', '-A'); git(dest, 'commit', '-qm', `eval: ${task.id} start`);
  git(dest, 'switch', '-qc', `eval/${task.id}`);
  return dest;
}

// a clean environment: inside a test runner, NODE_TEST_CONTEXT makes a child `node --test` report to the parent
// instead of judging its own tests (its exit code would always be 0)
const testEnv = () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return env; };
const nodeTest = (cwd, files = []) => run(process.execPath, ['--test', ...files], { cwd, timeoutMs: SCORE_TIMEOUT, env: testEnv() });
const tail = (r) => `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => /not ok|✖|Error|fail/i.test(l)).slice(0, 8).join('\n');

/** Score the project in `dir` against the task's hidden truth. → { pass, detail } */
export async function scoreEval(task, dir) {
  for (const f of task.protect || []) fs.copyFileSync(path.join(task.dir, 'repo', f), path.join(dir, f)); // the worker may not have changed it
  if (task.score === 'mutants') {
    const mutantDirs = fs.readdirSync(path.join(task.dir, 'mutants')).filter((m) => fs.statSync(path.join(task.dir, 'mutants', m)).isDirectory()).sort();
    const planted = mutantDirs.length;
    const base = await nodeTest(dir);
    if (base.code !== 0) return { pass: false, detail: `the worker's tests fail on the correct code:\n${tail(base)}`, killed: 0, planted };
    if (!/^# tests [1-9]/m.test(base.stdout) && !/ℹ tests [1-9]/.test(base.stdout)) return { pass: false, detail: 'no tests ran', killed: 0, planted };
    const survived = [];
    for (const m of mutantDirs) {
      const mdir = path.join(task.dir, 'mutants', m);
      const files = listFiles(mdir);
      const saved = files.map((f) => [f, fs.readFileSync(path.join(dir, f))]);
      for (const f of files) fs.copyFileSync(path.join(mdir, f), path.join(dir, f));
      const r = await nodeTest(dir);
      for (const [f, buf] of saved) fs.writeFileSync(path.join(dir, f), buf);
      if (r.code === 0) survived.push(m);
    }
    const killed = planted - survived.length;
    return { pass: !survived.length, detail: survived.length ? `bugs the tests did not catch: ${survived.join(', ')}` : 'every planted bug was caught', killed, planted };
  }
  const hiddenSrc = path.join(task.dir, 'hidden');
  const files = listFiles(hiddenSrc);
  const hdir = path.join(dir, 'hidden');
  fs.mkdirSync(hdir, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(hiddenSrc, f), path.join(hdir, f));
  try {
    const r = await nodeTest(dir, files.map((f) => path.join('hidden', f)));
    return { pass: r.code === 0, detail: r.code === 0 ? 'hidden tests pass' : tail(r) };
  } finally { fs.rmSync(hdir, { recursive: true, force: true }); }
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const n of fs.readdirSync(path.join(dir, rel))) {
    const r = path.join(rel, n);
    if (fs.statSync(path.join(dir, r)).isDirectory()) out.push(...listFiles(dir, r)); else out.push(r);
  }
  return out;
}

/** Is each task fair? Fails on the starting project, passes with the reference solution, plan is ready. No LLM. */
export async function checkEvals({ ids, dir } = {}) {
  const rows = [];
  for (const task of pick(ids, dir)) {
    const problems = [];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `conductor-evalcheck-${task.id}-`));
    try {
      const plan = fs.readFileSync(path.join(task.dir, 'plan.md'), 'utf8').replace(/\r\n?/g, '\n');
      for (const r of checkPlan(plan, { verifyCmd: 'npm test' })) for (const p of r.problems) problems.push(`plan ${r.id}: ${p}`);
      prepareEval(task, work);
      if ((await scoreEval(task, work)).pass) problems.push('already passes on the starting project: the task tests nothing');
      // the reference solutions ship only in the git repository, not the npm package (V10): the check needs them
      if (!fs.existsSync(path.join(task.dir, 'solution'))) throw new Error('no reference solution in this install: run conductor-ai eval check from a clone of the repository');
      fs.cpSync(path.join(task.dir, 'solution'), work, { recursive: true });
      const own = await nodeTest(work);
      if (own.code !== 0) problems.push(`the reference solution fails the project's own tests:\n${tail(own)}`);
      const s = await scoreEval(task, work);
      if (!s.pass) problems.push(`the reference solution fails the score: ${s.detail}`);
      // the plan's own acceptance lines, run as checks (H11), must hold for the reference solution too
      if (['build', 'fix'].includes(task.role)) {
        const section = extractTask(plan, 'T1');
        const ch = await runAcceptanceChecks(work, taskAcceptance(section), taskFiles(section));
        for (const f of ch?.failed || []) problems.push(`acceptance check fails on the reference solution: ${f.expr} → ${f.got}`);
      }
    } catch (e) { problems.push(e.message); } finally { fs.rmSync(work, { recursive: true, force: true }); }
    rows.push({ id: task.id, problems });
  }
  return rows;
}

/**
 * Run conductor-ai on each task the way a user would (plan → run → gates → verify), then score the result against the
 * hidden truth. Compares conductor-ai's verdict (outcome) with reality (pass): a "done" that fails is the worst case.
 */
/**
 * V1: lessons across eval runs. Each eval task is a fresh repo, so its lessons would be lost; with a store file they
 * carry over, task by task: run 1 learns from its failures, run 2 gets them in its prompts. lessons: 'off' turns them
 * off (the control). → the store's lessons for one task, and a writer for after the run.
 */
function lessonStore(file) {
  const all = () => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return {
    seed(taskId, work) {
      const mine = all().filter((l) => l.evalTask === taskId).map(({ evalTask, ...l }) => l);
      if (mine.length) { fs.mkdirSync(path.dirname(lessonsFile(work)), { recursive: true }); fs.writeFileSync(lessonsFile(work), mine.map((l) => JSON.stringify(l)).join('\n') + '\n'); }
      return mine.length;
    },
    save(taskId, work) {
      const keep = all().filter((l) => l.evalTask !== taskId);
      const mine = readLessons(work).map((l) => ({ ...l, evalTask: taskId }));
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, [...keep, ...mine].map((l) => JSON.stringify(l)).join('\n') + ([...keep, ...mine].length ? '\n' : ''));
    },
  };
}

export async function runEvals({ ids, dir, chain, provider, samples, repeat = 1, passK = repeat, keep = false, label = '', lessons, onEvent = () => {} } = {}) {
  if (!(Number.isInteger(repeat) && repeat >= 1 && Number.isInteger(passK) && passK >= 1 && passK <= repeat)) throw new Error(`--repeat and --pass-k must be whole numbers with 1 <= pass-k <= repeat (got repeat ${repeat}, pass-k ${passK})`);
  const store = lessons && lessons !== 'off' ? lessonStore(lessons) : null;
  const tasks = pick(ids, dir);
  const startedAt = new Date().toISOString();
  const results = [];
  // independent repeats: each run starts from a fresh copy (with a lesson store, later runs see earlier runs' lessons)
  for (const task of tasks) for (let i = 1; i <= repeat; i++) {
    const rep = repeat > 1 ? { run: i, of: repeat } : {};
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `conductor-eval-${task.id}-`));
    onEvent({ type: 'start', task: task.id, ...rep });
    const t0 = Date.now();
    const row = { id: task.id, run: i, role: task.role, difficulty: task.difficulty, pass: false };
    try {
      prepareEval(task, work);
      if (store) row.lessonsSeeded = store.seed(task.id, work);
      const cfg = loadConfig(work);
      if (lessons === 'off') cfg.settings = { ...cfg.settings, lessons: false };
      const s = await dispatch(cfg, { role: task.role, planPath: 'docs/plan/eval.md', taskId: 'T1', chain, provider, samples, onEvent: (e) => onEvent({ ...e, task: task.id }) });
      Object.assign(row, {
        outcome: s.outcome || outcomeOf(s), winner: s.winner, model: s.model, verify: s.verify?.status || null,
        attempts: s.attempts.filter((a) => !a.skipped).map((a) => `${a.provider}(${a.reason})`),
        tokens: s.samplesCost?.tokens ?? s.attempts.reduce((t, a) => t + (a.tokens?.input || 0) + (a.tokens?.output || 0), 0), // every attempt with --samples
        cost: s.samplesCost?.cost ?? s.attempts.reduce((t, a) => t + (a.cost || 0), 0),
        acceptance: s.acceptance ? `${s.acceptance.met}/${s.acceptance.total}` : null,
        outside: s.scope?.outside || [],
        suspectTests: s.verify?.suspectTests || null, // conductor-ai judged the code right and the worker's tests wrong
        handedOn: (s.escalated || []).length,
        lessonsInPrompt: (s.lessons || []).length,
      });
      const sc = await scoreEval(task, work);
      row.pass = sc.pass; row.detail = sc.detail;
      if (sc.planted != null) { row.killed = sc.killed; row.planted = sc.planted; }
      // no model was reached at all (DNS, offline): the run says nothing about conductor-ai, so it doesn't count
      const tried = s.attempts.filter((a) => !a.skipped);
      if (!s.winner && tried.length && tried.every((a) => /^network|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i.test(a.reason || ''))) {
        row.outcome = 'error'; row.detail = `no provider could be reached (${tried[0].reason}): not counted`;
      }
    } catch (e) {
      row.outcome = 'error'; row.detail = e.message;
    } finally {
      if (store) try { store.save(task.id, work); } catch { /* the store is a help */ }
      row.seconds = Math.round((Date.now() - t0) / 1000);
      if (keep) row.dir = work; else fs.rmSync(work, { recursive: true, force: true });
    }
    results.push(row);
    onEvent({ type: 'scored', task: task.id, pass: row.pass, outcome: row.outcome, ...rep });
  }
  const report = { version: VERSION, startedAt, label, chain: chain || null, provider: provider || null, samples: samples || 1, repeat, passK, lessons: lessons === 'off' ? 'off' : store ? 'store' : 'per-task', results, summary: summarize(results, passK) };
  fs.mkdirSync(resultsDir(), { recursive: true });
  const file = path.join(resultsDir(), `${startedAt.replace(/[:.]/g, '-')}${label ? `-${label.replace(/[^\w.-]/g, '')}` : ''}.json`);
  writeJSON(file, report);
  return { ...report, file };
}

const pct = (x) => Math.round(x * 100);
const ci = (passes, runs) => { const w = wilson(passes, runs); return [pct(w.low), pct(w.high)]; };
const mutantsOf = (rows) => {
  const m = rows.filter((r) => r.planted != null);
  if (!m.length) return null;
  const killed = m.reduce((t, r) => t + r.killed, 0), planted = m.reduce((t, r) => t + r.planted, 0);
  return { killed, planted, score: planted ? pct(killed / planted) : 0 };
};

/** Every run is one row; repeats of a task share its id. Errors are left out of the rates. */
export function summarize(results, passK = 1) {
  const n = results.length;
  const done = (r) => r.outcome === 'done';
  const count = (f) => results.filter(f).length;
  const counted = n - count((r) => r.outcome === 'error');
  const ids = [...new Set(results.map((r) => r.id))];
  const perTask = ids.map((id) => {
    const rows = results.filter((r) => r.id === id), ok = rows.filter((r) => r.outcome !== 'error');
    const runs = ok.length, passes = ok.filter((r) => r.pass).length, m = mutantsOf(rows);
    return { id, runs, passes, pass1: runs ? pct(passes / runs) : 0, ci: ci(passes, runs), passK: passK <= runs ? pct(passAtK(runs, passes, passK)) : null, ...(m && { killed: m.killed, planted: m.planted }) };
  });
  const ks = perTask.map((t) => t.passK).filter((v) => v != null);
  return {
    tasks: ids.length,
    runs: n,
    counted,
    passed: count((r) => r.pass),
    // errors (no provider reachable, broken setup) say nothing about conductor-ai: left out of the rate
    passRate: n - count((r) => r.outcome === 'error') ? Math.round((count((r) => r.pass) / (n - count((r) => r.outcome === 'error'))) * 100) : 0,
    // conductor-ai's verdict against the hidden truth
    rightDone: count((r) => done(r) && r.pass), // said done, really done
    falseDone: count((r) => done(r) && !r.pass), // said done, but broken: the case conductor-ai exists to prevent
    caught: count((r) => !done(r) && !r.pass && r.outcome !== 'error'), // said not done, and it wasn't
    falseAlarm: count((r) => !done(r) && r.pass && r.outcome !== 'error'), // said not done, but it was fine
    errors: count((r) => r.outcome === 'error'),
    seconds: results.reduce((t, r) => t + (r.seconds || 0), 0),
    tokens: results.reduce((t, r) => t + (r.tokens || 0), 0),
    cost: Math.round(results.reduce((t, r) => t + (r.cost || 0), 0) * 10000) / 10000,
    ci: ci(count((r) => r.pass), counted),
    passK: { k: passK, value: ks.length ? Math.round(ks.reduce((t, v) => t + v, 0) / ks.length) : null },
    perTask,
    mutants: mutantsOf(results),
  };
}

/** The saved result to compare with: a file path, or "last" (the newest before `exclude`). */
export function loadResult(which, exclude) {
  if (which && which !== 'last') return readJSON(path.resolve(which), null);
  let files = [];
  try { files = fs.readdirSync(resultsDir()).filter((f) => f.endsWith('.json')).sort(); } catch { return null; }
  const prev = files.filter((f) => path.join(resultsDir(), f) !== exclude).at(-1);
  return prev ? readJSON(path.join(resultsDir(), prev), null) : null;
}

export function formatEvals(report, prev) {
  const s = report.summary;
  const L = ['', '====================== CONDUCTOR EVAL ======================'];
  L.push(`conductor-ai ${report.version}${report.repeat > 1 ? ` · ${report.repeat} runs per task` : ''}${report.samples > 1 ? ` · best of ${report.samples} attempts per run` : ''}${report.label ? ` · ${report.label}` : ''}${report.provider ? ` · provider ${report.provider}` : report.chain ? ` · chain ${report.chain.join(',')}` : ' · your routing'}`);
  for (const r of report.results) {
    const mark = r.pass ? '✓' : '✗';
    const tags = `${r.suspectTests ? '  [said: code looks right, tests wrong]' : ''}${r.handedOn ? `  [handed on ×${r.handedOn}]` : ''}`;
    const verdict = r.outcome === 'done' && !r.pass ? '  ← conductor-ai said done, hidden tests fail' : r.outcome !== 'done' && r.pass && r.outcome !== 'error' ? '  ← work was fine, conductor-ai flagged it' : '';
    L.push(`${mark} ${(report.repeat > 1 ? `${r.id} #${r.run}` : r.id).padEnd(22)} ${String(r.outcome || '-').padEnd(13)} ${(r.winner || '-').padEnd(16)} ${String(r.seconds).padStart(4)}s${r.acceptance ? `  acc ${r.acceptance}` : ''}${r.planted != null ? `  mutants ${r.killed}/${r.planted}` : ''}${r.lessonsInPrompt ? `  [${r.lessonsInPrompt} lesson(s) in prompt]` : ''}${tags}${verdict}`);
    if (!r.pass && r.detail) L.push(`    ${r.detail.split('\n')[0].slice(0, 150)}`);
  }
  const k = s.passK?.k || 1;
  if (report.repeat > 1) {
    L.push('', 'per task:');
    for (const t of s.perTask) L.push(`  ${t.id.padEnd(22)} ${t.passes}/${t.runs} = ${t.pass1}% [${t.ci[0]}–${t.ci[1]}%]${k > 1 && t.passK != null ? `  pass@${k} ${t.passK}%` : ''}${t.planted != null ? `  mutants ${t.killed}/${t.planted} = ${t.planted ? Math.round((t.killed / t.planted) * 100) : 0}%` : ''}`);
  }
  // old saved reports have no interval: work it out from their counts
  const band = (sm) => sm.ci || ci(sm.passed, sm.counted ?? sm.tasks - sm.errors);
  const noise = () => {
    if (!prev?.summary) return '';
    // the two 95% intervals don't overlap: deliberately cautious, so 1/1 vs 0/1 stays "within noise"
    const [a, b] = [s, prev.summary].map(band);
    return a[0] > b[1] || b[0] > a[1] ? ' — likely real' : ' — within noise';
  };
  const delta = (k, unit = '') => (prev?.summary && prev.summary[k] != null ? ` (${s[k] - prev.summary[k] >= 0 ? '+' : ''}${s[k] - prev.summary[k]}${unit} vs ${prev.label || prev.startedAt.slice(0, 16)})` : '');
  const [lo, hi] = band(s);
  L.push('', `pass rate:   ${s.passed}/${s.counted ?? s.tasks - s.errors} = ${s.passRate}% [95% CI ${lo}–${hi}%]${k > 1 && s.passK.value != null ? ` · pass@${k} ${s.passK.value}%` : ''}${s.errors ? ` (${s.errors} not counted: error)` : ''}${delta('passRate', ' pts')}${noise()}`);
  L.push(`verdicts:    ${s.rightDone} done and right · ${s.falseDone} "done" but wrong${delta('falseDone')} · ${s.caught} caught · ${s.falseAlarm} false alarm${s.errors ? ` · ${s.errors} error` : ''}`);
  // V1: the tasks that had lessons in their prompt, against the same tasks in the compared run
  const withL = report.results.filter((r) => r.lessonsInPrompt);
  if (withL.length || report.lessons === 'off') {
    const same = (rs) => rs.filter((r) => withL.some((w) => w.id === r.id));
    const rate = (rs) => `${rs.filter((r) => r.pass).length}/${rs.length}`;
    L.push(`lessons:     ${report.lessons === 'off' ? 'off' : `${withL.length} task(s) had lessons in their prompt: ${rate(withL)} passed`}${prev?.results && withL.length ? `; the same tasks in ${prev.label || 'the compared run'} (lessons ${prev.lessons || 'per-task'}): ${rate(same(prev.results))}` : ''}`);
  }
  if (s.mutants) L.push(`mutation:    ${s.mutants.killed}/${s.mutants.planted} bugs caught = ${s.mutants.score}%`);
  L.push(`cost:        ${s.seconds}s · ${s.tokens.toLocaleString()} tokens${s.cost ? ` · $${s.cost}` : ''}`);
  if (report.file) L.push(`saved:       ${report.file}`);
  return L.join('\n');
}
