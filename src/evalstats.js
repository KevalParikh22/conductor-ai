// Statistical helpers for eval results: Wilson score interval and unbiased pass@k.

/**
 * Wilson score interval for a binomial proportion.
 * @param {number} passes - Number of successes (c)
 * @param {number} runs - Number of trials (n)
 * @param {number} [z=1.96] - Z-score for confidence level (default 1.96 for 95% CI)
 * @returns {{ low: number, high: number }} Confidence interval clamped to [0, 1]
 */
export function wilson(passes, runs, z = 1.96) {
  if (runs === 0) return { low: 0, high: 1 };
  const p = passes / runs;
  const z2 = z * z;
  const d = 1 + z2 / runs;
  const centre = (p + z2 / (2 * runs)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / runs + z2 / (4 * runs * runs))) / d;
  const low = Math.max(0, Math.min(1, centre - half));
  const high = Math.max(0, Math.min(1, centre + half));
  return { low, high };
}

/**
 * Unbiased estimator for pass@k given n samples with c correct.
 * Formula: 1 - C(n-c, k) / C(n, k) = 1 - Π_{i=n-c+1..n} (1 - k/i).
 * @param {number} n - Total samples / runs
 * @param {number} c - Number of passing / correct samples
 * @param {number} k - Number of attempts (1 <= k <= n)
 * @returns {number} Probability in [0, 1]
 */
export function passAtK(n, c, k) {
  if (k > n || k < 1 || c < 0 || c > n) {
    throw new RangeError('passAtK: k must be in 1..n and c in 0..n');
  }
  if (n - c < k) return 1;
  let prod = 1;
  for (let i = n - c + 1; i <= n; i++) {
    prod *= (1 - k / i);
  }
  return Math.max(0, Math.min(1, Math.round((1 - prod) * 1e12) / 1e12)) || 0;
}
