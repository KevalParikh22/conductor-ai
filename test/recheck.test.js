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

test('a running run shows its current step from live.json; the UI rechecks over POST /api/recheck, one at a time', async () => {
  const { createUiServer } = await import('../src/ui/server.js');
  const { dir } = makeRepo({ files: { '.gitignore': '.conductor/\n' } });
  const d = path.join(dir, '.conductor', 'runs', '20261120-1-build-T9'); fs.mkdirSync(d, { recursive: true });
  assert.equal(listRuns(dir)[0].state, 'running');
  fs.writeFileSync(path.join(d, 'live.json'), JSON.stringify({ role: 'build', task: 'T9', startedAt: '2026-11-20T10:00:00Z', step: 'codex-cli is working', since: '2026-11-20T10:00:05Z', limitMs: 1200000 }));
  const row = listRuns(dir)[0];
  assert.deepEqual([row.state, row.task, row.step, row.limitMs], ['running', 'T9', 'codex-cli is working', 1200000]);

  const ui = createUiServer({ cwd: dir, token: 'tok' });
  const port = await ui.listen(0);
  const post = (body) => fetch(`http://127.0.0.1:${port}/api/recheck`, { method: 'POST', headers: { 'x-conductor-token': 'tok', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const r = await post({ ids: ['20261120-1-build-T9'] });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).rows, [{ id: '20261120-1-build-T9', skipped: 'it is still running' }]);
  } finally { ui.server.closeAllConnections?.(); ui.server.close(); }
});

test('the run page of a running run: its step from live.json, then the full detail once it finishes', async () => {
  const { runDetail } = await import('../src/runs.js');
  const { dir } = makeRepo({ files: { '.gitignore': '.conductor/\n' } });
  const d = path.join(dir, '.conductor', 'runs', '20261120-2-build-T8'); fs.mkdirSync(d, { recursive: true });
  assert.equal(runDetail(dir, '20261120-2-build-T8'), null, 'nothing written yet');
  fs.writeFileSync(path.join(d, 'live.json'), JSON.stringify({ role: 'build', task: 'T8', startedAt: 'a', step: 'running verify', since: 'b', limitMs: 0 }));
  assert.deepEqual(runDetail(dir, '20261120-2-build-T8'), { id: '20261120-2-build-T8', state: 'running', role: 'build', task: 'T8', startedAt: 'a', step: 'running verify', since: 'b', limitMs: 0, output: [] });
  assert.equal(runDetail(dir, '../x'), null);
  fs.writeFileSync(path.join(d, 'summary.json'), JSON.stringify({ role: 'build', mode: 'write', winner: 'a', status: '## RESULT: DONE', attempts: [{ provider: 'a', ok: true }], verify: { status: 'PASS', cmd: 'true' } }));
  assert.equal(runDetail(dir, '20261120-2-build-T8').state, 'done');
});

test('live worker output: a CLI worker\'s output reaches <provider>.live.log while it runs, cleaned of colours and redraws', async () => {
  const { fakeBins } = await import('./helpers.js');
  const { runProvider } = await import('../src/providers.js');
  const { liveOutput } = await import('../src/runs.js');
  fakeBins({ 'slow-agent': `process.stdout.write('\\x1b[32mreading files\\x1b[0m\\n50%\\r100%\\n'); setTimeout(() => console.log('## RESULT: DONE'), 600);` });
  const { dir } = makeRepo();
  const runDir = fs.mkdtempSync(path.join(dir, 'run-')), liveLog = path.join(runDir, 'slow.live.log');
  const p = runProvider('slow', { type: 'cli', enabled: true, bin: 'slow-agent', write: ['{promptFile}'] }, { mode: 'write', prompt: 'x', cwd: dir, runDir, quotaRe: /quota/, timeoutMs: 10_000, liveLog });
  await new Promise((r) => setTimeout(r, 300));
  const mid = liveOutput(runDir);
  assert.equal(mid.length, 1);
  assert.equal(mid[0].worker, 'slow');
  assert.equal(mid[0].text, 'reading files\n100%\n', 'printed before the worker finished; no colour codes; the redrawn line shows its last state');
  const res = await p;
  assert.match(res.log, /RESULT: DONE/);
  assert.match(fs.readFileSync(liveLog, 'utf8'), /RESULT: DONE/);
});
