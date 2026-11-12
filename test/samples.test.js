// H1: several attempts in parallel, the best one kept by results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { dispatch, formatSummary, clearCooldowns, UsageError } = await import('../src/core.js');
const { rankSamples } = await import('../src/samples.js');
const { loadConfig } = await import('../src/config.js');

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
const REPORT = '## RESULT: DONE\\n## Files changed\\n- src/add.js\\n## Checks run\\n- npm test\\n## Acceptance\\n- [x] 1. add — evidence: src/add.js:1\\n';
const worker = (code) => `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/add.js',${JSON.stringify(code)});fs.writeFileSync(o,'${REPORT}');});`;
fakeBins({
  's-wrong': worker('export const add = (a, b) => a - b;\n'),
  's-long': worker('// adds two numbers\n// a: number\n// b: number\nexport function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\n'),
  's-short': worker('export const add = (a, b) => a + b;\n'),
});
const repo = () => makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '', 'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }) } });
const cfgFor = (dir) => {
  const cfg = loadConfig(dir);
  for (const b of ['s-wrong', 's-long', 's-short']) cfg.providers[b] = { type: 'cli', preset: 'codex', enabled: true, bin: b };
  return cfg;
};
const branches = (git) => git('for-each-ref', '--format=%(refname:short)', 'refs/heads/conductor').trim();

test('ranking: done first, then checks and criteria met, then the smallest diff', () => {
  const r = rankSamples([
    { id: 'a', outcome: 'partial', checksPassed: 1, accMet: 1, lines: 1 },
    { id: 'b', outcome: 'done', checksPassed: 1, accMet: 1, lines: 9 },
    { id: 'c', outcome: 'done', checksPassed: 1, accMet: 1, lines: 2 },
    { id: 'd', outcome: 'failed', checksPassed: 0, accMet: 0, lines: 0 },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['c', 'b', 'a', 'd']);
});

test('three attempts in parallel: the correct, smallest one lands in the working tree; nothing else is left', async () => {
  clearCooldowns();
  const { dir, git } = repo();
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['s-wrong', 's-long', 's-short'], samples: 3 });
  assert.equal(s.samples.length, 3);
  assert.ok(s.samplesCost && 'tokens' in s.samplesCost, 'the cost of every attempt is kept');
  const chosen = s.samples.find((x) => x.chosen);
  assert.deepEqual([chosen.provider, chosen.outcome], ['s-short', 'done']);
  assert.equal(s.samples.find((x) => x.provider === 's-wrong').outcome, 'partial', 'its acceptance check failed');
  assert.equal(fs.readFileSync(path.join(dir, 'src/add.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
  assert.equal(branches(git), '', 'every attempt\'s branch is gone');
  assert.equal(s.worktree, undefined);
  assert.match(s.appliedFrom, /^conductor\/T1-s\d$/);
  assert.match(formatSummary(s), /samples: +3 attempts, best kept: s-short done checks 1\/1 \d+ lines ← chosen/);
  assert.match(formatSummary(s), /landed: +the chosen attempt's changes are in your working tree/);
});

test('with --worktree the best attempt keeps its branch; the others are removed', async () => {
  clearCooldowns();
  const { dir, git } = repo();
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['s-wrong', 's-short'], samples: 2, worktree: true });
  assert.equal(s.winner, 's-short');
  assert.equal(branches(git), s.worktree.branch);
  assert.ok(fs.existsSync(path.join(dir, 'src/add.js')) === false, 'the main checkout is untouched');
});

test('one provider ready: one attempt, with a note; a weak task is refused once; a dirty tree is refused', async () => {
  clearCooldowns();
  let { dir } = repo();
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['s-short'], samples: 3 });
  assert.equal(s.samples, undefined);
  assert.ok(s.warnings.some((w) => /only 1 provider ready/.test(w)));
  ({ dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN.replace('  - [ ] `add(2, 3)` returns 5\n', '  - [ ] works\n') } }));
  await assert.rejects(dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['s-long', 's-short'], samples: 2 }), (e) => e instanceof UsageError && /isn't ready/.test(e.message));
  ({ dir } = repo());
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  await assert.rejects(dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['s-long', 's-short'], samples: 2 }), /working tree is dirty/);
});
