import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';

test('rejects bad page and size', () => {
  assert.throws(() => paginate([1], 0, 1), RangeError);
  assert.throws(() => paginate([1], 1, 0), RangeError);
});
