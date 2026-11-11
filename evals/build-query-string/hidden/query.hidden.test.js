import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toQuery } from '../src/query.js';
test('sorting and encoding', () => {
  assert.equal(toQuery({ b: 2, a: 1 }), 'a=1&b=2');
  assert.equal(toQuery({ q: 'a b&c' }), 'q=a%20b%26c');
  assert.equal(toQuery({ 'a b': 1 }), 'a%20b=1');
});
test('arrays and skipped values', () => {
  assert.equal(toQuery({ tag: ['x', 'y'] }), 'tag=x&tag=y');
  assert.equal(toQuery({ t: ['x', null, 'y', undefined] }), 't=x&t=y');
  assert.equal(toQuery({ a: undefined, b: null, c: 0 }), 'c=0');
});
test('scalars and empty', () => {
  assert.equal(toQuery({ f: false, n: 1.5 }), 'f=false&n=1.5');
  assert.equal(toQuery({}), '');
});
test('nested objects rejected', () => { assert.throws(() => toQuery({ o: { x: 1 } }), TypeError); });
