/**
 * Thin fetch wrapper for the API. Sends cookies, attaches the per-session CSRF token to state-changing
 * requests, and converts the API's error envelope into ApiError.
 */
let csrfToken = null;

export function setCsrfToken(token) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export async function api(path, { method = 'GET', body, formData, signal } = {}) {
  const headers = { Accept: 'application/json' };
  let payload;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin', signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Is the API running?');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    if (res.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new Event('auth:unauthorized'));
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details, e?.requestId);
  }
  return data;
}

export const qs = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== '') sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
};
