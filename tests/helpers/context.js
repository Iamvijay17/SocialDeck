import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { createContext, createLogger, createMemoryQueue, loadConfig } from '@osh/server-core';

export function testEnv(overrides = {}) {
  const dbName = `osh_test_${randomBytes(6).toString('hex')}`;
  const base = (process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/').replace(/\/[^/]*$/, '/');
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osh-media-'));
  return {
    NODE_ENV: 'test',
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    MONGODB_URI: `${base}${dbName}`,
    REDIS_URL: 'redis://127.0.0.1:6379',
    MEDIA_DIR: mediaDir,
    ENABLE_MOCK_PLATFORM: 'true',
    PUBLISH_RETRY_BASE_SECONDS: '1',
    PUBLISH_RETRY_MAX_SECONDS: '2',
    PUBLISH_MAX_ATTEMPTS: '4',
    STALE_JOB_SECONDS: '30',
    LOG_LEVEL: 'debug',
    ...overrides,
  };
}

/** A logger writing into memory so tests can assert on what would have been logged. */
export function captureLogger() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger({ level: 'debug', destination: stream }), lines, text: () => lines.join('') };
}

export async function createTestContext({ env = {}, adapterDeps = {}, now, realQueue = false } = {}) {
  const config = loadConfig(testEnv(env));
  const { logger, lines, text } = captureLogger();
  const queue = realQueue ? undefined : createMemoryQueue();
  const ctx = await createContext(config, { logger, queue, adapterDeps, now });
  ctx.logLines = lines;
  ctx.logText = text;
  ctx.dropDatabase = async () => {
    await mongoose.connection.dropDatabase();
  };
  const origClose = ctx.close;
  ctx.close = async () => {
    await mongoose.connection.dropDatabase().catch(() => {});
    await origClose();
    fs.rmSync(config.media.dir, { recursive: true, force: true });
  };
  return ctx;
}

/** Create the owner and connect `n` mock accounts through the real connect/callback code path. */
export async function seedOwnerWithMockAccounts(ctx, n = 2) {
  const { services } = ctx;
  const doc = await services.auth.createUser({ email: 'owner@example.com', password: 'correct horse battery staple', role: 'owner', isOwner: true });
  const user = { id: String(doc._id), email: doc.email };
  const accounts = [];
  for (let i = 0; i < n; i++) {
    const { authorizationUrl } = await services.accounts.beginConnect(user.id, 'mock', { handle: `demo${i}` });
    const query = new URL(authorizationUrl).searchParams;
    accounts.push(await services.accounts.completeConnect(user.id, 'mock', query));
  }
  return { user, accounts };
}

/** Simulate a worker: run every queued job (optionally ignoring their delay) until the queue is drained. */
export async function drainQueue(ctx, { all = true, maxRounds = 20, workerId = 'test-worker' } = {}) {
  const results = [];
  for (let round = 0; round < maxRounds; round++) {
    const jobs = ctx.queue.take({ all });
    if (!jobs.length) break;
    for (const j of jobs) results.push(await ctx.services.publishing.processJob(j.publishJobId, { workerId }));
  }
  return results;
}
