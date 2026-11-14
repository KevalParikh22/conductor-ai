const MOVES = {
  pay: { pending: 'paid' },
  ship: { paid: 'shipped' },
  deliver: { shipped: 'delivered' },
  cancel: { pending: 'cancelled', paid: 'cancelled' },
  refund: { paid: 'refunded', shipped: 'refunded', delivered: 'refunded' },
};
const WINDOW = 30 * 86_400_000;
const fail = (code, message) => Object.assign(new Error(message), { code });

export function createOrder({ id, lines, totalCents }, { now = () => Date.now() } = {}) {
  return { id, lines, totalCents, state: 'pending', history: [{ state: 'pending', at: now() }] };
}

export function transition(order, event, { now = () => Date.now() } = {}) {
  const moves = MOVES[event];
  if (!moves) throw fail('UNKNOWN_EVENT', `unknown event: ${event}`);
  const next = moves[order.state];
  if (!next) throw fail('INVALID_TRANSITION', `cannot ${event} a ${order.state} order`);
  const at = now();
  if (event === 'refund' && order.state === 'delivered') {
    const delivered = [...order.history].reverse().find((h) => h.state === 'delivered');
    if (at - delivered.at > WINDOW) throw fail('REFUND_WINDOW_CLOSED', 'the 30-day refund window has closed');
  }
  return { ...order, state: next, history: [...order.history, { state: next, at }] };
}

export function canTransition(order, event, opts = {}) {
  try { transition(order, event, opts); return true; } catch { return false; }
}
