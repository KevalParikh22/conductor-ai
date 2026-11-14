import { parseCSV } from './csv.js';

const REQUIRED = ['id', 'name', 'category', 'price', 'stock'];

export function importProducts(text) {
  const [header = [], ...records] = parseCSV(text);
  const col = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
  const missing = REQUIRED.filter((c) => !(c in col));
  if (missing.length) throw new SyntaxError(`missing column(s): ${missing.join(', ')}`);
  const products = [], errors = [], seen = new Set();
  records.forEach((rec, i) => {
    const row = i + 1;
    if (rec.every((f) => f.trim() === '')) return;
    const get = (c) => (rec[col[c]] ?? '').trim();
    const id = get('id'), name = get('name'), category = get('category'), price = get('price'), stock = get('stock');
    let message = null;
    if (!id) message = 'missing id';
    else if (!name) message = 'missing name';
    else if (!/^\d+(\.\d{1,2})?$/.test(price)) message = 'invalid price';
    else if (stock !== '' && !/^\d+$/.test(stock)) message = 'invalid stock';
    else if (seen.has(id)) message = 'duplicate id';
    if (message) { errors.push({ row, message }); return; }
    seen.add(id);
    const [whole, frac = ''] = price.split('.');
    products.push({ id, name, category, priceCents: Number(whole) * 100 + Number(frac.padEnd(2, '0')), stock: stock === '' ? Infinity : Number(stock) });
  });
  return { products, errors };
}
