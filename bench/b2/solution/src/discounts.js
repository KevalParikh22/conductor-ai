const isPosInt = (n) => Number.isInteger(n) && n >= 1;

function lineDiscount(rule, line) {
  if (rule.type === 'percent') return line.category === rule.category ? Math.floor(line.lineCents * rule.percent / 100) : null;
  if (rule.type === 'bogo') return line.id === rule.id ? Math.floor(line.qty / (rule.buy + rule.get)) * rule.get * line.unitCents : null;
  return null;
}

export function applyDiscounts(lines, rules) {
  for (const r of rules) {
    if (r.type === 'percent') { if (!(r.percent >= 0 && r.percent <= 100)) throw new RangeError('percent must be 0-100'); }
    else if (r.type === 'bogo') { if (!isPosInt(r.buy) || !isPosInt(r.get)) throw new RangeError('buy and get must be integers >= 1'); }
    else if (r.type !== 'amount') throw new TypeError(`unknown rule type: ${r.type}`);
  }
  const subtotal = lines.reduce((t, l) => t + l.lineCents, 0);
  const out = lines.map((line) => {
    let best = { discountCents: 0, rule: null };
    rules.forEach((r, i) => {
      const d = lineDiscount(r, line);
      if (d !== null && (best.rule === null || d > best.discountCents)) best = { discountCents: d, rule: i };
    });
    return { id: line.id, ...best };
  });
  const lineTotal = out.reduce((t, l) => t + l.discountCents, 0);
  const order = rules.filter((r) => r.type === 'amount' && subtotal >= r.minSubtotalCents).reduce((m, r) => Math.max(m, r.amountCents), 0);
  const orderDiscountCents = Math.max(0, Math.min(order, subtotal - lineTotal));
  return { lines: out, orderDiscountCents, totalDiscountCents: lineTotal + orderDiscountCents };
}
