// `conductor batch`: run several independent plan tasks at the same time, each in its own worktree,
// spreading them across different providers so no single quota takes all the load.
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, CLI_PRESETS } from './presets.js';
import { checkTask } from './plancheck.js';
import { detectVerify } from './verify.js';
import { speedStats, expectedSeconds, taskSize } from './selector.js';
import { removeWorktree } from './worktree.js';
import { execFileSync } from 'node:child_process';
import { planTaskIds } from './plancheck.js';
import { setTaskStatus } from './plan.js';
import { runVerify } from './verify.js';
import { providerLocation, providerReadiness } from './config.js';
import { controllerWorker } from './presets.js';
import { dispatch, extractTask, taskFiles, resolveChain, chooseChain, openQuestions, UsageError, outcome, unverifiedBlocks } from './core.js';

const field = (section, name) => (section.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, 'i')) || [])[1]?.trim() || '';

/** Read and check the tasks before anything runs. */
export function planBatch(cfg, { planPath, tasks, role, allowOpenQuestions, allowWeakPlan, all, merge }) {
  const planAbs = path.resolve(cfg.root, planPath || '');
  if (!planPath || !fs.existsSync(planAbs)) throw new UsageError(`plan not found: ${planPath || '(none given)'}`);
  const planText = fs.readFileSync(planAbs, 'utf8').replace(/\r\n?/g, '\n');
  const skipped = [];
  if (all) {
    // S3: every task a worker can do; controller and read-only tasks are left to the controller
    tasks = planTaskIds(planText).filter((id) => {
      const sec = extractTask(planText, id);
      if (/^done\b/i.test(field(sec, 'status'))) { skipped.push(`${id}: status done, skipped`); return false; }
      const r = role || field(sec, 'role').split(/[\s|,]/)[0] || 'build';
      const ok = r !== 'controller' && ROLES[r]?.mode === 'write';
      if (!ok) skipped.push(`${id} (${r}): not a worker task, left for you`);
      return ok;
    });
  }
  if (!tasks?.length) throw new UsageError(all ? `${planPath} has no tasks a worker can do` : 'batch needs --tasks T1,T2,... (or --all)');
  const open = openQuestions(planText);
  if (open.length && !allowOpenQuestions) throw new UsageError(`${planPath} still has ${open.length} open question(s): ${open.map((q) => `"${q}"`).join('; ')}. Answer them in the plan (- [x] question → answer) first, or pass --allow-open-questions`);
  const ids = [...new Set(tasks)];
  const items = ids.map((id) => {
    const section = extractTask(planText, id);
    if (!section) throw new UsageError(`task "${id}" not found in ${planPath}`);
    const r = role || field(section, 'role').split(/[\s|,]/)[0] || 'build';
    if (r === 'controller') throw new UsageError(`${id} is a controller task: do it yourself, not in a batch`);
    if (!ROLES[r] || ROLES[r].mode !== 'write') throw new UsageError(`${id}: role "${r}" can't run in a batch (use build, fix, test or docs)`);
    const deps = field(section, 'depends on').split(/[\s,]+/).filter((d) => /^T?\w+$/.test(d) && d !== '-' && !/^none$/i.test(d));
    return { id, role: r, files: taskFiles(section), deps, section };
  });
  // Q1: every task must be ready for a worker before any of them starts
  if (cfg.settings?.planGate !== false && !allowWeakPlan) {
    const verifyCmd = detectVerify(cfg.root, cfg.settings || {});
    const bad = items.map((t) => ({ id: t.id, problems: checkTask(t.section, { verifyCmd, maxFiles: cfg.settings?.maxTaskFiles || 4 }) })).filter((x) => x.problems.length);
    if (bad.length) throw new UsageError(`not ready to hand to workers:\n${bad.map((b) => `  ${b.id}:\n    - ${b.problems.join('\n    - ')}`).join('\n')}\nFix the tasks in ${planPath} (conductor plan check ${planPath}), or pass --allow-weak-plan`);
  }
  for (const t of items) {
    const inBatch = t.deps.filter((d) => ids.includes(d));
    if (inBatch.length && !merge) throw new UsageError(`${t.id} depends on ${inBatch.join(', ')} in the same batch. Run ${inBatch.join(', ')} first, merge, then batch the rest`);
  }
  if (merge) {
    // S3: dependencies run in order; a cycle could never start
    const seen = new Set(), stack = new Set(), byId = Object.fromEntries(items.map((t) => [t.id, t]));
    const visit = (id) => {
      if (stack.has(id)) throw new UsageError(`${id} depends on itself through ${[...stack].join(' → ')}: fix the depends lines in ${planPath}`);
      if (seen.has(id) || !byId[id]) return;
      stack.add(id); byId[id].deps.forEach(visit); stack.delete(id); seen.add(id);
    };
    items.forEach((t) => visit(t.id));
  }
  const warnings = [...skipped];
  const dependsOn = (a, b) => a.deps.includes(b.id) || b.deps.includes(a.id);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const shared = items[i].files.filter((f) => items[j].files.includes(f));
      if (shared.length && !(merge && dependsOn(items[i], items[j]))) warnings.push(`${items[i].id} and ${items[j].id} both list ${shared.join(', ')}: expect a merge conflict`);
    }
  }
  return { items, warnings };
}

/**
 * Give each task a different first provider where possible: task n of a role starts with the n-th ready
 * provider in that role's chain, and keeps the rest of the chain as its fallback. A task the plan or a route
 * assigns to a provider keeps that choice.
 */
export function spreadChains(cfg, items, { provider, priority } = {}) {
  const seen = {};
  return items.map((t) => {
    if (!provider) {
      const own = chooseChain(cfg, t.role, { section: t.section || '', body: t.section || '', files: t.files || [], priority });
      if (own.how === 'plan' || own.how === 'route') return { ...t, chain: own.chain.map((c) => c.name), route: own.note };
    }
    if (provider) return { ...t, chain: resolveChain(cfg, t.role, { provider }).map((c) => c.name) };
    // this task's own order (the selector puts fast, reliable providers first for small tasks), then spread: at most
    // maxParallelPerProvider tasks start on one provider, so a wave isn't stacked on one slow agent and its quota
    const ordered = chooseChain(cfg, t.role, { section: t.section || '', body: t.section || '', files: t.files || [], priority }).chain;
    const names = ordered.map((c) => c.name);
    const ready = ordered.filter((c) => !c.skip).map((c) => c.name);
    if (!ready.length) return { ...t, chain: names };
    // the provider expected to finish this task soonest: its measured median time, plus half of it again for every
    // task it already has (they share its quota and machine). A provider with no history counts as average (so a new
    // or newly working one gets tasks and gets measured); a measured, unreliable one goes last
    const cap = cfg.settings?.maxParallelPerProvider ?? ((priority || cfg.settings?.priority) === 'speed' ? 3 : 2);
    const size = taskSize({ role: t.role, mode: 'write', body: t.section || '', files: t.files || [] }).size;
    const secs = expectedSeconds(speedStats(ready, t.role, { size }), ready);
    const eta = (n) => secs(n) * (1 + 0.5 * (seen[n] || 0));
    // a provider's own limit wins (agy: 1, its quota belongs to the account); the setting is the default
    const capOf = (n) => cfg.providers?.[n]?.maxParallel ?? CLI_PRESETS[cfg.providers?.[n]?.preset]?.maxParallel ?? cap;
    const open = ready.filter((n) => (seen[n] || 0) < capOf(n));
    const pool = open.length ? open : ready;
    const first = pool.reduce((a, b) => (eta(b) < eta(a) ? b : a));
    seen[first] = (seen[first] || 0) + 1;
    return { ...t, chain: [first, ...names.filter((x) => x !== first)] };
  });
}

/** Run tasks with at most `concurrency` at once. Results come back in task order. */
/**
 * S0/S1: may this provider take a hedge (a second attempt at a slow task) under this priority?
 * save: never · balanced: free API routes and local models only (no money, no subscription quota) · speed: any route
 * without a per-token price (free routes, and agents on your subscriptions). Never the controller's own CLI or manual.
 */
export function hedgeAllowed(cfg, name, priority) {
  const p = cfg.providers?.[name];
  if (!p || priority === 'save' || p.type === 'manual' || name === controllerWorker(cfg.controller) || p.price) return false;
  if (!providerReadiness(name, p).ready) return false;
  if (priority === 'speed') return true;
  return !!p.free || providerLocation(p) === 'local-model';
}

const gitIn = (root, args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** S2: merging into your branch needs a clean checkout (tracked files): conductor won't mix its merges with your edits. */
export function assertCleanCheckout(root) {
  let dirty;
  try { dirty = gitIn(root, ['status', '--porcelain', '--untracked-files=no']).trim(); } catch (e) { throw new UsageError(`--merge needs a git repository: ${e.message}`); }
  if (dirty) throw new UsageError(`--merge needs a clean checkout; these files have changes:\n${dirty.split('\n').slice(0, 10).map((l) => `  ${l}`).join('\n')}\nCommit or stash them first`);
  if (gitIn(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'HEAD') throw new UsageError('--merge needs a branch checked out (HEAD is detached)');
}

/**
 * S2: merge one task's branch into the current branch (--no-ff), then run verify on the result. A conflict is undone
 * (merge --abort) and reported with the files; a failing verify keeps the merge (so you can see it) and stops the batch.
 * A merged task's worktree and branch are removed.
 */
export async function mergeTask(cfg, s, { emit, keepWorktree } = {}) {
  const wt = s.worktree;
  if (!wt?.commit) { if (wt?.id && !keepWorktree) removeWorktree(cfg.root, wt.id, { force: true }); return { status: 'no-changes' }; }
  emit?.({ type: 'merge', branch: wt.branch });
  try {
    gitIn(cfg.root, ['merge', '--no-ff', '--no-edit', '-m', `conductor: merge ${String(wt.id).replace(/-(s\d+|h\d*)$/, '')} (${s.winner})`, wt.branch]);
  } catch (e) {
    let files = [];
    try { files = gitIn(cfg.root, ['diff', '--name-only', '--diff-filter=U']).trim().split('\n').filter(Boolean); } catch { /* none */ }
    try { gitIn(cfg.root, ['merge', '--abort']); } catch { /* nothing to abort */ }
    return { status: 'conflict', branch: wt.branch, files, why: files.length ? `conflict in ${files.join(', ')}` : (e.stderr?.toString().trim() || e.message).split('\n')[0] };
  }
  const head = gitIn(cfg.root, ['rev-parse', '--short', 'HEAD']).trim();
  const v = s.verify?.status === 'SKIPPED' && !detectVerify(cfg.root, cfg.settings || {}) ? { status: 'SKIPPED' }
    : (emit?.({ type: 'verify' }), await runVerify(cfg.root, cfg.settings || {}, s.runDir ? path.join(cfg.root, s.runDir, 'merged-verify.log') : undefined));
  if (v.status === 'FAIL') return { status: 'verify-failed', branch: wt.branch, commit: head, cmd: v.cmd, tail: v.tail, log: v.log };
  if (!keepWorktree) removeWorktree(cfg.root, wt.id);
  return { status: 'merged', branch: wt.branch, commit: head, verify: v.status };
}

/** Set `status: done` for these tasks in the plan and commit it when the plan is tracked. → the ids changed. */
export function markDone(root, planPath, ids) {
  const abs = path.resolve(root, planPath);
  const before = fs.readFileSync(abs, 'utf8');
  let text = before;
  const changed = [];
  for (const id of ids) { const next = setTaskStatus(text, id, 'done'); if (next !== text) { text = next; changed.push(id); } }
  if (!changed.length) return [];
  fs.writeFileSync(abs, text);
  try {
    gitIn(root, ['ls-files', '--error-unmatch', planPath]);
    gitIn(root, ['commit', '-q', '-m', `conductor: ${changed.join(', ')} done in ${planPath}`, '--', planPath]);
  } catch { /* untracked or ignored plan: the edit stays in the file */ }
  return changed;
}

export async function runBatch(cfg, { planPath, tasks, role, provider, concurrency, noVerify, allowUnverified, allowScope, allowWeakPlan, noEscalate, allowNoRepro, review, noReview, replace, note, allowOpenQuestions, timeoutMs, priority, all, merge, onEvent }) {
  merge = merge || all; // --all schedules by depends, which needs each task merged before its dependents start
  if (merge) assertCleanCheckout(cfg.root);
  const { items, warnings } = planBatch(cfg, { planPath, tasks, role, allowOpenQuestions, allowWeakPlan, all, merge });
  const work = spreadChains(cfg, items, { provider, priority });
  const limit = Math.max(1, Math.min(Number(concurrency) || 4, work.length));
  const results = new Array(work.length);
  const prio = priority || cfg.settings?.priority || 'balanced';
  if (prio === 'speed') {
    const routes = [...new Set(work.flatMap((t) => t.chain))].filter((n) => hedgeAllowed(cfg, n, 'speed'));
    if (routes.length < 2) warnings.push(`priority speed: ${routes.length} route(s) can take a second attempt (${routes.join(', ') || 'none'}); hedging needs 2. Add a free route (conductor providers --free) or enable another agent`);
  }
  // S1: hedge stragglers. Once a task in this batch has finished, a task still running past 1.5× the finished ones'
  // median (and at least hedgeAfterSec) gets a second attempt on the idle route its priority allows that is expected to
  // be fastest for a task this size. Later, a route that becomes idle and is expected to be clearly faster (by
  // hedgeFaster, 1.5×) than every route already trying gets one more (up to hedgeMax attempts in all). The first
  // attempt that passes every check wins and the others are stopped. The slowest worker no longer sets the wave's time.
  const finished = [], running = new Map();
  const minSec = Number(cfg.settings?.hedgeAfterSec ?? 45);
  const maxTries = Math.max(2, Number(cfg.settings?.hedgeMax ?? 3));
  const faster = Number(cfg.settings?.hedgeFaster ?? 1.5);
  // the workers each open attempt is on now (an attempt moves on when a worker fails or hands its work on; a race runs
  // several at once), so the monitor judges the worker that is actually working, not the one the attempt started on
  const working = (x) => [...new Set(x.working.size ? x.working.values() : [x.provider])];
  const busy = () => new Set([...running.values()].flatMap((r) => r.tries.filter((x) => !x.result).flatMap(working)));
  const monitor = prio === 'save' || cfg.settings?.hedge === false ? null : setInterval(() => {
    if (!finished.length) return;
    const sorted = [...finished].sort((a, b) => a - b);
    const limitMs = Math.max(minSec * 1000, 1.5 * sorted[Math.floor(sorted.length / 2)]);
    for (const r of running.values()) {
      if (r.done || Date.now() - r.start < limitMs || r.tries.length >= maxTries) continue;
      const taken = busy();
      const tried = new Set(r.tries.flatMap((x) => [x.provider, ...x.seen]));
      const free = r.chain.filter((n) => !tried.has(n) && !taken.has(n) && hedgeAllowed(cfg, n, prio));
      if (!free.length) continue;
      const secs = expectedSeconds(speedStats(r.chain, r.role, { size: r.size }), r.chain);
      const best = free.reduce((x, y) => (secs(y) < secs(x) ? y : x));
      // the first hedge goes to the fastest idle route; another only to one clearly faster than every route trying
      const trying = r.tries.filter((x) => !x.result).flatMap(working).map((n) => secs(n));
      if (r.tries.length === 1 || secs(best) * faster <= Math.min(...trying)) r.startHedge(best);
    }
  }, Number(cfg.settings?.hedgeCheckMs ?? 2000));
  monitor?.unref?.();
  const runOne = async (t, emit) => {
    const base = { role: t.role, planPath, taskId: t.id, priority: prio, deferReview: true, note, noVerify, allowUnverified, allowScope, allowWeakPlan, noEscalate, allowNoRepro, review, noReview, timeoutMs, worktree: true, replace, allowOpenQuestions, onEvent: emit };
    const size = taskSize({ role: t.role, mode: 'write', body: t.section || '', files: t.files || [] }).size;
    const r = { start: Date.now(), primary: t.chain[0], chain: t.chain, role: t.role, size, tries: [], done: false };
    running.set(t.id, r);
    let wake = () => {}; // resolves the wait below when a hedge starts
    const launch = (provider, extra, wtId) => {
      const stop = new AbortController();
      const x = { provider, wtId, stop, at: Date.now(), result: null, working: new Map(), seen: new Set() };
      const track = (e) => { if (e.type === 'try' && e.provider) { x.working.set(e.sample || 0, e.provider); x.seen.add(e.provider); } emit(e); };
      x.p = dispatch(cfg, { ...base, worktreeId: wtId, signal: stop.signal, ...extra, onEvent: track }).then((s) => ({ s }), (e) => ({ e })).then((res) => { x.result = res; return x; });
      r.tries.push(x);
      wake();
    };
    launch(t.chain[0], { chain: t.chain }, t.id);
    r.startHedge = (to) => {
      emit({ type: 'hedge', provider: to, from: r.primary });
      launch(to, { chain: [to], noReview: true, noEscalate: true, race: false }, `${t.id}-h${r.tries.length > 1 ? r.tries.length : ''}`);
    };
    const passed = (x) => !!x.result?.s && outcome(x.result.s) === 'done';
    let win = null;
    for (;;) {
      const open = r.tries.filter((x) => !x.result);
      if (!open.length) break;
      const added = new Promise((res) => { wake = res; });
      const x = await Promise.race([...open.map((y) => y.p), added]);
      if (x && passed(x)) { win = x; break; }
    }
    r.done = true; // no hedge starts after this point
    const primary = r.tries[0];
    // nothing passed every check: the original attempt's result stands (a hedge's, if the original threw)
    if (!win) win = primary.result.e ? r.tries.find((x) => x.result.s) || primary : primary;
    if (r.tries.length > 1) {
      for (const x of r.tries) if (x !== win) x.stop.abort();
      await Promise.allSettled(r.tries.map((x) => x.p));
      // a loser's worktree: its own id, or the one its run ended in (a race attempt's T4-s1)
      for (const x of r.tries) if (x !== win) for (const id of new Set([x.wtId, x.result?.s?.worktree?.id].filter(Boolean))) { try { removeWorktree(cfg.root, id, { force: true }); } catch { /* already gone */ } }
      const hedges = r.tries.slice(1);
      if (win.result.s) win.result.s.hedged = { from: r.primary, to: hedges.map((x) => x.provider).join(', '), won: win.result.s.winner || win.provider, afterSec: Math.round((hedges[0].at - r.start) / 1000),
        tries: hedges.map((x) => ({ provider: x.provider, afterSec: Math.round((x.at - r.start) / 1000) })) };
      emit({ type: 'hedge-won', provider: win.result.s?.winner || win.provider });
    }
    running.delete(t.id);
    finished.push(Date.now() - r.start);
    if (win.result.e) throw win.result.e;
    return win.result.s;
  };
  // S2/S3: tasks start when their in-batch dependencies are merged; with merge, conductor merges each task that passed
  // (one at a time, in the order they finish), runs verify on the merged result, and stops at the first conflict or
  // failing verify. Without merge, tasks are independent (planBatch refused dependencies) and all start at once.
  const accepts = (r) => r.summary && (outcome(r.summary) === 'done' || (outcome(r.summary) === 'unverified' && !unverifiedBlocks(r.summary, { allowUnverified: allowUnverified || cfg.settings?.allowUnverified })));
  const state = Object.fromEntries(work.map((t) => [t.id, 'pending']));
  const ids = new Set(work.map((t) => t.id));
  let active = 0, merging = Promise.resolve(), mergesPending = 0, stop = null;
  const reviews = [];
  const doMerge = async (i, keepWorktree) => {
    const r = results[i], t = work[i];
    if (stop) { r.merge = { status: 'not-merged', why: `stopped after ${stop}` }; state[t.id] = 'failed'; return; }
    try {
      r.merge = await mergeTask(cfg, r.summary, { emit: (e) => onEvent?.({ ...e, task: t.id }), keepWorktree });
    } catch (e) { r.merge = { status: 'error', why: e.message }; }
    if (r.merge.status === 'merged' || r.merge.status === 'no-changes') state[t.id] = 'merged';
    else { state[t.id] = 'failed'; stop = `${t.id}'s merge (${r.merge.status})`; }
  };
  await new Promise((done) => {
    const pump = () => {
      for (let i = 0; i < work.length; i++) {
        const t = work[i];
        if (state[t.id] !== 'pending') continue;
        const deps = t.deps.filter((d) => ids.has(d));
        if (stop || deps.some((d) => state[d] === 'failed' || state[d] === 'blocked')) {
          state[t.id] = 'blocked';
          const why = stop ? `not started: the batch stopped after ${stop}` : `not started: ${deps.filter((d) => state[d] !== 'merged').join(', ')} did not pass and merge`;
          results[i] = { task: t.id, role: t.role, error: why, blocked: true };
          onEvent?.({ type: 'done', task: t.id, outcome: 'blocked' });
          continue;
        }
        if (active >= limit || !deps.every((d) => state[d] === 'merged')) continue;
        state[t.id] = 'running'; active++;
        const emit = (e) => onEvent?.({ ...e, task: t.id });
        emit({ type: 'start', provider: t.chain[0] });
        runOne(t, emit).then((s) => { results[i] = { task: t.id, role: t.role, summary: s }; }, (e) => { results[i] = { task: t.id, role: t.role, error: e.message }; })
          .then(() => {
            active--;
            emit({ type: 'done', outcome: results[i].summary ? outcome(results[i].summary) : 'failed' });
            // S4: the review (advisory) runs now that the worker's slot is free. Under speed the merge doesn't wait for
            // it (the worktree stays until it reports); otherwise only this task's merge waits, other tasks go on.
            const s = results[i].summary;
            const rv = s?.reviewLater ? s.reviewLater() : null;
            if (rv) reviews.push(rv);
            if (merge && accepts(results[i])) {
              mergesPending++;
              const holdMerge = rv && prio !== 'speed';
              (holdMerge ? rv : Promise.resolve()).then(() => {
                merging = merging.then(() => doMerge(i, !!rv && !holdMerge)).finally(() => { mergesPending--; pump(); });
                if (rv && !holdMerge) rv.then(() => merging).then(() => { const id = s.worktree?.id; if (id && ['merged', 'no-changes'].includes(results[i].merge?.status)) removeWorktree(cfg.root, id, { force: results[i].merge.status === 'no-changes' }); });
              });
            }
            else state[t.id] = merge ? 'failed' : 'finished';
            pump();
          });
      }
      if (!active && !mergesPending && !Object.values(state).some((x) => x === 'pending' || x === 'running')) done();
      else if (!active && !mergesPending && Object.values(state).every((x) => x !== 'running')) {
        // nothing running and nothing can start: whatever is still pending waits on something that never comes
        for (let i = 0; i < work.length; i++) if (state[work[i].id] === 'pending') { state[work[i].id] = 'blocked'; results[i] = { task: work[i].id, role: work[i].role, error: 'not started: its dependencies never merged', blocked: true }; }
        done();
      }
    };
    pump();
  });
  if (monitor) clearInterval(monitor);
  await Promise.allSettled(reviews);
  await merging;
  // conductor marks merged tasks done in the plan (one commit), so the controller doesn't spend turns on it
  let marked = [];
  if (merge && cfg.settings?.markDone !== false) {
    marked = results.filter((r) => r.merge?.status === 'merged' || r.merge?.status === 'no-changes').map((r) => r.task);
    if (marked.length) marked = markDone(cfg.root, planPath, marked);
  }
  for (const r of results) r.outcome = r.summary ? outcome(r.summary) : 'failed';
  const ok = results.filter((r) => r.outcome === 'done').length;
  const partial = results.filter((r) => r.outcome === 'partial').length;
  const unverified = results.filter((r) => r.outcome === 'unverified').length;
  const outOfScope = results.filter((r) => r.outcome === 'out-of-scope').length;
  // unverified work fails the batch too, unless the caller skipped or allowed it
  const accepted = ok + results.filter((r) => r.outcome === 'unverified' && !unverifiedBlocks(r.summary, { allowUnverified: allowUnverified || cfg.settings?.allowUnverified })).length;
  const merged = merge ? results.filter((r) => r.merge?.status === 'merged' || r.merge?.status === 'no-changes').length : undefined;
  const blocked = results.filter((r) => r.blocked).length;
  return { plan: planPath, warnings, results, ok, partial, unverified, outOfScope, blocked, failed: results.length - ok - partial - unverified - outOfScope - blocked, merge: !!merge, merged, marked, stopped: stop,
    exitCode: accepted === results.length && (!merge || merged === results.length) ? 0 : 3 };
}

export function formatBatch(b) {
  const L = ['', '===================== CONDUCTOR BATCH =====================', `plan:      ${b.plan}`];
  for (const w of b.warnings) L.push(`WARNING:   ${w}`);
  for (const r of b.results) {
    const s = r.summary;
    if (!s) { L.push(`${r.task.padEnd(6)} ${r.blocked ? '·' : '✗'} ${r.error}`); continue; }
    if (!s.winner) { L.push(`${r.task.padEnd(6)} ✗ every provider failed: ${s.attempts.map((a) => `${a.provider}${a.model ? `[${a.model}]` : ''}(${a.reason})`).join(' → ')}`); continue; }
    const v = s.verify ? `verify ${s.verify.status}` : 'not verified';
    const c = s.worktree.commit ? `${s.worktree.commit} on ${s.worktree.branch}` : 'no changes';
    const mark = { done: '✓', partial: '⚠', 'out-of-scope': '⚠', unverified: '?', 'verify-failed': '✗' }[r.outcome] || '✓';
    const why = r.outcome === 'partial' ? ` · ${(s.status || '').replace(/^#+\s*/, '')}` : r.outcome === 'out-of-scope' ? ` · outside its files: ${s.scope.outside.join(', ')}` : '';
    L.push(`${r.task.padEnd(6)} ${mark} ${s.winner} · ${v}${s.verify?.scope === 'task' ? ' (task)' : ''} · ${c} · ${s.changed.length} file(s)${why}`);
    if (r.merge) L.push(`         ${{ merged: `merged: ${r.merge.commit}${r.merge.verify === 'PASS' ? ', verify passed on the merged code' : r.merge.verify === 'SKIPPED' ? ', no verify command' : ''}`, 'no-changes': 'nothing to merge (no changes)',
      conflict: `NOT MERGED: ${r.merge.why}. Merge it yourself: git merge --no-ff ${r.merge.branch}`, 'verify-failed': `MERGED as ${r.merge.commit}, but verify FAILED on the merged code (${r.merge.cmd}); the batch stopped. Fix it, or undo: git reset --hard HEAD~1`,
      'not-merged': `not merged: ${r.merge.why}`, error: `merge failed: ${r.merge.why}` }[r.merge.status]}`);
    const rv = s.review;
    if (rv?.skipped) L.push(`         review: not done (${rv.skipped})`);
    else if (rv?.reviewer) L.push(`         review: ${rv.reviewer}: ${rv.verdict || 'no verdict'}, ${rv.findings.length} finding(s) (advisory${rv.report ? `; ${rv.report}` : ''})`);
    if (s.hedged) L.push(`         hedged: ${s.hedged.from} was slow, so ${(s.hedged.tries || [{ provider: s.hedged.to, afterSec: s.hedged.afterSec }]).map((x) => `${x.provider} (after ${x.afterSec} s)`).join(', then ')} also tried it; ${s.hedged.won} won`);
    for (const w of s.warnings) L.push(`         WARNING: ${w}`);
  }
  L.push(`result:    ${b.merge ? `${b.merged}/${b.results.length} merged · ` : ''}${b.ok} done, ${b.partial ? `${b.partial} partial, ` : ''}${b.outOfScope ? `${b.outOfScope} out of scope, ` : ''}${b.unverified ? `${b.unverified} unverified, ` : ''}${b.failed} failed${b.blocked ? `, ${b.blocked} not started` : ''}`);
  if (b.marked?.length) L.push(`plan:      marked ${b.marked.join(', ')} status: done in the plan`);
  if (b.stopped) L.push(`stopped:   after ${b.stopped}; tasks after it were not started or merged`);
  if (b.results.some((r) => r.summary?.verify?.scope === 'task')) L.push('verify:    "(task)" = the task\'s own verify line from the plan; run `conductor verify` after merging');
  if (b.merge) L.push(b.merged === b.results.length ? 'next:      everything is merged into your branch. Review it: git log --oneline, git diff <start>..HEAD' : 'next:      merged tasks are on your branch; for the rest see their lines above.');
  else L.push('next:      for each ✓: review `conductor diff conductor/<id>`, then `git merge --no-ff conductor/<id>`; afterwards `conductor worktree rm <id>` (or run the batch with --merge).');
  if (b.results.some((r) => r.summary?.hedged && /-h\d*$/.test(r.summary.worktree?.id || ''))) L.push('           A hedged task that the second attempt won lives on conductor/<id>-h… (the branch on its line).');
  if (b.unverified) L.push('           For each ?: no verify ran, so nothing proves it works. Set a verify command (conductor init --verify "<cmd>"), or check it yourself before merging.');
  if (b.partial) L.push('           For each ⚠: the worker did only part of it. Read its report.md, then finish it or retry the rest.');
  if (b.failed || b.results.some((r) => r.merge && !['merged', 'no-changes'].includes(r.merge.status))) L.push('           For each ✗: retry it alone with `conductor run <role> --plan … --task <id> --worktree --provider <other>`, or do it yourself.');
  return L.join('\n');
}
