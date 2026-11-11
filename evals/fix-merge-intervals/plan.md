# Plan: interval merge fixes

## Open questions
- [x] none

## Design notes
- `mergeIntervals(intervals)` takes `[start, end]` pairs in any order and returns them merged and sorted by start.
- Intervals that overlap OR touch (`[1, 3]` and `[3, 5]`) merge. An interval inside another disappears into it.
- The input array and its pairs must not be changed.

## Tasks

### T1: fix mergeIntervals
- **role:** fix
- **files:** `src/intervals.js`, `test/intervals.test.js`
- **steps:** see Design notes
- **acceptance:**
  - [ ] `mergeIntervals([[1,3],[3,5]])` returns `[[1,5]]`
  - [ ] `mergeIntervals([[1,10],[2,3]])` returns `[[1,10]]`
  - [ ] the input array is unchanged after the call (same order, same pairs)
  - [ ] `mergeIntervals([])` returns `[]`
- **verify:** `npm test`
