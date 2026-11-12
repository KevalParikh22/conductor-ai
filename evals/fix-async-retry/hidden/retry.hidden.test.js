import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retry } from '../src/retry.js';
const failing = (n, value) => { let calls = 0; const fn = async () => { calls++; if (calls <= n) throw new Error(`fail ${calls}`); return value; }; fn.calls = () => calls; return fn; };
test('rejections are retried', async () => {
  const fn = failing(2, 'ok');
  assert.equal(await retry(fn), 'ok');
  assert.equal(fn.calls(), 3);
});
test('exact number of attempts and the last error', async () => {
  const fn = failing(99);
  await assert.rejects(retry(fn, { attempts: 3 }), /fail 3/);
  assert.equal(fn.calls(), 3);
});
test('sync throws count too, and attempt numbers are passed', async () => {
  const seen = [];
  const v = await retry((n) => { seen.push(n); if (n < 2) throw new Error('x'); return n; });
  assert.equal(v, 2);
  assert.deepEqual(seen, [1, 2]);
});
test('no delay after the last attempt', async () => {
  const t0 = Date.now();
  // wide margins for slow CI machines: correct ≈ 200ms, waiting after the last attempt too ≈ 400ms
  await assert.rejects(retry(failing(99), { attempts: 2, delayMs: 200 }));
  const ms = Date.now() - t0;
  assert.ok(ms >= 180, `waited between attempts (${ms}ms)`);
  assert.ok(ms < 350, `no wait after the last (${ms}ms)`);
});
test('attempts validated', async () => {
  await assert.rejects(retry(() => 1, { attempts: 0 }), RangeError);
  await assert.rejects(retry(() => 1, { attempts: 1.5 }), RangeError);
});
