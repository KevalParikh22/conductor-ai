// Run history: every dispatch leaves .conductor/runs/<stamp>-<role>[-task]/summary.json in the project.
// `conductor runs` and the UI's Runs page read them back.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_DIRNAME } from './config.js';
import { readJSON } from './util.js';
import { outcome } from './core.js';
import { fixLines } from './nextsteps.js';
import { runGates, gatesPass, formatGates } from './rungates.js';
import { compactDiff } from './diffview.js';

export const runsDir = (root) => path.join(root, PROJECT_DIRNAME, 'runs');

/** One row per run, newest first. A run without summary.json is still going (or was killed). */
export function listRuns(root, { limit = 20 } = {}) {
  let dirs = [];
  try { dirs = fs.readdirSync(runsDir(root), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  dirs.sort().reverse();
  return dirs.slice(0, limit).map((id) => {
    const s = readJSON(path.join(runsDir(root), id, 'summary.json'), null);
    if (!s) return { id, state: 'running', role: id.split('-')[2] || '?' };
    const tried = s.attempts.filter((a) => !a.skipped);
    const known = s.attempts.filter((a) => a.cost != null);
    return {
      id,
      state: s.outcome || outcome(s), // done | partial | out-of-scope | unverified | verify-failed | failed
      startedAt: s.startedAt || null,
      role: s.role, task: s.task, plan: s.plan,
      winner: s.winner, model: s.model,
      status: s.status ? s.status.replace(/^#+\s*/, '') : null,
      verify: s.verify?.status || null,
      changed: s.changed?.length || 0,
      warnings: s.warnings || [],
      fixes: s.importedAs ? [] : fixLines(s.attempts || [], { won: !!s.winner }), // an answered manual run has nothing left to do
      validated: gatesPass(runGates(s)),
      outside: s.scope?.outside || [],
      base: s.base?.status || null,
      acceptance: s.acceptance ? { met: s.acceptance.met, total: s.acceptance.total, answered: s.acceptance.answered } : null,
      baseFailed: !!s.verify?.baseFailed,
      attempts: tried.map((a) => ({ provider: a.provider, model: a.model, ok: a.ok, reason: a.reason, next: a.next, seconds: a.seconds })),
      seconds: Math.round(tried.reduce((t, a) => t + (a.seconds || 0), 0)),
      cost: known.length ? known.reduce((t, a) => t + a.cost, 0) : null,
      branch: s.worktree?.commit ? s.worktree.branch : null,
      why: s.route || s.selector || null, // why this worker went first
      tokensSaved: s.tokensSaved?.tokens || 0,
      mode: s.mode || null,
      handedOn: (s.escalated || []).length,
      continued: !!s.worktree?.continued,
      tokens: s.attempts.reduce((t, a) => t + (a.tokens?.input || 0) + (a.tokens?.output || 0), 0),
      report: s.report,
    };
  });
}

/** Full summary.json of one run (id, or a unique prefix of it). */
export function readRun(root, id) {
  if (!id || /[\\/]/.test(id)) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(runsDir(root)); } catch { /* none */ }
  const hit = dirs.includes(id) ? [id] : dirs.filter((d) => d.startsWith(id)); // an exact id wins over its -2 sibling
  if (hit.length !== 1) return null;
  const s = readJSON(path.join(runsDir(root), hit[0], 'summary.json'), null);
  return s && { id: hit[0], summary: s };
}

export function formatRuns(rows) {
  if (!rows.length) return 'No runs yet in this project.';
  const L = [`${'run'.padEnd(30)}${'result'.padEnd(10)}${'worker'.padEnd(18)}${'verify'.padEnd(8)}${'files'.padStart(6)}${'time'.padStart(7)}  notes`];
  for (const r of rows) {
    if (r.state === 'running') { L.push(`${r.id.padEnd(30)}running…`); continue; }
    const notes = [r.branch && `branch ${r.branch}`, r.warnings.length && `${r.warnings.length} warning(s)`, r.cost && `$${r.cost.toFixed(4)}`].filter(Boolean).join(' · ');
    L.push(`${r.id.slice(0, 29).padEnd(30)}${({ done: '✓ done', partial: '⚠ partial', unverified: '? unverif', 'out-of-scope': '⚠ scope', 'verify-failed': '✗ verify', waiting: '… waiting', answered: '↳ answer' }[r.state] || '✗ failed').padEnd(10)}${(r.winner || '-').padEnd(18)}${(r.verify || '-').padEnd(8)}${String(r.changed).padStart(6)}${`${r.seconds}s`.padStart(7)}  ${notes}`);
    for (const f of r.fixes || []) L.push(`${''.padEnd(30)}fix: ${f}`);
  }
  L.push('', 'Details: conductor runs show <run>');
  return L.join('\n');
}

const tail = (root, rel, max) => {
  if (!rel) return null;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null; // never outside the project
  try { const t = fs.readFileSync(abs, 'utf8'); return t.length > max ? `…\n${t.slice(-max)}` : t; } catch { return null; }
};

/** Everything the run page shows: outcome, the checklist, attempts with next steps, report, logs, and the diff of a kept branch. */
export function runDetail(root, id) {
  const r = readRun(root, id);
  if (!r) return null;
  const s = r.summary;
  const gates = runGates(s);
  let diff = null;
  const wt = s.worktree;
  if (wt?.commit && wt.branch && wt.base) {
    try { const d = compactDiff(root, { range: `${wt.base}...${wt.branch}`, maxFileLines: 200 }); diff = d.empty ? '' : d.text; } catch { diff = null; }
  }
  return {
    id: r.id, role: s.role, task: s.task, plan: s.plan, startedAt: s.startedAt, mode: s.mode || null,
    state: outcome(s), validated: gatesPass(gates), gates,
    winner: s.winner, model: s.model, status: s.status, changed: s.changed || [], warnings: s.warnings || [],
    attempts: (s.attempts || []).map((a) => ({ provider: a.provider, model: a.model, ok: a.ok, reason: a.reason, next: a.next || '', seconds: a.seconds, tokens: a.tokens || null, skipped: !!a.skipped })),
    fixes: fixLines(s.attempts || [], { won: !!s.winner }),
    branch: wt?.commit ? wt.branch : null, worktreeId: wt?.id || null,
    report: tail(root, s.report, 20_000),
    waiting: s.waiting ? { ...s.waiting, importedAs: s.importedAs || null, promptText: s.importedAs ? null : tail(root, s.waiting.prompt, 400_000) } : null,
    logs: Object.fromEntries(gates.filter((g) => g.log).map((g) => [g.id, tail(root, g.log, 6_000)])),
    diff,
  };
}

export { formatGates, runGates };
