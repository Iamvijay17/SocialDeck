import { hostname } from 'node:os';
import { createContext, createLogger, loadConfig } from '@osh/server-core';
import { startPublishProcessor } from './processors/publish.js';
import { runRecovery } from './recovery/recover.js';
import { startScheduler } from './scheduler/sweep.js';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, name: 'osh-worker' });
const ctx = await createContext(config, { logger });
const workerId = `${hostname()}:${process.pid}`;

// 1. Repair state left behind by a previous crash BEFORE accepting new work.
await runRecovery(ctx, 'startup');

// 2. Start consuming and housekeeping.
const worker = startPublishProcessor(ctx, { workerId });
const stopScheduler = startScheduler(ctx);
logger.info({ workerId, concurrency: config.publish.workerConcurrency }, 'worker started');

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutting down; waiting for in-flight jobs');
  const force = setTimeout(() => {
    logger.error('forced exit while jobs were still running; recovery will handle them on next start');
    process.exit(1);
  }, 60_000);
  force.unref();
  stopScheduler();
  try {
    await worker.close(); // lets running jobs finish
    await ctx.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
