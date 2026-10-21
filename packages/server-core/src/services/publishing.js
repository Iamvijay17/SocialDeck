import {
  ACCOUNT_STATUS,
  ACTIVE_JOB_STATUSES,
  AppError,
  ERROR_CLASS,
  PUBLISH_JOB_STATUS as J,
  TARGET_STATUS as T,
  conflict,
  derivePostStatus,
  notFound,
} from '@osh/shared';
import { PlatformError, computeRetryDelayMs } from '@osh/platform-core';
import { scrubSecrets } from '../logger.js';
import { mongoose } from '../db.js';
import { Post, PostTarget, PublishJob, SocialAccount } from '../models/index.js';

const HEARTBEAT_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 10 * 60_000;
/** Targets in these states may be (re)queued. */
const QUEUEABLE = [T.DRAFT, T.SCHEDULED, T.FAILED, T.NEEDS_REAUTHORIZATION, T.CANCELLED];

/**
 * The publishing engine.
 *
 * Source of truth: PublishJob documents in MongoDB. The Redis queue only carries "run job X at time T" and can be
 * rebuilt from MongoDB by recoverJobs().
 *
 * Delivery guarantee: this system does NOT provide exactly-once delivery to third-party platforms. It provides
 *   - at most one active job per target (partial unique index),
 *   - an atomic claim before any network call, so a job body never runs twice concurrently,
 *   - no automatic retry after an *ambiguous* outcome (request may have been accepted) unless the platform adapter
 *     supports idempotency keys, in which case retries reuse the same key.
 */
export function createPublishingService({ config, logger, adapters, queue, storage, media, audit, getAccounts, now = () => Date.now() }) {
  const nowDate = () => new Date(now());

  // ---------------------------------------------------------------- post status

  async function refreshPostStatus(postId) {
    const targets = await PostTarget.find({ postId }).select('status publishedAt').lean();
    const status = derivePostStatus(targets.map((t) => t.status));
    const published = targets.map((t) => t.publishedAt).filter(Boolean);
    const publishedAt = published.length ? new Date(Math.max(...published.map((d) => d.getTime()))) : null;
    await Post.updateOne({ _id: postId }, { status, publishedAt });
    return status;
  }

  // ---------------------------------------------------------------- creating & cancelling jobs

  /**
   * Create the (single) active job for a target and put it on the queue.
   * Safe to call twice: the second call returns the existing job instead of creating a duplicate.
   */
  async function enqueueTarget(target, { runAt = nowDate() } = {}) {
    const _id = new mongoose.Types.ObjectId();
    const queueJobId = `${_id}.1`;
    try {
      await PublishJob.create({
        _id,
        targetId: target._id,
        postId: target.postId,
        ownerId: target.ownerId,
        runAt,
        status: J.PENDING,
        queueJobId,
        idempotencyKey: `osh-${target._id}`,
        maxAttempts: config.publish.maxAttempts,
      });
    } catch (err) {
      if (err?.code === 11000) {
        const existing = await PublishJob.findOne({ targetId: target._id, status: { $in: ACTIVE_JOB_STATUSES } });
        return { job: existing, duplicate: true };
      }
      throw err;
    }

    const immediate = runAt.getTime() <= now() + 1000;
    const res = await PostTarget.updateOne(
      { _id: target._id, status: { $in: QUEUEABLE } },
      {
        $set: {
          status: immediate ? T.QUEUED : T.SCHEDULED,
          scheduledAt: runAt,
          queuedAt: nowDate(),
          maxAttempts: config.publish.maxAttempts,
          errorClass: null,
          errorCode: null,
          errorMessage: null,
          nextRetryAt: null,
        },
      },
    );
    if (res.modifiedCount === 0) {
      await PublishJob.updateOne({ _id }, { status: J.CANCELLED, finishedAt: nowDate() });
      throw conflict('This target cannot be queued from its current state.');
    }

    try {
      await queue.enqueue({ queueJobId, publishJobId: _id, runAt });
      await PublishJob.updateOne({ _id, status: J.PENDING }, { status: J.ENQUEUED });
    } catch (err) {
      // Leave the job `pending`; recoverJobs() puts it on the queue as soon as Redis is reachable again.
      logger.error({ err, jobId: String(_id) }, 'failed to enqueue publish job; recovery will retry');
    }
    await refreshPostStatus(target.postId);
    return { job: await PublishJob.findById(_id), duplicate: false };
  }

  /** Cancel a job that has not started. Returns the cancelled job or null. */
  async function cancelActiveJob(targetId) {
    const job = await PublishJob.findOneAndUpdate(
      { targetId, status: { $in: [J.PENDING, J.ENQUEUED] } },
      { status: J.CANCELLED, finishedAt: nowDate() },
      { returnDocument: 'before' },
    );
    if (job?.queueJobId) await queue.remove(job.queueJobId).catch(() => false);
    return job;
  }

  async function cancelTarget(target, { reason } = {}) {
    await cancelActiveJob(target._id);
    if (await PublishJob.exists({ targetId: target._id, status: J.RUNNING })) {
      throw conflict('Publishing has already started for this account and can no longer be cancelled.');
    }
    await PostTarget.updateOne(
      { _id: target._id, status: { $in: [T.DRAFT, T.SCHEDULED, T.QUEUED, T.FAILED, T.NEEDS_REAUTHORIZATION] } },
      { status: T.CANCELLED, nextRetryAt: null, ...(reason ? { errorMessage: reason, errorClass: null } : {}) },
    );
    await refreshPostStatus(target.postId);
  }

  /** Put a scheduled target back to draft (unschedule). */
  async function unscheduleTarget(target) {
    await cancelActiveJob(target._id);
    await PostTarget.updateOne({ _id: target._id, status: { $in: [T.SCHEDULED, T.QUEUED] } }, { status: T.DRAFT, scheduledAt: null, nextRetryAt: null });
    await refreshPostStatus(target.postId);
  }

  // ---------------------------------------------------------------- execution

  /**
   * Execute one job. Called by the worker for each queue message. Idempotent with respect to redelivery.
   * @returns {Promise<{outcome: string}>}
   */
  async function processJob(publishJobId, { workerId = 'local', signal } = {}) {
    const existing = await PublishJob.findById(publishJobId);
    if (!existing || ![J.PENDING, J.ENQUEUED].includes(existing.status)) return { outcome: 'skipped' };
    if (existing.runAt.getTime() > now() + 5000) {
      // Delivered early (clock skew or manual trigger): put it back for its real time.
      await queue.enqueue({ queueJobId: existing.queueJobId, publishJobId, runAt: existing.runAt });
      return { outcome: 'early' };
    }

    // 1. Atomically claim the job. Only one worker can win; redeliveries lose.
    const startedAt = nowDate();
    const job = await PublishJob.findOneAndUpdate(
      { _id: publishJobId, status: { $in: [J.PENDING, J.ENQUEUED] } },
      { $set: { status: J.RUNNING, workerId, startedAt, heartbeatAt: startedAt, phase: 'preparing' }, $inc: { attemptCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!job) return { outcome: 'skipped' };
    const attemptNo = job.attemptCount;

    // 2. Claim the target.
    const target = await PostTarget.findOneAndUpdate(
      { _id: job.targetId, status: { $in: [T.SCHEDULED, T.QUEUED] } },
      { $set: { status: T.PUBLISHING, startedAt, lastAttemptAt: startedAt, nextRetryAt: null }, $inc: { attemptCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!target) {
      await PublishJob.updateOne({ _id: job._id }, { status: J.CANCELLED, finishedAt: nowDate(), phase: 'idle' });
      return { outcome: 'cancelled' };
    }
    await refreshPostStatus(target.postId);

    const heartbeat = setInterval(() => {
      PublishJob.updateOne({ _id: job._id, status: J.RUNNING }, { heartbeatAt: nowDate() }).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let sendingStarted = false;
    try {
      const result = await executePublish({ job, target, signal, onSending: async () => {
        // Persist *before* the creating request goes out: if we crash from here on, the outcome is unknown.
        await PublishJob.updateOne({ _id: job._id }, { phase: 'sending', sendingAt: nowDate() });
        sendingStarted = true;
      } });
      await PostTarget.updateOne(
        { _id: target._id },
        { $set: { status: T.PUBLISHED, remoteId: result.remoteId, remoteUrl: result.url ?? null, publishedAt: nowDate(), errorClass: null, errorCode: null, errorMessage: null, nextRetryAt: null } },
      );
      await PublishJob.updateOne(
        { _id: job._id },
        { $set: { status: J.SUCCEEDED, finishedAt: nowDate(), phase: 'idle' }, $push: { attempts: attemptRecord(attemptNo, startedAt, 'success') } },
      );
      await refreshPostStatus(target.postId);
      await audit.record({ actorId: target.ownerId, action: 'publish.succeeded', resourceType: 'post_target', resourceId: target._id, metadata: { platform: target.platform, attempt: attemptNo } });
      return { outcome: 'published', remoteId: result.remoteId };
    } catch (err) {
      return await settleFailure({ job, target, err, attemptNo, startedAt, sendingStarted });
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function executePublish({ job, target, signal, onSending }) {
    const accounts = getAccounts();
    const post = await Post.findById(target.postId);
    if (!post) throw new PlatformError('The post no longer exists.', { kind: ERROR_CLASS.PERMANENT, code: 'post_missing' });
    const loaded = await accounts.getWithCredentials(target.accountId);
    if (!loaded || loaded.account.status === ACCOUNT_STATUS.REVOKED) {
      throw new PlatformError('The account is no longer connected.', { kind: ERROR_CLASS.PERMANENT, code: 'account_unavailable' });
    }
    const { account, credentials } = loaded;
    if (account.status === ACCOUNT_STATUS.NEEDS_REAUTHORIZATION) {
      throw new PlatformError(account.statusReason || 'The account needs to be reconnected.', { kind: ERROR_CLASS.AUTH, code: 'needs_reauthorization' });
    }
    const adapter = adapters.get(target.platform);
    if (!adapter?.enabled) {
      throw new PlatformError(`${target.platform} publishing is not available.`, { kind: ERROR_CLASS.PERMANENT, code: 'integration_unavailable' });
    }

    let mediaDocs;
    try {
      mediaDocs = await media.getMany(post.ownerId, post.mediaIds);
    } catch {
      throw new PlatformError('An attached media file no longer exists.', { kind: ERROR_CLASS.PERMANENT, code: 'media_missing' });
    }
    const content = {
      text: target.textOverride ?? post.text,
      media: mediaDocs.map((d) => ({
        id: String(d._id),
        kind: d.kind,
        mimeType: d.mimeType,
        size: d.size,
        altText: d.altText,
        width: d.width ?? null,
        height: d.height ?? null,
        blob: () => storage.blob(d.storageKey, d.mimeType),
        publicUrl: adapter.capabilities.media.requiresPublicUrl ? media.publicUrl(d) : null,
      })),
    };

    // Re-validate at execution time: content, media or account limits may have changed since scheduling.
    const accountCtx = accounts.accountContext(account);
    const issues = (await adapter.validateContent(content, { account: accountCtx })).filter((i) => i.severity === 'error');
    if (issues.length) {
      throw new PlatformError(`Content is no longer valid: ${issues.map((i) => i.message).join(' ')}`.slice(0, 900), { kind: ERROR_CLASS.PERMANENT, code: 'invalid_content' });
    }

    const timeout = AbortSignal.timeout(PUBLISH_TIMEOUT_MS);
    return adapter.publish({
      credentials,
      account: accountCtx,
      content,
      options: target.options ?? {},
      idempotencyKey: job.idempotencyKey,
      ownerId: String(post.ownerId),
      redirectUri: undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      markSending: onSending,
      onCredentialsUpdated: (c, exp) => accounts.updateCredentials(account._id, c, exp),
    });
  }

  /** Decide what a failed attempt means: retry, give up, ask for reauthorization, or flag an unknown outcome. */
  async function settleFailure({ job, target, err, attemptNo, startedAt, sendingStarted }) {
    const perr = toPlatformError(err, sendingStarted);
    const adapter = adapters.get(target.platform);
    const idempotent = Boolean(adapter?.capabilities.idempotentPublish);
    const message = scrubSecrets(perr.message).slice(0, 900);
    const finishedAt = nowDate();
    const record = (outcome) => attemptRecord(attemptNo, startedAt, outcome, perr);

    const retryable =
      perr.kind === ERROR_CLASS.TRANSIENT || perr.kind === ERROR_CLASS.RATE_LIMITED || (perr.kind === ERROR_CLASS.AMBIGUOUS && idempotent);

    if (retryable && attemptNo < job.maxAttempts) {
      const delay = computeRetryDelayMs(attemptNo, { baseMs: config.publish.retryBaseMs, maxMs: config.publish.retryMaxMs, retryAfterMs: perr.retryAfterMs });
      const runAt = new Date(now() + delay);
      const queueJobId = `${job._id}.${attemptNo + 1}`;
      await PublishJob.updateOne(
        { _id: job._id },
        { $set: { status: J.ENQUEUED, runAt, queueJobId, phase: 'idle', heartbeatAt: finishedAt }, $push: { attempts: record('retry') } },
      );
      await PostTarget.updateOne(
        { _id: target._id },
        { $set: { status: T.QUEUED, nextRetryAt: runAt, errorClass: perr.kind, errorCode: perr.code, errorMessage: `Attempt ${attemptNo} failed, retrying: ${message}` } },
      );
      await queue.enqueue({ queueJobId, publishJobId: job._id, runAt }).catch((e) => logger.error({ err: e }, 'retry enqueue failed; recovery will re-add'));
      await refreshPostStatus(target.postId);
      logger.warn({ jobId: String(job._id), attempt: attemptNo, kind: perr.kind, code: perr.code, delayMs: delay }, 'publish attempt failed; scheduled retry');
      return { outcome: 'retry', delayMs: delay };
    }

    if (perr.kind === ERROR_CLASS.AUTH) {
      await getAccounts().markNeedsReauthorization(target.accountId, perr.message);
      await PostTarget.updateOne({ _id: target._id }, { $set: { status: T.NEEDS_REAUTHORIZATION, errorClass: perr.kind, errorCode: perr.code, errorMessage: message, nextRetryAt: null } });
      await PublishJob.updateOne({ _id: job._id }, { $set: { status: J.FAILED, finishedAt, phase: 'idle' }, $push: { attempts: record('auth') } });
      await refreshPostStatus(target.postId);
      await audit.record({ actorId: target.ownerId, action: 'publish.needs_reauthorization', resourceType: 'post_target', resourceId: target._id, metadata: { platform: target.platform } });
      return { outcome: 'needs_reauthorization' };
    }

    const exhausted = retryable;
    const ambiguous = perr.kind === ERROR_CLASS.AMBIGUOUS && !idempotent;
    const finalMessage = ambiguous
      ? `The outcome is unknown – the platform may have published this post. Check ${labelOf(target.platform)} before retrying to avoid a duplicate. (${message})`
      : exhausted
        ? `Gave up after ${attemptNo} attempts: ${message}`
        : message;
    await PostTarget.updateOne(
      { _id: target._id },
      { $set: { status: T.FAILED, errorClass: perr.kind, errorCode: perr.code, errorMessage: finalMessage.slice(0, 1000), nextRetryAt: null } },
    );
    await PublishJob.updateOne({ _id: job._id }, { $set: { status: J.FAILED, finishedAt, phase: 'idle' }, $push: { attempts: record('failed') } });
    await refreshPostStatus(target.postId);
    await audit.record({ actorId: target.ownerId, action: 'publish.failed', resourceType: 'post_target', resourceId: target._id, metadata: { platform: target.platform, errorClass: perr.kind, code: perr.code, attempt: attemptNo } });
    logger.warn({ jobId: String(job._id), kind: perr.kind, code: perr.code }, 'publish failed');
    return { outcome: 'failed', errorClass: perr.kind };
  }

  function toPlatformError(err, sendingStarted) {
    if (err instanceof PlatformError) return err;
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return new PlatformError('Publishing timed out.', { kind: sendingStarted ? ERROR_CLASS.AMBIGUOUS : ERROR_CLASS.TRANSIENT, code: 'timeout' });
    }
    // Unknown error: be conservative. After the creating request went out, assume the outcome is unknown.
    logger.error({ err }, 'unexpected error while publishing');
    return new PlatformError(sendingStarted ? 'Unexpected error after sending to the platform.' : 'Unexpected error while preparing to publish.', {
      kind: sendingStarted ? ERROR_CLASS.AMBIGUOUS : ERROR_CLASS.TRANSIENT,
      code: 'unexpected_error',
    });
  }

  // ---------------------------------------------------------------- user-initiated retry

  /** Re-queue a failed (or needs-reauthorization) target. Ambiguous outcomes need explicit acknowledgement. */
  async function retryJob(ownerId, jobId, { acknowledgeDuplicateRisk = false } = {}) {
    const job = await PublishJob.findOne({ _id: jobId, ownerId });
    if (!job) throw notFound('Job not found.');
    const target = await PostTarget.findOne({ _id: job.targetId, ownerId });
    if (!target) throw notFound('Target not found.');
    if (![T.FAILED, T.NEEDS_REAUTHORIZATION].includes(target.status)) {
      throw conflict(`Only failed targets can be retried (current status: ${target.status}).`);
    }
    if (target.errorClass === ERROR_CLASS.AMBIGUOUS && !acknowledgeDuplicateRisk) {
      throw new AppError(409, 'ambiguous_outcome', 'The previous attempt may already have been published. Check the platform, then confirm to retry anyway (this may create a duplicate).', { requiresAcknowledgement: true });
    }
    const account = await SocialAccount.findById(target.accountId);
    if (!account || account.status !== ACCOUNT_STATUS.ACTIVE) {
      throw conflict('The account is not connected. Reconnect it on the Social Accounts page first.');
    }
    const { job: newJob } = await enqueueTarget(target, { runAt: nowDate() });
    await audit.record({ actorId: ownerId, action: 'publish.retry', resourceType: 'post_target', resourceId: target._id, metadata: { acknowledgedDuplicateRisk: acknowledgeDuplicateRisk } });
    return newJob;
  }

  async function cancelJob(ownerId, jobId) {
    const job = await PublishJob.findOne({ _id: jobId, ownerId });
    if (!job) throw notFound('Job not found.');
    const target = await PostTarget.findById(job.targetId);
    if (job.status === J.RUNNING) throw conflict('Publishing has already started and cannot be cancelled.');
    if (![J.PENDING, J.ENQUEUED].includes(job.status)) throw conflict(`Job is already ${job.status}.`);
    await cancelTarget(target, { reason: 'Cancelled by user.' });
    await audit.record({ actorId: ownerId, action: 'publish.cancel', resourceType: 'post_target', resourceId: target._id });
    return PublishJob.findById(job._id);
  }

  // ---------------------------------------------------------------- recovery

  /**
   * Reconcile MongoDB (truth) with the queue (Redis). Run on worker start and periodically. Handles:
   *  - jobs persisted but never enqueued (API crashed between steps, Redis was down),
   *  - queue entries lost (Redis flushed/restarted without persistence),
   *  - jobs whose worker died mid-run.
   */
  async function recoverJobs() {
    const summary = { requeued: 0, reenqueuedMissing: 0, restarted: 0, abandoned: 0 };
    const t = now();

    // (a) pending jobs older than a few seconds were never confirmed on the queue
    const pending = await PublishJob.find({ status: J.PENDING, createdAt: { $lt: new Date(t - 5000) } }).limit(500);
    for (const job of pending) {
      await queue.enqueue({ queueJobId: job.queueJobId, publishJobId: job._id, runAt: job.runAt });
      await PublishJob.updateOne({ _id: job._id, status: J.PENDING }, { status: J.ENQUEUED, $inc: { 'recovery.count': 1 }, 'recovery.lastAt': nowDate(), 'recovery.lastReason': 'pending_without_queue_entry' });
      summary.requeued++;
    }

    // (b) enqueued jobs whose queue entry vanished
    const enqueued = await PublishJob.find({ status: J.ENQUEUED }).sort({ runAt: 1 }).limit(5000);
    for (const job of enqueued) {
      if (await queue.exists(job.queueJobId)) continue;
      await queue.enqueue({ queueJobId: job.queueJobId, publishJobId: job._id, runAt: job.runAt });
      await PublishJob.updateOne({ _id: job._id }, { $inc: { 'recovery.count': 1 }, 'recovery.lastAt': nowDate(), 'recovery.lastReason': 'queue_entry_missing' });
      summary.reenqueuedMissing++;
    }

    // (c) running jobs with a stale heartbeat: the worker died
    const stale = await PublishJob.find({ status: J.RUNNING, heartbeatAt: { $lt: new Date(t - config.publish.staleJobMs) } }).limit(200);
    for (const job of stale) {
      const target = await PostTarget.findById(job.targetId);
      const adapter = target ? adapters.get(target.platform) : null;
      const windowMs = (adapter?.capabilities.idempotencyWindowSeconds ?? 0) * 900; // 90% of the window
      const safeToRestart =
        job.phase !== 'sending' || (adapter?.capabilities.idempotentPublish && job.sendingAt && t - job.sendingAt.getTime() < windowMs);

      if (safeToRestart) {
        const queueJobId = `${job._id}.r${job.recovery.count + 1}`;
        const claimed = await PublishJob.findOneAndUpdate(
          { _id: job._id, status: J.RUNNING, heartbeatAt: { $lt: new Date(t - config.publish.staleJobMs) } },
          { $set: { status: J.ENQUEUED, queueJobId, runAt: nowDate(), phase: 'idle' }, $inc: { 'recovery.count': 1 }, 'recovery.lastAt': nowDate(), 'recovery.lastReason': `worker_died_in_${job.phase}` },
          { returnDocument: 'after' },
        );
        if (!claimed) continue;
        if (target?.status === T.PUBLISHING) await PostTarget.updateOne({ _id: target._id, status: T.PUBLISHING }, { status: T.QUEUED });
        await queue.enqueue({ queueJobId, publishJobId: job._id, runAt: claimed.runAt });
        summary.restarted++;
      } else {
        // The creating request may have reached the platform. Never retry automatically.
        const claimed = await PublishJob.findOneAndUpdate(
          { _id: job._id, status: J.RUNNING },
          { $set: { status: J.ABANDONED, finishedAt: nowDate(), phase: 'idle', 'recovery.lastAt': nowDate(), 'recovery.lastReason': 'worker_died_while_sending' }, $inc: { 'recovery.count': 1 }, $push: { attempts: { n: job.attemptCount, startedAt: job.startedAt, finishedAt: nowDate(), outcome: 'abandoned', errorClass: ERROR_CLASS.AMBIGUOUS } } },
          { returnDocument: 'after' },
        );
        if (!claimed || !target) continue;
        await PostTarget.updateOne(
          { _id: target._id },
          {
            $set: {
              status: T.FAILED,
              errorClass: ERROR_CLASS.AMBIGUOUS,
              errorCode: 'worker_interrupted',
              errorMessage: `The publisher stopped while sending to ${labelOf(target.platform)}. The post may or may not have been published – check the platform before retrying to avoid a duplicate.`,
              nextRetryAt: null,
            },
          },
        );
        await refreshPostStatus(target.postId);
        await audit.record({ actorId: target.ownerId, action: 'publish.abandoned', resourceType: 'post_target', resourceId: target._id, metadata: { platform: target.platform } });
        summary.abandoned++;
      }
    }

    if (summary.requeued || summary.reenqueuedMissing || summary.restarted || summary.abandoned) {
      logger.warn(summary, 'publish job recovery made changes');
    }
    return summary;
  }

  // ---------------------------------------------------------------- reading

  async function listJobs(ownerId, { page = 1, limit = 20, status, targetStatus } = {}) {
    const filter = { ownerId, ...(status ? { status } : {}) };
    if (targetStatus) {
      const ids = await PostTarget.find({ ownerId, status: targetStatus }).distinct('_id');
      filter.targetId = { $in: ids };
    }
    const [jobs, total] = await Promise.all([
      PublishJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      PublishJob.countDocuments(filter),
    ]);
    return { items: await decorateJobs(jobs), page, limit, total };
  }

  async function getJob(ownerId, id) {
    const job = await PublishJob.findOne({ _id: id, ownerId });
    if (!job) throw notFound('Job not found.');
    return (await decorateJobs([job]))[0];
  }

  async function decorateJobs(jobs) {
    const targets = await PostTarget.find({ _id: { $in: jobs.map((j) => j.targetId) } });
    const accounts = await SocialAccount.find({ _id: { $in: targets.map((t) => t.accountId) } }).select('displayName platform handle');
    const posts = await Post.find({ _id: { $in: jobs.map((j) => j.postId) } }).select('text');
    const tById = new Map(targets.map((t) => [String(t._id), t]));
    const aById = new Map(accounts.map((a) => [String(a._id), a]));
    const pById = new Map(posts.map((p) => [String(p._id), p]));
    return jobs.map((j) => {
      const t = tById.get(String(j.targetId));
      const a = t && aById.get(String(t.accountId));
      return {
        ...j.toJSON(),
        target: t
          ? { id: String(t._id), status: t.status, platform: t.platform, errorClass: t.errorClass, errorMessage: t.errorMessage, remoteUrl: t.remoteUrl, account: a ? { id: String(a._id), displayName: a.displayName, handle: a.handle } : null }
          : null,
        postExcerpt: (pById.get(String(j.postId))?.text ?? '').slice(0, 140),
      };
    });
  }

  return { enqueueTarget, cancelActiveJob, cancelTarget, unscheduleTarget, processJob, retryJob, cancelJob, recoverJobs, refreshPostStatus, listJobs, getJob };
}

function attemptRecord(n, startedAt, outcome, perr) {
  return { n, startedAt, finishedAt: new Date(), outcome, errorClass: perr?.kind, errorCode: perr?.code, httpStatus: perr?.status };
}

const LABELS = { bluesky: 'Bluesky', mastodon: 'Mastodon', mock: 'the mock platform', instagram: 'Instagram', facebook: 'Facebook', threads: 'Threads', x: 'X' };
const labelOf = (platform) => LABELS[platform] ?? platform;
