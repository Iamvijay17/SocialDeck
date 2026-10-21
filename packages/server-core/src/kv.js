import { KeyValue } from './models/key-value.js';

/**
 * Encrypted, namespaced key/value store with optional TTL. Used by platform adapters for OAuth state,
 * app registrations and platform sessions. Values are encrypted with the key bound to the storage key
 * (AAD) so ciphertext cannot be swapped between records.
 */
export function createKv(cipher, namespace) {
  const full = (key) => `${namespace}:${key}`;
  return {
    async get(key) {
      const doc = await KeyValue.findOne({ key: full(key) }).lean();
      if (!doc) return null;
      if (doc.expiresAt && doc.expiresAt < new Date()) return null;
      return cipher.decryptJson(doc.value, full(key));
    },
    async set(key, value, { ttlSeconds } = {}) {
      const k = full(key);
      await KeyValue.updateOne(
        { key: k },
        {
          $set: {
            value: cipher.encryptJson(value, k),
            expiresAt: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null,
          },
        },
        { upsert: true },
      );
    },
    async delete(key) {
      await KeyValue.deleteOne({ key: full(key) });
    },
  };
}
