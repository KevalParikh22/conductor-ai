const UNIT = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
export function parseDuration(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const s = text.trim().toLowerCase();
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*/y;
  let total = 0, n = 0;
  re.lastIndex = 0;
  while (re.lastIndex < s.length) {
    const m = re.exec(s);
    if (!m) throw new SyntaxError(`bad duration: ${text}`);
    total += parseFloat(m[1]) * UNIT[m[2]]; n++;
  }
  if (!n) throw new SyntaxError(`bad duration: ${text}`);
  return total;
}
