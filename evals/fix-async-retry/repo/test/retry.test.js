import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retry } from '../src/retry.js';
test('first try succeeds', async () => { assert.equal(await retry(() => 42), 42); });
