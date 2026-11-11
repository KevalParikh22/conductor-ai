import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, formatPrice } from '../src/money.js';
test('toCents', () => { assert.equal(toCents(12.5), 1250); });
test('formatPrice', () => { assert.equal(formatPrice(1250), '$12.50'); });
