// `conductor batch`: run several independent plan tasks at the same time, each in its own worktree,
// spreading them across different providers so no single quota takes all the load.
import fs from 'node:fs';
import path from 'node:path';
import { ROLES } from './presets.js';
import { checkTask } from './plancheck.js';
import { detectVerify } from './verify.js';
import { speedStats, expectedSeconds } from './selector.js';
import { dispatch, extractTask, taskFiles, resolveChain, chooseChain, openQuestions, UsageError, outcome, unverifiedBlocks } from './core.js';

const field = (section, name) => (section.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, 'i')) || [])[1]?.trim() || '';

/** Read and check the tasks before anything runs. */
export function planBatch(cfg, { planPath, tasks, role, allowOpenQuestions, allowWeakPlan }) {
  const planAbs = path.resolve(cfg.root, planPath || '');
  if (!planPath || !fs.existsSync(planAbs)) throw new UsageError(`plan not found: ${planPath || '(none given)'}`);
  if (!tasks?.length) throw new UsageError('batch needs --tasks T1,T2,...');
  const planText = fs.readFileSync(planAbs, 'utf8');
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
    if (inBatch.length) throw new UsageError(`${t.id} depends on ${inBatch.join(', ')} in the same batch. Run ${inBatch.join(', ')} first, merge, then batch the rest`);
  }
  const warnings = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const shared = items[i].files.filter((f) => items[j].files.includes(f));
      if (shared.length) warnings.push(`${items[i].id} and ${items[j].id} both list ${shared.join(', ')}: expect a merge conflict`);
    }
  }
  return { items, warnings };
}

/**
 * Give each task a different first provider where possible: task n of a role starts with the n-th ready
 * provider in that role's chain, and keeps the rest of the chain as its fallback. A task the plan or a route
 * assigns to a provider keeps that choice.
 */
export function spreadChains(cfg, items, { provider } = {}) {
  const seen = {};
  return items.map((t) => {
    if (!provider) {
      const own = chooseChain(cfg, t.role, { section: t.section || '', body: t.section || '', files: t.files || [] });
      if (own.how === 'plan' || own.how === 'route') return { ...t, chain: own.chain.map((c) => c.name), route: own.note };
    }
    if (provider) return { ...t, chain: resolveChain(cfg, t.role, { provider }).map((c) => c.name) };
    // this task's own order (the selector puts fast, reliable providers first for small tasks), then spread: at most
    // maxParallelPerProvider tasks start on one provider, so a wave isn't stacked on one slow agent and its quota
    const ordered = chooseChain(cfg, t.role, { section: t.section || '', body: t.section || '', files: t.files || [] }).chain;
    const names = ordered.map((c) => c.name);
    const ready = ordered.filter((c) => !c.skip).map((c) => c.name);
    if (!ready.length) return { ...t, chain: names };
    // the provider expected to finish this task soonest: its measured median time, plus half of it again for every
    // task it already has (they share its quota and machine). A provider with no history counts as average (so a new
    // or newly working one gets tasks and gets measured); a measured, unreliable one goes last
    const cap = cfg.settings?.maxParallelPerProvider ?? 2;
    const secs = expectedSeconds(speedStats(ready, t.role), ready);
    const eta = (n) => secs(n) * (1 + 0.5 * (seen[n] || 0));
    const open = ready.filter((n) => (seen[n] || 0) < cap);
    const pool = open.length ? open : ready;
    const first = pool.reduce((a, b) => (eta(b) < eta(a) ? b : a));
    seen[first] = (seen[first] || 0) + 1;
    return { ...t, chain: [first, ...names.filter((x) => x !== first)] };
  });
}

/** Run tasks with at most `concurrency` at once. Results come back in task order. */
export async function runBatch(cfg, { planPath, tasks, role, provider, concurrency, noVerify, allowUnverified, allowScope, allowWeakPlan, noEscalate, allowNoRepro, review, noReview, replace, note, allowOpenQuestions, timeoutMs, onEvent }) {
  const { items, warnings } = planBatch(cfg, { planPath, tasks, role, allowOpenQuestions, allowWeakPlan });
  const work = spreadChains(cfg, items, { provider });
  const limit = Math.max(1, Math.min(Number(concurrency) || 4, work.length));
  const results = new Array(work.length);
  let next = 0;
  const worker = async () => {
    while (next < work.length) {
      const i = next++;
      const t = work[i];
      const emit = (e) => onEvent?.({ ...e, task: t.id });
      emit({ type: 'start', provider: t.chain[0] });
      try {
        const s = await dispatch(cfg, {
          role: t.role, planPath, taskId: t.id, chain: t.chain, note, noVerify, allowUnverified, allowScope, allowWeakPlan, noEscalate, allowNoRepro, review, noReview, timeoutMs,
          worktree: true, worktreeId: t.id, replace, allowOpenQuestions, onEvent: emit,
        });
        results[i] = { task: t.id, role: t.role, summary: s };
      } catch (e) {
        results[i] = { task: t.id, role: t.role, error: e.message };
      }
      emit({ type: 'done' });
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  for (const r of results) r.outcome = r.summary ? outcome(r.summary) : 'failed';
  const ok = results.filter((r) => r.outcome === 'done').length;
  const partial = results.filter((r) => r.outcome === 'partial').length;
  const unverified = results.filter((r) => r.outcome === 'unverified').length;
  const outOfScope = results.filter((r) => r.outcome === 'out-of-scope').length;
  // unverified work fails the batch too, unless the caller skipped or allowed it
  const accepted = ok + results.filter((r) => r.outcome === 'unverified' && !unverifiedBlocks(r.summary, { allowUnverified: allowUnverified || cfg.settings?.allowUnverified })).length;
  return { plan: planPath, warnings, results, ok, partial, unverified, outOfScope, failed: results.length - ok - partial - unverified - outOfScope, exitCode: accepted === results.length ? 0 : 3 };
}

export function formatBatch(b) {
  const L = ['', '===================== CONDUCTOR BATCH =====================', `plan:      ${b.plan}`];
  for (const w of b.warnings) L.push(`WARNING:   ${w}`);
  for (const r of b.results) {
    const s = r.summary;
    if (!s) { L.push(`${r.task.padEnd(6)} ✗ ${r.error}`); continue; }
    if (!s.winner) { L.push(`${r.task.padEnd(6)} ✗ every provider failed: ${s.attempts.map((a) => `${a.provider}${a.model ? `[${a.model}]` : ''}(${a.reason})`).join(' → ')}`); continue; }
    const v = s.verify ? `verify ${s.verify.status}` : 'not verified';
    const c = s.worktree.commit ? `${s.worktree.commit} on ${s.worktree.branch}` : 'no changes';
    const mark = { done: '✓', partial: '⚠', 'out-of-scope': '⚠', unverified: '?', 'verify-failed': '✗' }[r.outcome] || '✓';
    const why = r.outcome === 'partial' ? ` · ${(s.status || '').replace(/^#+\s*/, '')}` : r.outcome === 'out-of-scope' ? ` · outside its files: ${s.scope.outside.join(', ')}` : '';
    L.push(`${r.task.padEnd(6)} ${mark} ${s.winner} · ${v}${s.verify?.scope === 'task' ? ' (task)' : ''} · ${c} · ${s.changed.length} file(s)${why}`);
    for (const w of s.warnings) L.push(`         WARNING: ${w}`);
  }
  L.push(`result:    ${b.ok} done, ${b.partial ? `${b.partial} partial, ` : ''}${b.outOfScope ? `${b.outOfScope} out of scope, ` : ''}${b.unverified ? `${b.unverified} unverified, ` : ''}${b.failed} failed`);
  if (b.results.some((r) => r.summary?.verify?.scope === 'task')) L.push('verify:    "(task)" = the task\'s own verify line from the plan; run `conductor verify` after merging');
  L.push('next:      for each ✓: review `conductor diff conductor/<id>`, then `git merge --no-ff conductor/<id>`; afterwards `conductor worktree rm <id>`.');
  if (b.unverified) L.push('           For each ?: no verify ran, so nothing proves it works. Set a verify command (conductor init --verify "<cmd>"), or check it yourself before merging.');
  if (b.partial) L.push('           For each ⚠: the worker did only part of it. Read its report.md, then finish it or retry the rest.');
  L.push('           For each ✗: retry it alone with `conductor run <role> --plan … --task <id> --worktree --provider <other>`, or do it yourself.');
  return L.join('\n');
}
