/** Price × quantity, rounded to cents. */
export function lineTotal(price, qty) {
  if (!Number.isInteger(qty) || qty < 1) throw new RangeError('qty must be a positive integer');
  return Math.round(price * qty * 100) / 100;
}

/** Sum of the lines, minus `discountPct` percent, rounded to cents. */
export function cartTotal(lines, { discountPct = 0 } = {}) {
  if (discountPct < 0) throw new RangeError('discountPct must be between 0 and 100');
  const sub = lines.reduce((t, l) => t + lineTotal(l.price, l.qty), 0);
  return Math.round(sub * (100 - discountPct)) / 100;
}
