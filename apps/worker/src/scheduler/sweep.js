import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRecovery } from '../recovery/recover.js';

const HEARTBEAT_FILE = path.join(os.tmpdir(), 'worker-heartbeat');
const touch = async () => fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));

const SWEEP_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Periodic housekeeping. Scheduled publishing itself relies on delayed queue messages (persisted in Redis and
 * rebuilt from MongoDB on demand); this sweep is the safety net that repairs any divergence, plus:
 *  - a heartbeat so the dashboard can show whether a worker is alive,
 *  - orphaned media cleanup.
 * @returns {() => void} stop function
 */
export function startScheduler(ctx) {
  const timers = [];
  const every = (ms, fn) => {
    const t = setInterval(() => fn().catch((err) => ctx.logger.error({ err }, 'scheduler task failed')), ms);
    t.unref?.();
    timers.push(t);
  };

  every(HEARTBEAT_INTERVAL_MS, async () => {
    await touch(); // container health check
    await ctx.queue.setWorkerHeartbeat(30); // dashboard "worker online" indicator
  });
  touch().catch(() => {});
  every(SWEEP_INTERVAL_MS, () => runRecovery(ctx, 'periodic'));
  every(CLEANUP_INTERVAL_MS, () => ctx.services.media.cleanupOrphans());
  ctx.queue.setWorkerHeartbeat(30).catch(() => {});

  return () => timers.forEach(clearInterval);
}
