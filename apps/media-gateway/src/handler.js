import fs from 'node:fs';
import path from 'node:path';
import { verifyMediaToken } from '@osh/shared/media-token';

/**
 * The media gateway: the ONLY thing that is ever meant to be reachable from the internet (through a tunnel),
 * and only so that Instagram / Threads can download media they are about to publish.
 *
 *  - serves GET/HEAD /m/<signed-token> and GET /healthz, nothing else (every other path is a 404);
 *  - a token names exactly one file and expires (default 30 minutes);
 *  - no database, no sessions, no API: it holds the signing key and a read-only view of the media folder;
 *  - global request budget, strict headers, no directory listing, no path derived from the request.
 */
export function createGatewayHandler({ mediaDir, signingKey, now = () => Date.now(), maxRequestsPerMinute = 600, logger }) {
  const root = path.resolve(mediaDir);
  let windowStart = now();
  let count = 0;

  function limited() {
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      count = 0;
    }
    return ++count > maxRequestsPerMinute;
  }

  const baseHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  };

  function send(res, status, body = '', extra = {}) {
    res.writeHead(status, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  }

  return function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    if (limited()) return send(res, 429, 'Too many requests', { 'Retry-After': '30' });

    let pathname;
    try {
      pathname = new URL(req.url, 'http://gateway.invalid').pathname;
    } catch {
      return send(res, 400, 'Bad request');
    }

    if (pathname === '/healthz') return send(res, 200, 'ok\n', { 'X-SocialDeck-Gateway': '1' });

    const m = /^\/m\/([A-Za-z0-9_.-]{20,700})$/.exec(pathname);
    if (!m) return send(res, 404, 'Not found');

    const claims = verifyMediaToken({ key: signingKey, token: m[1], nowSeconds: Math.floor(now() / 1000) });
    // One generic answer for bad, expired and tampered tokens: no oracle for guessing.
    if (!claims) return send(res, 404, 'Not found');

    const abs = path.resolve(root, claims.storageKey);
    if (!abs.startsWith(root + path.sep)) return send(res, 404, 'Not found');

    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found');

      let start = 0;
      let end = st.size - 1;
      let status = 200;
      const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (range && (range[1] || range[2])) {
        if (range[1] === '') {
          start = Math.max(0, st.size - Number(range[2])); // suffix range
        } else {
          start = Number(range[1]);
          if (range[2] !== '') end = Math.min(end, Number(range[2]));
        }
        if (start > end || start >= st.size) return send(res, 416, 'Range not satisfiable', { 'Content-Range': `bytes */${st.size}` });
        status = 206;
      }

      const headers = {
        ...baseHeaders,
        'Content-Type': claims.mimeType,
        'Content-Length': String(end - start + 1),
        'Content-Disposition': 'inline',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=60',
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}),
      };
      res.writeHead(status, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(abs, { start, end })
        .on('error', (e) => {
          logger?.error({ code: e.code }, 'media read failed');
          res.destroy(e);
        })
        .pipe(res);
    });
  };
}
