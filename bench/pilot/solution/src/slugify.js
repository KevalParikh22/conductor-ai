export function slugify(text, { maxLength = 60 } = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  let s = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > maxLength) {
    let cut = s.slice(0, maxLength);
    if (s[maxLength] !== '-') { const i = cut.lastIndexOf('-'); if (i > 0) cut = cut.slice(0, i); }
    s = cut.replace(/-+$/, '');
  }
  return s;
}
