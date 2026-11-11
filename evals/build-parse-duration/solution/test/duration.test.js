import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.js';
test('parse', () => { assert.equal(parseDuration('1h30m'), 5400000); });
