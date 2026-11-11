# Plan: pagination fixes

## Open questions
- [x] none

## Design notes
- `paginate(items, page, size)` returns page `page` (1-based) with `size` items; a page past the end is `[]`.
- `pageCount(items, size)` is the number of pages needed: 5 items at size 2 is 3 pages; no items is 0 pages.
- Keep the existing RangeError checks.

## Tasks

### T1: fix paginate and pageCount
- **role:** fix
- **files:** `src/paginate.js`, `test/paginate.test.js`
- **steps:** see Design notes
- **acceptance:**
  - [ ] `paginate([1,2,3,4,5], 1, 2)` returns `[1, 2]`
  - [ ] `paginate([1,2,3,4,5], 3, 2)` returns `[5]`
  - [ ] `paginate([1,2,3], 5, 2)` returns `[]`
  - [ ] `pageCount([1,2,3,4,5], 2)` returns 3 and `pageCount([], 3)` returns 0
- **verify:** `npm test`
