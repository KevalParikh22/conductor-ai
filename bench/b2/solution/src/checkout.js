import { applyDiscounts } from './discounts.js';
import { formatCents } from './money.js';

export function checkout(cart, { rules = [], taxRatePercent = 0, shipping = {} } = {}) {
  const lines = cart.lines();
  if (!lines.length) throw new Error('empty cart');
  const { flatCents = 0, freeOverCents = Infinity } = shipping;
  const subtotalCents = cart.subtotalCents();
  const d = applyDiscounts(lines, rules);
  const discountCents = d.totalDiscountCents;
  const after = subtotalCents - discountCents;
  const shippingCents = after >= freeOverCents ? 0 : flatCents;
  const taxCents = Math.round(after * taxRatePercent / 100);
  return {
    subtotalCents, discountCents, shippingCents, taxCents, totalCents: after + shippingCents + taxCents,
    lines: lines.map((l, i) => ({ ...l, discountCents: d.lines[i].discountCents })),
  };
}

export function formatReceipt(r) {
  const out = r.lines.map((l) => `${l.qty} x ${l.name}  ${formatCents(l.lineCents)}`);
  out.push(`Subtotal ${formatCents(r.subtotalCents)}`);
  if (r.discountCents > 0) out.push(`Discount -${formatCents(r.discountCents)}`);
  out.push(`Shipping ${formatCents(r.shippingCents)}`, `Tax ${formatCents(r.taxCents)}`, `Total ${formatCents(r.totalCents)}`);
  return out.join('\n');
}
