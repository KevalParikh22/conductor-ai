// Continuing a task in its existing worktree (retry with a note), and agy's sandbox rules for unattended builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo, fakeBins, PLAN } from './helpers.js';

isolateHome();
// writes first.txt on a fresh task; on a continued one, checks it can see the earlier work and writes fix.txt
fakeBins({
  'agent-w': `const p = args[0];
const again = p.includes('You are continuing this task');
if (again && !fs.existsSync('first.txt')) { console.log('## RESULT: FAILED\\nearlier work missing'); process.exit(0); }
fs.writeFileSync(again ? 'fix.txt' : 'first.txt', again ? (p.match(/Orchestrator note \\(important\\)\\n(.*)/) || [])[1] : 'v1');
console.log('## RESULT: DONE\\n## Files changed\\n- ' + (again ? 'fix.txt' : 'first.txt'));`,
  'agent-other': `fs.writeFileSync('other.txt', 'x'); console.log('## RESULT: DONE\\n## Files changed\\n- other.txt');`,
  'agent-broken': `process.exit(1);`,
});

const { dispatch, clearCooldowns, buildCommands } = await import('../src/core.js');
const { loadConfig } = await import('../src/config.js');
const { readWorktreeMeta } = await import('../src/worktree.js');
const { withCommands } = await import('../src/providers.js');
const { CLI_PRESETS, BUILD_COMMANDS } = await import('../src/presets.js');

function setup() {
  clearCooldowns();
  const { dir, git } = makeRepo({ files: { 'docs/plan.md': PLAN } });
  const providers = {
    'agent-w': { type: 'cli', enabled: true, bin: 'agent-w', write: ['{prompt}'], read: ['{prompt}'] },
    'agent-other': { type: 'cli', enabled: true, bin: 'agent-other', write: ['x'], read: ['x'] },
    'agent-broken': { type: 'cli', enabled: true, bin: 'agent-broken', write: ['x'], read: ['x'] },
  };
  fs.mkdirSync(path.join(dir, '.conductor'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.conductor/config.json'), JSON.stringify({ providers, roles: { build: ['agent-w'], fix: ['agent-w'] }, settings: { autoVerify: false } }));
  git('add', '-A'); git('commit', '-qm', 'conductor config');
  return { dir, git, cfg: loadConfig(dir) };
}

test('continue: the same worker picks up its earlier work in the worktree, with the note', async () => {
  const { dir, git, cfg } = setup();
  const first = await dispatch(cfg, { role: 'build', planPath: 'docs/plan.md', taskId: 'T1', worktree: true, chain: ['agent-other', 'agent-w'].reverse() });
  assert.equal(first.winner, 'agent-w');
  assert.equal(readWorktreeMeta(dir, 'T1').winner, 'agent-w');
  const again = await dispatch(cfg, { role: 'build', planPath: 'docs/plan.md', taskId: 'T1', continue: true, note: 'rename the export to sum' });
  assert.equal(again.winner, 'agent-w', 'same worker by default');
  assert.equal(again.worktree.continued, true);
  assert.match(again.worktree.commit, /^[0-9a-f]{7,}$/);
  const wt = again.worktree.dir;
  assert.equal(fs.readFileSync(path.join(wt, 'fix.txt'), 'utf8'), 'rename the export to sum');
  assert.ok(fs.existsSync(path.join(wt, 'first.txt')), 'earlier work kept');
  assert.equal(git('rev-list', '--count', 'HEAD..conductor/T1').trim(), '2', 'one commit per round');
  assert.match(git('log', '-1', '--format=%s', 'conductor/T1'), /T1 \(continued\) by agent-w/);
});

test('continue: a failed retry keeps the worktree and its earlier work; another provider can be named', async () => {
  const { cfg } = setup();
  const first = await dispatch(cfg, { role: 'build', planPath: 'docs/plan.md', taskId: 'T1', worktree: true, chain: ['agent-w'] });
  const failed = await dispatch(cfg, { role: 'build', planPath: 'docs/plan.md', taskId: 'T1', continue: true, note: 'x', chain: ['agent-broken'] });
  assert.equal(failed.winner, null);
  assert.ok(!failed.worktree.removed);
  assert.ok(fs.existsSync(path.join(first.worktree.dir, 'first.txt')));
  const other = await dispatch(cfg, { role: 'build', planPath: 'docs/plan.md', taskId: 'T1', continue: true, note: 'x', provider: 'agent-other' });
  assert.equal(other.winner, 'agent-other');
});

test('continue without a worktree says how to start one; conductor retry runs it from the CLI', async () => {
  const { dir, cfg } = setup();
  await assert.rejects(dispatch(cfg, { role: 'build', planPath: 'docs/plan.md', taskId: 'T1', continue: true, note: 'x' }), /no worktree for "T1"/);
  await dispatch(cfg, { role: 'build', planPath: 'docs/plan.md', taskId: 'T1', worktree: true, chain: ['agent-w'] });
  const bin = new URL('../bin/conductor.js', import.meta.url).pathname;
  const run = (...a) => execFileSync(process.execPath, [bin, ...a], { cwd: dir, env: process.env }).toString();
  assert.throws(() => run('retry', 'T1'), /needs --note/);
  const out = run('retry', 'T1', '--note', 'use sum not add');
  assert.match(out, /worker: +agent-w/);
  assert.match(out, /T1 \(continued\)|on conductor\/T1/);
});

test('agy: only conductor\'s sensitive files are denied, not the folder its worktrees live in', () => {
  for (const mode of ['write', 'read']) {
    const deny = CLI_PRESETS.antigravity.sessionSettings[mode].permissions.deny;
    assert.ok(!deny.includes('read_file({conductorHome})'), `${mode}: whole folder not denied`);
    for (const f of ['secrets.env', 'config.json', 'state.json', 'usage.jsonl']) assert.ok(deny.includes(`read_file({conductorHome}/${f})`), `${mode}: ${f} denied`);
  }
});

test('agy: build and test commands, the verify command and allowCommands run without a prompt', () => {
  const cmds = buildCommands({ verify: 'npx tsc --noEmit && npx expo lint; npm test', allowCommands: ['npx expo export'] });
  for (const c of ['npx tsc', 'npx jest', 'npx expo lint', 'npx tsc --noEmit', 'npm test', 'npx expo export']) assert.ok(cmds.includes(c), c);
  const s = withCommands({ permissions: { deny: ['command(git push)'] } }, cmds);
  assert.ok(s.permissions.allow.includes('command(npx jest)'));
  assert.deepEqual(s.permissions.deny, ['command(git push)'], 'deny rules kept (they win)');
  assert.ok(BUILD_COMMANDS.every((c) => !/^git |sudo/.test(c)));
});
