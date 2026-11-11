# Plan: slugify

## Open questions
- [x] none

## Design notes
- New file `src/slugify.js` exporting `slugify(text, { maxLength = 60 } = {})`.
- Steps: normalize with NFKD and remove combining marks (é → e); lowercase; replace every run of characters other than a-z and 0-9 with one `-`; remove leading and trailing `-`.
- If the result is longer than `maxLength`: cut it to `maxLength`; when the cut falls inside a word, go back to the last `-` before it (if there is one); then remove trailing `-`.
- Not a string → `TypeError`. `''` → `''`.

## Tasks

### T1: slugify
- **role:** build
- **files:** `src/slugify.js`, `test/slugify.test.js`
- **steps:** see Design notes
- **acceptance:**
  - [ ] `slugify('Hello, World!')` returns `'hello-world'`
  - [ ] `slugify('Crème Brûlée')` returns `'creme-brulee'`
  - [ ] `slugify('alpha beta gamma', { maxLength: 12 })` returns `'alpha-beta'`
  - [ ] `slugify(5)` throws TypeError
- **verify:** `npm test`
