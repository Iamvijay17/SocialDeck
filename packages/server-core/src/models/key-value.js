import { Schema, defineModel } from './common.js';

/**
 * Encrypted key/value storage used for short-lived OAuth state and platform sessions/app registrations.
 * `value` is always AES-GCM ciphertext (see kv.js).
 */
const keyValueSchema = new Schema(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
    expiresAt: { type: Date },
  },
  { versionKey: false, timestamps: true },
);

keyValueSchema.index({ key: 1 }, { unique: true });
keyValueSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const KeyValue = defineModel('KeyValue', keyValueSchema);
