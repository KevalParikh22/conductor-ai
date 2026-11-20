// conductor-ai runs recheck: verify again on a run's own commit, after something outside its code was fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo } from './helpers.js';

isolateHome();
const { recheckRuns, listRuns, runGates, readRun, formatRecheck } = await import('../src/runs.js');
const { outcome } = await import('../src/outcome.js');

test('recheck runs verify on the run\'s commit with the shared folders, updates the run and keeps the first result', async () => {
  const { dir, git } = makeRepo({ files: { '.gitignore': 'node_modules/\n.conductor/\n' } });
  // the task's commit, on a branch that was merged and deleted since: its commit is all that's left
  git('switch', '-qc', 'conductor/T1'); fs.writeFileSync(path.join(dir, 'task.js'), 'x'); git('add', '-A'); git('commit', '-qm', 'T1');
  const commit = git('rev-parse', '--short', 'HEAD').trim();
  git('switch', '-q', 'feat/x'); git('merge', '-q', '--no-ff', '-m', 'merge', 'conductor/T1'); git('branch', '-qd', 'conductor/T1');
  // verify needs the task's file (from the commit) and a package in node_modules (ignored, shared from the main checkout)
  const cmd = 'node -e "const f=require(\'fs\');process.exit(f.existsSync(\'task.js\')&&f.existsSync(\'node_modules/dep/ok\')?0:1)"';
  const mk = (id, extra) => { const d = path.join(dir, '.conductor', 'runs', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'summary.json'), JSON.stringify({ role: 'build', mode: 'write', winner: 'a', status: '## RESULT: DONE', changed: ['task.js'], attempts: [{ provider: 'a', ok: true }], startedAt: '2026-10-30T14:35:00Z', ...extra })); };
  mk('20261030-1-build-T1', { verify: { status: 'FAIL', cmd, log: 'old.log' }, worktree: { id: 'T1', branch: 'conductor/T1', base: 'x', commit } });
  mk('20261030-2-build-T2', { verify: { status: 'FAIL', cmd } }); // not a worktree run: no commit to check
  mk('20261030-3-build-T3', { verify: { status: 'PASS', cmd }, worktree: { commit } }); // passed: not picked by default

  let rows = await recheckRuns(dir, []);
  assert.deepEqual(rows.map((r) => [r.id, r.after || 'skipped']), [['20261030-1-build-T1', 'FAIL'], ['20261030-2-build-T2', 'skipped']]);
  assert.match(formatRecheck(rows), /0 now pass, 1 still fail, 1 skipped/);

  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true }); fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'ok'), '');
  rows = await recheckRuns(dir, ['20261030-1']);
  assert.equal(rows[0].after, 'PASS');
  const s = readRun(dir, '20261030-1-build-T1').summary;
  assert.equal(s.verify.status, 'PASS');
  assert.deepEqual(s.verify.rechecked.first, { status: 'FAIL', log: 'old.log', at: '2026-10-30T14:35:00Z' }, 'the first result is kept, not the first recheck');
  assert.equal(outcome(s), 'done');
  assert.match(runGates(s).find((g) => g.id === 'verify').evidence, /run again .* \(it was FAIL when the run finished\)/);
  assert.ok(listRuns(dir).find((r) => r.id === '20261030-1-build-T1').rechecked);
  assert.equal(git('worktree', 'list').trim().split('\n').length, 1, 'the throwaway checkout is gone');
});
