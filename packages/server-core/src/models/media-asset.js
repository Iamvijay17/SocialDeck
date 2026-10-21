import { Schema, ObjectId, baseOptions, defineModel } from './common.js';

const mediaAssetSchema = new Schema(
  {
    ownerId: { type: ObjectId, ref: 'User', required: true },
    /** Generated server-side, relative to MEDIA_DIR. Never derived from user input. */
    storageKey: { type: String, required: true },
    originalName: { type: String, maxlength: 255 },
    mimeType: { type: String, required: true },
    kind: { type: String, enum: ['image', 'video'], required: true },
    size: { type: Number, required: true },
    checksumSha256: { type: String, required: true },
    width: Number,
    height: Number,
    durationSeconds: Number,
    altText: { type: String, maxlength: 1500, default: null },
  },
  { ...baseOptions, timestamps: { createdAt: true, updatedAt: false } },
);

mediaAssetSchema.index({ storageKey: 1 }, { unique: true });
mediaAssetSchema.index({ ownerId: 1, createdAt: -1 });
mediaAssetSchema.index({ ownerId: 1, checksumSha256: 1 });

export const MediaAsset = defineModel('MediaAsset', mediaAssetSchema);
