// Tests for Wilson score interval and pass@k helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilson, passAtK } from '../src/evalstats.js';

const r4 = (x) => Math.round(x * 10000) / 10000;

test('wilson: 0 passes in 10 runs has low 0 and high ~0.2775', () => {
  const w = wilson(0, 10);
  assert.equal(w.low, 0);
  assert.equal(r4(w.high), 0.2775);
});

test('wilson: 10 passes in 10 runs has low ~0.7225 and high 1', () => {
  const w = wilson(10, 10);
  assert.equal(r4(w.low), 0.7225);
  assert.equal(w.high, 1);
});

test('wilson: 5 passes in 10 runs has low ~0.2366 and high ~0.7634', () => {
  const w = wilson(5, 10);
  assert.equal(r4(w.low), 0.2366);
  assert.equal(r4(w.high), 0.7634);
});

test('wilson: 1 pass in 1 run has low ~0.2065 and high 1', () => {
  const w = wilson(1, 1);
  assert.equal(r4(w.low), 0.2065);
  assert.equal(w.high, 1);
});

test('wilson: 0 runs returns { low: 0, high: 1 }', () => {
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });
});

test('wilson: custom z parameter adjusts interval', () => {
  const wDefault = wilson(5, 10);
  const wWide = wilson(5, 10, 2.576); // ~99% CI
  assert.ok(wWide.low < wDefault.low);
  assert.ok(wWide.high > wDefault.high);
});

test('wilson: values are clamped to [0, 1]', () => {
  const wZero = wilson(0, 10);
  assert.ok(wZero.low >= 0 && wZero.low <= 1);
  assert.ok(wZero.high >= 0 && wZero.high <= 1);

  const wFull = wilson(10, 10);
  assert.ok(wFull.low >= 0 && wFull.low <= 1);
  assert.ok(wFull.high >= 0 && wFull.high <= 1);
});

test('passAtK: acceptance cases with valid n, c, k', () => {
  assert.equal(r4(passAtK(10, 3, 1)), 0.3);
  assert.equal(passAtK(10, 3, 1), 0.3);
  assert.equal(passAtK(4, 1, 2), 0.5);
  assert.equal(passAtK(5, 0, 3), 0);
  assert.equal(passAtK(5, 5, 2), 1);
  assert.equal(passAtK(3, 3, 3), 1);
});

test('passAtK: returns 1 when n - c < k', () => {
  // 4 samples, 3 correct, k = 2 -> n - c = 1 < 2 -> 1
  assert.equal(passAtK(4, 3, 2), 1);
  // 5 samples, 4 correct, k = 3 -> n - c = 1 < 3 -> 1
  assert.equal(passAtK(5, 4, 3), 1);
});

test('passAtK: throws RangeError when k > n', () => {
  assert.throws(() => passAtK(2, 1, 3), RangeError);
});

test('passAtK: throws RangeError when k < 1', () => {
  assert.throws(() => passAtK(2, 1, 0), RangeError);
  assert.throws(() => passAtK(5, 2, -1), RangeError);
});

test('passAtK: throws RangeError when c outside 0..n', () => {
  assert.throws(() => passAtK(5, -1, 1), RangeError);
  assert.throws(() => passAtK(5, 6, 1), RangeError);
  assert.throws(() => passAtK(2, -2, 1), RangeError);
  assert.throws(() => passAtK(2, 3, 1), RangeError);
});
