import http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  PlatformError,
  assertSafeUrl,
  classifyHttpFailure,
  classifyNetworkError,
  computeRetryDelayMs,
  createSafeFetch,
  graphemeLength,
  isPrivateAddress,
  mastodonLength,
  parseRetryAfter,
} from '../src/index.js';

describe('retry delay', () => {
  it('grows exponentially and is capped', () => {
    const noJitter = () => 0.999999;
    const d = (n) => computeRetryDelayMs(n, { baseMs: 1000, maxMs: 10_000, random: noJitter });
    expect(d(1)).toBeGreaterThan(900);
    expect(d(1)).toBeLessThanOrEqual(1000);
    expect(d(3)).toBeGreaterThan(3900);
    expect(d(3)).toBeLessThanOrEqual(4000);
    expect(d(10)).toBeLessThanOrEqual(10_000);
  });
  it('applies jitter within [exp/2, exp]', () => {
    for (let i = 0; i < 50; i++) {
      const v = computeRetryDelayMs(2, { baseMs: 1000, maxMs: 60_000 });
      expect(v).toBeGreaterThanOrEqual(1000);
      expect(v).toBeLessThanOrEqual(2000);
    }
  });
  it('never retries sooner than Retry-After', () => {
    const v = computeRetryDelayMs(1, { baseMs: 100, maxMs: 1000, retryAfterMs: 30_000 });
    expect(v).toBeGreaterThanOrEqual(30_000);
  });
});

describe('error classification', () => {
  const mk = (status, opts = {}) => classifyHttpFailure({ status, headers: new Headers(opts.headers), ...opts });
  it('maps statuses to retry classes', () => {
    expect(mk(429, { headers: { 'retry-after': '12' } })).toMatchObject({ kind: 'rate_limited', retryAfterMs: 12_000 });
    expect(mk(401).kind).toBe('auth');
    expect(mk(403).kind).toBe('auth');
    expect(mk(422).kind).toBe('permanent');
    expect(mk(400).kind).toBe('permanent');
  });
  it('treats 5xx on creating requests as ambiguous unless an idempotency key was used', () => {
    expect(mk(502, { mutating: true }).kind).toBe('ambiguous');
    expect(mk(502, { mutating: true, idempotent: true }).kind).toBe('transient');
    expect(mk(502, { mutating: false }).kind).toBe('transient');
  });
  it('classifies network errors by whether the request could have been sent', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(classifyNetworkError(refused, { mutating: true }).kind).toBe('transient');
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(classifyNetworkError(reset, { mutating: true }).kind).toBe('ambiguous');
    expect(classifyNetworkError(reset, { mutating: true, idempotent: true }).kind).toBe('transient');
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    expect(classifyNetworkError(timeout, { mutating: true }).kind).toBe('ambiguous');
    const blocked = Object.assign(new Error('Address is not publicly routable'), { code: 'ERR_SSRF_BLOCKED' });
    expect(classifyNetworkError(blocked).kind).toBe('permanent');
    expect(classifyNetworkError(new PlatformError('x', { kind: 'auth' })).kind).toBe('auth');
  });
  it('parses Retry-After in seconds and HTTP-date forms', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
  });
});

describe('text counting', () => {
  it('counts graphemes, not UTF-16 units', () => {
    expect(graphemeLength('héllo')).toBe(5);
    expect(graphemeLength('👨‍👩‍👧‍👦')).toBe(1);
    expect(graphemeLength('🇩🇪🇫🇷')).toBe(2);
  });
  it('counts URLs as a fixed length for Mastodon', () => {
    const url = 'https://example.com/' + 'a'.repeat(200);
    expect(mastodonLength(`hi ${url}`)).toBe(3 + 23);
    expect(mastodonLength(`hi ${url}`, 30)).toBe(3 + 30);
  });
  it('ignores the domain of remote mentions on Mastodon', () => {
    expect(mastodonLength('@bob@very.long.example.social hi')).toBe('@bob hi'.length);
  });
});

describe('SSRF protection', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', 'ff02::1',
  ])('blocks %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '172.32.0.1'])('allows %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('validates URLs before any request', () => {
    expect(() => assertSafeUrl('http://example.com')).toThrow(/https/);
    expect(() => assertSafeUrl('https://user:pw@example.com')).toThrow(/credentials/);
    expect(() => assertSafeUrl('https://127.0.0.1/')).toThrow();
    expect(() => assertSafeUrl('https://[::1]/')).toThrow();
    expect(() => assertSafeUrl('https://localhost/')).toThrow();
    expect(() => assertSafeUrl('https://printer.local/')).toThrow();
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow();
    expect(assertSafeUrl('https://mastodon.social/api').hostname).toBe('mastodon.social');
    expect(assertSafeUrl('http://localhost:3000', { allowPrivate: true }).port).toBe('3000');
  });

  it('blocks connections to loopback addresses at connect time, and allows them only when explicitly enabled', async () => {
    const server = http.createServer((_req, res) => res.end('secret'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const strict = createSafeFetch({ allowPrivate: false });
      await expect(strict(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: 'ERR_SSRF_BLOCKED' });
      // a hostname that resolves to loopback is caught by the guarded DNS lookup, not just the literal-IP check
      await expect(strict(`https://localtest.me:${port}/`)).rejects.toBeTruthy();

      const dev = createSafeFetch({ allowPrivate: true });
      const res = await dev(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('secret');
    } finally {
      server.close();
    }
  });

  it('does not follow redirects automatically', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const dev = createSafeFetch({ allowPrivate: true });
      const res = await dev(`http://127.0.0.1:${server.address().port}/`);
      expect(res.status).toBe(302);
    } finally {
      server.close();
    }
  });
});
