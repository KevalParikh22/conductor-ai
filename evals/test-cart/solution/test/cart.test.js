import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotal, cartTotal } from '../src/cart.js';
test('line total rounds to cents', () => { assert.equal(lineTotal(0.1, 3), 0.3); assert.equal(lineTotal(19.99, 2), 39.98); });
test('qty must be a positive integer', () => {
  for (const q of [0, -1, 1.5]) assert.throws(() => lineTotal(5, q), RangeError);
});
test('cart total and discount', () => {
  assert.equal(cartTotal([]), 0);
  assert.equal(cartTotal([{ price: 50, qty: 2 }], { discountPct: 10 }), 90);
  assert.equal(cartTotal([{ price: 10, qty: 1 }, { price: 0.1, qty: 3 }]), 10.3);
});
test('discount range', () => {
  assert.throws(() => cartTotal([], { discountPct: 101 }), RangeError);
  assert.throws(() => cartTotal([], { discountPct: -1 }), RangeError);
});
