// Hidden acceptance tests for the pilot: never shown to Claude or the workers. Each test names its task, so the
// harness can score tasks separately (node --test --test-name-pattern "^T1 ").
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = async (f) => import(new URL(`../src/${f}`, import.meta.url));

test('T1 slugify', async () => {
  const { slugify } = await load('slugify.js');
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  --a--b--  '), 'a-b');
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
  assert.equal(slugify('Ünïcödé 2026'), 'unicode-2026');
  assert.equal(slugify('alpha beta gamma', { maxLength: 12 }), 'alpha-beta');
  assert.equal(slugify('alpha beta gamma', { maxLength: 10 }), 'alpha-beta');
  assert.equal(slugify('abcdefghij', { maxLength: 4 }), 'abcd');
  assert.equal(slugify(''), '');
  assert.throws(() => slugify(5), TypeError);
});

test('T2 parseDuration', async () => {
  const { parseDuration } = await load('duration.js');
  assert.equal(parseDuration('1h30m'), 5400000);
  assert.equal(parseDuration('1.5h'), 5400000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('2d'), 172800000);
  assert.equal(parseDuration('1H 30M'), 5400000);
  assert.equal(parseDuration('1m 500ms'), 60500);
  for (const bad of ['', 'abc', '10', '1m30', '5x', 'h']) assert.throws(() => parseDuration(bad), SyntaxError, bad);
  assert.throws(() => parseDuration(5), TypeError);
});

test('T3 LRUCache', async () => {
  const { LRUCache } = await load('lru.js');
  const c = new LRUCache(2);
  c.set('a', 1).set('b', 2); c.get('a'); c.set('c', 3);
  assert.deepEqual(c.keys(), ['a', 'c']);
  const h = new LRUCache(2);
  h.set('a', 1); h.set('b', 2); h.has('a'); h.set('c', 3);
  assert.deepEqual(h.keys(), ['b', 'c']);
  const u = new LRUCache(2);
  u.set('a', 1); u.set('b', 2); u.set('a', 10);
  assert.deepEqual([u.size, u.keys(), u.get('a')], [2, ['b', 'a'], 10]);
  assert.equal(u.delete('b'), true); assert.equal(u.delete('b'), false);
  assert.throws(() => new LRUCache(0), RangeError);
  assert.throws(() => new LRUCache(1.5), RangeError);
});

test('T4 pagination', async () => {
  const { paginate, pageCount } = await load('paginate.js');
  const five = [1, 2, 3, 4, 5];
  assert.deepEqual(paginate(five, 1, 2), [1, 2]);
  assert.deepEqual(paginate(five, 2, 2), [3, 4]);
  assert.deepEqual(paginate(five, 3, 2), [5]);
  assert.deepEqual(paginate([1, 2, 3], 5, 2), []);
  assert.equal(pageCount(five, 2), 3);
  assert.equal(pageCount([], 3), 0);
  assert.throws(() => paginate(five, 1.5, 2), RangeError);
});

test('T5 slugPath', async () => {
  const { slugPath } = await load('paths.js');
  assert.equal(slugPath(['Blog', 'Crème Brûlée']), 'blog/creme-brulee');
  assert.equal(slugPath(['A', '!!!', 'B']), 'a/b');
  assert.equal(slugPath([]), '');
  assert.throws(() => slugPath('a'), TypeError);
});

test('T6 formatDuration', async () => {
  const { formatDuration, parseDuration } = await load('duration.js');
  assert.equal(formatDuration(5400000), '1h30m');
  assert.equal(formatDuration(90061001), '1d1h1m1s1ms');
  assert.equal(formatDuration(250), '250ms');
  assert.equal(formatDuration(0), '0ms');
  for (const ms of [1, 999, 60000, 3723004, 172800000]) assert.equal(parseDuration(formatDuration(ms)), ms);
  assert.throws(() => formatDuration(-1), RangeError);
  assert.throws(() => formatDuration(1.5), RangeError);
});
