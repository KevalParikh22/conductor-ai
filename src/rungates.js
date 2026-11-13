// V4: "done" means validated. One checklist per run, built from summary.json: each gate with pass / fail / waived /
// skipped / missing and its evidence. The CLI (`conductor runs show`), MCP and the UI's run page all show this list.
// `required` gates must pass (or be waived on purpose) for the run to count as done; the rest are information.

const OK = new Set(['pass', 'waived', 'off']);

/** → [{ id, label, status, required, evidence, log? }] for one run summary. Gates that don't apply are left out. */
export function runGates(s) {
  const G = [];
  const write = s.mode ? s.mode === 'write' : ['build', 'fix', 'test', 'docs'].includes(s.role);
  const add = (id, label, status, evidence, extra = {}) => G.push({ id, label, status, required: true, evidence, ...extra });

  if (s.planGate) add('plan', 'Task ready to hand out (files, checks, size)', s.planGate.status, { pass: 'the plan task passed the plan gate', waived: 'skipped with --allow-weak-plan', off: 'planGate is off in settings' }[s.planGate.status]);

  if (!s.winner) {
    add('worker', 'A worker finished', 'fail', `every provider failed or was skipped: ${s.attempts.map((a) => `${a.provider} (${a.reason})`).join(', ') || 'none tried'}`);
    return G;
  }
  add('worker', 'A worker finished', 'pass', `${s.winner}${s.model ? ` (${s.model})` : ''}${s.attempts.length > 1 ? ` after ${s.attempts.length - 1} failed attempt(s)` : ''}`);

  if (write) {
    const rejected = s.attempts.filter((a) => a.guard);
    add('guard', 'Code parses, names and exports exist', 'pass', `checked on the kept code${rejected.length ? `; rejected earlier: ${rejected.map((a) => `${a.provider} (${a.reason})`).join(', ')}` : ''}`);
  }
  if (/RESULT:\s*\**\s*(PARTIAL|BLOCKED|FAILED|FAIL)\b/i.test(s.status || '')) add('result', 'Worker says it finished', 'fail', s.status);

  const a = s.acceptance;
  if (a) {
    const met = a.answered && a.met >= a.total;
    add('acceptance', 'Every acceptance criterion answered with evidence', a.waived ? 'waived' : met ? 'pass' : 'fail',
      a.waived ? `${a.met}/${a.total} met; not required` : !a.answered ? 'the report does not answer the criteria' : `${a.met}/${a.total} met${a.unmet?.length ? `; not met: ${a.unmet.slice(0, 4).join(' | ')}` : ''}`);
  }
  const c = s.checks;
  if (c) {
    add('checks', 'Acceptance checks pass when conductor runs them', c.failed?.length ? 'fail' : 'pass',
      `${c.passed}/${c.total} pass${c.failed?.length ? `; failing: ${c.failed.slice(0, 3).map((f) => `${f.expr} → ${f.got}`).join(' | ')}` : ''}${c.skipped?.length ? `; ${c.skipped.length} skipped` : ''}`);
  }

  const v = s.verify;
  if (write || v) {
    if (!v) add('verify', 'Verify passes', 'missing', 'no verify command, so nothing proves the code works: conductor init --verify "<cmd>"');
    else if (v.status === 'SKIPPED' && v.chosen) add('verify', 'Verify passes', 'skipped', `${v.note || 'skipped on purpose'}: check the work yourself`, { required: write });
    else if (v.status === 'SKIPPED') add('verify', 'Verify passes', write ? 'missing' : 'skipped', 'no verify command, so nothing proves the code works: conductor init --verify "<cmd>"', { required: write });
    else add('verify', 'Verify passes', v.status === 'PASS' ? 'pass' : 'fail',
      `\`${v.cmd}\` ${v.status}${v.baseFailed ? ` (it already failed before the worker started${v.newFailures?.length ? `; ${v.newFailures.length} new failure line(s)` : '; no new failure lines'})` : ''}${v.suspectTests?.length ? `; only the worker's own tests fail: ${v.suspectTests.join(', ')}` : ''}`,
      { required: write || v.status === 'FAIL', log: v.log || null });
  }
  if (s.base) G.push({ id: 'base', label: 'Verify on the starting commit', status: s.base.status === 'PASS' ? 'pass' : s.base.status === 'FAIL' ? 'fail' : 'skipped', required: false,
    evidence: `${s.base.status} at ${s.base.head || '?'}${s.base.cached ? ' (cached)' : ''}${s.base.status === 'FAIL' ? ': these failures are not the worker\'s' : ''}`, log: s.base.log || null });

  const sc = s.scope;
  if (sc) add('scope', 'Only the task\'s files changed', !sc.outside?.length ? 'pass' : sc.allowed ? 'waived' : 'fail',
    sc.outside?.length ? `outside the task: ${sc.outside.join(', ')}${sc.allowed ? ' (allowed with --allow-scope)' : ''}` : `${(s.changed || []).length} file(s), all listed`);

  const r = s.repro;
  if (r) {
    const st = r.waived ? 'waived' : r.ok === true ? 'pass' : r.ok === false ? 'fail' : 'unknown';
    const ev = r.cmd ? `\`${r.cmd}\` ${r.before || '?'} before${r.after ? `, ${r.after} after` : ''}`
      : r.tests ? `regression test ${r.tests.join(', ')}: ${r.proof === 'proved' ? 'fails on the original code, passes now' : r.proof === 'not-proved' ? 'also passes on the original code (proves nothing)' : `couldn't check: ${r.why}`}` : r.why || '';
    add('repro', 'The fix is proven (bug reproduced, then gone)', st, ev, { required: st !== 'unknown' });
  }

  const rv = s.review;
  if (rv) G.push({ id: 'review', label: 'Independent review (advisory)', status: rv.skipped ? 'skipped' : 'pass', required: false,
    evidence: rv.skipped ? `not done (${rv.skipped})` : `${rv.reviewer}: ${rv.verdict || 'no verdict'}, ${rv.findings?.length || 0} finding(s)`, log: rv.report || null });
  return G;
}

/** True when every required gate passed (or was waived on purpose). */
export const gatesPass = (gates) => gates.filter((g) => g.required).every((g) => OK.has(g.status));

const MARK = { pass: '✓', fail: '✗', missing: '✗', waived: '~', off: '~', skipped: '-', unknown: '?' };

/** Text checklist for the CLI and MCP. */
export function formatGates(gates) {
  const L = ['checks:'];
  for (const g of gates) L.push(`  ${MARK[g.status] || '?'} ${g.label}${g.required ? '' : ' (info)'}: ${g.status}. ${g.evidence || ''}${g.log ? `  [log: ${g.log}]` : ''}`.trimEnd());
  L.push(`  → ${gatesPass(gates) ? 'every required check passed' : 'NOT validated: a required check failed or is missing'}`);
  return L.join('\n');
}
