import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIntervals } from '../src/intervals.js';
test('overlap and gaps', () => { assert.deepEqual(mergeIntervals([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]]); });
test('touching', () => { assert.deepEqual(mergeIntervals([[1, 3], [3, 5]]), [[1, 5]]); });
test('contained', () => { assert.deepEqual(mergeIntervals([[1, 10], [2, 3]]), [[1, 10]]); assert.deepEqual(mergeIntervals([[1, 10], [2, 3], [4, 12]]), [[1, 12]]); });
test('unsorted input', () => { assert.deepEqual(mergeIntervals([[8, 9], [1, 2], [2, 4]]), [[1, 4], [8, 9]]); });
test('input untouched', () => {
  const input = [[5, 6], [1, 3], [2, 4]];
  const copy = JSON.parse(JSON.stringify(input));
  mergeIntervals(input);
  assert.deepEqual(input, copy);
});
test('empty', () => { assert.deepEqual(mergeIntervals([]), []); });
