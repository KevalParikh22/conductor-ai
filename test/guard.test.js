// Q8b: guard hooks (formats checked against real Claude Code and Antigravity runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo } from './helpers.js';

isolateHome();
const G = await import('../src/guard.js');
const bin = path.resolve('bin/conductor.js');

test('commit detection: git commit in any position of a shell line, nothing else', () => {
  for (const c of ['git commit -m x', 'cd a && git commit -am y', 'x; git commit', '(git commit)', 'git -C sub commit', 'git -c user.name=t commit --allow-empty']) assert.equal(G.isCommit(c), true, c);
  for (const c of ['git status', 'echo git commit', 'git commit-tree x', 'gitcommit', '', undefined]) assert.equal(G.isCommit(c), false, String(c));
});

test('a failed verify blocks commits on that HEAD only; a pass, a new commit or allow lifts it', () => {
  const { dir, git } = makeRepo();
  assert.equal(G.commitBlock(dir), null, 'nothing recorded');
  G.recordVerify(dir, { status: 'FAIL', cmd: 'npm test' });
  assert.match(G.commitBlock(dir), /the last verify failed \(`npm test`\), so this commit is blocked/);
  G.allowCommit(dir);
  assert.equal(G.commitBlock(dir), null, 'allowed once on this HEAD');
  G.recordVerify(dir, { status: 'FAIL', cmd: 'npm test' });
  assert.ok(G.commitBlock(dir), 'a new failure blocks again');
  git('commit', '-q', '--allow-empty', '-m', 'next');
  assert.equal(G.commitBlock(dir), null, 'a different HEAD: that failure was about older code');
  G.recordVerify(dir, { status: 'PASS', cmd: 'npm test' });
  assert.equal(G.commitBlock(dir), null);
  G.recordVerify(dir, { status: 'SKIPPED' });
  assert.equal(G.readVerifyState(dir).status, 'PASS', 'SKIPPED is not recorded');
});

test('hook answers: Claude exit 2 + reason; agy deny + reason, and "ask" (never {}) otherwise', () => {
  const { dir } = makeRepo();
  G.recordVerify(dir, { status: 'FAIL', cmd: 'npm test' });
  const c = G.runHook('claude-pretool', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, dir);
  assert.deepEqual([c.code, c.stdout], [2, '']);
  assert.match(c.stderr, /commit is blocked/);
  assert.deepEqual(G.runHook('claude-pretool', { tool_input: { command: 'npm test' } }, dir), { stdout: '', stderr: '', code: 0 });
  const a = JSON.parse(G.runHook('agy-pretool', { toolCall: { name: 'run_command', args: { CommandLine: 'git commit -m x' } } }, dir).stdout);
  assert.equal(a.decision, 'deny'); assert.match(a.reason, /commit is blocked/);
  assert.deepEqual(JSON.parse(G.runHook('agy-pretool', { toolCall: { args: { CommandLine: 'ls' } } }, dir).stdout), { decision: 'ask' }, 'agy denies on {}: "ask" defers to its own rules');
});

test('Stop reminder lists task branches waiting for review, and stays quiet otherwise', async () => {
  const { createWorktree } = await import('../src/worktree.js');
  const { dir } = makeRepo();
  assert.equal(G.runHook('claude-stop', {}, dir).stdout, '');
  const wt = createWorktree(dir, 'T7');
  fs.writeFileSync(path.join(wt.dir, 'x.js'), '1\n');
  execFileSync('git', ['add', '-A'], { cwd: wt.dir }); execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'w'], { cwd: wt.dir });
  const out = JSON.parse(G.runHook('claude-stop', {}, dir).stdout);
  assert.match(out.systemMessage, /1 task branch waiting for review \(conductor\/T7\)/);
  assert.equal(G.runHook('claude-stop', { stop_hook_active: true }, dir).stdout, '', 'never loops');
});

test('turning guards on and off keeps your own hooks; bad JSON is never overwritten; other controllers are refused', () => {
  const { dir } = makeRepo();
  const f = path.join(dir, '.claude/settings.local.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'mine.sh' }] }] } }));
  assert.equal(G.setGuards(dir, 'claude-code', true).changed, true);
  assert.equal(G.setGuards(dir, 'claude-code', true).changed, false, 'idempotent');
  let d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(d.permissions, { allow: ['Bash(ls)'] });
  assert.equal(d.hooks.PreToolUse.length, 2);
  assert.ok(G.guardsOn(dir, 'claude-code'));
  G.setGuards(dir, 'claude-code', false);
  d = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(d.hooks, { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'mine.sh' }] }] }, 'only ours removed');
  G.setGuards(dir, 'antigravity', true);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, '.agents/hooks.json'), 'utf8'))['conductor-guard'].PreToolUse[0].matcher === 'run_command');
  G.setGuards(dir, 'antigravity', false);
  assert.ok(!fs.existsSync(path.join(dir, '.agents/hooks.json')), 'a file conductor emptied is removed');
  fs.writeFileSync(f, '{ broken');
  assert.throws(() => G.setGuards(dir, 'claude-code', true), /not valid JSON/);
  assert.equal(G.setGuards(dir, 'codex-cli', true).unsupported, true);
});

test('CLI: the hook never blocks on its own errors; guard on / status / off; verify records state', () => {
  const { dir } = makeRepo();
  const run = (args, input) => { try { return { out: execFileSync('node', [bin, ...args], { cwd: dir, input, encoding: 'utf8', env: process.env }), code: 0 }; } catch (e) { return { out: `${e.stdout}${e.stderr}`, code: e.status }; } };
  assert.deepEqual(JSON.parse(run(['hook', 'agy-pretool'], 'not json').out), { decision: 'ask' });
  assert.equal(run(['hook', 'claude-pretool'], 'not json').code, 0);
  assert.match(run(['guard', 'on']).out, /guards on \(\.claude\/settings\.local\.json\)/);
  assert.match(run(['guard', 'status']).out, /on \(\.claude\/settings\.local\.json\)[\s\S]*last verify: (PASS|FAIL)?|none recorded/);
  run(['verify']);
  assert.equal(G.readVerifyState(dir).status, 'PASS', 'makeRepo has a passing test script');
  assert.match(run(['guard', 'off']).out, /guards off/);
});
