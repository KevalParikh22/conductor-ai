import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toQuery } from '../src/query.js';
test('query', () => { assert.equal(toQuery({ a: 1 }), 'a=1'); });
