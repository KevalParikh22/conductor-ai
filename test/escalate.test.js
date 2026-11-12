// H3 (failure brief) and H2 (hand failed work to the next provider with the real error).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { failureBrief } = await import('../src/gates.js');
const { dispatch, formatSummary, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

const NODE_FAIL = `✖ adds two numbers (1.3ms)
✔ fine (0.2ms)
ℹ tests 2

✖ failing tests:

test at test/add.test.js:2:1
✖ adds two numbers (1.332227ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  -1 !== 5

      at TestContext.<anonymous> (file:///work/proj/test/add.test.js:2:41)
      at Test.runInAsyncScope (node:async_hooks:227:14)`;

test('a failing verify becomes a short brief: what failed, the error, where', () => {
  const b = failureBrief(NODE_FAIL, '/work/proj', 'npm test');
  assert.match(b, /^Verify failed \(`npm test`\)\.\nFailing: adds two numbers\nErrors:\n- AssertionError \[ERR_ASSERTION\]: Expected values to be strictly equal: → -1 !== 5\nWhere: test\/add\.test\.js:2/);
  assert.ok(!b.includes('node:async_hooks'));
  // Node 20 prints TAP when piped: same brief
  const tap = "not ok 1 - adds two numbers\n  ---\n  location: '/work/proj/test/add.test.js:2:1'\n  error: |-\n    Expected values to be strictly equal:\n    \n    -1 !== 5\n    \n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: 5\n  actual: -1\n  stack: |-\n    TestContext.<anonymous> (file:///work/proj/test/add.test.js:2:41)\n    Test.runInAsyncScope (node:async_hooks:206:9)\n  ...\n";
  assert.match(failureBrief(tap, '/work/proj', 'npm test'), /Failing: adds two numbers\nErrors:\n- AssertionError: Expected values to be strictly equal: → -1 !== 5\nWhere: test\/add\.test\.js:2/);
  assert.match(failureBrief('FAILED tests/test_x.py::test_add - assert 1 == 5\nE       assert 1 == 5\ntests/test_x.py:4: AssertionError'), /Failing: tests\/test_x\.py::test_add[\s\S]*Where: tests\/test_x\.py:4/);
});

const PLAN = `# Plan
## Open questions
- [x] none
## Tasks
### T1: add
- **role:** build
- **files:** \`src/add.js\`
- **acceptance:**
  - [ ] \`add(2, 3)\` returns 5
`;
const TEST = "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/add.js';\ntest('adds two numbers', () => { assert.equal(add(2, 3), 5); });\n";
const REPORT = '## RESULT: DONE\\n## Files changed\\n- src/add.js\\n## Checks run\\n- npm test\\n## Acceptance\\n- [x] 1. add — evidence: src/add.js:1\\n';
const worker = (code, extra = '') => `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];${extra}
  fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/add.js',${JSON.stringify(code)});fs.writeFileSync(o,'${REPORT}');});`;
fakeBins({
  'w-wrong': worker('export const add = (a, b) => a - b;\n'),
  // records the prompt it got, then fixes the work
  'w-crash': "console.error('boom'); process.exit(1);",
  'w-fixer': worker('export const add = (a, b) => a + b;\n', "fs.writeFileSync(require('path').join(require('os').tmpdir(),'fixer-prompt-'+process.pid+'.txt'),p);process.env.FIXER_LOG&&fs.writeFileSync(process.env.FIXER_LOG,p);"),
});
const repo = () => makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '', 'test/add.test.js': TEST, 'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }) } });
const cfgFor = (dir) => {
  const cfg = loadConfig(dir);
  cfg.providers.wrong = { type: 'cli', preset: 'codex', enabled: true, bin: 'w-wrong' };
  cfg.providers.fixer = { type: 'cli', preset: 'codex', enabled: true, bin: 'w-fixer' };
  cfg.providers.crash = { type: 'cli', preset: 'codex', enabled: true, bin: 'w-crash' };
  return cfg;
};

test('work that fails verify goes to the next provider once, with the brief; it fixes it in place', async () => {
  clearCooldowns();
  const { dir } = repo();
  process.env.FIXER_LOG = path.join(dir, '..', `fixer-${path.basename(dir)}.txt`);
  const events = [];
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['wrong', 'fixer'], onEvent: (e) => events.push(e.type) });
  assert.equal(s.winner, 'fixer');
  assert.deepEqual([s.verify.status, s.outcome], ['PASS', 'done']);
  assert.deepEqual(s.attempts.map((a) => a.provider), ['wrong', 'fixer']);
  assert.equal(s.escalated[0].from, 'wrong');
  assert.ok(events.includes('escalate'));
  const prompt = fs.readFileSync(process.env.FIXER_LOG, 'utf8');
  assert.match(prompt, /A previous worker \(wrong\) did this task[\s\S]*Failing: adds two numbers[\s\S]*-1 !== 5/);
  assert.deepEqual(s.changed, ['src/add.js'], 'the inherited change counts as this task\'s work');
  assert.match(formatSummary(s), /handed on: wrong's work failed verify and acceptance checks → fixer took it over[\s\S]*checks: +1\/1 acceptance checks pass when run/);
});

test('in a worktree the next provider continues on the task branch', async () => {
  clearCooldowns();
  const { dir } = repo();
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['wrong', 'fixer'], worktree: true });
  assert.deepEqual([s.winner, s.verify.status, s.outcome], ['fixer', 'PASS', 'done']);
  assert.equal(s.worktree.continued, true);
  assert.ok(s.worktree.commit, 'committed on the task branch');
});

test('no hand-off when nobody is left, when turned off, or when the next one cannot run: the brief is shown instead', async () => {
  clearCooldowns();
  let s = await dispatch(cfgFor(repo().dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['wrong'] });
  assert.deepEqual([s.winner, s.verify.status, s.escalated], ['wrong', 'FAIL', undefined]);
  assert.match(formatSummary(s), /why: +Failing: adds two numbers/);
  s = await dispatch(cfgFor(repo().dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['wrong', 'fixer'], noEscalate: true });
  assert.equal(s.winner, 'wrong');
  const { dir } = repo();
  s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['wrong', 'crash'] });
  assert.deepEqual([s.winner, s.verify.status], ['wrong', 'FAIL'], 'the earlier result stands');
  assert.ok(s.warnings.some((w) => /handing the failed work to crash did not work: crash\(exit 1\)/.test(w)));
  assert.equal(fs.readFileSync(path.join(dir, 'src/add.js'), 'utf8'), 'export const add = (a, b) => a - b;\n', 'its work is still there to look at');
});
