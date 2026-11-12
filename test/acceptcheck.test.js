// H11: acceptance criteria run as checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo } from './helpers.js';

isolateHome();
const { parseChecks, freeNames, runAcceptanceChecks, checksBrief } = await import('../src/acceptcheck.js');
const { outcome, formatSummary } = await import('../src/core.js');

test('criteria become checks; prose and non-code are left alone', () => {
  const c = parseChecks([
    "`f('a')` and `f('b')` return 5400000",
    "`f('x')` throws SyntaxError and `g([])` returns `[]`",
    "`retry(fn, { attempts: 0 })` rejects with RangeError",
    "`new Cache(0)` throws RangeError",
    'the input array is unchanged after the call',
    "with capacity 2 → `keys()` is `['a']`",
    "`f(` returns `1`",
  ]);
  assert.deepEqual(c.map((x) => [x.n, x.kind, x.expr, x.expected]), [
    [1, 'returns', "f('a')", '5400000'], [1, 'returns', "f('b')", '5400000'],
    [2, 'throws', "f('x')", 'SyntaxError'], [2, 'returns', 'g([])', '[]'],
    [3, 'rejects', 'retry(fn, { attempts: 0 })', 'RangeError'],
    [4, 'throws', 'new Cache(0)', 'RangeError'],
  ]);
  assert.deepEqual(freeNames("slugify('a b', { maxLength: 12 }).trim()"), ['slugify']);
});

const CRIT = [
  "`add(2, 3)` returns 5",
  "`add('2', 3)` throws TypeError",
  "`addAsync(1, 1)` returns 2",
  "`loadUser(-1)` rejects with RangeError",
  "`add(helper(), 1)` returns 2",
];
test('checks run against the code: pass, fail with what came back, unknown helpers skipped', async () => {
  const { dir } = makeRepo({ files: {
    'package.json': JSON.stringify({ name: 'x', type: 'module' }),
    'src/math.js': "export function add(a, b) { if (typeof a !== 'number') throw new TypeError('x'); return a - b; }\nexport const addAsync = async (a, b) => a + b;\nexport async function loadUser(id) { if (id < 0) throw new RangeError('bad id'); return {}; }\n",
  } });
  const r = await runAcceptanceChecks(dir, CRIT, ['src/math.js']);
  assert.equal(r.total, 4);
  assert.equal(r.passed, 3);
  assert.deepEqual(r.failed.map((f) => [f.n, f.expr, f.got]), [[1, 'add(2, 3)', 'returned -1']]);
  assert.deepEqual(r.skipped.map((s) => s.why), ['nothing exports helper']);
  assert.match(checksBrief(r), /criterion 1: `add\(2, 3\)` should return `5`, but returned -1/);
});

test('a function the plan calls but no file exports is a failed check; a file that won\'t load fails them all', async () => {
  const { dir } = makeRepo({ files: { 'package.json': JSON.stringify({ name: 'x', type: 'module' }), 'src/s.js': 'function slugify(s) { return s; }\n', 'src/b.js': 'export const broken = () => { throw 1 };\nimport "./missing.js";\n' } });
  const r = await runAcceptanceChecks(dir, ["`slugify('A')` returns `'a'`"], ['src/s.js']);
  assert.deepEqual(r.failed.map((f) => f.got), ['slugify is not exported from any file']);
  const r2 = await runAcceptanceChecks(dir, ['`broken()` returns 1'], ['src/b.js']);
  assert.equal(r2.passed, 0);
  assert.match(r2.failed[0].got, /Cannot find module|ERR_MODULE_NOT_FOUND/);
});

test('a failed check makes DONE partial; all checks passing but verify failing hints the test is wrong', () => {
  const base = { winner: 'w', mode: 'write', role: 'build', status: '## RESULT: DONE', changed: ['a.js'], applied: [], rejected: [], warnings: [], attempts: [{ provider: 'w', reason: 'ok' }] };
  const s = { ...base, verify: { status: 'PASS' }, checks: { total: 2, passed: 1, failed: [{ n: 1, expr: 'add(2, 3)', kind: 'returns', expected: '5', got: 'returned -1' }], skipped: [] } };
  assert.equal(outcome(s), 'partial');
  assert.match(formatSummary(s), /PARTIAL\. 1 acceptance check\(s\) fail when conductor runs them[\s\S]*checks: +1\/2 acceptance checks pass when run\n +✗ add\(2, 3\) → returned -1 \(expected 5\)/);
  const t = { ...base, verify: { status: 'FAIL', brief: 'Verify failed.\nFailing: x\nFix it.' }, checks: { total: 2, passed: 2, failed: [], skipped: [] } };
  assert.match(formatSummary(t), /hint: +every acceptance check passes, so the failing test may itself be wrong/);
});

test('a project function named like conductor\'s own helpers (check, show, inspect, out) still works', async () => {
  const { dir } = makeRepo({ files: { 'package.json': JSON.stringify({ name: 'x', type: 'module' }), 'src/h.js': 'export const check = (a, b) => a === b;\nexport const show = (x) => `<${x}>`;\nexport function inspect() { return 1; }\nexport const out = [];\n' } });
  const r = await runAcceptanceChecks(dir, ["`check('a', 'a')` returns true", "`show(1)` returns `'<1>'`", '`inspect()` returns 1'], ['src/h.js']);
  assert.deepEqual([r.passed, r.total, r.failed], [3, 3, []]);
});
