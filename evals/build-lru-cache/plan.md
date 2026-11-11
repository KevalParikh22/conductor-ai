# Plan: LRU cache

## Open questions
- [x] none

## Design notes
- New file `src/lru.js` exporting `class LRUCache`.
- `new LRUCache(capacity)`: capacity is an integer >= 1, otherwise `RangeError`.
- `get(key)`: the value or `undefined`; marks the key as most recently used.
- `set(key, value)`: adds or updates (an update also marks it most recently used) and returns the cache. When the size goes over capacity, the least recently used key is removed.
- `has(key)`: true/false; does NOT change the order. `delete(key)`: true if it was there. `size`: a getter.
- `keys()`: an array from least to most recently used.

## Tasks

### T1: LRUCache
- **role:** build
- **files:** `src/lru.js`, `test/lru.test.js`
- **steps:** see Design notes
- **acceptance:**
  - [ ] with capacity 2: set a, set b, get a, set c → `keys()` is `['a', 'c']` (b was evicted)
  - [ ] `has()` does not change the eviction order
  - [ ] updating an existing key never evicts another key
  - [ ] `new LRUCache(0)` throws RangeError
- **verify:** `npm test`
