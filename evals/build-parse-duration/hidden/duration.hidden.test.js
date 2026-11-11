import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.js';

test('units and combinations', () => {
  assert.equal(parseDuration('1h30m'), 5400000);
  assert.equal(parseDuration('1.5h'), 5400000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('90s'), 90000);
  assert.equal(parseDuration('2d'), 172800000);
  assert.equal(parseDuration('1H 30M'), 5400000);
  assert.equal(parseDuration('1m 500ms'), 60500);
});
test('strict', () => {
  for (const bad of ['', 'abc', '10', '1m30', '5x', 'h', ' ']) assert.throws(() => parseDuration(bad), SyntaxError, bad);
});
test('type', () => { assert.throws(() => parseDuration(5), TypeError); });
