import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signMediaToken, verifyMediaToken } from '@osh/shared/media-token';
import { createGatewayHandler } from '../src/handler.js';

const KEY = randomBytes(32);
const STORAGE_KEY = '2026/10/00000000-0000-4000-8000-000000000001.jpg';
const BYTES = Buffer.from('0123456789abcdefghij');

let dir;
let server;
let base;
const nowMs = Date.now();

const token = (over = {}) =>
  signMediaToken({ key: KEY, storageKey: STORAGE_KEY, mimeType: 'image/jpeg', expiresAtSeconds: Math.floor(nowMs / 1000) + 600, ...over });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-gw-'));
  fs.mkdirSync(path.join(dir, '2026/10'), { recursive: true });
  fs.writeFileSync(path.join(dir, STORAGE_KEY), BYTES);
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
  const handler = createGatewayHandler({ mediaDir: dir, signingKey: KEY, now: () => nowMs, maxRequestsPerMinute: 1000 });
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('signed media tokens', () => {
  it('round-trip, and reject tampering, wrong keys, expiry and unsafe storage keys', () => {
    const t = token();
    expect(verifyMediaToken({ key: KEY, token: t, nowSeconds: Math.floor(nowMs / 1000) })).toMatchObject({ storageKey: STORAGE_KEY, mimeType: 'image/jpeg' });
    expect(verifyMediaToken({ key: randomBytes(32), token: t })).toBeNull();
    const [payload, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ k: '2026/10/00000000-0000-4000-8000-000000000002.jpg', t: 'image/jpeg', e: 9_999_999_999 })).toString('base64url');
    expect(verifyMediaToken({ key: KEY, token: `${forged}.${sig}` })).toBeNull();
    expect(verifyMediaToken({ key: KEY, token: `${payload}.${sig}x` })).toBeNull();
    expect(verifyMediaToken({ key: KEY, token: token({ expiresAtSeconds: 100 }), nowSeconds: 200 })).toBeNull();
    expect(verifyMediaToken({ key: KEY, token: token({ storageKey: '../../etc/passwd' }) })).toBeNull();
    expect(verifyMediaToken({ key: KEY, token: 'garbage' })).toBeNull();
    expect(verifyMediaToken({ key: KEY, token: `${t}.extra` })).toBeNull();
  });
});

describe('media gateway', () => {
  it('serves exactly the signed file with safe headers', async () => {
    const res = await fetch(`${base}/m/${token()}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(BYTES);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-length')).toBe(String(BYTES.length));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('supports HEAD and byte ranges (needed by video fetchers)', async () => {
    const head = await fetch(`${base}/m/${token()}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(BYTES.length));

    const part = await fetch(`${base}/m/${token()}`, { headers: { range: 'bytes=5-9' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 5-9/${BYTES.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('56789');

    const tail = await fetch(`${base}/m/${token()}`, { headers: { range: 'bytes=-4' } });
    expect(Buffer.from(await tail.arrayBuffer()).toString()).toBe('ghij');
    expect((await fetch(`${base}/m/${token()}`, { headers: { range: 'bytes=999-' } })).status).toBe(416);
  });

  it('answers 404 to expired, tampered and malformed links without revealing which', async () => {
    const t = token();
    const bodies = new Set();
    for (const url of [`${base}/m/${token({ expiresAtSeconds: Math.floor(nowMs / 1000) - 5 })}`, `${base}/m/${t.slice(0, -2)}xx`, `${base}/m/abc`, `${base}/m/${token({ storageKey: '2026/10/00000000-0000-4000-8000-0000000000ff.jpg' })}`]) {
      const res = await fetch(url);
      expect(res.status).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  it('exposes nothing else: no API, no directory listing, no path traversal, no writes', async () => {
    for (const p of ['/', '/api/auth/me', '/api/posts', '/m/', '/m', '/secret.txt', '/../secret.txt', '/m/../secret.txt', '/%2e%2e/secret.txt', '/2026/10/']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(404);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await fetch(`${base}/m/${token()}`, { method })).status).toBe(405);
    }
  });

  it('has a health endpoint that identifies the gateway (used by the "test connection" button)', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-socialdeck-gateway')).toBe('1');
  });

  it('applies a global request budget', async () => {
    const limited = createGatewayHandler({ mediaDir: dir, signingKey: KEY, now: () => nowMs, maxRequestsPerMinute: 3 });
    const s = http.createServer(limited);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${s.address().port}/healthz`;
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await fetch(url)).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    } finally {
      s.close();
    }
  });
});
