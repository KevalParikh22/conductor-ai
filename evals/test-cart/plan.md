# Plan: cart tests

## Open questions
- [x] none

## Design notes
- `src/cart.js` is correct; do not change it. Write `test/cart.test.js` (node:test) for it.
- `lineTotal(price, qty)`: price × qty rounded to cents (`lineTotal(0.1, 3)` is exactly `0.3`); qty must be an integer >= 1, otherwise RangeError.
- `cartTotal(lines, { discountPct })`: sum of line totals, discount applied once, rounded to cents; an empty cart is 0; discountPct outside 0–100 is a RangeError.

## Tasks

### T1: tests for cart.js
- **role:** test
- **files:** `test/cart.test.js`
- **steps:** see Design notes
- **acceptance:**
  - [ ] a test fails if `lineTotal` stops rounding to cents (e.g. `lineTotal(0.1, 3)` must equal `0.3` exactly)
  - [ ] a test fails if qty 0 or a non-integer qty is accepted
  - [ ] a test fails if the discount is applied twice (e.g. 10% off 100 must be 90)
  - [ ] a test fails if a discount above 100 is accepted, and all tests pass on the current `src/cart.js`
- **verify:** `npm test`
