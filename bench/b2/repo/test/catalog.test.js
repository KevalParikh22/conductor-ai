import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTS, getProduct } from '../src/catalog.js';
import { formatCents } from '../src/money.js';

test('getProduct returns a copy, or undefined', () => {
  const p = getProduct('bk-001');
  assert.equal(p.priceCents, 4200);
  p.priceCents = 1;
  assert.equal(PRODUCTS[0].priceCents, 4200);
  assert.equal(getProduct('nope'), undefined);
});

test('formatCents', () => {
  assert.equal(formatCents(1234), '$12.34');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(-50), '-$0.50');
});
