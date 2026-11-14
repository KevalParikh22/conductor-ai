// conductor demo: a throwaway project, both tasks handed out in parallel, merged when they pass, tested, removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, fakeBins, tmpdir } from './helpers.js';

const home = isolateHome();
const { runDemo, DEMO_PLAN } = await import('../src/demo.js');
const { checkPlan } = await import('../src/plancheck.js');

// a fake worker that solves whichever demo task it is given, with a test
fakeBins({
  'demo-worker': `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];
    const t=(p.match(/Your task id: (T\\d)/)||[])[1];
    const files = t==='T1'
      ? { 'src/titleCase.js': "export function titleCase(text) { if (typeof text !== 'string') throw new TypeError('text'); return text.split(' ').map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' '); }\\n",
          'test/titleCase.test.js': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { titleCase } from '../src/titleCase.js'; test('t', () => assert.equal(titleCase('hello wORLD'), 'Hello World'));\\n" }
      : { 'src/truncate.js': "export function truncate(text, max) { if (!Number.isInteger(max) || max < 1) throw new RangeError('max'); return text.length > max ? text.slice(0, max - 1) + '…' : text; }\\n",
          'test/truncate.test.js': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { truncate } from '../src/truncate.js'; test('t', () => assert.equal(truncate('conductor', 5), 'cond…'));\\n" };
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(f, c);
    fs.writeFileSync(o, '## RESULT: DONE\\n## Files changed\\n' + Object.keys(files).map((f) => '- ' + f).join('\\n') + '\\n## Checks run\\n- npm test\\n## Acceptance\\n- [x] 1. ok — evidence: ' + Object.keys(files)[0] + ':1\\n- [x] 2. ok — evidence: ' + Object.keys(files)[0] + ':1\\n- [x] 3. ok — evidence: ' + Object.keys(files)[0] + ':1\\n## Notes\\n- none\\n');});`,
});
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, providers: { good: { type: 'cli', preset: 'codex', enabled: true, bin: 'demo-worker' } }, roles: { build: ['good'] }, settings: { autoReview: false } }));

test('the demo plan is ready to hand out', () => {
  assert.ok(checkPlan(DEMO_PLAN, { verifyCmd: 'npm test' }).every((r) => !r.problems.length));
});

test('demo: both tasks run in parallel, pass every check, merge, the tests pass, and the project is removed', async () => {
  const parent = tmpdir('conductor-demo-parent-');
  const steps = [];
  const d = await runDemo({ provider: 'good', parent, say: (m) => steps.push(m) });
  assert.deepEqual(d.batch.results.map((r) => [r.task, r.outcome]), [['T1', 'done'], ['T2', 'done']]);
  assert.deepEqual(d.merged, ['T1', 'T2']);
  assert.equal(d.verify.status, 'PASS');
  assert.match(steps[0], /A throwaway project/);
  assert.ok(!fs.existsSync(d.dir), 'removed');
  assert.deepEqual(fs.existsSync(path.join(home, 'worktrees')) ? fs.readdirSync(path.join(home, 'worktrees')) : [], [], 'nothing left in conductor\'s worktree folder');
});

test('demo --keep leaves the project, with both helpers merged', async () => {
  const d = await runDemo({ provider: 'good', keep: true, parent: tmpdir('conductor-demo-parent-') });
  assert.ok(fs.existsSync(path.join(d.dir, 'src', 'titleCase.js')) && fs.existsSync(path.join(d.dir, 'src', 'truncate.js')));
});
