import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/lru.js';
test('lru', () => { const c = new LRUCache(1); c.set('a', 1); assert.equal(c.get('a'), 1); });
