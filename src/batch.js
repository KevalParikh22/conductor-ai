// `conductor batch`: run several independent plan tasks at the same time, each in its own worktree,
// spreading them across different providers so no single quota takes all the load.
import fs from 'node:fs';
import path from 'node:path';
import { ROLES } from './presets.js';
import { dispatch, extractTask, taskFiles, resolveChain, UsageError } from './core.js';

const field = (section, name) => (section.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, 'i')) || [])[1]?.trim() || '';

/** Read and check the tasks before anything runs. */
export function planBatch(cfg, { planPath, tasks, role }) {
  const planAbs = path.resolve(cfg.root, planPath || '');
  if (!planPath || !fs.existsSync(planAbs)) throw new UsageError(`plan not found: ${planPath || '(none given)'}`);
  if (!tasks?.length) throw new UsageError('batch needs --tasks T1,T2,...');
  const planText = fs.readFileSync(planAbs, 'utf8');
  const ids = [...new Set(tasks)];
  const items = ids.map((id) => {
    const section = extractTask(planText, id);
    if (!section) throw new UsageError(`task "${id}" not found in ${planPath}`);
    const r = role || field(section, 'role').split(/[\s|,]/)[0] || 'build';
    if (r === 'controller') throw new UsageError(`${id} is a controller task: do it yourself, not in a batch`);
    if (!ROLES[r] || ROLES[r].mode !== 'write') throw new UsageError(`${id}: role "${r}" can't run in a batch (use build, fix, test or docs)`);
    const deps = field(section, 'depends on').split(/[\s,]+/).filter((d) => /^T?\w+$/.test(d) && d !== '-' && !/^none$/i.test(d));
    return { id, role: r, files: taskFiles(section), deps };
  });
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
 * provider in that role's chain, and keeps the rest of the chain as its fallback.
 */
export function spreadChains(cfg, items, { provider } = {}) {
  const seen = {};
  return items.map((t) => {
    const resolved = resolveChain(cfg, t.role, { provider });
    const names = resolved.map((c) => c.name);
    const ready = resolved.filter((c) => !c.skip).map((c) => c.name);
    const n = seen[t.role] = (seen[t.role] ?? -1) + 1;
    if (!ready.length || provider) return { ...t, chain: names };
    const first = ready[n % ready.length];
    return { ...t, chain: [first, ...names.filter((x) => x !== first)] };
  });
}

/** Run tasks with at most `concurrency` at once. Results come back in task order. */
export async function runBatch(cfg, { planPath, tasks, role, provider, concurrency, noVerify, replace, note, onEvent }) {
  const { items, warnings } = planBatch(cfg, { planPath, tasks, role });
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
          role: t.role, planPath, taskId: t.id, chain: t.chain, note, noVerify,
          worktree: true, worktreeId: t.id, replace, onEvent: emit,
        });
        results[i] = { task: t.id, role: t.role, summary: s };
      } catch (e) {
        results[i] = { task: t.id, role: t.role, error: e.message };
      }
      emit({ type: 'done' });
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  const ok = results.filter((r) => r.summary?.winner).length;
  return { plan: planPath, warnings, results, ok, failed: results.length - ok, exitCode: ok === results.length ? 0 : 3 };
}

export function formatBatch(b) {
  const L = ['', '===================== CONDUCTOR BATCH =====================', `plan:      ${b.plan}`];
  for (const w of b.warnings) L.push(`WARNING:   ${w}`);
  for (const r of b.results) {
    const s = r.summary;
    if (!s) { L.push(`${r.task.padEnd(6)} ✗ ${r.error}`); continue; }
    if (!s.winner) { L.push(`${r.task.padEnd(6)} ✗ every provider failed: ${s.attempts.map((a) => `${a.provider}(${a.reason})`).join(' → ')}`); continue; }
    const v = s.verify ? `verify ${s.verify.status}` : 'not verified';
    const c = s.worktree.commit ? `${s.worktree.commit} on ${s.worktree.branch}` : 'no changes';
    L.push(`${r.task.padEnd(6)} ✓ ${s.winner} · ${v}${s.verify?.scope === 'task' ? ' (task)' : ''} · ${c} · ${s.changed.length} file(s)`);
    for (const w of s.warnings) L.push(`         WARNING: ${w}`);
  }
  L.push(`result:    ${b.ok} done, ${b.failed} failed`);
  if (b.results.some((r) => r.summary?.verify?.scope === 'task')) L.push('verify:    "(task)" = the task\'s own verify line from the plan; run `conductor verify` after merging');
  L.push('next:      for each ✓: review `git diff HEAD...conductor/<id>`, then `git merge --no-ff conductor/<id>`; afterwards `conductor worktree rm <id>`.');
  L.push('           For each ✗: retry it alone with `conductor run <role> --plan … --task <id> --worktree --provider <other>`, or do it yourself.');
  return L.join('\n');
}
