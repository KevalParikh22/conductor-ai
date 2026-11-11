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
