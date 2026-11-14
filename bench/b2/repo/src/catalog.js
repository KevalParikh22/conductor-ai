// The shop's products. Prices are integer cents; stock Infinity means no limit (ebooks).
export const PRODUCTS = [
  { id: 'bk-001', name: 'The Pragmatic Programmer', category: 'books', priceCents: 4200, stock: 5 },
  { id: 'bk-002', name: 'Refactoring', category: 'books', priceCents: 3800, stock: 2 },
  { id: 'mg-001', name: 'Coffee Mug', category: 'merch', priceCents: 1200, stock: 10 },
  { id: 'st-001', name: 'Sticker Pack', category: 'merch', priceCents: 400, stock: 0 },
  { id: 'eb-001', name: 'Clean Code (ebook)', category: 'ebooks', priceCents: 2500, stock: Infinity },
];

/** A copy of the product with this id, or undefined. */
export function getProduct(id, catalog = PRODUCTS) {
  const p = catalog.find((x) => x.id === id);
  return p ? { ...p } : undefined;
}
