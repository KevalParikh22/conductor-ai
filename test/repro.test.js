// Q4: reproduce first for fix tasks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { dispatch, formatSummary, clearCooldowns, UsageError } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');

const plan = (extra = '') => `# Plan
## Open questions
- [x] none
## Tasks
### T1: fix add
- **role:** fix
- **files:** \`src/add.js\`, \`test/add.test.js\`${extra}
- **acceptance:**
  - [ ] \`add(2, 3)\` returns 5
`;
const REPRO = "- **repro:** `node -e \"import('./src/add.js').then(m => process.exit(m.add(2, 3) === 5 ? 0 : 1))\"`";
const FIXED = 'export const add = (a, b) => a + b;\n';
const T = (body) => `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/add.js';\n${body}\n`;
const REAL_TEST = T("test('adds', () => { assert.equal(add(2, 3), 5); });");
const EMPTY_TEST = T("test('loads', () => { assert.equal(typeof add, 'function'); });");
const REPORT = '## RESULT: DONE\\n## Files changed\\n- src/add.js\\n## Checks run\\n- npm test\\n## Acceptance\\n- [x] 1. add — evidence: src/add.js:1\\n';
const worker = (files) => `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const o=args[args.indexOf('-o')+1];
  ${Object.entries(files).map(([f, c]) => `fs.mkdirSync(require('path').dirname(${JSON.stringify(f)}),{recursive:true});fs.writeFileSync(${JSON.stringify(f)},${JSON.stringify(c)});`).join('')}
  if(process.env.FX_PROMPT)fs.writeFileSync(process.env.FX_PROMPT,p);fs.writeFileSync(o,'${REPORT}');});`;
fakeBins({
  'fx-good': worker({ 'src/add.js': FIXED, 'test/add.test.js': REAL_TEST }),
  'fx-notest': worker({ 'src/add.js': FIXED }),
  'fx-weaktest': worker({ 'src/add.js': FIXED, 'test/add.test.js': EMPTY_TEST }),
  'fx-nofix': worker({ 'src/add.js': 'export const add = (a, b) => a * b;\n', 'test/add.test.js': EMPTY_TEST }),
});
const repo = (p) => makeRepo({ files: { 'docs/plan/p.md': p, 'src/add.js': 'export const add = (a, b) => a - b;\n', 'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }) } });
const cfgFor = (dir, extra = {}) => {
  const cfg = loadConfig(dir);
  for (const b of ['fx-good', 'fx-notest', 'fx-weaktest', 'fx-nofix']) cfg.providers[b] = { type: 'cli', preset: 'codex', enabled: true, bin: b };
  cfg.settings = { ...cfg.settings, escalate: false, ...extra };
  return cfg;
};
const run = (dir, chain, opts = {}, extra = {}) => (process.env.FX_PROMPT = path.join(dir, '.git', 'PROMPT.txt'), dispatch(cfgFor(dir, extra), { role: 'fix', planPath: 'docs/plan/p.md', taskId: 'T1', chain, ...opts }));

test('with a repro: it must fail before (else refused), and pass after', async () => {
  clearCooldowns();
  // the repro passes already: the bug isn't reproduced, so no worker runs
  const fixedRepo = makeRepo({ files: { 'docs/plan/p.md': plan(`\n${REPRO}`), 'src/add.js': FIXED, 'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }) } }).dir;
  await assert.rejects(run(fixedRepo, ['fx-good']), (e) => e instanceof UsageError && /already passes before any change[\s\S]*--allow-no-repro/.test(e.message));

  let { dir } = repo(plan(`\n${REPRO}`));
  let s = await run(dir, ['fx-good']);
  assert.deepEqual([s.repro.before, s.repro.after, s.outcome], ['FAIL', 'PASS', 'done']);
  assert.match(fs.readFileSync(path.join(dir, '.git', 'PROMPT.txt'), 'utf8'), /## Reproduce\nconductor runs `node -e/);
  assert.match(formatSummary(s), /repro: +`node -e .*` FAIL before, PASS after/);

  ({ dir } = repo(plan(`\n${REPRO}`)));
  s = await run(dir, ['fx-nofix'], {}, { runAcceptance: false });
  assert.deepEqual([s.repro.after, s.outcome], ['FAIL', 'partial']);
  assert.match(s.fixBrief, /The bug still reproduces/);
  assert.match(formatSummary(s), /PARTIAL\. The bug still reproduces/);
});

test('without a repro: the new test must fail on the original code', async () => {
  clearCooldowns();
  let s = await run(repo(plan()).dir, ['fx-good']);
  assert.deepEqual([s.repro.proof, s.repro.ok, s.outcome], ['proved', true, 'done']);
  assert.match(formatSummary(s), /regression test test\/add\.test\.js: fails on the original code \(proves the bug\)/);

  s = await run(repo(plan()).dir, ['fx-weaktest']);
  assert.deepEqual([s.repro.proof, s.outcome], ['not-proved', 'partial']);
  assert.match(s.fixBrief, /also pass on the original, buggy code/);

  s = await run(repo(plan()).dir, ['fx-notest']);
  assert.deepEqual([s.repro.why, s.outcome], ['no regression test added', 'partial']);
  assert.match(formatSummary(s), /PARTIAL\. The fix has no regression test/);

  s = await run(repo(plan()).dir, ['fx-notest'], {}, { requireRepro: false });
  assert.equal(s.repro, undefined, 'requireRepro: false');
  assert.equal(s.outcome, 'done');
});

test('the proof works in a worktree too, and leaves nothing behind', async () => {
  clearCooldowns();
  const { dir, git } = repo(plan());
  const s = await run(dir, ['fx-good'], { worktree: true });
  assert.deepEqual([s.repro.proof, s.outcome], ['proved', 'done']);
  assert.ok(!git('worktree', 'list').includes('conductor-repro-'), 'the temporary checkout is removed');
});

test('a failed fix is handed on with what is missing', async () => {
  clearCooldowns();
  const { dir } = repo(plan());
  process.env.FX_PROMPT = path.join(dir, '.git', 'PROMPT.txt');
  const s = await dispatch(cfgFor(dir, { escalate: true }), { role: 'fix', planPath: 'docs/plan/p.md', taskId: 'T1', chain: ['fx-notest', 'fx-good'] });
  assert.deepEqual([s.winner, s.repro.proof, s.outcome], ['fx-good', 'proved', 'done']);
  assert.match(fs.readFileSync(path.join(dir, '.git', 'PROMPT.txt'), 'utf8'), /Add a regression test/);
});
