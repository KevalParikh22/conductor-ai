# Plan: query strings

## Open questions
- [x] none

## Design notes
- New file `src/query.js` exporting `toQuery(params)` → a string without a leading `?`.
- Keys sorted alphabetically; keys and values encoded with `encodeURIComponent` (a space is `%20`).
- An array becomes the key repeated, in array order. `undefined` and `null` values are skipped, also inside arrays.
- Numbers and booleans are written as strings (`false` → `false`). `{}` → `''`. A nested object value → `TypeError`.

## Tasks

### T1: toQuery
- **role:** build
- **files:** `src/query.js`, `test/query.test.js`
- **steps:** see Design notes
- **acceptance:**
  - [ ] `toQuery({ b: 2, a: 1 })` returns `'a=1&b=2'`
  - [ ] `toQuery({ q: 'a b&c' })` returns `'q=a%20b%26c'`
  - [ ] `toQuery({ t: ['x', null, 'y'] })` returns `'t=x&t=y'`
  - [ ] `toQuery({ o: { x: 1 } })` throws TypeError
- **verify:** `npm test`
