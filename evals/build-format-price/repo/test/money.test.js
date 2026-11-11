import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents } from '../src/money.js';
test('toCents', () => { assert.equal(toCents(12.5), 1250); });
