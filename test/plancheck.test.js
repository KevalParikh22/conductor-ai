// Plan gate (Q1) and acceptance recited and checked (H5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { taskAcceptance, checkTask, checkPlan, planTaskIds, readAcceptance, acceptancePrompt } = await import('../src/plancheck.js');
const { dispatch, outcome, formatSummary, UsageError } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');
const { planBatch } = await import('../src/batch.js');

const GOOD = `### T1: cart total
- **role:** build
- **files:** \`src/cart.js\`, \`src/cart.test.js\`
- **acceptance:**
  - [ ] total() of an empty cart returns 0
  - [ ] total() sums price × qty, rounded to 2 decimals
- **verify:** \`npm test\`
`;
const PLAN = `# Plan: cart

## Open questions
- [x] none

## Tasks

${GOOD}
### T2: polish
- **role:** build
- **files:** \`a.js\`, \`b.js\`, \`c.js\`, \`d.js\`, \`e.js\`
- **acceptance:**
  - [ ] works
  - [ ] done

### T3: decide the API
- **role:** controller
`;

test('acceptance criteria are read from the task, placeholders skipped', () => {
  assert.deepEqual(taskAcceptance(GOOD), ['total() of an empty cart returns 0', 'total() sums price × qty, rounded to 2 decimals']);
  assert.deepEqual(taskAcceptance('- **acceptance:** GET /x returns 404\n- **verify:** `x`'), ['GET /x returns 404']);
  assert.deepEqual(taskAcceptance('- **acceptance:**\n  - [ ] ...\n  - [ ] <criterion>\n'), []);
  assert.deepEqual(planTaskIds(PLAN), ['T1', 'T2', 'T3']);
});

test('plan check: ready tasks pass; each gap is named; controller tasks are not checked', () => {
  assert.deepEqual(checkTask(GOOD), []);
  const rows = checkPlan(PLAN, { verifyCmd: '' });
  assert.deepEqual(rows.map((r) => [r.id, r.problems.length]), [['T1', 0], ['T2', 3], ['T3', 0]]);
  const p = rows[1].problems.join('\n');
  assert.match(p, /too vague to check: "works", "done"/);
  assert.match(p, /no verify command/);
  assert.match(p, /too big for one worker: 5 files/);
  assert.match(checkTask('### T9: x\n- **role:** fix\n').join('\n'), /no files[\s\S]*no acceptance criteria[\s\S]*no verify command/);
  assert.equal(checkTask('### T9: x\n- **role:** build\n- **files:** `a.js`\n- **acceptance:** returns 5 for add(2,3)\n', { verifyCmd: 'npm test' }).length, 0, 'the project verify counts');
});

test('the CLI plan check prints each task and exits 1 when one needs work', () => {
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN } });
  const bin = path.resolve('bin/conductor.js');
  let out = '', code = 0;
  try { out = execFileSync('node', [bin, 'plan', 'check', 'docs/plan/p.md'], { cwd: dir, encoding: 'utf8', env: process.env }); } catch (e) { out = e.stdout; code = e.status; }
  assert.equal(code, 1);
  assert.match(out, /✓ T1: cart total[\s\S]*✗ T2: polish[\s\S]*✓ T3: decide the API \(controller\)[\s\S]*1 of 3 task\(s\) need work/);
  assert.equal(execFileSync('node', [bin, 'plan', 'check', 'docs/plan/p.md', '--task', 'T1'], { cwd: dir, encoding: 'utf8', env: process.env }).includes('All 1 task(s) are ready'), true);
});

test('a weak task is refused before any worker runs; batch refuses the whole set; --allow-weak-plan overrides', async () => {
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN } });
  const cfg = loadConfig(dir);
  await assert.rejects(dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T2', chain: ['nobody'] }),
    (e) => e instanceof UsageError && /T2 isn't ready to hand to a worker[\s\S]*too vague[\s\S]*--allow-weak-plan/.test(e.message));
  assert.throws(() => planBatch(cfg, { planPath: 'docs/plan/p.md', tasks: ['T1', 'T2'] }), /not ready to hand to workers:\s+T2:/);
  assert.equal(planBatch(cfg, { planPath: 'docs/plan/p.md', tasks: ['T1', 'T2'], allowWeakPlan: true }).items.length, 2);
});

test('acceptance answers are counted: all met, some not, none, or never answered', () => {
  const c = ['a returns 1', 'b throws'];
  assert.deepEqual(readAcceptance('## RESULT: DONE\n## Acceptance\n- [x] 1. a returns 1 — evidence: npm test → pass\n- [x] 2. b throws — evidence: x.test.js:9\n## Notes\n- n', c), { total: 2, met: 2, answered: true, unmet: [] });
  const some = readAcceptance('## Acceptance\n- [x] 1. ok — evidence: t\n- [ ] 2. b throws — not done yet', c);
  assert.deepEqual([some.met, some.unmet], [1, ['2. b throws — not done yet']]);
  assert.deepEqual(readAcceptance('## Acceptance\n- [x] 1. only one', c).unmet, ['2. b throws (not answered)']);
  assert.equal(readAcceptance('## RESULT: DONE\n## Notes\n- none', c).answered, false);
  assert.match(acceptancePrompt(c), /^\n## Before you finish[\s\S]*1\. a returns 1\n2\. b throws[\s\S]*## Acceptance/);
});

test('DONE without every criterion met with evidence is PARTIAL, and the summary says which', () => {
  const s = { winner: 'w', mode: 'write', role: 'build', status: '## RESULT: DONE', changed: ['a.js'], applied: [], rejected: [], warnings: [], attempts: [{ provider: 'w', reason: 'ok' }], verify: { status: 'PASS' },
    acceptance: { total: 2, met: 1, answered: true, unmet: ['2. b throws — not done'] } };
  assert.equal(outcome(s), 'partial');
  assert.match(formatSummary(s), /PARTIAL\. Only 1 of 2 acceptance criteria are met with evidence[\s\S]*acceptance: 1\/2 met with evidence; not met: 2\. b throws/);
  assert.equal(outcome({ ...s, acceptance: { ...s.acceptance, answered: false, met: 0 } }), 'partial');
  assert.equal(outcome({ ...s, acceptance: { ...s.acceptance, waived: true } }), 'done', 'requireAcceptance: false');
  assert.equal(outcome({ ...s, acceptance: { total: 2, met: 2, answered: true, unmet: [] } }), 'done');
});

test('the worker\'s prompt ends with its acceptance criteria, and its answers decide the outcome', async () => {
  fakeBins({
    answers: `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];fs.writeFileSync('PROMPT.txt',p);
      fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/cart.js','export const total=()=>0;\\n');
      fs.writeFileSync(o,'## RESULT: DONE\\n## Files changed\\n- src/cart.js\\n## Checks run\\n- npm test → pass\\n## Acceptance\\n- [x] 1. empty cart — evidence: src/cart.js:1\\n- [ ] 2. sums — not done\\n');});`,
  });
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '' } });
  const cfg = loadConfig(dir);
  cfg.providers.ans = { type: 'cli', preset: 'codex', enabled: true, bin: 'answers' };
  const s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['ans'] });
  const prompt = fs.readFileSync(path.join(dir, 'PROMPT.txt'), 'utf8');
  assert.match(prompt.slice(-900), /Before you finish: check every acceptance criterion\n1\. total\(\) of an empty cart returns 0\n2\. total\(\) sums/, 'recited at the very end');
  assert.deepEqual([s.acceptance.met, s.acceptance.total, s.outcome], [1, 2, 'partial']);
});
