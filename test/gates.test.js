// Base check (H4) and scope gate (Q5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo, tmpdir } from './helpers.js';

isolateHome();
const { scopeCheck, failureLines, newFailures, baseVerify } = await import('../src/gates.js');
const { outcome, formatSummary } = await import('../src/core.js');

test('scope gate: listed files, their tests, folders, lockfiles and snapshots are in scope; the rest is listed', () => {
  const listed = ['src/food/types.ts', 'src/api/', 'lib/util.py', 'README.md'];
  const changed = ['src/food/types.ts', 'src/food/types.test.ts', 'tests/test_util.py', 'src/api/routes/x.ts', 'package-lock.json',
    'src/__snapshots__/a.snap', 'docs/README.md', 'src/other.ts', 'config/app.json', 'src/food/types.spec.tsx'];
  assert.deepEqual(scopeCheck(changed, listed).outside, ['src/other.ts', 'config/app.json']);
  assert.deepEqual(scopeCheck(['config/app.json'], listed, { allow: ['config/*.json'] }).outside, [], 'scopeAllow globs');
  assert.equal(scopeCheck(['anything.js'], []), null, 'no files listed: nothing to compare against');
});

test('failure lines ignore timings, so the same failure before and after compares equal', () => {
  const before = 'not ok 3 - parses dates (12.5ms)\nFAIL src/a.test.ts\nall good line';
  const after = 'not ok 3 - parses dates (40.1ms)\nFAIL src/a.test.ts\nFAIL src/b.test.ts\n';
  assert.deepEqual(failureLines(before).length, 2);
  assert.deepEqual(newFailures(failureLines(before), after), ['FAIL src/b.test.ts']);
});

test('base check runs verify once per commit and command, then reads the cache', async () => {
  const { dir, git } = makeRepo();
  const count = path.join(tmpdir('cnt-'), 'n');
  process.env.CNT_FILE = count;
  const settings = { verify: `node -e "require('fs').appendFileSync(process.env.CNT_FILE,'x'); console.log('FAIL thing'); process.exit(1)"`, timeoutSec: 60 };
  const log = (n) => path.join(tmpdir('log-'), `${n}.log`);
  const a = await baseVerify(dir, dir, settings, log(1));
  assert.deepEqual([a.status, a.cached, a.failures], ['FAIL', false, ['FAIL thing']]);
  const [b, c] = await Promise.all([baseVerify(dir, dir, settings, log(2)), baseVerify(dir, dir, settings, log(3))]);
  assert.ok(b.cached && c.cached);
  assert.equal(fs.readFileSync(count, 'utf8'), 'x', 'verify ran once');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x'); git('add', '-A'); git('commit', '-qm', 'next');
  assert.equal((await baseVerify(dir, dir, settings, log(4))).cached, false, 'a new commit is checked again');
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  await baseVerify(dir, dir, settings, log(5)); await baseVerify(dir, dir, settings, log(6));
  assert.equal(fs.readFileSync(count, 'utf8'), 'xxxx', 'uncommitted changes are never cached');
});

test('outcome and summary: out of scope, and verify that already failed on the base', () => {
  const base = { winner: 'w', mode: 'write', role: 'build', status: '## RESULT: DONE', changed: ['a.js', 'b.js'], applied: [], rejected: [], warnings: [], attempts: [{ provider: 'w', reason: 'ok' }] };
  const out = { ...base, verify: { status: 'PASS' }, scope: { listed: ['a.js'], outside: ['b.js'] } };
  assert.equal(outcome(out), 'out-of-scope');
  assert.match(formatSummary(out), /OUT OF SCOPE[\s\S]*b\.js/);
  assert.equal(outcome({ ...out, scope: { ...out.scope, allowed: true } }), 'done', '--allow-scope');
  const broken = { ...base, base: { status: 'FAIL', head: 'abc1234', log: 'l' }, verify: { status: 'FAIL', baseFailed: true, newFailures: [] } };
  assert.match(formatSummary(broken), /NOT PROVEN[\s\S]*No new failure lines/);
  assert.match(formatSummary(broken), /base: +verify FAIL on the starting commit abc1234/);
});
