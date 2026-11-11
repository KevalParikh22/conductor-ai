import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice, toCents } from '../src/money.js';
test('symbols', () => {
  assert.equal(formatPrice(1250), '$12.50');
  assert.equal(formatPrice(1250, 'EUR'), '€12.50');
  assert.equal(formatPrice(5, 'GBP'), '£0.05');
});
test('thousands and negatives', () => {
  assert.equal(formatPrice(123456), '$1,234.56');
  assert.equal(formatPrice(100000000), '$1,000,000.00');
  assert.equal(formatPrice(-1250, 'GBP'), '-£12.50');
  assert.equal(formatPrice(0), '$0.00');
});
test('validation', () => {
  assert.throws(() => formatPrice(1.5), TypeError);
  assert.throws(() => formatPrice(100, 'XYZ'), RangeError);
});
test('toCents still works', () => { assert.equal(toCents(12.5), 1250); });
