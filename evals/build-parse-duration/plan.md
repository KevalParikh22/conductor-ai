# Plan: duration parser

## Open questions
- [x] none

## Design notes
- New file `src/duration.js` exporting `parseDuration(text)` → milliseconds (a number).
- Units: `ms`, `s`, `m`, `h`, `d`, case-insensitive. Parts can be combined (`1h30m`) and separated by spaces (`1h 30m`). Numbers may have decimals (`1.5h`).
- Anything else is a `SyntaxError`: empty text, a number without a unit (`'10'`), a trailing number (`'1m30'`), unknown units.
- Not a string → `TypeError`.

## Tasks

### T1: parseDuration
- **role:** build
- **files:** `src/duration.js`, `test/duration.test.js`
- **steps:** see Design notes
- **acceptance:**
  - [ ] `parseDuration('1h30m')` and `parseDuration('1.5h')` return 5400000
  - [ ] `parseDuration('250ms')` returns 250 (ms is not minutes)
  - [ ] `parseDuration('10')` and `parseDuration('1m30')` throw SyntaxError
  - [ ] `parseDuration(5)` throws TypeError
- **verify:** `npm test`
