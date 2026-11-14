import { PRODUCTS } from './catalog.js';

export function createCart(catalog = PRODUCTS) {
  const items = new Map(); // id → qty, in first-added order
  const product = (id) => catalog.find((p) => p.id === id);
  const checkQty = (qty, min) => { if (!Number.isInteger(qty) || qty < min) throw new RangeError(`quantity must be an integer >= ${min}`); };
  const checkStock = (p, qty) => { if (qty > p.stock) throw new RangeError(`not enough stock for ${p.id}: ${p.stock} left`); };
  const cart = {
    add(id, qty = 1) {
      checkQty(qty, 1);
      const p = product(id);
      if (!p) throw new Error(`unknown product: ${id}`);
      const next = (items.get(id) || 0) + qty;
      checkStock(p, next);
      items.set(id, next);
      return cart;
    },
    setQty(id, qty) {
      checkQty(qty, 0);
      if (!items.has(id)) throw new Error(`not in cart: ${id}`);
      if (qty === 0) { items.delete(id); return cart; }
      checkStock(product(id), qty);
      items.set(id, qty);
      return cart;
    },
    remove(id) { return items.delete(id); },
    lines() {
      return [...items].map(([id, qty]) => {
        const p = product(id);
        return { id, name: p.name, category: p.category, unitCents: p.priceCents, qty, lineCents: p.priceCents * qty };
      });
    },
    subtotalCents() { return cart.lines().reduce((t, l) => t + l.lineCents, 0); },
    count() { return [...items.values()].reduce((t, q) => t + q, 0); },
  };
  return cart;
}
