import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIntervals } from '../src/intervals.js';
test('overlapping', () => { assert.deepEqual(mergeIntervals([[1, 3], [2, 6]]), [[1, 6]]); });
