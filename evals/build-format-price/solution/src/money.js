/** Dollars (or euros...) as a number → integer cents. */
export function toCents(amount) {
  return Math.round(amount * 100);
}

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

/** Integer cents → "$1,234.56" (USD, EUR or GBP). */
export function formatPrice(cents, currency = 'USD') {
  if (!Number.isInteger(cents)) throw new TypeError('cents must be an integer');
  const symbol = SYMBOLS[currency];
  if (!symbol) throw new RangeError(`unknown currency: ${currency}`);
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}${symbol}${whole}.${String(abs % 100).padStart(2, '0')}`;
}
