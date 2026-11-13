# Plan: text and time utilities (pilot benchmark)

**Goal:** a small utility library: slugs, durations, a cache and pagination, with tests.
**Branch:** feat/utils

## Open questions
- [x] none

## Design notes
- ES modules, no dependencies. Each module in `src/`, its tests in `test/` (node:test), run by `npm test`.
- `src/slugify.js` exports `slugify(text, { maxLength = 60 } = {})`: NFKD-normalize and drop combining marks; lowercase; every run of characters other than a-z and 0-9 becomes one `-`; trim `-` at both ends. Longer than `maxLength`: cut there; if the cut falls inside a word, go back to the last `-` before it; trim a trailing `-`. Not a string → `TypeError`.
- `src/duration.js` exports `parseDuration(text)` → milliseconds. Units `ms`, `s`, `m`, `h`, `d` (case-insensitive), combinable (`1h30m`, `1h 30m`), decimals allowed (`1.5h`). Empty text, a bare number, a trailing number or an unknown unit → `SyntaxError`; not a string → `TypeError`.
- `src/lru.js` exports `class LRUCache`: `new LRUCache(capacity)` (integer ≥ 1, else `RangeError`); `get(key)` (marks it most recently used), `set(key, value)` (returns the cache; evicts the least recently used when over capacity), `has(key)` (no reordering), `delete(key)`, `size` getter, `keys()` (least → most recently used).
- `src/paginate.js` already exists and has bugs (T4).
- `src/paths.js` exports `slugPath(segments)` (T5): slugify each segment with the default options, drop the empty ones, join with `/`. Not an array → `TypeError`.
- `formatDuration(ms)` (T6) goes in `src/duration.js`: the shortest form `parseDuration` reads back, largest units first, no spaces (`5400000` → `1h30m`, `250` → `250ms`, `0` → `0ms`). Negative or not an integer → `RangeError`.

## Tasks

### T1: slugify
- **role:** build
- **depends on:** none
- **files:** `src/slugify.js`, `test/slugify.test.js`
- **acceptance:**
  - [ ] `slugify('Hello, World!')` returns `'hello-world'`
  - [ ] `slugify('Crème Brûlée')` returns `'creme-brulee'`
  - [ ] `slugify('alpha beta gamma', { maxLength: 12 })` returns `'alpha-beta'`
  - [ ] `slugify(5)` throws TypeError
- **verify:** `npm test`

### T2: parseDuration
- **role:** build
- **depends on:** none
- **files:** `src/duration.js`, `test/duration.test.js`
- **acceptance:**
  - [ ] `parseDuration('1h30m')` and `parseDuration('1.5h')` return 5400000
  - [ ] `parseDuration('250ms')` returns 250
  - [ ] `parseDuration('10')` and `parseDuration('1m30')` throw SyntaxError
  - [ ] `parseDuration(5)` throws TypeError
- **verify:** `npm test`

### T3: LRU cache
- **role:** build
- **depends on:** none
- **files:** `src/lru.js`, `test/lru.test.js`
- **acceptance:**
  - [ ] with capacity 2: set a, set b, get a, set c → `keys()` is `['a', 'c']`
  - [ ] `has()` does not change the eviction order
  - [ ] updating an existing key never evicts another key
  - [ ] `new LRUCache(0)` throws RangeError
- **verify:** `npm test`

### T4: fix pagination
- **role:** fix
- **depends on:** none
- **files:** `src/paginate.js`, `test/paginate.test.js`
- **acceptance:**
  - [ ] `paginate([1,2,3,4,5], 1, 2)` returns `[1, 2]`
  - [ ] `paginate([1,2,3,4,5], 3, 2)` returns `[5]`
  - [ ] `pageCount([1,2,3,4,5], 2)` returns 3 and `pageCount([], 3)` returns 0
- **verify:** `npm test`

### T5: slugPath
- **role:** build
- **depends on:** T1
- **files:** `src/paths.js`, `test/paths.test.js`
- **acceptance:**
  - [ ] `slugPath(['Blog', 'Crème Brûlée'])` returns `'blog/creme-brulee'`
  - [ ] `slugPath(['A', '!!!', 'B'])` returns `'a/b'`
  - [ ] `slugPath('a')` throws TypeError
- **verify:** `npm test`

### T6: formatDuration
- **role:** build
- **depends on:** T2
- **files:** `src/duration.js`, `test/duration.test.js`
- **acceptance:**
  - [ ] `formatDuration(5400000)` returns `'1h30m'`
  - [ ] `formatDuration(90061001)` returns `'1d1h1m1s1ms'`
  - [ ] `formatDuration(0)` returns `'0ms'`
  - [ ] `formatDuration(-1)` throws RangeError
- **verify:** `npm test`
