import { ERROR_CLASS } from '@osh/shared';

/**
 * Error raised by platform adapters. `kind` drives the retry policy (see ERROR_CLASS).
 * Messages must never contain credentials; adapters are responsible for that.
 */
export class PlatformError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {string} opts.kind one of ERROR_CLASS
   * @param {string} [opts.code] platform specific or generic machine readable code
   * @param {number} [opts.status] HTTP status when applicable
   * @param {number} [opts.retryAfterMs] retry hint from the platform
   * @param {unknown} [opts.cause]
   */
  constructor(message, { kind, code, status, retryAfterMs, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PlatformError';
    this.kind = kind ?? ERROR_CLASS.PERMANENT;
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return Math.max(0, Math.round(asNumber * 1000));
  const date = Date.parse(String(value));
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * Classify an HTTP failure from a platform API.
 *
 * `mutating` marks requests that create something on the platform. For those a 5xx response
 * is *ambiguous* (the platform may have created the resource before failing) unless the
 * request carried an idempotency key (`idempotent`).
 */
export function classifyHttpFailure({ status, headers, mutating = false, idempotent = false, body }) {
  const retryAfterMs = parseRetryAfter(
    typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'],
  );
  const code = typeof body?.error === 'string' ? body.error : undefined;
  const detail = describeBody(body);

  if (status === 429) {
    return { kind: ERROR_CLASS.RATE_LIMITED, code: code ?? 'rate_limited', retryAfterMs, message: `Rate limited by the platform${detail}` };
  }
  if (status === 401) {
    return { kind: ERROR_CLASS.AUTH, code: code ?? 'unauthorized', message: `The platform rejected the credentials${detail}` };
  }
  if (status === 403) {
    return { kind: ERROR_CLASS.AUTH, code: code ?? 'forbidden', message: `Permission denied by the platform${detail}` };
  }
  if (status === 408 || status === 425) {
    return { kind: mutating && !idempotent ? ERROR_CLASS.AMBIGUOUS : ERROR_CLASS.TRANSIENT, code: code ?? 'timeout', retryAfterMs, message: `Request timed out${detail}` };
  }
  if (status >= 500) {
    return {
      kind: mutating && !idempotent ? ERROR_CLASS.AMBIGUOUS : ERROR_CLASS.TRANSIENT,
      code: code ?? 'server_error',
      retryAfterMs,
      message: `The platform returned a server error (${status})${detail}`,
    };
  }
  if (status >= 400) {
    return { kind: ERROR_CLASS.PERMANENT, code: code ?? 'rejected', message: `The platform rejected the request (${status})${detail}` };
  }
  return { kind: ERROR_CLASS.PERMANENT, code: 'unexpected_response', message: `Unexpected response (${status})` };
}

function describeBody(body) {
  const text = body?.error_description ?? body?.message ?? body?.error;
  if (typeof text !== 'string' || !text) return '';
  return `: ${text.slice(0, 300)}`;
}

/** Errors thrown by undici/fetch before or after a request is on the wire. */
const NEVER_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_SSRF_BLOCKED',
]);

/**
 * Convert a thrown network error into a PlatformError.
 * Failures to connect mean the request was never sent (safe to retry); failures after connecting
 * (reset, timeout) are ambiguous for mutating requests.
 */
export function classifyNetworkError(err, { mutating = false, idempotent = false } = {}) {
  if (err instanceof PlatformError) return err;
  const code = err?.cause?.code ?? err?.code ?? err?.name;
  if (code === 'ERR_SSRF_BLOCKED' || err?.code === 'ERR_SSRF_BLOCKED' || err?.cause?.code === 'ERR_SSRF_BLOCKED') {
    return new PlatformError(err.cause?.message ?? err.message, { kind: ERROR_CLASS.PERMANENT, code: 'blocked_address', cause: err });
  }
  if (NEVER_SENT_CODES.has(code)) {
    return new PlatformError(`Could not reach the platform (${code})`, { kind: ERROR_CLASS.TRANSIENT, code, cause: err });
  }
  const abortLike = err?.name === 'AbortError' || err?.name === 'TimeoutError';
  return new PlatformError(
    abortLike ? 'The request to the platform timed out' : `Network error while talking to the platform${code ? ` (${code})` : ''}`,
    {
      kind: mutating && !idempotent ? ERROR_CLASS.AMBIGUOUS : ERROR_CLASS.TRANSIENT,
      code: abortLike ? 'timeout' : (code ?? 'network_error'),
      cause: err,
    },
  );
}
