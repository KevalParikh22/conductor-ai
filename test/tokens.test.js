// Token savers: the smart selector, trimmed reports and compact diffs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolateHome, makeRepo, fakeBins } from './helpers.js';

isolateHome();
fakeBins({ 'agent-a': `console.log('## RESULT: DONE\\n## Files changed\\n- (none)\\n## Notes\\n- ok');` });

const { taskSize, smartOrder } = await import('../src/selector.js');
const { trimReport, dispatch, clearCooldowns } = await import('../src/core.js');
const { compactDiff } = await import('../src/diffview.js');
const { recordUsage } = await import('../src/usage.js');
const { loadConfig } = await import('../src/config.js');

const agent = (name) => ({ name, p: { type: 'cli', bin: name } });
const freeApi = (name) => ({ name, p: { type: 'openai', baseUrl: 'https://x.example/v1', free: true } });
const paidApi = (name) => ({ name, p: { type: 'openai', baseUrl: 'https://y.example/v1', price: { input: 1, output: 2 } } });

test('task size: listed files and short text are small; unlisted or many files are large', () => {
  assert.equal(taskSize({ role: 'fix', mode: 'write', body: 'fix the typo', files: ['a.js'] }).size, 'small');
  assert.equal(taskSize({ role: 'build', mode: 'write', body: 'add login', files: [] }).size, 'large');
  assert.equal(taskSize({ role: 'build', mode: 'write', body: 'x', files: ['a', 'b', 'c'] }).size, 'large');
  assert.equal(taskSize({ role: 'review', mode: 'read', diffBytes: 5000 }).size, 'small');
  assert.equal(taskSize({ role: 'review', mode: 'read', diffBytes: 90000 }).size, 'large');
});

test('selector: small tasks try free API models first, large ones agents first, paid APIs last; skips stay put', () => {
  const chain = [paidApi('paid'), agent('agent-1'), freeApi('free-1'), { name: 'gone', skip: 'disabled' }, agent('agent-2')];
  const small = smartOrder(chain, { role: 'fix', mode: 'write', body: 'x', files: ['a.js'] });
  assert.deepEqual(small.chain.map((e) => e.name), ['free-1', 'agent-1', 'agent-2', 'paid', 'gone']);
  assert.match(small.note, /small task.*free API models first/);
  const large = smartOrder(chain, { role: 'build', mode: 'write', body: 'x', files: [] });
  assert.deepEqual(large.chain.map((e) => e.name), ['agent-1', 'agent-2', 'free-1', 'paid', 'gone']);
  const already = [agent('a'), freeApi('f')];
  assert.equal(smartOrder(already, { role: 'build', mode: 'write', body: 'x' }).note, '', 'no note when nothing moved');
});

test('selector: a provider that failed 3 times in a row goes last; rate limits do not count', () => {
  for (let i = 0; i < 3; i++) recordUsage({ provider: 'flaky', ok: false, reason: 'exit 1' });
  for (let i = 0; i < 3; i++) recordUsage({ provider: 'limited', ok: false, reason: 'quota' });
  const r = smartOrder([agent('flaky'), agent('limited'), agent('fine')], { role: 'build', mode: 'write', body: 'x' });
  assert.deepEqual(r.chain.map((e) => e.name), ['limited', 'fine', 'flaky']);
  assert.match(r.note, /moved last: flaky/);
});

test('selector runs inside dispatch unless the chain or provider is given', async () => {
  clearCooldowns();
  const { dir } = makeRepo();
  const cfg = loadConfig(dir);
  cfg.providers['agent-a'] = { type: 'cli', enabled: true, bin: 'agent-a', write: ['x'], read: ['x'] };
  cfg.providers.dead = { type: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:9/v1', apiKeyEnv: '', model: 'm', free: true };
  cfg.roles.fix = ['agent-a', 'dead'];
  const s = await dispatch(cfg, { role: 'fix', task: 'fix it', files: ['a.js'], noVerify: true });
  assert.match(s.selector, /free API models first/);
  assert.deepEqual(s.attempts.map((a) => a.provider), ['dead', 'agent-a'], 'the free API went first, then fell back');
  const pinned = await dispatch(cfg, { role: 'fix', task: 'fix it', chain: ['agent-a', 'dead'], noVerify: true, allowDirty: true });
  assert.equal(pinned.selector, undefined);
});

test('report.md keeps the RESULT block, not the transcript before it', () => {
  const transcript = 'tool call 1\n'.repeat(500) + '## RESULT: DONE\n## Files changed\n- a.js\n';
  assert.equal(trimReport(transcript), '## RESULT: DONE\n## Files changed\n- a.js\n');
  assert.match(trimReport('x'.repeat(20000), 8000), /start cut/);
  assert.ok(trimReport('x'.repeat(20000), 8000).length < 8100);
});

test('compact diff: whitespace ignored, lockfiles hidden, new files included, long files cut', () => {
  const { dir, git } = makeRepo({ files: { 'a.js': 'const a = 1;\nconst b = 2;\n', 'package-lock.json': '{}\n' } });
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n    const b = 2;\nconst c = 3;\n'); // one real change, one re-indent
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{\n' + '"x": 1,\n'.repeat(300) + '}\n');
  fs.writeFileSync(path.join(dir, 'new.js'), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'));
  const d = compactDiff(dir, { maxFileLines: 20 });
  assert.match(d.text, /hidden \(generated\/lockfiles\): package-lock\.json/);
  assert.ok(!d.text.includes('"x": 1'), 'lockfile content not shown');
  assert.ok(d.text.includes('+const c = 3;'));
  assert.ok(!d.text.includes('+    const b = 2;'), 'whitespace-only change left out');
  assert.match(d.text, /A new\.js/);
  assert.match(d.text, /more lines in new\.js/);
  assert.ok(d.chars < d.fullChars);

  git('add', '-A'); git('commit', '-qm', 'work'); git('switch', '-qc', 'conductor/T1');
  fs.writeFileSync(path.join(dir, 'b.js'), 'b\n'); git('add', '-A'); git('commit', '-qm', 'T1'); git('switch', '-q', 'feat/x');
  const out = execFileSync(process.execPath, [new URL('../bin/conductor.js', import.meta.url).pathname, 'diff', 'conductor/T1'], { cwd: dir }).toString();
  assert.match(out, /1 file changed, \+1 -0 \(HEAD\.\.\.conductor\/T1\)/);
});

test('help: short by default, everything with help all', () => {
  const bin = new URL('../bin/conductor.js', import.meta.url).pathname;
  const short = execFileSync(process.execPath, [bin, '--help']).toString();
  const all = execFileSync(process.execPath, [bin, 'help', 'all']).toString();
  assert.ok(short.split('\n').length < 25, 'short help fits on one screen');
  assert.match(all, /conductor cooldown/);
  assert.ok(all.length > short.length * 2);
});
