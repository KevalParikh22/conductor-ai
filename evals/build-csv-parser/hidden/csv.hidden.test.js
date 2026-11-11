import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV } from '../src/csv.js';
test('simple', () => { assert.deepEqual(parseCSV('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]); });
test('quotes', () => {
  assert.deepEqual(parseCSV('a,"b,c"\n'), [['a', 'b,c']]);
  assert.deepEqual(parseCSV('"say ""hi"""'), [['say "hi"']]);
  assert.deepEqual(parseCSV('"line1\nline2",x'), [['line1\nline2', 'x']]);
});
test('line endings and empty lines', () => {
  assert.deepEqual(parseCSV('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseCSV('a\n\nb'), [['a'], [''], ['b']]);
  assert.deepEqual(parseCSV('a,,c'), [['a', '', 'c']]);
  assert.deepEqual(parseCSV(' a , b '), [[' a ', ' b ']]);
});
test('delimiter option', () => { assert.deepEqual(parseCSV('a;"b;c"', { delimiter: ';' }), [['a', 'b;c']]); });
test('empty and errors', () => {
  assert.deepEqual(parseCSV(''), []);
  assert.throws(() => parseCSV('"abc'), SyntaxError);
});
