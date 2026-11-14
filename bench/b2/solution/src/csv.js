export function parseCSV(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const rows = [];
  let row = [], field = '', i = 0, quoted = false, any = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; any = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; any = true; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; any = false; i++; continue; }
    field += c; any = true; i++;
  }
  if (quoted) throw new SyntaxError('unterminated quoted field');
  if (any || field) { row.push(field); rows.push(row); }
  return rows;
}
