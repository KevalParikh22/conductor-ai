# Plan: CSV parser

## Open questions
- [x] none

## Design notes
- New file `src/csv.js` exporting `parseCSV(text, { delimiter = ',' } = {})` → an array of rows, each an array of strings.
- Fields may be wrapped in double quotes. Inside quotes: `""` is one `"`, and the delimiter and line breaks are part of the field.
- Rows end at `\n` or `\r\n`. A final line break does not add an empty row. An empty line in the middle is a row with one empty field `['']`.
- Unquoted fields are kept exactly (no trimming). `''` → `[]`. An unclosed quote → `SyntaxError`.

## Tasks

### T1: parseCSV
- **role:** build
- **files:** `src/csv.js`, `test/csv.test.js`
- **steps:** see Design notes
- **acceptance:**
  - [ ] `parseCSV('a,"b,c"\n')` returns `[['a', 'b,c']]`
  - [ ] `parseCSV('"say ""hi"""')` returns `[['say "hi"']]`
  - [ ] a quoted field can contain a line break, and `\r\n` ends a row like `\n`
  - [ ] `parseCSV('"abc')` throws SyntaxError and `parseCSV('')` returns `[]`
- **verify:** `npm test`
