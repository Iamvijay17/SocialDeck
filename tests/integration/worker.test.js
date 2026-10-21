import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostTarget, PublishJob } from '@osh/server-core';
import { startPublishProcessor } from '../../apps/worker/src/processors/publish.js';
import { runRecovery } from '../../apps/worker/src/recovery/recover.js';
import { createTestContext, seedOwnerWithMockAccounts } from '../helpers/context.js';

/**
 * Real BullMQ + Redis. Requires TEST_REDIS_URL (CI provides a service container; locally run any Redis).
 * Skipped otherwise so `npm test` works with only MongoDB available.
 */
const REDIS = process.env.TEST_REDIS_URL;
const d = REDIS ? describe : describe.skip;

async function waitFor(fn, { timeout = 15_000, interval = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, interval));
  }
}

d('worker with real BullMQ', () => {
  let ctx;
  let owner;
  let accounts;
  const workers = [];

  beforeAll(async () => {
    ctx = await createTestContext({ realQueue: true, env: { REDIS_URL: REDIS } });
    await ctx.queue.queue.obliterate({ force: true }).catch(() => {});
    ({ user: owner, accounts } = await seedOwnerWithMockAccounts(ctx, 2));
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close(true)));
    await ctx.queue.queue.obliterate({ force: true }).catch(() => {});
    await ctx.close();
  });

  const startWorker = () => {
    const w = startPublishProcessor(ctx, { workerId: `test-${workers.length}` });
    workers.push(w);
    return w;
  };
  const targetsOf = (postId) => PostTarget.find({ postId });

  it('publishes to several accounts through the real queue', async () => {
    startWorker();
    const post = await ctx.services.posts.create(owner.id, { text: 'via bullmq', mediaIds: [], targets: accounts.map((a) => ({ accountId: String(a._id) })) });
    await ctx.services.posts.publishNow(owner.id, post.id);
    await waitFor(async () => (await ctx.services.posts.get(owner.id, post.id)).status === 'published');
    expect((await targetsOf(post.id)).every((t) => t.status === 'published')).toBe(true);
  });

  it('runs a delayed (scheduled) job at its time and survives a worker restart', async () => {
    const post = await ctx.services.posts.create(owner.id, { text: 'scheduled', mediaIds: [], targets: [{ accountId: String(accounts[0]._id) }] });
    const when = new Date(Date.now() + 40_000);
    // Bypass the 30s lead rule's intent: schedule normally (>=30s), the worker is restarted in the meantime.
    await ctx.services.posts.schedule(owner.id, post.id, { scheduledAt: when });
    expect((await targetsOf(post.id))[0].status).toBe('scheduled');

    // "Restart": stop every worker; the delayed job stays in Redis / MongoDB.
    await Promise.all(workers.splice(0).map((w) => w.close(true)));
    await runRecovery(ctx, 'test-restart');
    startWorker();

    await new Promise((r) => setTimeout(r, 500));
    expect((await targetsOf(post.id))[0].status).toBe('scheduled'); // not early
    await waitFor(async () => (await targetsOf(post.id))[0].status === 'published', { timeout: 60_000 });
    const job = await PublishJob.findOne({ postId: post.id });
    expect(job.status).toBe('succeeded');
    expect(job.finishedAt.getTime()).toBeGreaterThanOrEqual(when.getTime() - 1000);
  }, 90_000);

  it('rebuilds queue entries from MongoDB after Redis loses its data', async () => {
    await Promise.all(workers.splice(0).map((w) => w.close(true)));
    const post = await ctx.services.posts.create(owner.id, { text: 'after flush', mediaIds: [], targets: [{ accountId: String(accounts[1]._id) }] });
    await ctx.services.posts.publishNow(owner.id, post.id);
    await ctx.queue.queue.obliterate({ force: true }); // simulate Redis wipe
    const summary = await runRecovery(ctx, 'test-flush');
    expect(summary.reenqueuedMissing).toBe(1);
    startWorker();
    await waitFor(async () => (await targetsOf(post.id))[0].status === 'published');
  });

  it('retries transient failures through the real queue with backoff', async () => {
    startWorker();
    const post = await ctx.services.posts.create(owner.id, { text: 'flaky [mock:fail-transient]', mediaIds: [], targets: [{ accountId: String(accounts[0]._id) }] });
    await ctx.services.posts.publishNow(owner.id, post.id);
    await waitFor(async () => (await targetsOf(post.id))[0].status === 'published', { timeout: 30_000 });
    expect((await targetsOf(post.id))[0].attemptCount).toBe(3);
  }, 40_000);
});
