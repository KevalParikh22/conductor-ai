const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call fn until it succeeds, at most `attempts` times. */
export async function retry(fn, { attempts = 3, delayMs = 0 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts must be an integer >= 1');
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastError = e;
      if (delayMs && i < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}
