/**
 * Retry delay computation: exponential backoff with "equal jitter" (half fixed, half random),
 * floored by any platform supplied Retry-After hint.
 *
 * @param {number} attempt number of attempts already made (>= 1)
 * @param {object} [opts]
 * @param {number} [opts.baseMs]
 * @param {number} [opts.maxMs]
 * @param {number} [opts.retryAfterMs] platform hint; the result is never shorter than this
 * @param {() => number} [opts.random] injectable for tests, returns [0,1)
 */
export function computeRetryDelayMs(attempt, { baseMs = 30_000, maxMs = 15 * 60_000, retryAfterMs, random = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(exp / 2 + random() * (exp / 2));
  const hint = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
  // A Retry-After hint is honoured exactly (plus a small jitter so many jobs don't stampede), capped at 1h.
  return Math.min(60 * 60_000, Math.max(jittered, hint ? hint + Math.floor(random() * 1000) : 0));
}
