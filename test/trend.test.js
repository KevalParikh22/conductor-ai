// The Overview's weekly trend: the first-try accept rate per week (Monday to Sunday), oldest first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, makeRepo } from './helpers.js';

isolateHome();
const { qualityTrend } = await import('../src/stats.js');

test('first-try rate per week; weeks without write tasks are null; read runs do not count', () => {
  const { dir } = makeRepo();
  const now = new Date(2026, 10, 14, 12).getTime(); // a Saturday
  const run = (id, at, role, outcome, attempts = 1) => {
    const d = path.join(dir, '.conductor', 'runs', id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'summary.json'), JSON.stringify({ role, mode: role === 'ask' ? 'read' : 'write', startedAt: new Date(at).toISOString(), winner: outcome === 'failed' ? null : 'w',
      attempts: Array.from({ length: attempts }, () => ({ provider: 'w', ok: true })), verify: outcome === 'done' ? { status: 'PASS', cmd: 'npm test' } : null, status: '## RESULT: DONE', warnings: [] }));
  };
  const day = 86_400_000;
  run('a', now - 1 * day, 'build', 'done');
  run('b', now - 2 * day, 'build', 'done', 2); // done, but after a fallback: not first try
  run('c', now - 3 * day, 'fix', 'failed');
  run('d', now - 8 * day, 'build', 'done');
  run('e', now - 1 * day, 'ask', 'done'); // a read: not counted
  const t = qualityTrend({ root: dir, weeks: 3, now });
  assert.deepEqual(t.map((w) => w.week), ['2026-10-26', '2026-11-02', '2026-11-09']);
  assert.deepEqual(t.map((w) => [w.writeTasks, w.firstTry, w.rate]), [[0, 0, null], [1, 1, 100], [3, 1, 33]]);
});
