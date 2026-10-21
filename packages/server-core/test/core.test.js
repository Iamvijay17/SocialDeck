import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCipher } from '../src/crypto.js';
import { loadConfig } from '../src/config.js';
import { createLogger, scrubSecrets } from '../src/logger.js';
import { detectMedia, readImageSize } from '../src/media/sniff.js';
import { createMediaStorage } from '../src/media/storage.js';

const KEY = randomBytes(32).toString('hex');
const baseEnv = { NODE_ENV: 'test', ENCRYPTION_KEY: KEY };

describe('encryption at rest', () => {
  const cipher = createCipher({ key: Buffer.from(KEY, 'hex') });
  it('round-trips and never stores plaintext', () => {
    const blob = cipher.encryptJson({ accessToken: 'super-secret-token' }, 'aad');
    expect(blob).not.toContain('super-secret-token');
    expect(cipher.decryptJson(blob, 'aad')).toEqual({ accessToken: 'super-secret-token' });
  });
  it('uses a fresh IV each time', () => {
    expect(cipher.encrypt('x')).not.toBe(cipher.encrypt('x'));
  });
  it('detects tampering and binds ciphertext to its context', () => {
    const blob = cipher.encrypt('hello', 'a');
    expect(() => cipher.decrypt(blob, 'b')).toThrow();
    const parts = blob.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => cipher.decrypt(parts.join('.'), 'a')).toThrow();
  });
  it('supports key rotation through previous keys', () => {
    const oldKey = randomBytes(32);
    const old = createCipher({ key: oldKey });
    const blob = old.encrypt('legacy');
    const rotated = createCipher({ key: randomBytes(32), previousKeys: [oldKey] });
    expect(rotated.needsRotation(blob)).toBe(true);
    expect(rotated.decrypt(blob)).toBe('legacy');
    expect(rotated.needsRotation(rotated.encrypt('new'))).toBe(false);
    expect(() => createCipher({ key: randomBytes(32) }).decrypt(blob)).toThrow(/No encryption key/);
  });
  it('derives independent subkeys', () => {
    expect(cipher.deriveKey('a').equals(cipher.deriveKey('b'))).toBe(false);
  });
});

describe('configuration validation', () => {
  it('requires an encryption key of exactly 32 bytes', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...baseEnv, ENCRYPTION_KEY: 'short' })).toThrow(/32 bytes/);
    expect(loadConfig(baseEnv).encryptionKey).toHaveLength(32);
  });
  it('names the offending variable and rejects bad values', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...baseEnv, DEFAULT_TIMEZONE: 'Mars/Base' })).toThrow(/DEFAULT_TIMEZONE/);
  });
  it('binds to loopback by default and refuses insecure remote production setups', () => {
    expect(loadConfig(baseEnv).host).toBe('127.0.0.1');
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production', PUBLIC_URL: 'http://psm.example.net' })).toThrow(/https/);
    expect(loadConfig({ ...baseEnv, NODE_ENV: 'production', PUBLIC_URL: 'http://127.0.0.1:8080' }).cookieSecure).toBe(false);
    expect(loadConfig({ ...baseEnv, NODE_ENV: 'production', PUBLIC_URL: 'https://psm.example.net' }).cookieSecure).toBe(true);
  });
  it('only builds an owner when both email and password are set', () => {
    expect(loadConfig(baseEnv).owner).toBeNull();
    expect(loadConfig({ ...baseEnv, OWNER_EMAIL: 'A@B.co', OWNER_PASSWORD: 'x'.repeat(14) }).owner.email).toBe('a@b.co');
  });
});

describe('log redaction', () => {
  function capture() {
    const lines = [];
    const dest = new Writable({ write(c, _e, cb) { lines.push(c.toString()); cb(); } });
    return { logger: createLogger({ level: 'debug', destination: dest }), text: () => lines.join('') };
  }
  it('redacts credential-like fields at any shallow depth', () => {
    const { logger, text } = capture();
    logger.info({ password: 'pw-123456789', account: { accessToken: 'tok-abcdef', credentials: 'cipher' }, req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'osh_session=zzz' } } }, 'event');
    const out = text();
    for (const secret of ['pw-123456789', 'tok-abcdef', 'cipher', 'abc.def.ghi', 'osh_session=zzz']) expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });
  it('scrubs tokens from error messages', () => {
    const { logger, text } = capture();
    logger.error({ err: new Error('request failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def and access_token=abcdef123456') }, 'boom');
    expect(text()).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(text()).not.toContain('abcdef123456');
    expect(scrubSecrets('client_secret: s3cr3tvalue99')).toContain('[REDACTED]');
  });
});

describe('file signatures', () => {
  const pad = (b) => Buffer.concat([b, Buffer.alloc(64)]);
  it('identifies supported formats from content', () => {
    expect(detectMedia(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))).toMatchObject({ mime: 'image/jpeg' });
    expect(detectMedia(pad(Buffer.from('GIF89a')))).toMatchObject({ mime: 'image/gif' });
    expect(detectMedia(pad(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])))).toMatchObject({ mime: 'image/webp' });
    expect(detectMedia(pad(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')])))).toMatchObject({ mime: 'video/mp4', kind: 'video' });
    expect(detectMedia(pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8), Buffer.from('webm')])))).toMatchObject({ mime: 'video/webm' });
  });
  it('rejects scripts, SVG, HEIC, QuickTime, Matroska and empty input', () => {
    expect(detectMedia(pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBeNull();
    expect(detectMedia(pad(Buffer.from('<?php system($_GET[0]); ?>')))).toBeNull();
    expect(detectMedia(pad(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')])))).toBeNull();
    expect(detectMedia(pad(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  ')])))).toBeNull();
    expect(detectMedia(pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20), Buffer.from('matroska')])))).toBeNull();
    expect(detectMedia(Buffer.alloc(0))).toBeNull();
  });
  it('reads JPEG dimensions from the SOF marker', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(readImageSize(jpeg, 'image/jpeg')).toEqual({ width: 640, height: 480 });
  });
});

describe('media storage path safety', () => {
  const storage = createMediaStorage({ dir: '/tmp/osh-test-media' });
  it('accepts generated keys and rejects traversal or odd keys', () => {
    const key = storage.newKey('png');
    expect(storage.absolutePath(key).startsWith(storage.root)).toBe(true);
    for (const bad of ['../etc/passwd', '2026/10/../../../x.png', '/etc/passwd', 'C:\\Windows\\win.ini', '2026/10/not-a-uuid.png', '2026/10/00000000-0000-0000-0000-000000000000.php/../x.png', '', null, undefined]) {
      expect(() => storage.absolutePath(bad), String(bad)).toThrow(/Invalid storage key/);
    }
  });
});
