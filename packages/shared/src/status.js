/**
 * Target and post lifecycle definitions. Shared by the API, the worker and the web UI
 * so that status semantics live in exactly one place.
 */

export const TARGET_STATUS = Object.freeze({
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  QUEUED: 'queued',
  PUBLISHING: 'publishing',
  PUBLISHED: 'published',
  FAILED: 'failed',
  NEEDS_REAUTHORIZATION: 'needs_reauthorization',
  CANCELLED: 'cancelled',
});

export const TARGET_STATUSES = Object.freeze(Object.values(TARGET_STATUS));

export const POST_STATUS = Object.freeze({
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  PUBLISHING: 'publishing',
  PUBLISHED: 'published',
  PARTIALLY_PUBLISHED: 'partially_published',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const POST_STATUSES = Object.freeze(Object.values(POST_STATUS));

const T = TARGET_STATUS;

/** Allowed target status transitions. Anything not listed is rejected. */
export const TARGET_TRANSITIONS = Object.freeze({
  [T.DRAFT]: [T.SCHEDULED, T.QUEUED, T.CANCELLED],
  [T.SCHEDULED]: [T.DRAFT, T.QUEUED, T.CANCELLED],
  // queued -> queued is a delayed retry after a transient failure
  [T.QUEUED]: [T.QUEUED, T.PUBLISHING, T.CANCELLED, T.SCHEDULED],
  [T.PUBLISHING]: [T.PUBLISHED, T.FAILED, T.NEEDS_REAUTHORIZATION, T.QUEUED],
  [T.PUBLISHED]: [],
  [T.FAILED]: [T.QUEUED, T.SCHEDULED, T.DRAFT, T.CANCELLED],
  [T.NEEDS_REAUTHORIZATION]: [T.QUEUED, T.SCHEDULED, T.DRAFT, T.CANCELLED],
  [T.CANCELLED]: [T.DRAFT],
});

export function canTransitionTarget(from, to) {
  return (TARGET_TRANSITIONS[from] ?? []).includes(to);
}

/** Target states in which the target is still "in flight" and owned by the queue. */
export const ACTIVE_TARGET_STATUSES = Object.freeze([T.QUEUED, T.PUBLISHING]);

/** Target states that can no longer change without explicit user action. */
export const SETTLED_TARGET_STATUSES = Object.freeze([
  T.PUBLISHED,
  T.FAILED,
  T.NEEDS_REAUTHORIZATION,
  T.CANCELLED,
]);

/**
 * Derives the overall post status from its targets without discarding per-target results.
 * @param {string[]} targetStatuses
 * @returns {string}
 */
export function derivePostStatus(targetStatuses) {
  if (!targetStatuses || targetStatuses.length === 0) return POST_STATUS.DRAFT;
  const has = (s) => targetStatuses.includes(s);
  const count = (s) => targetStatuses.filter((x) => x === s).length;
  const total = targetStatuses.length;

  if (has(T.QUEUED) || has(T.PUBLISHING)) return POST_STATUS.PUBLISHING;
  if (count(T.CANCELLED) === total) return POST_STATUS.CANCELLED;

  const live = targetStatuses.filter((s) => s !== T.CANCELLED);
  const published = live.filter((s) => s === T.PUBLISHED).length;
  const failed = live.filter((s) => s === T.FAILED || s === T.NEEDS_REAUTHORIZATION).length;

  if (has(T.SCHEDULED)) return POST_STATUS.SCHEDULED;
  if (published === live.length) return POST_STATUS.PUBLISHED;
  if (published > 0 && failed > 0) return POST_STATUS.PARTIALLY_PUBLISHED;
  if (published > 0) return POST_STATUS.PARTIALLY_PUBLISHED;
  if (failed > 0) return POST_STATUS.FAILED;
  return POST_STATUS.DRAFT;
}

export const PUBLISH_JOB_STATUS = Object.freeze({
  PENDING: 'pending', // persisted, not yet confirmed in the queue
  ENQUEUED: 'enqueued', // present in the queue (possibly delayed)
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  ABANDONED: 'abandoned', // outcome unknown after a crash; never auto-retried
});

export const ACTIVE_JOB_STATUSES = Object.freeze([
  PUBLISH_JOB_STATUS.PENDING,
  PUBLISH_JOB_STATUS.ENQUEUED,
  PUBLISH_JOB_STATUS.RUNNING,
]);

/**
 * How a failed publish attempt is classified. Drives retry behaviour.
 *  - transient: the platform did not accept the request (network refused, 429, 503 w/ guarantee) – safe to retry.
 *  - rate_limited: transient with an explicit retry-after hint.
 *  - ambiguous: the request may have been accepted (timeout after send, 5xx, crash) – NOT retried automatically
 *    unless the adapter supports idempotency keys.
 *  - auth: credentials rejected / expired – needs the user to reauthorize.
 *  - permanent: the platform rejected the content or request – retrying cannot help.
 */
export const ERROR_CLASS = Object.freeze({
  TRANSIENT: 'transient',
  RATE_LIMITED: 'rate_limited',
  AMBIGUOUS: 'ambiguous',
  AUTH: 'auth',
  PERMANENT: 'permanent',
});

export const ACCOUNT_STATUS = Object.freeze({
  ACTIVE: 'active',
  NEEDS_REAUTHORIZATION: 'needs_reauthorization',
  REVOKED: 'revoked',
});
