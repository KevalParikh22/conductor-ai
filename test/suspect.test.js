// False alarms: correct code, wrong test written by the worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { dispatch, formatSummary, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

const PLAN = `# Plan
## Open questions
- [x] none
## Tasks
### T1: add
- **role:** build
- **files:** \`src/add.js\`, \`test/add.test.js\`
- **acceptance:**
  - [ ] \`add(2, 3)\` returns 5
`;
const PLAN_PROSE = PLAN.replace('`add(2, 3)` returns 5', 'adding two and three gives five');
const T = (expect) => `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/add.js';\ntest('adds', () => { assert.equal(add(2, 3), ${expect}); });\n`;
const REPORT = '## RESULT: DONE\\n## Files changed\\n- src/add.js\\n## Checks run\\n- npm test\\n## Acceptance\\n- [x] 1. add — evidence: src/add.js:1\\n';
const worker = (code, testBody) => `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];if(process.env.SUS_PROMPT)fs.writeFileSync(process.env.SUS_PROMPT,p);
  fs.mkdirSync('src',{recursive:true});fs.mkdirSync('test',{recursive:true});fs.writeFileSync('src/add.js',${JSON.stringify(code)});fs.writeFileSync('test/add.test.js',${JSON.stringify(testBody)});fs.writeFileSync(o,'${REPORT}');});`;
const RIGHT = 'export const add = (a, b) => a + b;\n', WRONG = 'export const add = (a, b) => a - b;\n';
fakeBins({ 'sus-badtest': worker(RIGHT, T(6)), 'sus-good': worker(RIGHT, T(5)), 'sus-badcode': worker(WRONG, T(5)) });
const repo = (plan = PLAN) => makeRepo({ files: { 'docs/plan/p.md': plan, 'src/.keep': '', 'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }) } });
const cfgFor = (dir, settings = {}) => {
  const cfg = loadConfig(dir);
  for (const b of ['sus-badtest', 'sus-good', 'sus-badcode']) cfg.providers[b] = { type: 'cli', preset: 'codex', enabled: true, bin: b };
  cfg.settings = { ...cfg.settings, escalate: false, ...settings };
  return cfg;
};
const run = (dir, chain, settings) => dispatch(cfgFor(dir, settings), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', chain });

test('right code, wrong test: conductor says the test is the problem', async () => {
  clearCooldowns();
  const s = await run(repo().dir, ['sus-badtest']);
  assert.equal(s.outcome, 'verify-failed');
  assert.deepEqual(s.verify.suspectTests, ['test/add.test.js']);
  assert.match(s.fixBrief, /^Your code changes pass every test that existed before and all 1 acceptance checks\. Only tests you added or changed fail \(test\/add\.test\.js\)[\s\S]*These tests are probably wrong/);
  assert.match(formatSummary(s), /NOT DONE, but the code looks right[\s\S]*check those tests first/);
});

test('wrong code is never blamed on the test; without acceptance checks conductor does not guess', async () => {
  clearCooldowns();
  let s = await run(repo().dir, ['sus-badcode']);
  assert.equal(s.verify.suspectTests, undefined, 'the acceptance check fails: the code is wrong');
  s = await run(repo(PLAN_PROSE).dir, ['sus-badtest']);
  assert.equal(s.verify.suspectTests, undefined, 'no acceptance check to vouch for the code');
});

test('the hand-off tells the next worker to fix the test, and it does', async () => {
  clearCooldowns();
  const { dir } = repo();
  process.env.SUS_PROMPT = path.join(dir, '.git', 'SUS_PROMPT.txt');
  const s = await run(dir, ['sus-badtest', 'sus-good'], { escalate: true });
  assert.deepEqual([s.winner, s.outcome], ['sus-good', 'done']);
  assert.match(fs.readFileSync(process.env.SUS_PROMPT, 'utf8'), /These tests are probably wrong: compare each expected value/);
});
