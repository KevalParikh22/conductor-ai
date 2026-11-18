// More routing rules shouldn't slow a task down: matching runs once per task, before any worker starts.
// A generous limit (CI machines vary): 1,000 rules that don't match, 200 files and a 20 kB task, in well under a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateHome } from './helpers.js';

isolateHome();
const { matchRoute } = await import('../src/routing.js');

test('1,000 routing rules match a large task in under 300 ms', () => {
  const routes = Array.from({ length: 1000 }, (_, i) => (i % 2 ? { files: [`pkg${i}/**/*.ts`, `**/mod${i}/*.sql`], provider: 'codex-cli' } : { text: `\\bkeyword${i}\\b`, role: 'build', provider: 'kilo-free' }));
  routes.push({ files: ['src/api/**'], provider: 'codex-cli' });
  const files = Array.from({ length: 200 }, (_, i) => `src/area${i % 20}/file${i}.js`).concat('src/api/users.js');
  const body = 'Add input validation to the users endpoint. '.repeat(450);
  const t0 = performance.now();
  const hit = matchRoute(routes, { role: 'build', body, files });
  const ms = performance.now() - t0;
  assert.equal(hit.index, 1000, 'the last rule matched');
  assert.ok(ms < 300, `took ${ms.toFixed(1)} ms`);
});
