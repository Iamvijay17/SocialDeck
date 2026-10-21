import { Worker } from 'bullmq';
import { QUEUE_NAME } from '@osh/server-core';

/**
 * BullMQ worker that executes publish jobs. The queue message only carries the PublishJob id; all state
 * (and all idempotency/claim logic) lives in the publishing service, so redelivery of a message is harmless.
 */
export function startPublishProcessor(ctx, { workerId }) {
  const { logger, config } = ctx;
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const result = await ctx.services.publishing.processJob(job.data.publishJobId, { workerId });
      logger.info({ queueJob: job.id, publishJobId: job.data.publishJobId, outcome: result.outcome }, 'publish job processed');
      return result;
    },
    {
      connection: ctx.queue.connection,
      concurrency: config.publish.workerConcurrency,
      // A stalled message (worker died) is redelivered at most once; the claim in processJob() makes that safe.
      maxStalledCount: 1,
      lockDuration: 60_000,
    },
  );
  worker.on('error', (err) => logger.error({ err }, 'worker error'));
  worker.on('failed', (job, err) => logger.error({ queueJob: job?.id, err }, 'publish job crashed'));
  return worker;
}
