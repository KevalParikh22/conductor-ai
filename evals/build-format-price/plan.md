# Plan: price formatting

## Open questions
- [x] none

## Design notes
- Add `formatPrice(cents, currency = 'USD')` to `src/money.js`, next to the existing `toCents`.
- Symbols: USD `$`, EUR `€`, GBP `£`. Format: symbol, then whole units with `,` every three digits, then `.` and two digits. Negative amounts start with `-` before the symbol.
- `cents` must be an integer (`TypeError` otherwise); an unknown currency is a `RangeError`.
- `src/legacy.js` is out of scope: don't change it.

## Tasks

### T1: formatPrice
- **role:** build
- **files:** `src/money.js`, `test/money.test.js`
- **steps:** see Design notes
- **acceptance:**
  - [ ] `formatPrice(1250)` returns `'$12.50'` and `formatPrice(1250, 'EUR')` returns `'€12.50'`
  - [ ] `formatPrice(123456)` returns `'$1,234.56'`
  - [ ] `formatPrice(-1250, 'GBP')` returns `'-£12.50'`
  - [ ] `formatPrice(1.5)` throws TypeError and `formatPrice(100, 'XYZ')` throws RangeError
- **verify:** `npm test`
