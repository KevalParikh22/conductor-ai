import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('basics', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  --a--b--  '), 'a-b');
  assert.equal(slugify(''), '');
  assert.equal(slugify('日本語'), '');
});
test('accents', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
  assert.equal(slugify('Ünïcödé 2026'), 'unicode-2026');
});
test('max length cuts at a word boundary', () => {
  assert.equal(slugify('alpha beta gamma', { maxLength: 12 }), 'alpha-beta');
  assert.equal(slugify('alpha beta gamma', { maxLength: 10 }), 'alpha-beta');
  assert.equal(slugify('abcdefghij', { maxLength: 4 }), 'abcd');
  assert.equal(slugify('a'.repeat(70)).length, 60);
});
test('type check', () => { assert.throws(() => slugify(5), TypeError); assert.throws(() => slugify(null), TypeError); });
