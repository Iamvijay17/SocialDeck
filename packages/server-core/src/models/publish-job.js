import { ACTIVE_JOB_STATUSES, PUBLISH_JOB_STATUS } from '@osh/shared';
import { Schema, ObjectId, baseOptions, defineModel } from './common.js';

const attemptSchema = new Schema(
  {
    n: Number,
    startedAt: Date,
    finishedAt: Date,
    outcome: { type: String, enum: ['success', 'retry', 'failed', 'abandoned', 'auth'] },
    errorClass: String,
    errorCode: String,
    httpStatus: Number,
  },
  { _id: false },
);

const publishJobSchema = new Schema(
  {
    targetId: { type: ObjectId, ref: 'PostTarget', required: true },
    postId: { type: ObjectId, ref: 'Post', required: true },
    ownerId: { type: ObjectId, ref: 'User', required: true },
    /** Id of the BullMQ job currently representing this job (changes per retry: `<id>.<attempt>`). */
    queueJobId: { type: String },
    /** Earliest execution time (UTC). */
    runAt: { type: Date, required: true },
    status: { type: String, enum: Object.values(PUBLISH_JOB_STATUS), default: PUBLISH_JOB_STATUS.PENDING },
    attemptCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    attempts: { type: [attemptSchema], default: [] },
    /** Stable across all attempts; sent to platforms that support idempotency keys. */
    idempotencyKey: { type: String, required: true },
    /**
     * idle | preparing (claimed; uploading media etc. - nothing public created yet) |
     * sending (the request that creates the post may be on the wire - outcome unknown if we crash now).
     */
    phase: { type: String, enum: ['idle', 'preparing', 'sending'], default: 'idle' },
    sendingAt: Date,
    workerId: String,
    startedAt: Date,
    finishedAt: Date,
    heartbeatAt: Date,
    recovery: {
      count: { type: Number, default: 0 },
      lastAt: Date,
      lastReason: String,
    },
  },
  baseOptions,
);

// Database-level duplicate prevention: at most one active job per target.
publishJobSchema.index(
  { targetId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_JOB_STATUSES } }, name: 'one_active_job_per_target' },
);
publishJobSchema.index({ status: 1, runAt: 1 });
publishJobSchema.index({ ownerId: 1, createdAt: -1 });
publishJobSchema.index({ postId: 1 });
publishJobSchema.index({ queueJobId: 1 }, { sparse: true });

export const PublishJob = defineModel('PublishJob', publishJobSchema);
