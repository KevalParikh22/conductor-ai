// Harness eval suite (H9) and failure stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, fakeBins, makeRepo, tmpdir } from './helpers.js';

const home = isolateHome();
const { listEvals, checkEvals, runEvals, formatEvals, loadResult, summarize, scoreEval, prepareEval, EVALS_DIR } = await import('../src/evals.js');
const { failureKind, failureStats, formatFailureStats } = await import('../src/stats.js');

test('every eval task is fair: fails on the starting project, passes with the reference solution, plan is ready', async () => {
  const tasks = listEvals();
  assert.ok(tasks.length >= 10);
  assert.deepEqual([...new Set(tasks.map((t) => t.role))].sort(), ['build', 'fix', 'test']);
  const rows = await checkEvals();
  assert.deepEqual(rows.filter((r) => r.problems.length), [], 'no unfair tasks');
});

test('eval run scores against hidden tests and compares conductor-ai\'s verdict with reality', async () => {
  const sol = fs.readFileSync(path.join(EVALS_DIR, 'fix-paginate/solution/src/paginate.js'), 'utf8');
  // a real fix comes with a regression test that fails on the old code (Q4)
  const REGRESSION = "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { paginate } from '../src/paginate.js';\ntest('page 2', () => { assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 2), [3, 4]); });\n";
  const acc = '## Acceptance\\n- [x] 1. a — evidence: src/paginate.js:6\\n- [x] 2. b — evidence: x\\n- [x] 3. c — evidence: x\\n- [x] 4. d — evidence: x\\n';
  const report = (extra = '') => `'## RESULT: DONE\\n## Files changed\\n- src/paginate.js\\n## Checks run\\n- npm test → pass\\n${acc}${extra}'`;
  fakeBins({
    // fixes the bug for real
    evgood: `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];fs.writeFileSync('src/paginate.js',${JSON.stringify(sol)});fs.writeFileSync('test/paginate.regression.test.js',${JSON.stringify(REGRESSION)});fs.writeFileSync(o,${report()});});`,
    // claims everything, changes a comment only: verify still passes, acceptance all ticked → conductor-ai says done
    evliar: `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];fs.appendFileSync('src/paginate.js','// fixed\\n');fs.writeFileSync(o,${report()});});`,
  });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: {
    good: { type: 'cli', preset: 'codex', enabled: true, bin: 'evgood' }, liar: { type: 'cli', preset: 'codex', enabled: true, bin: 'evliar' } } }));
  const a = await runEvals({ ids: ['fix-paginate'], chain: ['good'], label: 'good' });
  assert.deepEqual([a.results[0].outcome, a.results[0].pass], ['done', true]);
  assert.equal('killed' in a.results[0], false);
  assert.equal('planted' in a.results[0], false);
  assert.deepEqual([a.summary.passRate, a.summary.rightDone, a.summary.falseDone], [100, 1, 0]);
  assert.ok(fs.existsSync(a.file), 'saved');
  // the liar ticks every criterion; conductor-ai runs them itself (H11) and catches it: not "done"
  const b = await runEvals({ ids: ['fix-paginate'], chain: ['liar'], label: 'liar' });
  assert.deepEqual([b.results[0].outcome, b.results[0].pass, b.summary.falseDone, b.summary.caught], ['partial', false, 0, 1]);
  const out = formatEvals(b, loadResult('last', b.file));
  assert.match(out, /✗ fix-paginate +partial/);
  assert.match(out, /pass rate: +0\/1 = 0% \(-100 pts vs good\)/);
  // with the checks off, the same lie gets through: what the eval exists to measure
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ settings: { runAcceptance: false, escalate: false, requireRepro: false }, providers: {
    good: { type: 'cli', preset: 'codex', enabled: true, bin: 'evgood' }, liar: { type: 'cli', preset: 'codex', enabled: true, bin: 'evliar' } } }));
  const c = await runEvals({ ids: ['fix-paginate'], chain: ['liar'], label: 'liar-nochecks' });
  assert.deepEqual([c.results[0].outcome, c.summary.falseDone], ['done', 1]);
  assert.match(formatEvals(c), /conductor-ai said done, hidden tests fail/);
});

test('summary counts the four verdicts', () => {
  const s = summarize([{ outcome: 'done', pass: true }, { outcome: 'done', pass: false }, { outcome: 'partial', pass: false }, { outcome: 'out-of-scope', pass: true }, { outcome: 'error', pass: false }]);
  assert.deepEqual([s.rightDone, s.falseDone, s.caught, s.falseAlarm, s.errors, s.passRate], [1, 1, 1, 1, 1, 50], 'errors are left out of the rate and of caught');
});

test('failure stats group attempts and runs by cause, biggest first', () => {
  assert.equal(failureKind('exit 1'), 'exited with an error');
  assert.equal(failureKind('denied: command (add an allow rule)'), 'refused an action (needs an allow rule)');
  assert.equal(failureKind('timeout (20m)'), 'time limit');
  assert.equal(failureKind('quota'), 'rate limit / quota');
  const lines = [['p1', false, 'quota'], ['p2', false, 'quota'], ['p1', false, 'exit 2'], ['p1', true, 'ok']]
    .map(([provider, ok, reason]) => JSON.stringify({ ts: new Date().toISOString(), provider, ok, reason, kind: 'agent' })).join('\n');
  fs.writeFileSync(path.join(home, 'usage.jsonl'), lines + '\n');
  const { dir } = makeRepo();
  const put = (id, s) => { const d = path.join(dir, '.conductor-ai', 'runs', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'summary.json'), JSON.stringify({ role: 'build', mode: 'write', attempts: [], startedAt: new Date().toISOString(), ...s })); };
  put('20261111-000001-build', { winner: 'x', status: '## RESULT: DONE', verify: { status: 'PASS' }, acceptance: { total: 2, met: 1, answered: true, unmet: ['x'] } });
  put('20261111-000002-build', { winner: 'x', status: '## RESULT: DONE', verify: { status: 'PASS' }, acceptance: { total: 2, met: 1, answered: true, unmet: ['x'] } });
  put('20261111-000003-build', { winner: 'x', status: '## RESULT: DONE', verify: { status: 'PASS' }, scope: { outside: ['b.js'] } });
  const st = failureStats({ root: dir, days: 1 });
  assert.deepEqual(st.attempts.map((a) => [a.kind, a.count]), [['rate limit / quota', 2], ['exited with an error', 1]]);
  assert.deepEqual(st.causes.map((c) => [c.cause, c.count]), [['acceptance criteria not all met', 2], ['changed files outside the task', 1]]);
  assert.match(formatFailureStats(st), /2 +acceptance criteria not all met[\s\S]*2 +rate limit \/ quota +p1 1, p2 1/);
});

test('mutation scoring returns killed and planted counts, hidden tasks return neither', async () => {
  const task = listEvals().find((t) => t.id === 'test-cart');
  assert.ok(task, 'test-cart task found');
  const mutantDirs = fs.readdirSync(path.join(task.dir, 'mutants')).filter((m) => fs.statSync(path.join(task.dir, 'mutants', m)).isDirectory());
  const work = tmpdir('conductor-eval-test-cart-');
  try {
    prepareEval(task, work);
    const start = await scoreEval(task, work);
    assert.equal(start.killed, 0);
    assert.equal(start.planted, mutantDirs.length);
    assert.equal(start.planted, 5);

    fs.cpSync(path.join(task.dir, 'solution'), work, { recursive: true });
    const solved = await scoreEval(task, work);
    assert.equal(solved.pass, true);
    assert.equal(solved.killed, 5);
    assert.equal(solved.planted, 5);
    assert.equal(solved.killed, solved.planted);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // worker's tests fail on the correct code
  const workFail = tmpdir('conductor-eval-fail-');
  try {
    prepareEval(task, workFail);
    fs.mkdirSync(path.join(workFail, 'test'), { recursive: true });
    fs.writeFileSync(path.join(workFail, 'test', 'broken.test.js'), 'import test from "node:test"; import assert from "node:assert/strict"; test("broken", () => { assert.fail("broken"); });\n');
    const failed = await scoreEval(task, workFail);
    assert.equal(failed.pass, false);
    assert.equal(failed.killed, 0);
    assert.equal(failed.planted, 5);
    assert.match(failed.detail, /the worker's tests fail on the correct code/);
  } finally {
    fs.rmSync(workFail, { recursive: true, force: true });
  }

  // hidden-score tasks return no killed/planted keys
  const hiddenTask = listEvals().find((t) => t.id === 'fix-paginate');
  assert.ok(hiddenTask, 'hidden task found');
  const hWork = tmpdir('conductor-eval-hidden-');
  try {
    prepareEval(hiddenTask, hWork);
    const hScore = await scoreEval(hiddenTask, hWork);
    assert.equal('killed' in hScore, false);
    assert.equal('planted' in hScore, false);
  } finally {
    fs.rmSync(hWork, { recursive: true, force: true });
  }

  // runEvals copies killed/planted onto row when present
  const solCart = fs.readFileSync(path.join(EVALS_DIR, 'test-cart/solution/test/cart.test.js'), 'utf8');
  fakeBins({
    cartGood: `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];fs.mkdirSync('test',{recursive:true});fs.writeFileSync('test/cart.test.js',${JSON.stringify(solCart)});fs.writeFileSync(o,'## RESULT: DONE\\\\n## Files changed\\\\n- test/cart.test.js\\\\n## Checks run\\\\n- npm test → pass\\\\n');});`,
  });
  const cfgPath = path.join(home, 'config.json');
  const cfgData = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfgData.providers.cartGood = { type: 'cli', preset: 'codex', enabled: true, bin: 'cartGood' };
  fs.writeFileSync(cfgPath, JSON.stringify(cfgData));
  const rCart = await runEvals({ ids: ['test-cart'], chain: ['cartGood'], label: 'cart-test' });
  assert.equal(rCart.results[0].killed, 5);
  assert.equal(rCart.results[0].planted, 5);
  assert.equal(rCart.results[0].pass, true);
});
