import { ACCOUNT_STATUS, PLATFORM_IDS } from '@osh/shared';
import { Schema, ObjectId, baseOptions, defineModel } from './common.js';

const socialAccountSchema = new Schema(
  {
    ownerId: { type: ObjectId, ref: 'User', required: true },
    platform: { type: String, enum: PLATFORM_IDS, required: true },
    /** Stable id on the platform (DID, user@instance, ...). */
    externalId: { type: String, required: true, maxlength: 400 },
    displayName: { type: String, required: true, maxlength: 200 },
    handle: { type: String, maxlength: 300 },
    avatarUrl: { type: String, maxlength: 1000 },
    instance: { type: String, maxlength: 253 },
    /** AES-256-GCM ciphertext of the adapter credentials JSON. Never selected or serialised by default. */
    credentials: { type: String, required: true, select: false },
    scopes: { type: [String], default: [] },
    tokenExpiresAt: { type: Date, default: null },
    status: { type: String, enum: Object.values(ACCOUNT_STATUS), default: ACCOUNT_STATUS.ACTIVE },
    statusReason: { type: String, maxlength: 500 },
    lastVerifiedAt: Date,
    connectedAt: { type: Date, default: Date.now },
  },
  {
    ...baseOptions,
    toJSON: {
      ...baseOptions.toJSON,
      transform(doc, ret) {
        baseOptions.toJSON.transform(doc, ret);
        delete ret.credentials; // defence in depth: ciphertext is never returned either
        return ret;
      },
    },
  },
);

socialAccountSchema.index({ ownerId: 1, platform: 1, externalId: 1 }, { unique: true });
socialAccountSchema.index({ ownerId: 1, status: 1 });

export const SocialAccount = defineModel('SocialAccount', socialAccountSchema);
