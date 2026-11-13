// V4: "done" means validated. Each run gets a checklist of gates with evidence; the outcome and the checklist agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isolateHome, makeRepo, fakeBins, PLAN } from './helpers.js';

isolateHome();
const { runGates, gatesPass, formatGates } = await import('../src/rungates.js');
const { outcome, dispatch, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');
const { runDetail, listRuns, readRun } = await import('../src/runs.js');
const { createUiServer } = await import('../src/ui/server.js');

test('the UI can never say done unless every required check passed: outcome and checklist agree on every combination', () => {
  const V = [null, { status: 'PASS', cmd: 'npm test' }, { status: 'FAIL', cmd: 'npm test' }, { status: 'SKIPPED', cmd: '', chosen: true }, { status: 'SKIPPED', cmd: '' }];
  const C = [null, { passed: 2, total: 2, failed: [] }, { passed: 1, total: 2, failed: [{ expr: 'f()', got: '1' }] }];
  const A = [null, { met: 2, total: 2, answered: true, unmet: [] }, { met: 1, total: 2, answered: true, unmet: ['x'] }, { met: 0, total: 2, answered: false, unmet: [], waived: true }];
  const SC = [null, { outside: [] }, { outside: ['x.js'] }, { outside: ['x.js'], allowed: true }];
  const R = [null, { cmd: 'r', before: 'FAIL', after: 'PASS', ok: true }, { kind: 'test', ok: false, why: 'no regression test added' }, { kind: 'test', ok: false, waived: true }, { kind: 'test', ok: null, why: 'no base' }];
  let n = 0, done = 0;
  for (const mode of ['write', 'read']) for (const verify of V) for (const checks of C) for (const acceptance of A) for (const scope of SC) for (const repro of R) for (const status of ['## RESULT: DONE', '## RESULT: PARTIAL']) {
    const s = { mode, role: mode === 'write' ? 'build' : 'review', winner: 'w', attempts: [{ provider: 'w', ok: true, reason: 'ok' }], status, verify, checks, acceptance, scope, repro };
    const g = runGates(s);
    n++; if (outcome(s) === 'done') done++;
    assert.equal(gatesPass(g), outcome(s) === 'done', `${outcome(s)} vs checklist ${JSON.stringify(g.map((x) => [x.id, x.status, x.required]))}`);
  }
  assert.ok(n > 4000 && done > 10, `${n} combinations, ${done} done`);
  const failed = { mode: 'write', role: 'build', winner: null, attempts: [{ provider: 'a', ok: false, reason: 'quota' }] };
  assert.equal(gatesPass(runGates(failed)), false);
  assert.match(formatGates(runGates(failed)), /✗ A worker finished: fail\. every provider failed or was skipped: a \(quota\)[\s\S]*NOT validated/);
});

test('each gate carries its evidence: command, numbers, files, log', () => {
  const s = {
    mode: 'write', role: 'fix', winner: 'cx', model: 'm', planGate: { status: 'pass' }, changed: ['src/a.js'], status: '## RESULT: DONE',
    attempts: [{ provider: 'kilo', ok: false, reason: 'syntax error in src/a.js', guard: { syntax: [{ file: 'src/a.js' }] } }, { provider: 'cx', ok: true, reason: 'ok' }],
    base: { status: 'PASS', head: 'abc123', cached: true }, verify: { status: 'PASS', cmd: 'npm test', log: '.conductor/runs/x/verify.log' },
    checks: { passed: 3, total: 3, failed: [] }, acceptance: { met: 3, total: 3, answered: true, unmet: [] }, scope: { outside: [] },
    repro: { kind: 'test', tests: ['test/a.test.js'], proof: 'proved', ok: true }, review: { reviewer: 'gem', verdict: 'APPROVE', findings: [] },
  };
  const g = Object.fromEntries(runGates(s).map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(g), ['plan', 'worker', 'guard', 'acceptance', 'checks', 'verify', 'base', 'scope', 'repro', 'review']);
  assert.match(g.worker.evidence, /cx \(m\) after 1 failed attempt/);
  assert.match(g.guard.evidence, /rejected earlier: kilo \(syntax error in src\/a\.js\)/);
  assert.match(g.verify.evidence, /`npm test` PASS/);
  assert.equal(g.verify.log, '.conductor/runs/x/verify.log');
  assert.match(g.repro.evidence, /test\/a\.test\.js: fails on the original code, passes now/);
  assert.equal(g.base.required, false); assert.equal(g.review.required, false);
  assert.ok(gatesPass(Object.values(g)));
});

test('a real run: conductor runs show / MCP / UI API get the same checklist, and the API never reads outside the project', async () => {
  fakeBins({
    'codex-v4': `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];
      fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/add.js','export const add=(a,b)=>a+b;\\n');
      fs.writeFileSync(o,'## RESULT: DONE\\n## Files changed\\n- src/add.js\\n## Checks run\\n- none\\n## Acceptance\\n- [x] 1. add(2, 3) returns 5 — evidence: src/add.js:1\\n## Notes\\n- none\\n');});`,
  });
  clearCooldowns();
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '' } });
  const cfg = loadConfig(dir);
  cfg.providers = { cx: { type: 'cli', preset: 'codex', enabled: true, bin: 'codex-v4' } };
  const s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['cx'] });
  assert.equal(s.outcome ?? outcome(s), 'done');
  assert.deepEqual(s.planGate, { status: 'pass' }, 'the plan gate result is recorded');

  const id = listRuns(dir)[0].id;
  assert.equal(listRuns(dir)[0].validated, true);
  const d = runDetail(dir, id);
  assert.equal(d.validated, true);
  assert.deepEqual(d.gates.filter((g) => g.required).map((g) => [g.id, g.status]).slice(0, 3), [['plan', 'pass'], ['worker', 'pass'], ['guard', 'pass']]);
  assert.match(d.report, /RESULT: DONE/);
  assert.ok(d.gates.some((g) => g.id === 'verify' && g.status === 'pass'));
  assert.equal(readRun(dir, ''), null, 'an empty id matches nothing');
  assert.equal(readRun(dir, '../x'), null);

  const ui = createUiServer({ cwd: dir, token: 'tok' });
  const port = await ui.listen(0);
  const get = (q) => fetch(`http://127.0.0.1:${port}/api/run${q}`, { headers: { 'x-conductor-token': 'tok' } });
  try {
    const r = await (await get(`?id=${id}`)).json();
    assert.equal(r.validated, true);
    assert.deepEqual(r.gates, d.gates);
    assert.equal((await get('?id=..%2F..%2Fetc')).status, 404);
    assert.equal((await get('')).status, 404);
  } finally { ui.server.closeAllConnections?.(); ui.server.close(); }

  // a report path that points outside the project is not read
  const sumFile = `${dir}/.conductor/runs/${id}/summary.json`;
  const sj = JSON.parse(fs.readFileSync(sumFile, 'utf8'));
  fs.writeFileSync(sumFile, JSON.stringify({ ...sj, report: '../../../../etc/hostname' }));
  assert.equal(runDetail(dir, id).report, null);
});
