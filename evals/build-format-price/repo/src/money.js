/** Dollars (or euros...) as a number → integer cents. */
export function toCents(amount) {
  return Math.round(amount * 100);
}
