import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostTarget, PublishJob, SocialAccount } from '@osh/server-core';
import { createTestContext, drainQueue, seedOwnerWithMockAccounts } from '../helpers/context.js';

let ctx;
let owner;
let accounts;

beforeAll(async () => {
  ctx = await createTestContext();
  ({ user: owner, accounts } = await seedOwnerWithMockAccounts(ctx, 2));
});
afterAll(async () => ctx.close());

const newPost = (text, targets = accounts.map((a) => ({ accountId: String(a._id) })), extra = {}) =>
  ctx.services.posts.create(owner.id, { text, mediaIds: [], targets, ...extra });

const statusMap = (post) => Object.fromEntries(post.targets.map((t) => [t.account.displayName, t.status]));

describe('multi-target publishing', () => {
  it('publishes one post to several accounts with independent results', async () => {
    const post = await newPost('hello from the hub');
    expect(post.status).toBe('draft');
    const queued = await ctx.services.posts.publishNow(owner.id, post.id);
    expect(queued.status).toBe('publishing');
    expect(queued.targets.map((t) => t.status)).toEqual(['queued', 'queued']);

    await drainQueue(ctx);
    const done = await ctx.services.posts.get(owner.id, post.id);
    expect(done.status).toBe('published');
    for (const t of done.targets) {
      expect(t.remoteId).toMatch(/^mock_/);
      expect(t.remoteUrl).toContain('mock.invalid');
      expect(t.attemptCount).toBe(1);
    }
  });

  it('keeps a successful result when another target fails permanently', async () => {
    const [a, b] = accounts;
    const post = await newPost('shared text', [
      { accountId: String(a._id) },
      { accountId: String(b._id), text: 'this one will be rejected [mock:fail-permanent]' },
    ]);
    await ctx.services.posts.publishNow(owner.id, post.id);
    await drainQueue(ctx);

    const done = await ctx.services.posts.get(owner.id, post.id);
    expect(done.status).toBe('partially_published');
    const byName = Object.fromEntries(done.targets.map((t) => [t.account.displayName, t]));
    expect(byName[a.displayName].status).toBe('published');
    expect(byName[a.displayName].remoteId).toBeTruthy();
    expect(byName[b.displayName].status).toBe('failed');
    expect(byName[b.displayName].errorClass).toBe('permanent');
    expect(byName[b.displayName].attemptCount).toBe(1); // permanent errors are not retried
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    const post = await newPost('flaky [mock:fail-transient]', [{ accountId: String(accounts[0]._id) }]);
    await ctx.services.posts.publishNow(owner.id, post.id);

    const first = await drainQueue(ctx, { maxRounds: 1 });
    expect(first[0].outcome).toBe('retry');
    let t = (await ctx.services.posts.get(owner.id, post.id)).targets[0];
    expect(t.status).toBe('queued');
    expect(t.nextRetryAt).toBeTruthy();
    expect(t.errorMessage).toMatch(/retrying/);

    await drainQueue(ctx);
    t = (await ctx.services.posts.get(owner.id, post.id)).targets[0];
    expect(t.status).toBe('published');
    expect(t.attemptCount).toBe(3);
  });

  it('honours Retry-After on rate limits', async () => {
    const post = await newPost('limited [mock:rate-limit]', [{ accountId: String(accounts[0]._id) }]);
    const before = Date.now();
    await ctx.services.posts.publishNow(owner.id, post.id);
    const [r] = await drainQueue(ctx, { maxRounds: 1 });
    expect(r.outcome).toBe('retry');
    expect(r.delayMs).toBeGreaterThanOrEqual(2000);
    const job = await PublishJob.findOne({ postId: post.id });
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(before + 2000);
    await drainQueue(ctx);
    expect((await ctx.services.posts.get(owner.id, post.id)).status).toBe('published');
  });

  it('gives up after the bounded number of attempts', async () => {
    // fail-transient only fails twice; use a config with max 4 attempts and force 4 failures via ambiguous+idempotent? use auth-less permanent instead:
    const post = await newPost('x', [{ accountId: String(accounts[0]._id) }]);
    await ctx.services.posts.publishNow(owner.id, post.id);
    const adapter = ctx.adapters.get('mock');
    const original = adapter.publish.bind(adapter);
    adapter.publish = async () => {
      const { PlatformError } = await import('@osh/platform-core');
      throw new PlatformError('down', { kind: 'transient', code: 'down' });
    };
    try {
      await drainQueue(ctx);
    } finally {
      adapter.publish = original;
    }
    const t = (await ctx.services.posts.get(owner.id, post.id)).targets[0];
    expect(t.status).toBe('failed');
    expect(t.attemptCount).toBe(4);
    expect(t.errorMessage).toMatch(/Gave up after 4 attempts/);
  });

  it('does not auto-retry ambiguous outcomes and requires acknowledgement to retry', async () => {
    const post = await newPost('maybe posted [mock:fail-ambiguous]', [{ accountId: String(accounts[0]._id) }]);
    await ctx.services.posts.publishNow(owner.id, post.id);
    const results = await drainQueue(ctx);
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('failed');

    const t = (await ctx.services.posts.get(owner.id, post.id)).targets[0];
    expect(t.status).toBe('failed');
    expect(t.errorClass).toBe('ambiguous');
    expect(t.errorMessage).toMatch(/Check .* before retrying/);

    // The generic publish endpoint refuses to silently re-send...
    await expect(ctx.services.posts.publishNow(owner.id, post.id)).rejects.toMatchObject({ code: 'ambiguous_outcome', status: 409 });
    // ...and an explicit retry needs acknowledgement.
    const job = await PublishJob.findOne({ postId: post.id }).sort({ createdAt: -1 });
    await expect(ctx.services.publishing.retryJob(owner.id, job.id, {})).rejects.toMatchObject({ code: 'ambiguous_outcome' });
    const retried = await ctx.services.publishing.retryJob(owner.id, job.id, { acknowledgeDuplicateRisk: true });
    expect(retried.status).toBe('enqueued');
    expect(String(retried._id)).not.toBe(String(job._id));
  });

  it('marks auth failures as needing reauthorization and flags the account', async () => {
    const acct = accounts[1];
    const post = await newPost('auth [mock:fail-auth]', [{ accountId: String(acct._id) }]);
    await ctx.services.posts.publishNow(owner.id, post.id);
    await drainQueue(ctx);
    const t = (await ctx.services.posts.get(owner.id, post.id)).targets[0];
    expect(t.status).toBe('needs_reauthorization');
    expect((await SocialAccount.findById(acct._id)).status).toBe('needs_reauthorization');

    // Publishing to a flagged account is rejected up front with a clear message.
    const next = await newPost('another', [{ accountId: String(acct._id) }]);
    await expect(ctx.services.posts.publishNow(owner.id, next.id)).rejects.toMatchObject({ status: 422 });
    await SocialAccount.updateOne({ _id: acct._id }, { status: 'active', statusReason: null });
  });
});

describe('job consistency', () => {
  it('never creates two active jobs for the same target', async () => {
    const post = await newPost('dup', [{ accountId: String(accounts[0]._id) }]);
    const target = await PostTarget.findOne({ postId: post.id });
    const [a, b] = await Promise.all([
      ctx.services.publishing.enqueueTarget(target),
      ctx.services.publishing.enqueueTarget(target).catch((e) => ({ error: e })),
    ]);
    expect(await PublishJob.countDocuments({ targetId: target._id })).toBe(1);
    expect([a.duplicate, b.duplicate ?? b.error?.code].filter(Boolean).length).toBe(1);
  });

  it('runs a job body only once even if the queue delivers it twice concurrently', async () => {
    const post = await newPost('concurrent', [{ accountId: String(accounts[0]._id) }]);
    await ctx.services.posts.publishNow(owner.id, post.id);
    const job = await takeFromQueue(post.id);
    const mock = ctx.adapters.get('mock');
    const before = mock.published.size;
    const outcomes = await Promise.all([
      ctx.services.publishing.processJob(job.publishJobId, { workerId: 'w1' }),
      ctx.services.publishing.processJob(job.publishJobId, { workerId: 'w2' }),
      ctx.services.publishing.processJob(job.publishJobId, { workerId: 'w3' }),
    ]);
    expect(outcomes.filter((o) => o.outcome === 'published')).toHaveLength(1);
    expect(mock.published.size).toBe(before + 1);
  });
});

describe('scheduling and cancellation', () => {
  it('schedules in the future, survives a queue wipe via recovery, and can be cancelled', async () => {
    const post = await newPost('later', [{ accountId: String(accounts[0]._id) }]);
    const when = new Date(Date.now() + 3_600_000);
    const scheduled = await ctx.services.posts.schedule(owner.id, post.id, { scheduledAt: when, timezone: 'Europe/Berlin' });
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.targets[0].status).toBe('scheduled');
    expect(new Date(scheduled.scheduledAt).getTime()).toBe(when.getTime());

    // Not due yet: a worker polling the queue sees nothing.
    const queued = await PublishJob.findOne({ postId: post.id, status: 'enqueued' });
    expect(ctx.queue.jobs.get(queued.queueJobId).runAt.getTime()).toBeGreaterThan(Date.now() + 3_000_000);

    // Simulate Redis losing its data (restart without persistence).
    ctx.queue.clear();
    const summary = await ctx.services.publishing.recoverJobs();
    expect(summary.reenqueuedMissing).toBeGreaterThanOrEqual(1);
    const job = await PublishJob.findOne({ postId: post.id, status: 'enqueued' });
    expect(ctx.queue.jobs.has(job.queueJobId)).toBe(true);

    const cancelled = await ctx.services.posts.cancel(owner.id, post.id);
    expect(cancelled.status).toBe('cancelled');
    expect(ctx.queue.jobs.has(job.queueJobId)).toBe(false);
    expect((await PublishJob.findById(job._id)).status).toBe('cancelled');
  });

  it('refuses to schedule in the past', async () => {
    const post = await newPost('past', [{ accountId: String(accounts[0]._id) }]);
    await expect(ctx.services.posts.schedule(owner.id, post.id, { scheduledAt: new Date(Date.now() - 1000) })).rejects.toMatchObject({ status: 422 });
  });

  it('reschedules without creating a second active job', async () => {
    const post = await newPost('moving', [{ accountId: String(accounts[0]._id) }]);
    await ctx.services.posts.schedule(owner.id, post.id, { scheduledAt: new Date(Date.now() + 3_600_000) });
    const later = new Date(Date.now() + 7_200_000);
    const res = await ctx.services.posts.schedule(owner.id, post.id, { scheduledAt: later });
    expect(res.targets[0].status).toBe('scheduled');
    const jobs = await PublishJob.find({ postId: post.id });
    expect(jobs.filter((j) => ['pending', 'enqueued', 'running'].includes(j.status))).toHaveLength(1);
    expect(jobs.find((j) => j.status === 'enqueued').runAt.getTime()).toBe(later.getTime());
    await ctx.services.posts.cancel(owner.id, post.id);
  });
});

/** Remove this post's job from the (shared) memory queue, as a worker picking it up would. */
async function takeFromQueue(postId) {
  const job = await PublishJob.findOne({ postId, status: { $in: ['pending', 'enqueued'] } });
  ctx.queue.jobs.delete(job.queueJobId);
  return { publishJobId: String(job._id) };
}

describe('crash recovery', () => {
  async function runningJob({ phase, sendingAgoMs = 0, text = 'crash test' }) {
    const post = await newPost(text, [{ accountId: String(accounts[0]._id) }]);
    await ctx.services.posts.publishNow(owner.id, post.id);
    const taken = await takeFromQueue(post.id);
    const stale = new Date(Date.now() - 10 * 60_000);
    // Simulate: a worker claimed the job and then died.
    await PublishJob.updateOne(
      { _id: taken.publishJobId },
      { status: 'running', phase, heartbeatAt: stale, startedAt: stale, attemptCount: 1, workerId: 'dead', ...(phase === 'sending' ? { sendingAt: new Date(Date.now() - sendingAgoMs) } : {}) },
    );
    await PostTarget.updateOne({ postId: post.id }, { status: 'publishing' });
    return { post, jobId: taken.publishJobId };
  }

  it('restarts a job whose worker died before anything was sent', async () => {
    const { post, jobId } = await runningJob({ phase: 'preparing' });
    const summary = await ctx.services.publishing.recoverJobs();
    expect(summary.restarted).toBeGreaterThanOrEqual(1);
    expect((await PublishJob.findById(jobId)).status).toBe('enqueued');
    await drainQueue(ctx);
    expect((await ctx.services.posts.get(owner.id, post.id)).status).toBe('published');
  });

  it('does NOT restart a job that died while sending on a non-idempotent platform', async () => {
    const { post, jobId } = await runningJob({ phase: 'sending', sendingAgoMs: 60_000 });
    const mock = ctx.adapters.get('mock');
    const before = mock.published.size;
    const summary = await ctx.services.publishing.recoverJobs();
    expect(summary.abandoned).toBeGreaterThanOrEqual(1);
    expect((await PublishJob.findById(jobId)).status).toBe('abandoned');
    const t = (await ctx.services.posts.get(owner.id, post.id)).targets[0];
    expect(t.status).toBe('failed');
    expect(t.errorClass).toBe('ambiguous');
    expect(t.errorCode).toBe('worker_interrupted');
    await drainQueue(ctx);
    expect(mock.published.size).toBe(before); // nothing was re-sent
  });

  it('re-enqueues pending jobs that never reached the queue', async () => {
    const post = await newPost('orphan job', [{ accountId: String(accounts[0]._id) }]);
    const target = await PostTarget.findOne({ postId: post.id });
    await ctx.services.publishing.enqueueTarget(target);
    ctx.queue.clear();
    await PublishJob.collection.updateOne({ postId: post._id ?? new (await import('mongoose')).default.Types.ObjectId(post.id) }, { $set: { status: 'pending', createdAt: new Date(Date.now() - 60_000) } });
    const summary = await ctx.services.publishing.recoverJobs();
    expect(summary.requeued).toBe(1);
    await drainQueue(ctx);
    expect((await ctx.services.posts.get(owner.id, post.id)).status).toBe('published');
  });
});

describe('secrets', () => {
  it('never exposes or logs stored credentials', async () => {
    const withCreds = await SocialAccount.findById(accounts[0]._id).select('+credentials');
    const plaintext = ctx.cipher.decryptJson(withCreds.credentials, 'social-account-credentials');
    expect(plaintext.token).toMatch(/^mock-/);
    expect(withCreds.credentials).not.toContain(plaintext.token);

    const apiShape = JSON.stringify(await ctx.services.accounts.list(owner.id));
    expect(apiShape).not.toContain(plaintext.token);
    expect(apiShape).not.toContain('credentials');
    expect(ctx.logText()).not.toContain(plaintext.token);
    expect(statusMap).toBeTypeOf('function');
  });
});
