import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authenticated encryption for secrets at rest (AES-256-GCM).
 *
 * Format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts). `keyId` identifies which configured key
 * encrypted the value so keys can be rotated: set ENCRYPTION_KEY to the new key and move the old one to
 * ENCRYPTION_KEY_PREVIOUS, then run `npm run rotate-key`.
 *
 * Subkeys for other purposes (signed media URLs) are derived with HKDF so the master key is never reused directly.
 */

const keyIdOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 8);

export function createCipher({ key, previousKeys = [] }) {
  const keys = new Map([key, ...previousKeys].map((k) => [keyIdOf(k), k]));
  const currentId = keyIdOf(key);

  function encrypt(plaintext, aad = '') {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', currentId, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  function decrypt(payload, aad = '') {
    const parts = String(payload).split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('Unsupported ciphertext format');
    const k = keys.get(parts[1]);
    if (!k) throw new Error('No encryption key available for this ciphertext (was ENCRYPTION_KEY changed?)');
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(parts[2], 'base64url'));
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
  }

  const encryptJson = (value, aad) => encrypt(JSON.stringify(value), aad);
  const decryptJson = (payload, aad) => JSON.parse(decrypt(payload, aad));
  const needsRotation = (payload) => String(payload).split('.')[1] !== currentId;

  function deriveKey(purpose) {
    return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `private-social-manager:${purpose}`, 32));
  }

  return { encrypt, decrypt, encryptJson, decryptJson, needsRotation, deriveKey, currentKeyId: currentId };
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function hmacHex(key, data) {
  return createHmac('sha256', key).update(data).digest('hex');
}
