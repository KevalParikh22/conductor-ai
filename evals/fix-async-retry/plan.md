# Plan: retry fixes

## Open questions
- [x] none

## Design notes
- `retry(fn, { attempts = 3, delayMs = 0 })` calls `fn(attemptNumber)` (1, 2, ...) at most `attempts` times and resolves with the first success.
- A thrown error and a rejected promise both count as a failure. After the last failure it rejects with that last error.
- It waits `delayMs` between attempts, never after the last one.
- `attempts` must be an integer >= 1, otherwise `RangeError` (rejected).

## Tasks

### T1: fix retry
- **role:** fix
- **files:** `src/retry.js`, `test/retry.test.js`
- **steps:** see Design notes
- **acceptance:**
  - [ ] a `fn` that rejects twice then resolves gives its value after exactly 3 calls
  - [ ] with `attempts: 3` and a `fn` that always fails, `fn` is called exactly 3 times and the last error is the rejection
  - [ ] a rejected promise from `fn` is retried, not leaked
  - [ ] `retry(fn, { attempts: 0 })` rejects with RangeError
- **verify:** `npm test`
