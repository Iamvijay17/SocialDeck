import mongoose from 'mongoose';
import * as models from './models/index.js';

mongoose.set('strictQuery', true);

/** Connect to MongoDB and make sure every index (including unique constraints) exists. */
export async function connectDb(uri, { logger, autoIndex = true } = {}) {
  mongoose.connection.on('error', (err) => logger?.error({ err }, 'mongodb connection error'));
  mongoose.connection.on('disconnected', () => logger?.warn('mongodb disconnected'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false });
  if (autoIndex) {
    for (const model of Object.values(models)) await model.createIndexes();
  }
  logger?.info('mongodb connected');
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export async function pingDb() {
  if (mongoose.connection.readyState !== 1) return false;
  await mongoose.connection.db.admin().ping();
  return true;
}

export { mongoose };
