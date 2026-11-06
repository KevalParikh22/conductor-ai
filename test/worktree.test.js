// Worktree runs and `conductor batch` (parallel tasks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
// Fake agents: read the prompt file, write src/<task>.js, take ~1s so parallelism is measurable.
const agent = (who) => `if (process.env.PWD !== process.cwd()) { console.error('PWD mismatch'); process.exit(1); } const p=fs.readFileSync(args[0],'utf8'); const id=(p.match(/Your task id: (\\w+)/)||[])[1]||'free';
  setTimeout(()=>{ fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/'+id+'.js','// by ${who}\\n');
  console.log('## RESULT: DONE\\n## Files changed\\n- src/'+id+'.js\\n## Notes\\n- ${who} '+(p.includes('Design notes')?'saw design notes':'no notes')); }, Number(process.env.FAKE_DELAY_MS) || 1000);`;
fakeBins({
  'agent-a': agent('a'),
  'agent-b': agent('b'),
  // records where its prompt file is, then writes into the path given in LEAK_TARGET (simulating a worker that escapes)
  'agent-leaky': `fs.writeFileSync(process.env.PROMPT_PATH_LOG, args[0]); fs.writeFileSync(process.env.LEAK_TARGET, 'oops'); console.log('## RESULT: DONE but I wrote elsewhere');`,
  'agent-broken': `fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/junk.js','x'); console.error('crashed'); process.exit(1);`,
});

const { loadConfig } = await import('../src/config.js');
const { dispatch, clearCooldowns, UsageError } = await import('../src/core.js');
const { runBatch, planBatch } = await import('../src/batch.js');
const { listWorktrees, removeWorktree } = await import('../src/worktree.js');

const PLAN = `# Plan: demo

## Design notes
- each task writes src/<id>.js

## Tasks

### T1: one
- **role:** build
- **depends on:** none
- **files:** \`src/T1.js\`

### T2: two
- **role:** build
- **files:** \`src/T2.js\`
- **verify:** \`test -f src/T2.js\`

### T3: three
- **role:** build
- **depends on:** T1
- **files:** \`src/T1.js\`
`;

function cfgFor(dir) {
  const cfg = loadConfig(dir);
  const cli = (bin) => ({ type: 'cli', enabled: true, bin, write: ['{promptFile}'], read: ['{promptFile}'] });
  cfg.providers = { ...cfg.providers, 'agent-a': cli('agent-a'), 'agent-b': cli('agent-b'), 'agent-broken': cli('agent-broken'), 'agent-leaky': cli('agent-leaky') };
  cfg.roles = { ...cfg.roles, build: ['agent-a', 'agent-b'] };
  return cfg;
}

test('--worktree runs on its own branch, commits there, and leaves the main checkout alone', async () => {
  clearCooldowns();
  // on main, with an uncommitted change and an ignored node_modules: both fine for worktree runs
  const { dir, git } = makeRepo({ branch: null, files: { 'docs/plan/p.md': PLAN, '.gitignore': 'node_modules/\n', 'node_modules/dep/index.js': '' } });
  fs.writeFileSync(path.join(dir, 'scratch.txt'), 'mine');
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', worktree: true });
  assert.equal(s.winner, 'agent-a');
  assert.equal(s.verify.status, 'PASS');
  assert.match(s.worktree.commit, /^[0-9a-f]{7,}$/);
  assert.deepEqual(s.worktree.linked, ['node_modules']);
  assert.ok(s.warnings.some((w) => w.includes('uncommitted changes')));
  assert.equal(git('symbolic-ref', '--short', 'HEAD').trim(), 'main', 'main checkout stays on its branch');
  assert.ok(!fs.existsSync(path.join(dir, 'src/T1.js')), 'the main checkout is not written to');
  assert.equal(fs.readFileSync(path.join(dir, 'scratch.txt'), 'utf8'), 'mine');
  assert.equal(git('show', 'conductor/T1:src/T1.js'), '// by a\n');
  assert.match(git('log', '-1', '--format=%s', 'conductor/T1'), /conductor: T1 by agent-a \(verify PASS\)/);
  assert.equal(git('status', '--porcelain', '--', 'node_modules').trim(), '');
  assert.match(fs.readFileSync(path.join(dir, s.runDir, 'task.md'), 'utf8'), /each task writes src/, 'design notes are inlined');

  // a second run for the same task is refused unless --replace
  await assert.rejects(dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', worktree: true }), UsageError);
  const again = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T1', worktree: true, replace: true, chain: ['agent-b'] });
  assert.equal(git('show', 'conductor/T1:src/T1.js'), '// by b\n');

  // merge, then rm deletes the merged branch
  git('merge', '-q', '--no-ff', 'conductor/T1', '-m', 'merge T1');
  assert.deepEqual(listWorktrees(dir).map((w) => [w.id, w.merged]), [['T1', true]]);
  assert.ok(removeWorktree(dir, 'T1').some((l) => l.includes('deleted branch')));
  assert.ok(!fs.existsSync(again.worktree.dir));
  assert.deepEqual(listWorktrees(dir), []);
});

test('a failed worktree run stashes the attempt and removes the empty worktree', async () => {
  clearCooldowns();
  const { dir, git } = makeRepo({ files: { 'docs/plan/p.md': PLAN } });
  const s = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T2', worktree: true, chain: ['agent-broken'] });
  assert.equal(s.exitCode, 3);
  assert.equal(s.attempts[0].stashed, true);
  assert.equal(s.worktree.removed, true);
  assert.ok(!fs.existsSync(s.worktree.dir));
  assert.equal(git('branch', '--list', 'conductor/T2').trim(), '');
  assert.match(git('stash', 'list'), /failed attempt by agent-broken T2/);
});

test('--worktree is refused for read-only roles', async () => {
  const { dir } = makeRepo();
  await assert.rejects(dispatch(cfgFor(dir), { role: 'ask', task: 'q', worktree: true }), /read-only/);
});

test('batch runs independent tasks in parallel on different providers', async () => {
  clearCooldowns();
  const { dir, git } = makeRepo({ files: { 'docs/plan/p.md': PLAN } });
  // 3s tasks: one after another takes 6s+, so finishing under 5s shows they ran at the same time, with room for a slow runner
  process.env.FAKE_DELAY_MS = '3000';
  const t0 = Date.now();
  const b = await runBatch(cfgFor(dir), { planPath: 'docs/plan/p.md', tasks: ['T1', 'T2'] }).finally(() => { delete process.env.FAKE_DELAY_MS; });
  const secs = (Date.now() - t0) / 1000;
  assert.equal(b.exitCode, 0);
  assert.deepEqual(b.results.map((r) => r.summary.winner), ['agent-a', 'agent-b'], 'spread across providers');
  assert.ok(secs < 5, `ran in parallel (took ${secs}s for two 3s tasks)`);
  assert.equal(git('show', 'conductor/T1:src/T1.js'), '// by a\n');
  assert.equal(git('show', 'conductor/T2:src/T2.js'), '// by b\n');
  assert.ok(!fs.existsSync(path.join(dir, 'src')), 'main checkout untouched');
  assert.equal(listWorktrees(dir).length, 2);

  // unmerged branches are kept unless forced
  assert.ok(removeWorktree(dir, 'T2').some((l) => l.includes('kept branch')));
  assert.ok(removeWorktree(dir, 'T2', { force: true }).some((l) => l.includes('deleted branch')));
  removeWorktree(dir, 'T1', { force: true });
  assert.deepEqual(listWorktrees(dir), []);
});

test('batch refuses dependencies inside the batch and warns about shared files', () => {
  const { dir } = makeRepo({ files: { 'docs/plan/p.md': PLAN } });
  const cfg = cfgFor(dir);
  assert.throws(() => planBatch(cfg, { planPath: 'docs/plan/p.md', tasks: ['T1', 'T3'] }), /T3 depends on T1/);
  const p = planBatch(cfg, { planPath: 'docs/plan/p.md', tasks: ['T2', 'T3'] });
  assert.deepEqual(p.warnings, []);
  const shared = PLAN.replace('- **depends on:** T1\n', '');
  fs.writeFileSync(path.join(dir, 'docs/plan/q.md'), shared);
  assert.match(planBatch(cfg, { planPath: 'docs/plan/q.md', tasks: ['T1', 'T3'] }).warnings[0], /T1 and T3 both list src\/T1\.js/);
  assert.throws(() => planBatch(cfg, { planPath: 'docs/plan/p.md', tasks: ['T9'] }), /not found/);
});

test('worktree runs keep the prompt file outside the repo, use the task verify line, and flag writes to the main checkout', async () => {
  clearCooldowns();
  const { dir, git } = makeRepo({ files: { 'docs/plan/p.md': PLAN } });
  const ok = await dispatch(cfgFor(dir), { role: 'build', planPath: 'docs/plan/p.md', taskId: 'T2', worktree: true });
  assert.equal(ok.verify.scope, 'task');
  assert.equal(ok.verify.cmd, 'test -f src/T2.js');
  assert.equal(ok.verify.status, 'PASS');
  removeWorktree(dir, 'T2', { force: true });

  const log = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.CONDUCTOR_HOME), 'p-')), 'prompt-path');
  process.env.PROMPT_PATH_LOG = log;
  process.env.LEAK_TARGET = path.join(dir, 'leaked.txt');
  const s = await dispatch(cfgFor(dir), { role: 'build', task: 'do x', worktree: true, worktreeId: 'leak', chain: ['agent-leaky'] });
  const promptPath = fs.readFileSync(log, 'utf8');
  assert.ok(![dir, fs.realpathSync(dir)].some((d) => promptPath.startsWith(d + path.sep)), `prompt file must not be inside the repo: ${promptPath}`);
  assert.ok(!fs.existsSync(promptPath), 'the worker IO folder is cleaned up');
  assert.deepEqual(s.leaked, ['leaked.txt']);
  assert.ok(s.warnings.some((w) => w.includes('MAIN checkout') && w.includes('leaked.txt')));
  removeWorktree(dir, 'leak', { force: true });
  assert.match(git('status', '--porcelain'), /leaked\.txt/);
});
