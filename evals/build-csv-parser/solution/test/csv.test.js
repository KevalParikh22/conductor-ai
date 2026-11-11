import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV } from '../src/csv.js';
test('csv', () => { assert.deepEqual(parseCSV('a,b'), [['a', 'b']]); });
