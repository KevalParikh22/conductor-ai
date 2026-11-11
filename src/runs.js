// Run history: every dispatch leaves .conductor/runs/<stamp>-<role>[-task]/summary.json in the project.
// `conductor runs` and the UI's Runs page read them back.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_DIRNAME } from './config.js';
import { readJSON } from './util.js';
import { outcome } from './core.js';

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
      outside: s.scope?.outside || [],
      base: s.base?.status || null,
      attempts: tried.map((a) => ({ provider: a.provider, model: a.model, ok: a.ok, reason: a.reason, seconds: a.seconds })),
      seconds: Math.round(tried.reduce((t, a) => t + (a.seconds || 0), 0)),
      cost: known.length ? known.reduce((t, a) => t + a.cost, 0) : null,
      branch: s.worktree?.commit ? s.worktree.branch : null,
      why: s.route || s.selector || null, // why this worker went first
      tokensSaved: s.tokensSaved?.tokens || 0,
      report: s.report,
    };
  });
}

/** Full summary.json of one run (id, or a unique prefix of it). */
export function readRun(root, id) {
  let dirs = [];
  try { dirs = fs.readdirSync(runsDir(root)); } catch { /* none */ }
  const hit = dirs.filter((d) => d === id || d.startsWith(id));
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
    L.push(`${r.id.slice(0, 29).padEnd(30)}${({ done: '✓ done', partial: '⚠ partial', unverified: '? unverif', 'out-of-scope': '⚠ scope', 'verify-failed': '✗ verify' }[r.state] || '✗ failed').padEnd(10)}${(r.winner || '-').padEnd(18)}${(r.verify || '-').padEnd(8)}${String(r.changed).padStart(6)}${`${r.seconds}s`.padStart(7)}  ${notes}`);
  }
  L.push('', 'Details: conductor runs show <run>');
  return L.join('\n');
}
