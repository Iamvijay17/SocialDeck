import { Schema, defineModel } from './common.js';

/** Small non-secret runtime settings the owner can change without restarting (e.g. the public media URL). */
const appSettingSchema = new Schema(
  { key: { type: String, required: true }, value: { type: Schema.Types.Mixed } },
  { versionKey: false, timestamps: true },
);
appSettingSchema.index({ key: 1 }, { unique: true });

export const AppSetting = defineModel('AppSetting', appSettingSchema);
