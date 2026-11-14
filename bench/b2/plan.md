# Plan: bookshop orders (B2 benchmark)

**Goal:** the order side of a small bookshop library: a cart, discounts, a product import, the order lifecycle and checkout totals, with tests.
**Branch:** feat/orders

## Open questions
- [x] none

## Design notes
- ES modules, no dependencies, Node 20+. Each module in `src/`, its tests in `test/` (node:test), run by `npm test`.
- Money is always **integer cents** (`priceCents`, `unitCents`, `lineCents`…). Never floats for money.
- Existing: `src/catalog.js` (`PRODUCTS`, `getProduct(id, catalog = PRODUCTS)`; products are `{ id, name, category, priceCents, stock }`, `stock: Infinity` = no limit) and `src/money.js` (`formatCents`).
- Errors: wrong type → `TypeError`; out-of-range number → `RangeError`; anything else → `Error`. When a message is given below, it must contain that text.

### Cart (`src/cart.js`, T1)
- `createCart(catalog = PRODUCTS)` returns a cart object:
  - `add(id, qty = 1)`: `qty` must be an integer ≥ 1 (else `RangeError`). Unknown id → `Error` with message containing `unknown product`. Adding an id already in the cart increases its quantity. If the cart's quantity for the product would go over its `stock` → `RangeError` with message containing `not enough stock`, and the cart is unchanged. Returns the cart.
  - `setQty(id, qty)`: `qty` integer ≥ 0 (else `RangeError`); `0` removes the line. An id not in the cart → `Error` containing `not in cart`. Same stock rule as `add`. Returns the cart.
  - `remove(id)` → `true` if a line was removed, else `false`.
  - `lines()` → a new array of `{ id, name, category, unitCents, qty, lineCents }` in the order products were first added (`unitCents` = the product's `priceCents`, `lineCents = unitCents * qty`).
  - `subtotalCents()` → sum of `lineCents`; `count()` → sum of `qty`. An empty cart: `0` and `0`.

### Discounts (`src/discounts.js`, T2)
- `applyDiscounts(lines, rules)`; `lines` have the shape `cart.lines()` returns. Rules:
  - `{ type: 'percent', category, percent }`: a line in `category` gets `Math.floor(lineCents * percent / 100)`. `percent` outside 0–100 → `RangeError`.
  - `{ type: 'bogo', id, buy, get }`: the line with that `id` gets `Math.floor(qty / (buy + get)) * get` free units: discount = free units × `unitCents`. `buy` and `get` must be integers ≥ 1 (else `RangeError`).
  - `{ type: 'amount', minSubtotalCents, amountCents }`: an order-level discount of `amountCents` when the subtotal (sum of `lineCents`, before any discount) is ≥ `minSubtotalCents`.
  - Any other `type` → `TypeError`.
- Line discounts don't stack: each line gets only its **largest** applicable line discount (a tie goes to the earlier rule). Of the `amount` rules that apply, only the one with the largest `amountCents` is used.
- The total discount is never more than the subtotal: the order-level part is reduced if needed.
- Returns `{ lines: [{ id, discountCents, rule }], orderDiscountCents, totalDiscountCents }`: `lines` in the input order, `rule` = the index of the rule used for that line or `null` (then `discountCents` is 0).

### CSV import (`src/csv.js`, `src/import.js`, T3)
- `parseCSV(text)` → an array of rows, each an array of strings. Fields are separated by `,`; a field in double quotes may contain `,`, newlines and `""` (one `"`). Lines end in `\n` or `\r\n`; a final line ending does not add an empty row. An unterminated quoted field → `SyntaxError`. Not a string → `TypeError`.
- `importProducts(text)` → `{ products, errors }`:
  - The first row is the header: columns `id`, `name`, `category`, `price`, `stock`, in any order, matched case-insensitively after trimming; extra columns are ignored. A required column missing → `SyntaxError` (for the whole file).
  - Every later row is one record; `row` numbers start at 1 for the first record. A row whose fields are all empty is skipped (not an error).
  - Values are trimmed. `price` is a decimal with at most 2 decimals and ≥ 0 (`12`, `12.5`, `12.50`) → `priceCents` (`1250`); anything else → error `invalid price`. `stock` is an integer ≥ 0, or empty for `Infinity`; anything else → error `invalid stock`. An empty `id` or `name` → error `missing id` / `missing name`. An id seen in an earlier valid record → error `duplicate id` (the first one is kept).
  - `errors` is `[{ row, message }]` in row order, one per bad record (the first problem found, in the order: id, name, price, stock, duplicate). `products` is the valid records as `{ id, name, category, priceCents, stock }`, in row order.

### Orders (`src/orders.js`, T4)
- `createOrder({ id, lines, totalCents }, { now = () => Date.now() } = {})` → `{ id, lines, totalCents, state: 'pending', history: [{ state: 'pending', at }] }` (`at` from `now()`).
- `transition(order, event, { now = () => Date.now() } = {})` → a **new** order (the given one is not changed) with the new `state` and one more `history` entry `{ state, at }`.
  - `pay`: pending → paid · `ship`: paid → shipped · `deliver`: shipped → delivered · `cancel`: pending or paid → cancelled · `refund`: paid, shipped or delivered → refunded; from delivered only within 30 days (`30 * 86_400_000` ms, inclusive) of the delivered entry's `at`.
  - An event not allowed from the current state → `Error` with `code: 'INVALID_TRANSITION'` and message `cannot <event> a <state> order` (e.g. `cannot ship a pending order`). A refund after the 30 days → `Error` with `code: 'REFUND_WINDOW_CLOSED'`. An unknown event → `Error` with `code: 'UNKNOWN_EVENT'`.
- `canTransition(order, event, { now } = {})` → `true` or `false`, never throws.

### Checkout (`src/checkout.js`, T5, needs T1 and T2)
- `checkout(cart, { rules = [], taxRatePercent = 0, shipping = {} } = {})`, `shipping = { flatCents = 0, freeOverCents = Infinity }`:
  - An empty cart → `Error` containing `empty cart`.
  - `subtotalCents` = the cart's subtotal; `discountCents` = `applyDiscounts(cart.lines(), rules).totalDiscountCents`; `afterDiscount = subtotalCents - discountCents`.
  - `shippingCents` = `0` when `afterDiscount >= freeOverCents`, else `flatCents`.
  - `taxCents` = `Math.round(afterDiscount * taxRatePercent / 100)` (tax on goods after discount, not on shipping).
  - `totalCents = afterDiscount + shippingCents + taxCents`.
  - Returns `{ subtotalCents, discountCents, shippingCents, taxCents, totalCents, lines }`, `lines` = the cart's lines, each with its `discountCents` added.
- `formatReceipt(result)` → a string, one line per cart line `"<qty> x <name>  <formatCents(lineCents)>"`, then lines `Subtotal <…>`, `Discount -<…>` (only when discountCents > 0), `Shipping <…>`, `Tax <…>`, `Total <…>` (amounts with `formatCents`), joined with `\n`.

## Tasks

### T1: cart
- **role:** build
- **depends on:** none
- **files:** `src/cart.js`, `test/cart.test.js`
- **acceptance:**
  - [ ] `createCart().add('bk-001', 2).add('mg-001').subtotalCents()` returns `9600`
  - [ ] `createCart().add('bk-002', 3)` throws RangeError
  - [ ] `createCart().add('nope')` throws Error
  - [ ] `createCart().add('bk-001').setQty('bk-001', 0).count()` returns `0`
  - [ ] lines keep the order products were first added, with `unitCents`, `qty` and `lineCents`
- **verify:** `npm test`

### T2: discounts
- **role:** build
- **depends on:** none
- **files:** `src/discounts.js`, `test/discounts.test.js`
- **acceptance:**
  - [ ] `applyDiscounts([{ id: 'a', category: 'books', unitCents: 1000, qty: 3, lineCents: 3000 }], [{ type: 'bogo', id: 'a', buy: 2, get: 1 }]).totalDiscountCents` returns `1000`
  - [ ] each line gets only its largest line discount; the earlier rule wins a tie
  - [ ] only the largest applicable `amount` rule is used, and the total never exceeds the subtotal
  - [ ] `applyDiscounts([], [{ type: 'free' }])` throws TypeError
- **verify:** `npm test`

### T3: CSV product import
- **role:** build
- **depends on:** none
- **files:** `src/csv.js`, `src/import.js`, `test/csv.test.js`, `test/import.test.js`
- **acceptance:**
  - [ ] `parseCSV('a,"b,""c"""\r\nd,e\n')` returns `[['a', 'b,"c"'], ['d', 'e']]`
  - [ ] `parseCSV('"open')` throws SyntaxError
  - [ ] `importProducts('id,name,category,price,stock\nx,X,books,12.5,\n').products` returns `[{ id: 'x', name: 'X', category: 'books', priceCents: 1250, stock: Infinity }]`
  - [ ] bad records are reported as `{ row, message }` and left out; a missing column throws SyntaxError
- **verify:** `npm test`

### T4: order lifecycle
- **role:** build
- **depends on:** none
- **files:** `src/orders.js`, `test/orders.test.js`
- **acceptance:**
  - [ ] pay → ship → deliver moves an order to `delivered` with 4 history entries, and the original order is unchanged
  - [ ] shipping a pending order throws an Error with code `INVALID_TRANSITION`
  - [ ] a refund 31 days after delivery throws an Error with code `REFUND_WINDOW_CLOSED`
  - [ ] `canTransition` returns false instead of throwing
- **verify:** `npm test`

### T5: checkout
- **role:** build
- **depends on:** T1, T2
- **files:** `src/checkout.js`, `test/checkout.test.js`
- **acceptance:**
  - [ ] subtotal, discount, free shipping over the threshold, tax on the discounted goods and the total are right for a cart with a percent rule
  - [ ] `checkout(createCart())` throws Error
  - [ ] `formatReceipt` lists each line and the totals, with a Discount line only when there is one
- **verify:** `npm test`
