import { Schema, baseOptions, defineModel } from './common.js';

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    displayName: { type: String, trim: true, maxlength: 80 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['owner', 'friend', 'member'], default: 'member' },
    /** True for the single installation owner. A partial unique index makes "claiming" a fresh install atomic. */
    isOwner: { type: Boolean, default: false },
    preferences: {
      timezone: { type: String, default: 'UTC' },
      theme: { type: String, enum: ['dark', 'light', 'system'], default: 'dark' },
    },
    lastLoginAt: Date,
  },
  {
    ...baseOptions,
    toJSON: {
      ...baseOptions.toJSON,
      transform(doc, ret) {
        baseOptions.toJSON.transform(doc, ret);
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ isOwner: 1 }, { unique: true, partialFilterExpression: { isOwner: true } });

export const User = defineModel('User', userSchema);
