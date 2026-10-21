import { POST_STATUSES, POST_STATUS } from '@osh/shared';
import { Schema, ObjectId, baseOptions, defineModel } from './common.js';

const postSchema = new Schema(
  {
    ownerId: { type: ObjectId, ref: 'User', required: true },
    text: { type: String, default: '', maxlength: 10_000 },
    mediaIds: { type: [ObjectId], ref: 'MediaAsset', default: [] },
    /** Denormalised from the targets (see derivePostStatus); recomputed whenever a target changes. */
    status: { type: String, enum: POST_STATUSES, default: POST_STATUS.DRAFT },
    /** UTC instant. Display timezone is a user preference. */
    scheduledAt: { type: Date, default: null },
    /** Timezone the user picked when scheduling (display hint only). */
    timezone: { type: String, maxlength: 64 },
    publishedAt: { type: Date, default: null },
  },
  baseOptions,
);

postSchema.index({ ownerId: 1, createdAt: -1 });
postSchema.index({ ownerId: 1, status: 1, scheduledAt: 1 });
postSchema.index({ ownerId: 1, scheduledAt: 1 });
postSchema.index({ mediaIds: 1 });

export const Post = defineModel('Post', postSchema);
