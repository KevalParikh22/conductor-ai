// S2/S3: `batch --merge` and `batch --all`. conductor merges each task that passed into the current branch (one at a
// time), runs verify on the merged code, and stops at the first conflict or failing verify. With --all, every worker
// task in the plan runs, each starting as soon as its dependencies are merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
const { clearCooldowns, UsageError } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');
const { runBatch, formatBatch } = await import('../src/batch.js');
const { listWorktrees } = await import('../src/worktree.js');

const task = (id, deps = 'none', file = `src/${id}.js`) => `### ${id}: make ${id}
- **role:** build
- **depends on:** ${deps}
- **files:** \`${file}\`
- **acceptance:**
  - [ ] \`${file}\` exists
`;
const plan = (...tasks) => `# Plan\n## Open questions\n- [x] none\n## Tasks\n${tasks.join('\n')}\n### T9: check the release\n- **role:** controller\n`;
// the worktree's folder names the task. A task with dependencies records which earlier files it could see, so the test
// can tell it started from the merged code. MERGE_SHARED=1: every task writes the same file (a conflict).
const worker = `let p='';process.stdin.on('data',d=>p+=d).on('end',()=>{const id=require('path').basename(process.cwd()).replace(/-h$/,'');
  const f=process.env.MERGE_SHARED?'src/shared.js':'src/'+id+'.js';const saw=['T1','T2'].filter(x=>fs.existsSync('src/'+x+'.js')).join(',');
  setTimeout(()=>{const o=args[args.indexOf('-o')+1];fs.mkdirSync('src',{recursive:true});fs.writeFileSync(f,'// '+id+' saw '+saw+'\\n');
  fs.writeFileSync(o,'## RESULT: DONE\\n## Files changed\\n- '+f+'\\n## Checks run\\n- true\\n## Acceptance\\n- [x] 1. exists — evidence: '+f+':1\\n');},150);});`;
fakeBins({ 'm-a': worker, 'm-b': worker });
const cfgFor = (dir, settings = {}) => {
  const cfg = loadConfig(dir);
  cfg.providers = Object.fromEntries(['m-a', 'm-b'].map((b) => [b, { type: 'cli', preset: 'codex', enabled: true, bin: b, free: true }]));
  cfg.roles = { ...cfg.roles, build: ['m-a', 'm-b'] };
  cfg.settings = { ...cfg.settings, autoReview: false, verify: 'true', hedge: false, ...settings };
  return cfg;
};
const repo = (planText) => makeRepo({ files: { 'docs/plan/p.md': planText, 'src/.keep': '' } });

test('batch --all: runs every worker task, starts T3 after T1 and T2 are merged, merges all, leaves no worktrees', async () => {
  clearCooldowns();
  const { dir, git } = repo(plan(task('T1'), task('T2'), task('T3', 'T1, T2')));
  const b = await runBatch(cfgFor(dir), { planPath: 'docs/plan/p.md', all: true });
  assert.equal(b.exitCode, 0, formatBatch(b));
  assert.deepEqual(b.results.map((r) => r.task), ['T1', 'T2', 'T3'], 'the controller task T9 is left out');
  assert.ok(b.warnings.some((w) => /T9 \(controller\): not a worker task/.test(w)));
  assert.equal(b.merged, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'src/T3.js'), 'utf8'), '// T3 saw T1,T2\n', 'T3 started from the merged code');
  assert.equal(git('log', '--merges', '--format=%s').trim().split('\n').length, 3);
  assert.deepEqual(listWorktrees(dir), []);
  assert.equal(git('for-each-ref', '--format=%(refname:short)', 'refs/heads/conductor').trim(), '', 'merged branches deleted');
  assert.match(formatBatch(b), /3\/3 merged/);
  assert.match(formatBatch(b), /merged: [0-9a-f]+, verify passed on the merged code/);
});

test('batch --merge stops at a conflict: the merge is undone, the checkout is clean, dependents never start', async () => {
  clearCooldowns();
  process.env.MERGE_SHARED = '1';
  try {
    const { dir, git } = repo(plan(task('T1', 'none', 'src/shared.js'), task('T2', 'none', 'src/shared.js'), task('T3', 'T1, T2', 'src/shared.js')));
    const b = await runBatch(cfgFor(dir), { planPath: 'docs/plan/p.md', tasks: ['T1', 'T2', 'T3'], merge: true, concurrency: 2 });
    assert.equal(b.exitCode, 3);
    assert.equal(b.merged, 1);
    const conflict = b.results.find((r) => r.merge?.status === 'conflict');
    assert.ok(conflict, formatBatch(b));
    assert.deepEqual(conflict.merge.files, ['src/shared.js']);
    assert.equal(git('status', '--porcelain', '--untracked-files=no').trim(), '', 'the conflicted merge was aborted');
    assert.ok(b.results.find((r) => r.task === 'T3').blocked);
    assert.match(formatBatch(b), /NOT MERGED: conflict in src\/shared\.js/);
    assert.match(formatBatch(b), /stopped: +after T\d's merge \(conflict\)/);
  } finally { delete process.env.MERGE_SHARED; }
});

test('batch --merge: a failing verify on the merged code keeps that merge, says how to undo it, and stops', async () => {
  clearCooldowns();
  const { dir } = repo(plan(task('T1'), task('T2', 'T1')));
  // passes in T1's worktree (no merge commits there), fails on the branch once T1 is merged
  const b = await runBatch(cfgFor(dir, { verify: 'test -z "$(git log --merges --oneline)"' }), { planPath: 'docs/plan/p.md', tasks: ['T1', 'T2'], merge: true });
  assert.equal(b.exitCode, 3);
  assert.equal(b.results[0].merge.status, 'verify-failed');
  assert.ok(b.results[1].blocked);
  assert.match(formatBatch(b), /verify FAILED on the merged code .*git reset --hard HEAD~1/);
});

test('batch --merge refuses a dirty checkout and dependency cycles; without --merge dependencies are still refused', async () => {
  clearCooldowns();
  const { dir } = repo(plan(task('T1', 'T2'), task('T2', 'T1')));
  await assert.rejects(runBatch(cfgFor(dir), { planPath: 'docs/plan/p.md', all: true }), /depends on itself/);
  await assert.rejects(runBatch(cfgFor(dir), { planPath: 'docs/plan/p.md', tasks: ['T1', 'T2'] }), /depends on T2 in the same batch/);
  fs.writeFileSync(path.join(dir, 'docs/plan/p.md'), plan(task('T1')) + '\nedited\n');
  await assert.rejects(runBatch(cfgFor(dir), { planPath: 'docs/plan/p.md', all: true }), (e) => e instanceof UsageError && /clean checkout/.test(e.message));
});
