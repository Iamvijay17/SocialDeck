import { ERROR_CLASS } from '@osh/shared';
import { PlatformError, classifyNetworkError, parseRetryAfter, readJsonBody } from '@osh/platform-core';

/**
 * Shared plumbing for Meta's Graph-style APIs (Facebook Pages, Instagram, Threads): one HTTP helper and one place
 * that turns Graph errors into the retry classes the publishing engine understands.
 */

const SECRET_RE = /(access_token|client_secret|fb_exchange_token|input_token)=([^&\s"']+)/gi;
const TOKENISH_RE = /\b(EA[A-Za-z0-9]{20,}|THAA[A-Za-z0-9]{20,}|IG[A-Za-z0-9]{30,})\b/g;

/** Defence in depth: never let a token echo back into an error message. */
export const redact = (text) => String(text ?? '').replace(SECRET_RE, '$1=[REDACTED]').replace(TOKENISH_RE, '[REDACTED]');

const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]); // token expired / revoked / user logged out / password changed
const RATE_CODES = new Set([4, 17, 32, 341, 613]); // app, user, page and "application limit reached" throttles

/** Largest `estimated_time_to_regain_access` (minutes) reported by Meta's usage headers, in ms. */
function usageBackoffMs(headers) {
  let best = 0;
  for (const name of ['x-business-use-case-usage', 'x-app-usage', 'x-page-usage', 'x-ad-account-usage']) {
    const raw = headers?.get?.(name);
    if (!raw) continue;
    try {
      const visit = (v) => {
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object') {
          if (Number.isFinite(v.estimated_time_to_regain_access)) best = Math.max(best, v.estimated_time_to_regain_access);
          Object.values(v).forEach(visit);
        }
      };
      visit(JSON.parse(raw));
    } catch {
      /* ignore malformed header */
    }
  }
  return best * 60_000;
}

/**
 * @param {object} p
 * @param {number} p.status HTTP status
 * @param {object} [p.body] parsed JSON error body ({ error: { message, type, code, error_subcode, is_transient } })
 * @param {Headers} [p.headers]
 * @param {boolean} [p.mutating] the request creates something public
 */
export function classifyGraphError({ status, body, headers, mutating = false }) {
  const e = body?.error ?? {};
  const code = e.code;
  const sub = e.error_subcode;
  const message = redact(e.error_user_msg || e.message || `The platform returned HTTP ${status}`).slice(0, 400);
  const make = (kind, extra = {}, text = message) => new PlatformError(text, { kind, code: String(code ?? status), status, ...extra });

  if (code === 190 || status === 401 || AUTH_SUBCODES.has(sub)) {
    return make(ERROR_CLASS.AUTH, { code: 'token_invalid' }, 'The access token is no longer valid (expired, revoked, or the password changed). Reconnect the account.');
  }
  if (code === 10 || (code >= 200 && code <= 299) || status === 403) {
    return make(ERROR_CLASS.AUTH, { code: 'permission_denied' }, `Permission denied: ${message} Reconnect the account and approve every requested permission.`);
  }
  if (RATE_CODES.has(code) || (code >= 80000 && code <= 80014) || status === 429) {
    const retryAfterMs = parseRetryAfter(headers?.get?.('retry-after')) ?? (usageBackoffMs(headers) || 15 * 60_000);
    return make(ERROR_CLASS.RATE_LIMITED, { retryAfterMs });
  }
  if (code === 368) return make(ERROR_CLASS.PERMANENT, { code: 'temporarily_blocked' });
  // Instagram: the container is still being processed. Nothing is public yet, so waiting and retrying is safe.
  if (code === 9007 || sub === 2207027) return make(ERROR_CLASS.TRANSIENT, { code: 'media_not_ready' });
  if (e.is_transient === true || code === 1 || code === 2 || status >= 500) {
    return make(mutating ? ERROR_CLASS.AMBIGUOUS : ERROR_CLASS.TRANSIENT, { code: code ? String(code) : 'server_error' });
  }
  return make(ERROR_CLASS.PERMANENT);
}

/** Minimal Graph HTTP client. Tokens travel in the request body / query only and never appear in messages. */
export class GraphClient {
  /**
   * @param {object} o
   * @param {Function} o.fetch SSRF-safe fetch (or a mock)
   * @param {string} o.baseUrl e.g. https://graph.facebook.com/v26.0
   */
  constructor({ fetch, baseUrl }) {
    this.fetch = fetch;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * @param {'GET'|'POST'|'DELETE'} method
   * @param {string} path e.g. "/me/accounts"
   * @param {object} [o]
   * @param {Record<string, string|number|boolean|undefined>} [o.params] query (GET) or urlencoded form (POST)
   * @param {FormData} [o.multipart] file upload body (POST)
   * @param {string} [o.token]
   * @param {boolean} [o.mutating]
   * @param {AbortSignal} [o.signal]
   */
  async request(method, path, { params = {}, multipart, token, mutating = false, signal } = {}) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if (token) clean.access_token = token;
    let url = `${this.baseUrl}${path}`;
    let body;
    const headers = { accept: 'application/json' };
    if (multipart) {
      for (const [k, v] of Object.entries(clean)) multipart.set(k, String(v));
      body = multipart;
    } else if (method === 'GET' || method === 'DELETE') {
      url += `?${new URLSearchParams(Object.entries(clean).map(([k, v]) => [k, String(v)]))}`;
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(Object.entries(clean).map(([k, v]) => [k, String(v)]));
    }

    let res;
    try {
      res = await this.fetch(url, { method, headers, body, signal });
    } catch (err) {
      throw classifyNetworkError(err, { mutating, idempotent: false });
    }
    let data;
    try {
      data = await readJsonBody(res);
    } catch (err) {
      throw classifyNetworkError(err, { mutating });
    }
    if (res.status >= 300 && res.status < 400) {
      throw new PlatformError('The platform redirected the request, which is not allowed.', { kind: ERROR_CLASS.PERMANENT, code: 'redirected', status: res.status });
    }
    if (!res.ok || data?.error) throw classifyGraphError({ status: res.status, body: data, headers: res.headers, mutating });
    return data ?? {};
  }
}
