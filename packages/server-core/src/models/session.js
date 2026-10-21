import { Schema, ObjectId, defineModel } from './common.js';

/** Server-side session. Only a hash of the cookie token is stored. */
const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    userId: { type: ObjectId, ref: 'User', required: true },
    csrfToken: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    /** idle expiry – slid forward on use; also drives the TTL index */
    expiresAt: { type: Date, required: true },
    userAgent: { type: String, maxlength: 300 },
  },
  { versionKey: false },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = defineModel('Session', sessionSchema);
