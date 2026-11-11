import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/lru.js';
test('eviction follows use', () => {
  const c = new LRUCache(2);
  c.set('a', 1).set('b', 2);
  assert.equal(c.get('a'), 1);
  c.set('c', 3);
  assert.deepEqual(c.keys(), ['a', 'c']);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.size, 2);
});
test('has does not refresh', () => {
  const c = new LRUCache(2);
  c.set('a', 1); c.set('b', 2);
  assert.equal(c.has('a'), true);
  c.set('c', 3);
  assert.equal(c.has('a'), false);
  assert.deepEqual(c.keys(), ['b', 'c']);
});
test('update refreshes and never evicts', () => {
  const c = new LRUCache(2);
  c.set('a', 1); c.set('b', 2); c.set('a', 10);
  assert.equal(c.size, 2);
  assert.deepEqual(c.keys(), ['b', 'a']);
  assert.equal(c.get('a'), 10);
});
test('delete and capacity 1', () => {
  const c = new LRUCache(1);
  c.set('x', 1); c.set('y', 2);
  assert.deepEqual(c.keys(), ['y']);
  assert.equal(c.delete('y'), true);
  assert.equal(c.delete('y'), false);
  assert.equal(c.size, 0);
});
test('bad capacity', () => {
  assert.throws(() => new LRUCache(0), RangeError);
  assert.throws(() => new LRUCache(1.5), RangeError);
});
