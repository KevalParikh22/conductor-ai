import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, pageCount } from '../src/paginate.js';

const five = [1, 2, 3, 4, 5];
test('pages are 1-based', () => {
  assert.deepEqual(paginate(five, 1, 2), [1, 2]);
  assert.deepEqual(paginate(five, 2, 2), [3, 4]);
  assert.deepEqual(paginate(five, 3, 2), [5]);
  assert.deepEqual(paginate(five, 1, 10), five);
});
test('past the end is empty', () => { assert.deepEqual(paginate([1, 2, 3], 5, 2), []); });
test('page count rounds up', () => {
  assert.equal(pageCount(five, 2), 3);
  assert.equal(pageCount(five, 5), 1);
  assert.equal(pageCount([], 3), 0);
});
test('validation kept', () => { assert.throws(() => paginate(five, 1.5, 2), RangeError); });
