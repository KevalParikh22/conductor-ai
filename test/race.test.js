// V9: race mode. The fastest free routes start together; the first attempt that passes every check wins and the
// others are stopped (their processes killed), so the task takes as long as the fastest correct worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins, tmpdir } from './helpers.js';

isolateHome();
const { dispatch, formatSummary, clearCooldowns } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');
const { run } = await import('../src/util.js');

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
// a worker that waits `ms`, then writes add(); `mark` records that it finished (a stopped one never does)
const worker = (ms, code, mark) => `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>setTimeout(()=>{const o=args[args.indexOf('-o')+1];
  fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/add.js',${JSON.stringify(code)});fs.writeFileSync(o,'${REPORT}');
  fs.appendFileSync(process.env.RACE_LOG, ${JSON.stringify(mark)} + '\\n');}, ${ms}));`;
const RIGHT = 'export const add = (a, b) => a + b;\n';
fakeBins({
  'r-fast': worker(300, RIGHT, 'fast'),
  'r-slow': worker(20_000, RIGHT, 'slow'),
  'r-fast-wrong': worker(200, 'export const add = (a, b) => a - b;\n', 'fast-wrong'),
});
const repo = () => makeRepo({ files: { 'docs/plan/p.md': PLAN, 'src/.keep': '', 'package.json': JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node --test' } }) } });
const cfgFor = (dir, bins) => {
  const cfg = loadConfig(dir);
  cfg.providers = Object.fromEntries(bins.map((b) => [b, { type: 'cli', preset: 'codex', enabled: true, bin: b }]));
  cfg.roles = { ...cfg.roles, build: bins };
  cfg.settings = { ...cfg.settings, autoReview: false };
  return cfg;
};

test('race: the first attempt to pass every check wins, the slow one is stopped, and only the winner\'s change lands', async () => {
  clearCooldowns();
  process.env.RACE_LOG = path.join(tmpdir(), 'race.log'); fs.writeFileSync(process.env.RACE_LOG, '');
  const { dir, git } = repo();
  const t0 = Date.now();
  const s = await dispatch(cfgFor(dir, ['r-slow', 'r-fast']), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', race: true });
  const took = Date.now() - t0;
  assert.equal(s.winner, 'r-fast');
  assert.equal(s.outcome, 'done');
  assert.deepEqual(s.race.stopped, ['r-slow']);
  assert.ok(took < 15_000, `done in ${took} ms: did not wait for the 20 s worker`);
  assert.equal(fs.readFileSync(path.join(dir, 'src/add.js'), 'utf8'), RIGHT);
  assert.match(formatSummary(s), /race: +r-fast passed every check first \(\d+s\); stopped: r-slow/);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(fs.readFileSync(process.env.RACE_LOG, 'utf8').trim().split('\n'), ['fast'], 'the slow worker was killed, it never finished');
  assert.equal(git('for-each-ref', '--format=%(refname:short)', 'refs/heads/conductor').trim(), '', 'no branches left behind');
});

test('race: a fast but wrong attempt does not win; the correct one does', async () => {
  clearCooldowns();
  process.env.RACE_LOG = path.join(tmpdir(), 'race2.log'); fs.writeFileSync(process.env.RACE_LOG, '');
  const { dir } = repo();
  const s = await dispatch(cfgFor(dir, ['r-fast-wrong', 'r-fast']), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', race: true });
  assert.equal(s.winner, 'r-fast');
  assert.equal(s.race.winner, 'r-fast');
});

test('race is opt-in: settings.race applies to small tasks only; paid providers and the controller\'s own CLI never race', async () => {
  clearCooldowns();
  process.env.RACE_LOG = path.join(tmpdir(), 'race3.log'); fs.writeFileSync(process.env.RACE_LOG, '');
  const { dir } = repo();
  const cfg = cfgFor(dir, ['r-fast', 'r-slow']);
  cfg.providers['r-slow'].price = { input: 1, output: 1 }; // paid: left out of the race
  let s = await dispatch(cfg, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', race: true });
  assert.ok(!s.race, 'one free route left: a normal run');
  assert.ok(s.warnings.some((w) => /only 1 provider ready/.test(w)));
  const { dir: d2 } = repo();
  const cfg2 = cfgFor(d2, ['r-fast', 'r-slow']);
  s = await dispatch(cfg2, { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1' });
  assert.ok(!s.race && !s.samples, 'off by default');
});

test('a stop signal kills a running process group and says so', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 200);
  const t0 = Date.now();
  const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { signal: ctrl.signal });
  assert.equal(r.cancelled, true);
  assert.ok(Date.now() - t0 < 12_000);
});
