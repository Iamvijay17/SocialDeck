import { Schema, ObjectId, defineModel } from './common.js';

const auditLogSchema = new Schema(
  {
    actorId: { type: ObjectId, ref: 'User', default: null },
    action: { type: String, required: true, maxlength: 100 },
    resourceType: { type: String, maxlength: 50 },
    resourceId: { type: String, maxlength: 100 },
    /** Non-sensitive context only. Never put tokens, passwords or message bodies here. */
    metadata: { type: Schema.Types.Mixed, default: {} },
    requestId: { type: String, maxlength: 100 },
    createdAt: { type: Date, default: Date.now },
  },
  {
    versionKey: false,
    toJSON: {
      versionKey: false,
      transform(_d, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
      },
    },
  },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1 });

export const AuditLog = defineModel('AuditLog', auditLogSchema);
