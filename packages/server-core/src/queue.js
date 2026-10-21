import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const QUEUE_NAME = 'osh-publish';

/**
 * Thin queue abstraction over BullMQ. MongoDB (PublishJob) is the source of truth for job state; Redis only
 * carries "wake up and run job X at time T". If Redis loses data, the recovery routine rebuilds queue entries
 * from MongoDB.
 *
 * Queue job ids are `<publishJobId>.<attempt>`, so retries get fresh ids while duplicate adds of the same attempt
 * are ignored by BullMQ.
 */
export function createRedisConnection(redisUrl) {
  return new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export function createBullQueue({ connection, logger }) {
  const queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: { removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 24 * 3600, count: 1000 }, attempts: 1 },
  });
  queue.on('error', (err) => logger?.error({ err }, 'queue error'));

  return {
    kind: 'bullmq',
    queue,
    connection,
    async enqueue({ queueJobId, publishJobId, runAt }) {
      const delay = Math.max(0, new Date(runAt).getTime() - Date.now());
      await queue.add('publish', { publishJobId: String(publishJobId) }, { jobId: queueJobId, delay });
    },
    async remove(queueJobId) {
      const job = await queue.getJob(queueJobId);
      if (!job) return false;
      try {
        await job.remove();
        return true;
      } catch {
        return false; // locked: currently being processed
      }
    },
    async exists(queueJobId) {
      return Boolean(await queue.getJob(queueJobId));
    },
    async ping() {
      return (await connection.ping()) === 'PONG';
    },
    async close() {
      await queue.close();
    },
  };
}

/**
 * In-memory queue for tests. Jobs are never run automatically; tests call `runDue()`/`take()` to simulate a worker.
 */
export function createMemoryQueue() {
  const jobs = new Map();
  return {
    kind: 'memory',
    jobs,
    async enqueue({ queueJobId, publishJobId, runAt }) {
      if (!jobs.has(queueJobId)) jobs.set(queueJobId, { queueJobId, publishJobId: String(publishJobId), runAt: new Date(runAt) });
    },
    async remove(queueJobId) {
      return jobs.delete(queueJobId);
    },
    async exists(queueJobId) {
      return jobs.has(queueJobId);
    },
    async ping() {
      return true;
    },
    async close() {},
    /** Remove and return jobs whose time has come (or all, when `all` is true). */
    take({ all = false, now = Date.now() } = {}) {
      const due = [...jobs.values()].filter((j) => all || j.runAt.getTime() <= now);
      for (const j of due) jobs.delete(j.queueJobId);
      return due;
    },
    clear() {
      jobs.clear();
    },
  };
}
