import mongoose from 'mongoose';

/** Shared schema options: UTC timestamps, `id` instead of `_id`, no `__v` in JSON output. */
export const baseOptions = {
  timestamps: true,
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform(_doc, ret) {
      ret.id = String(ret._id);
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
};

export const { Schema } = mongoose;
export const ObjectId = Schema.Types.ObjectId;

export function defineModel(name, schema) {
  return mongoose.models[name] ?? mongoose.model(name, schema);
}
