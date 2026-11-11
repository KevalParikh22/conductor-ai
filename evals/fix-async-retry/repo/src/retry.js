const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call fn until it succeeds, at most `attempts` times. */
export async function retry(fn, { attempts = 3, delayMs = 0 } = {}) {
  let lastError;
  for (let i = 0; i <= attempts; i++) {
    try {
      return fn(i + 1);
    } catch (e) {
      lastError = e;
      if (delayMs) await sleep(delayMs);
    }
  }
  throw lastError;
}
