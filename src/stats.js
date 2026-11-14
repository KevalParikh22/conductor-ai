// `conductor stats --failures`: why work fails, biggest cause first, so the harness is fixed where it matters
// (the trace-driven loop: look at failures, group them, fix the top group, measure with conductor eval).
import { readUsage } from './usage.js';
import { listRuns } from './runs.js';

/** One label per kind of attempt failure: "exit 1" and "exit 2" are the same kind; details after ":" are dropped. */
export function failureKind(reason) {
  const r = String(reason || 'unknown').toLowerCase();
  if (/^quota|rate.?limit|429/.test(r)) return 'rate limit / quota';
  if (/^timeout/.test(r)) return 'time limit';
  if (/^idle/.test(r)) return 'no output (idle)';
  if (/^denied/.test(r)) return 'refused an action (needs an allow rule)';
  if (/^empty output/.test(r)) return 'empty answer';
  if (/no file blocks|only protected/.test(r)) return 'chat answer had no usable files';
  if (/^not installed/.test(r)) return 'not installed';
  if (/^exit \d+/.test(r)) return 'exited with an error';
  if (/^server 5|^http 5/.test(r)) return 'provider server error';
  if (/cooling down|skipped/.test(r)) return 'skipped (cooling down)';
  return r.split(/[:(]/)[0].replace(/\d+/g, 'N').trim() || 'unknown';
}

/** Why runs in this project weren't done: outcome plus the cause conductor recorded. */
function runCause(r) {
  if (r.state === 'failed') return 'every provider failed';
  if (r.state === 'verify-failed') return r.baseFailed ? 'verify failed (already failing before the worker)' : 'verify failed';
  if (r.state === 'partial') return r.acceptance && (!r.acceptance.answered || r.acceptance.met < r.acceptance.total) && !/PARTIAL|BLOCKED/i.test(r.status || '')
    ? (r.acceptance.answered ? 'acceptance criteria not all met' : 'acceptance criteria not answered') : 'worker reported PARTIAL/BLOCKED';
  if (r.state === 'out-of-scope') return 'changed files outside the task';
  if (r.state === 'unverified') return 'no verify ran';
  return null;
}

export function failureStats({ root, days = 30 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const attempts = new Map();
  let total = 0;
  for (const e of readUsage(since)) {
    if (e.kind === 'saving') continue;
    total++;
    if (e.ok) continue;
    const k = failureKind(e.reason);
    const a = attempts.get(k) || { kind: k, count: 0, providers: {} };
    a.count++; a.providers[e.provider] = (a.providers[e.provider] || 0) + 1;
    attempts.set(k, a);
  }
  const runs = root ? listRuns(root, { limit: 500 }).filter((r) => r.state !== 'running' && (!r.startedAt || Date.parse(r.startedAt) >= since)) : [];
  const causes = new Map();
  for (const r of runs) {
    const c = runCause(r);
    if (!c) continue;
    const x = causes.get(c) || { cause: c, count: 0, examples: [] };
    x.count++; if (x.examples.length < 3) x.examples.push(r.id);
    causes.set(c, x);
  }
  const warnings = new Map();
  for (const r of runs) for (const w of r.warnings || []) {
    const k = w.replace(/\b\S+\.(js|ts|php|py|md|json)\b/g, '<file>').replace(/\d+/g, 'N').split(/[:.(]/)[0].slice(0, 90);
    warnings.set(k, (warnings.get(k) || 0) + 1);
  }
  const sortDesc = (m, key = 'count') => [...m.values()].sort((a, b) => b[key] - a[key]);
  return {
    days, attemptsTotal: total, attemptsFailed: [...attempts.values()].reduce((t, a) => t + a.count, 0),
    attempts: sortDesc(attempts), runsTotal: runs.length, runsNotDone: [...causes.values()].reduce((t, c) => t + c.count, 0),
    causes: sortDesc(causes), warnings: [...warnings.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count).slice(0, 8),
  };
}

export function formatFailureStats(st) {
  const L = [`Failures in the last ${st.days} days, biggest cause first.`, ''];
  L.push(`Runs in this project: ${st.runsTotal}, not done: ${st.runsNotDone}`);
  if (!st.causes.length) L.push('  (none)');
  for (const c of st.causes) L.push(`  ${String(c.count).padStart(4)}  ${c.cause}   e.g. ${c.examples[0]}`);
  L.push('', `Worker attempts (all projects): ${st.attemptsTotal}, failed: ${st.attemptsFailed}`);
  if (!st.attempts.length) L.push('  (none)');
  for (const a of st.attempts) L.push(`  ${String(a.count).padStart(4)}  ${a.kind.padEnd(42)} ${Object.entries(a.providers).sort((x, y) => y[1] - x[1]).map(([p, n]) => `${p} ${n}`).join(', ')}`);
  if (st.warnings.length) {
    L.push('', 'Most common warnings:');
    for (const w of st.warnings) L.push(`  ${String(w.count).padStart(4)}  ${w.text}`);
  }
  L.push('', 'Fix the top cause first, then measure the change with: conductor eval run');
  return L.join('\n');
}

/**
 * Q10: is conductor delivering? From this project's runs: how often a write task was accepted on the first try with
 * proof (done, one worker, no hand-off or retry), where the rest ended, and what the workers cost. The alpha gate is
 * a first-try accept rate of 70% or more over at least 10 write tasks.
 */
export function qualityStats({ root, days = 30 } = {}) {
  const since = Date.now() - days * 86_400_000;
  const runs = listRuns(root, { limit: 1000 }).filter((r) => r.state !== 'running' && (!r.startedAt || Date.parse(r.startedAt) >= since));
  const write = runs.filter((r) => r.mode === 'write' || ['build', 'fix', 'test', 'docs'].includes(r.role));
  const firstTry = write.filter((r) => r.state === 'done' && r.attempts.length === 1 && !r.handedOn && !r.continued);
  const outcomes = {};
  for (const r of write) outcomes[r.state] = (outcomes[r.state] || 0) + 1;
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const gate = write.length >= 10 ? (pct(firstTry.length, write.length) >= 70 ? 'met' : 'not met') : `needs ${10 - write.length} more write task(s)`;
  return {
    days, runs: runs.length, writeTasks: write.length,
    firstTry: firstTry.length, firstTryRate: pct(firstTry.length, write.length),
    done: outcomes.done || 0, doneRate: pct(outcomes.done || 0, write.length), outcomes,
    handedOn: write.filter((r) => r.handedOn).length, retried: write.filter((r) => r.continued).length,
    fallbacks: write.filter((r) => r.attempts.length > 1).length,
    workerTokens: runs.reduce((t, r) => t + (r.tokens || 0), 0),
    workerCost: Math.round(runs.reduce((t, r) => t + (r.cost || 0), 0) * 10000) / 10000,
    contextKeptOut: runs.reduce((t, r) => t + (r.tokensSaved || 0), 0),
    workerMinutes: Math.round(runs.reduce((t, r) => t + (r.seconds || 0), 0) / 60),
    gate,
  };
}

export function formatQualityStats(q) {
  const L = [`Last ${q.days} days in this project: ${q.runs} runs, ${q.writeTasks} write tasks.`, ''];
  if (!q.writeTasks) return [...L, 'No write tasks yet. Run some (conductor run build …), then check again.'].join('\n');
  L.push(`accepted first try   ${q.firstTry}/${q.writeTasks} = ${q.firstTryRate}%   (done, one worker, no hand-off or retry)`);
  L.push(`done in the end      ${q.done}/${q.writeTasks} = ${q.doneRate}%`);
  L.push(`outcomes             ${Object.entries(q.outcomes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  L.push(`help needed          ${q.fallbacks} fell back to another worker · ${q.handedOn} handed on after failing checks · ${q.retried} retried with a note`);
  L.push(`worker cost          ${q.workerTokens.toLocaleString()} tokens${q.workerCost ? ` · $${q.workerCost}` : ''} · ${q.workerMinutes} worker-minutes`);
  L.push(`context kept out     ~${q.contextKeptOut.toLocaleString()} tokens (estimate: trimmed reports, compact diffs, free-model picks)`);
  L.push('', `alpha gate (≥70% first try over ≥10 write tasks): ${q.gate}`);
  L.push('Why the rest failed: conductor stats --failures');
  return L.join('\n');
}

/**
 * The trend for the Overview: the first-try accept rate per week (Monday to Sunday) for the last `weeks` weeks, oldest
 * first. → [{ week: 'YYYY-MM-DD' (its Monday), writeTasks, firstTry, rate (null when there were none) }]
 */
export function qualityTrend({ root, weeks = 6, now = Date.now() } = {}) {
  const monday = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const start = monday(now) - (weeks - 1) * 7 * 86_400_000;
  const out = Array.from({ length: weeks }, (_, i) => ({ at: start + i * 7 * 86_400_000, writeTasks: 0, firstTry: 0 }));
  for (const r of listRuns(root, { limit: 2000 })) {
    if (r.state === 'running' || !r.startedAt) continue;
    if (!(r.mode === 'write' || ['build', 'fix', 'test', 'docs'].includes(r.role))) continue;
    const i = Math.floor((monday(Date.parse(r.startedAt)) - start) / (7 * 86_400_000));
    if (i < 0 || i >= weeks) continue;
    out[i].writeTasks++;
    if (r.state === 'done' && r.attempts.length === 1 && !r.handedOn && !r.continued) out[i].firstTry++;
  }
  return out.map((w) => ({ week: (() => { const d = new Date(w.at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })(), writeTasks: w.writeTasks, firstTry: w.firstTry, rate: w.writeTasks ? Math.round((w.firstTry / w.writeTasks) * 100) : null }));
}
