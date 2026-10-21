import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * SSRF protection for every outbound request that targets a user-influenced host
 * (e.g. the Mastodon instance a user types in).
 *
 *  1. The URL is validated (scheme, no credentials, literal IPs checked).
 *  2. Hostnames are resolved by a custom `lookup` used *at connect time*, and every resolved
 *     address is checked – this closes the DNS-rebinding gap that a separate pre-flight lookup leaves.
 *  3. Redirects are never followed automatically.
 */

function ssrfError(message) {
  const err = new Error(message);
  err.code = 'ERR_SSRF_BLOCKED';
  return err;
}

/** @param {string} ip */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  return true; // not an IP -> treat as unsafe
}

function isPrivateV4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast + reserved + broadcast
  );
}

function isPrivateV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:aabb:ccdd)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xff00) === 0xff00 || // multicast
    lower.startsWith('2001:db8') || // documentation
    lower.startsWith('64:ff9b:') // NAT64 – can reach private v4 space
  );
}

/**
 * Validate a URL string before any request is made.
 * @returns {URL}
 */
export function assertSafeUrl(input, { allowPrivate = false, allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw ssrfError('Invalid URL');
  }
  if (url.username || url.password) throw ssrfError('URLs with embedded credentials are not allowed');
  const httpOk = allowHttp || allowPrivate;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && httpOk)) {
    throw ssrfError('Only https:// URLs are allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (net.isIP(host) && isPrivateAddress(host)) throw ssrfError('Address is not publicly routable');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw ssrfError('Local hostnames are not allowed');
    }
  }
  return url;
}

function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIPv6(addresses) ? 6 : 4 }];
      const allowed = allowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));
      if (allowed.length === 0) return callback(ssrfError('Hostname resolves to a non-public address'));
      if (options?.all) return callback(null, allowed);
      return callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

/**
 * Create a fetch function with SSRF protection, timeouts and a stable User-Agent.
 * @param {object} [opts]
 * @param {boolean} [opts.allowPrivate] allow loopback/private targets (local development only)
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.userAgent]
 * @param {Function} [opts.fetchImpl] test seam
 */
export function createSafeFetch({ allowPrivate = false, timeoutMs = 20_000, userAgent = 'OpenSocialHub/0.1', fetchImpl } = {}) {
  const dispatcher = new Agent({
    connect: { lookup: guardedLookup(allowPrivate), timeout: 10_000 },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
  const doFetch = fetchImpl ?? undiciFetch;

  return async function safeFetch(input, init = {}) {
    const url = assertSafeUrl(String(input), { allowPrivate });
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('user-agent')) headers.set('user-agent', userAgent);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return doFetch(url, { ...init, headers, signal, redirect: 'manual', dispatcher });
  };
}

/** Read a response body as JSON with a size cap. Returns undefined for empty/non-JSON bodies. */
export async function readJsonBody(res, maxBytes = 2 * 1024 * 1024) {
  const text = await readTextBody(res, maxBytes);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function readTextBody(res, maxBytes = 2 * 1024 * 1024) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Response body too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Response body too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
