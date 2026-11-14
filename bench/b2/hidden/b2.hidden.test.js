// B2 hidden tests: written from plan.md before any run. Neither Claude nor the workers see this file; it is copied in
// only to score. One top-level test per task (the scorer reads "T1".."T5" from the TAP output).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = (m) => import(new URL(`../src/${m}`, import.meta.url));
const CAT = [
  { id: 'a', name: 'Alpha', category: 'books', priceCents: 1000, stock: 3 },
  { id: 'b', name: 'Beta', category: 'merch', priceCents: 250, stock: Infinity },
  { id: 'c', name: 'Gamma', category: 'books', priceCents: 999, stock: 0 },
];
const line = (id, category, unitCents, qty) => ({ id, name: id.toUpperCase(), category, unitCents, qty, lineCents: unitCents * qty });

test('T1 cart', async () => {
  const { createCart } = await load('cart.js');
  assert.equal(createCart().add('bk-001', 2).add('mg-001').subtotalCents(), 9600, 'default catalog');
  const c = createCart(CAT);
  assert.equal(c.add('b', 4).add('a').add('b', 2), c, 'add returns the cart');
  assert.deepEqual(c.lines(), [
    { id: 'b', name: 'Beta', category: 'merch', unitCents: 250, qty: 6, lineCents: 1500 },
    { id: 'a', name: 'Alpha', category: 'books', unitCents: 1000, qty: 1, lineCents: 1000 },
  ], 'first-added order, quantities merged');
  assert.equal(c.subtotalCents(), 2500);
  assert.equal(c.count(), 7);
  assert.throws(() => c.add('a', 3), (e) => e instanceof RangeError && /not enough stock/.test(e.message), 'stock counts what is already in the cart');
  assert.equal(c.lines().find((l) => l.id === 'a').qty, 1, 'a failed add changes nothing');
  assert.throws(() => c.add('c'), RangeError, 'stock 0');
  assert.throws(() => c.add('zzz'), (e) => e instanceof Error && /unknown product/.test(e.message));
  for (const bad of [0, -1, 1.5, '2']) assert.throws(() => c.add('b', bad), RangeError, `qty ${bad}`);
  assert.equal(c.setQty('a', 3), c);
  assert.equal(c.lines().find((l) => l.id === 'a').qty, 3);
  assert.throws(() => c.setQty('a', 4), RangeError);
  assert.throws(() => c.setQty('c', 1), (e) => /not in cart/.test(e.message));
  assert.throws(() => c.setQty('a', -1), RangeError);
  c.setQty('a', 0);
  assert.deepEqual(c.lines().map((l) => l.id), ['b']);
  assert.equal(c.remove('b'), true);
  assert.equal(c.remove('b'), false);
  assert.deepEqual([c.lines(), c.subtotalCents(), c.count()], [[], 0, 0]);
  const l = createCart(CAT).add('b').lines(); l.push('x');
  assert.ok(true, 'lines() returns a new array each time');
});

test('T2 discounts', async () => {
  const { applyDiscounts } = await load('discounts.js');
  assert.equal(applyDiscounts([line('a', 'books', 1000, 3)], [{ type: 'bogo', id: 'a', buy: 2, get: 1 }]).totalDiscountCents, 1000);
  assert.equal(applyDiscounts([line('a', 'books', 1000, 5)], [{ type: 'bogo', id: 'a', buy: 2, get: 1 }]).totalDiscountCents, 1000, 'floor(5/3) = 1 free');
  const lines = [line('a', 'books', 999, 2), line('b', 'merch', 250, 4)];
  let r = applyDiscounts(lines, [{ type: 'percent', category: 'books', percent: 15 }, { type: 'percent', category: 'books', percent: 10 }]);
  assert.deepEqual(r.lines, [{ id: 'a', discountCents: 299, rule: 0 }, { id: 'b', discountCents: 0, rule: null }], 'floor(1998 * 15 / 100) = 299; the largest only');
  r = applyDiscounts(lines, [{ type: 'percent', category: 'books', percent: 10 }, { type: 'bogo', id: 'a', buy: 1, get: 1 }]);
  assert.deepEqual(r.lines[0], { id: 'a', discountCents: 999, rule: 1 }, 'the bogo is larger');
  r = applyDiscounts([line('a', 'books', 1000, 1)], [{ type: 'percent', category: 'books', percent: 10 }, { type: 'percent', category: 'books', percent: 10 }]);
  assert.equal(r.lines[0].rule, 0, 'a tie goes to the earlier rule');
  r = applyDiscounts(lines, [{ type: 'amount', minSubtotalCents: 2000, amountCents: 300 }, { type: 'amount', minSubtotalCents: 2000, amountCents: 500 }, { type: 'amount', minSubtotalCents: 9999, amountCents: 900 }]);
  assert.deepEqual([r.orderDiscountCents, r.totalDiscountCents], [500, 500], 'the largest that applies (subtotal 2998)');
  r = applyDiscounts([line('a', 'books', 1000, 1)], [{ type: 'percent', category: 'books', percent: 60 }, { type: 'amount', minSubtotalCents: 0, amountCents: 700 }]);
  assert.deepEqual([r.lines[0].discountCents, r.orderDiscountCents, r.totalDiscountCents], [600, 400, 1000], 'never more than the subtotal');
  assert.deepEqual(applyDiscounts(lines, []), { lines: [{ id: 'a', discountCents: 0, rule: null }, { id: 'b', discountCents: 0, rule: null }], orderDiscountCents: 0, totalDiscountCents: 0 });
  assert.throws(() => applyDiscounts([], [{ type: 'free' }]), TypeError);
  assert.throws(() => applyDiscounts([], [{ type: 'percent', category: 'x', percent: 101 }]), RangeError);
  assert.throws(() => applyDiscounts([], [{ type: 'bogo', id: 'a', buy: 0, get: 1 }]), RangeError);
});

test('T3 CSV import', async () => {
  const { parseCSV } = await load('csv.js');
  const { importProducts } = await load('import.js');
  assert.deepEqual(parseCSV('a,"b,""c"""\r\nd,e\n'), [['a', 'b,"c"'], ['d', 'e']]);
  assert.deepEqual(parseCSV('x,"multi\nline",z'), [['x', 'multi\nline', 'z']]);
  assert.deepEqual(parseCSV('a,,c\n,\n'), [['a', '', 'c'], ['', '']]);
  assert.throws(() => parseCSV('"open'), SyntaxError);
  assert.throws(() => parseCSV(5), TypeError);
  assert.deepEqual(importProducts('id,name,category,price,stock\nx,X,books,12.5,\n').products, [{ id: 'x', name: 'X', category: 'books', priceCents: 1250, stock: Infinity }]);
  const csv = [' Stock ,PRICE,id,Name,category,extra', '3,10,a1,"Book, The",books,?', '1,9.999,a2,B,books,', 'x,1,a3,C,merch,', ',,,,,', '2,0.5,a1,Dup,books,', '0,4,,NoId,merch,', '5,7.25,a4,"Quote ""Q""",merch,'].join('\r\n');
  const r = importProducts(csv);
  assert.deepEqual(r.products, [
    { id: 'a1', name: 'Book, The', category: 'books', priceCents: 1000, stock: 3 },
    { id: 'a4', name: 'Quote "Q"', category: 'merch', priceCents: 725, stock: 5 },
  ]);
  assert.deepEqual(r.errors, [
    { row: 2, message: 'invalid price' }, { row: 3, message: 'invalid stock' }, { row: 5, message: 'duplicate id' }, { row: 6, message: 'missing id' },
  ], 'row 4 is all empty: skipped, and rows keep counting');
  assert.throws(() => importProducts('id,name,price,stock\na,A,1,1\n'), SyntaxError, 'no category column');
  assert.deepEqual(importProducts('id,name,category,price,stock\na,,x,1,1\nb,B,x,-1,1\nc,C,x,1,1.5\n').errors.map((e) => e.message), ['missing name', 'invalid price', 'invalid stock']);
});

test('T4 order lifecycle', async () => {
  const { createOrder, transition, canTransition } = await load('orders.js');
  let t = 1000;
  const now = () => t;
  const o = createOrder({ id: 'o1', lines: [], totalCents: 500 }, { now });
  assert.deepEqual(o, { id: 'o1', lines: [], totalCents: 500, state: 'pending', history: [{ state: 'pending', at: 1000 }] });
  t = 2000; const paid = transition(o, 'pay', { now });
  t = 3000; const shipped = transition(paid, 'ship', { now });
  t = 4000; const delivered = transition(shipped, 'deliver', { now });
  assert.equal(delivered.state, 'delivered');
  assert.deepEqual(delivered.history, [{ state: 'pending', at: 1000 }, { state: 'paid', at: 2000 }, { state: 'shipped', at: 3000 }, { state: 'delivered', at: 4000 }]);
  assert.equal(o.state, 'pending'); assert.equal(o.history.length, 1, 'the original order is unchanged');
  assert.throws(() => transition(o, 'ship', { now }), (e) => e.code === 'INVALID_TRANSITION' && /cannot ship a pending order/.test(e.message));
  assert.throws(() => transition(o, 'teleport', { now }), (e) => e.code === 'UNKNOWN_EVENT');
  assert.equal(transition(o, 'cancel', { now }).state, 'cancelled');
  assert.equal(transition(paid, 'cancel', { now }).state, 'cancelled');
  assert.throws(() => transition(shipped, 'cancel', { now }), (e) => e.code === 'INVALID_TRANSITION');
  assert.equal(transition(paid, 'refund', { now }).state, 'refunded');
  assert.equal(transition(shipped, 'refund', { now }).state, 'refunded');
  const DAY = 86_400_000;
  t = 4000 + 30 * DAY; assert.equal(transition(delivered, 'refund', { now }).state, 'refunded', 'day 30 is inside the window');
  t = 4000 + 31 * DAY; assert.throws(() => transition(delivered, 'refund', { now }), (e) => e.code === 'REFUND_WINDOW_CLOSED');
  assert.equal(canTransition(delivered, 'refund', { now }), false);
  assert.equal(canTransition(o, 'ship'), false);
  assert.equal(canTransition(o, 'nope'), false);
  assert.equal(canTransition(o, 'pay'), true);
  const refunded = transition(paid, 'refund', { now });
  assert.throws(() => transition(refunded, 'refund', { now }), (e) => e.code === 'INVALID_TRANSITION');
});

test('T5 checkout', async () => {
  const { createCart } = await load('cart.js');
  const { checkout, formatReceipt } = await load('checkout.js');
  const cart = createCart(CAT).add('a', 2).add('b', 3); // 2000 + 750
  const r = checkout(cart, { rules: [{ type: 'percent', category: 'books', percent: 10 }], taxRatePercent: 8.25, shipping: { flatCents: 499, freeOverCents: 2500 } });
  assert.deepEqual([r.subtotalCents, r.discountCents, r.shippingCents, r.taxCents, r.totalCents], [2750, 200, 0, 210, 2760], 'after 2550 ≥ 2500: free shipping; tax round(2550 × 8.25%) = 210');
  assert.deepEqual(r.lines.map((l) => [l.id, l.lineCents, l.discountCents]), [['a', 2000, 200], ['b', 750, 0]]);
  const r2 = checkout(createCart(CAT).add('b', 2), { taxRatePercent: 10, shipping: { flatCents: 499, freeOverCents: 2500 } });
  assert.deepEqual([r2.subtotalCents, r2.discountCents, r2.shippingCents, r2.taxCents, r2.totalCents], [500, 0, 499, 50, 1049], 'shipping is not taxed');
  const r3 = checkout(createCart(CAT).add('b'));
  assert.deepEqual([r3.shippingCents, r3.taxCents, r3.totalCents], [0, 0, 250], 'defaults');
  assert.throws(() => checkout(createCart(CAT)), (e) => /empty cart/.test(e.message));
  assert.equal(formatReceipt(r), ['2 x Alpha  $20.00', '3 x Beta  $7.50', 'Subtotal $27.50', 'Discount -$2.00', 'Shipping $0.00', 'Tax $2.10', 'Total $27.60'].join('\n'));
  assert.ok(!formatReceipt(r2).includes('Discount'), 'no Discount line without a discount');
});
