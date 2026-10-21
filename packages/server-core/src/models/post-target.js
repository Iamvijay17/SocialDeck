import { ERROR_CLASS, PLATFORM_IDS, TARGET_STATUS, TARGET_STATUSES } from '@osh/shared';
import { Schema, ObjectId, baseOptions, defineModel } from './common.js';

const postTargetSchema = new Schema(
  {
    postId: { type: ObjectId, ref: 'Post', required: true },
    ownerId: { type: ObjectId, ref: 'User', required: true },
    accountId: { type: ObjectId, ref: 'SocialAccount', required: true },
    platform: { type: String, enum: PLATFORM_IDS, required: true },
    /** Platform-specific caption. null = use the shared post text. */
    textOverride: { type: String, default: null, maxlength: 10_000 },
    options: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: TARGET_STATUSES, default: TARGET_STATUS.DRAFT },
    scheduledAt: { type: Date, default: null },

    remoteId: { type: String, maxlength: 500 },
    remoteUrl: { type: String, maxlength: 2000 },

    attemptCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    errorClass: { type: String, enum: [...Object.values(ERROR_CLASS), null], default: null },
    errorCode: { type: String, maxlength: 100 },
    errorMessage: { type: String, maxlength: 1000 },
    nextRetryAt: { type: Date, default: null },

    queuedAt: Date,
    startedAt: Date,
    lastAttemptAt: Date,
    publishedAt: Date,
  },
  baseOptions,
);

// A post can target each account at most once.
postTargetSchema.index({ postId: 1, accountId: 1 }, { unique: true });
postTargetSchema.index({ ownerId: 1, status: 1 });
postTargetSchema.index({ accountId: 1, status: 1 });
postTargetSchema.index({ ownerId: 1, publishedAt: -1 });

export const PostTarget = defineModel('PostTarget', postTargetSchema);
