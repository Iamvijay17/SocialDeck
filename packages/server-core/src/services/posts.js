import {
  ACCOUNT_STATUS,
  AppError,
  TARGET_STATUS as T,
  badRequest,
  conflict,
  notFound,
  unprocessable,
} from '@osh/shared';
import { MediaAsset, Post, PostTarget, PublishJob, SocialAccount } from '../models/index.js';

const MIN_SCHEDULE_LEAD_MS = 30_000;
/** A post's content can only be edited while none of its targets is in flight or already published. */
const LOCKED_FOR_EDIT = [T.QUEUED, T.PUBLISHING, T.PUBLISHED];

export function createPostService({ adapters, media, audit, publishing }) {
  // ---------------------------------------------------------------- helpers

  async function loadOwnedPost(ownerId, id) {
    const post = await Post.findOne({ _id: id, ownerId });
    if (!post) throw notFound('Post not found.');
    return post;
  }

  async function loadAccounts(ownerId, accountIds) {
    const accounts = await SocialAccount.find({ _id: { $in: accountIds }, ownerId });
    if (accounts.length !== new Set(accountIds.map(String)).size) throw notFound('One or more selected accounts were not found.');
    for (const a of accounts) {
      if (a.status === ACCOUNT_STATUS.REVOKED) throw conflict(`${a.displayName} has been disconnected.`);
    }
    return accounts;
  }

  /** Full post representation: post + targets (+ media summaries). */
  async function present(posts) {
    const list = Array.isArray(posts) ? posts : [posts];
    if (!list.length) return [];
    const ids = list.map((p) => p._id);
    const targets = await PostTarget.find({ postId: { $in: ids } }).sort({ createdAt: 1 });
    const accounts = await SocialAccount.find({ _id: { $in: targets.map((t) => t.accountId) } });
    const aById = new Map(accounts.map((a) => [String(a._id), a]));
    const mediaIds = [...new Set(list.flatMap((p) => p.mediaIds.map(String)))];
    const mediaDocs = mediaIds.length ? await MediaAsset.find({ _id: { $in: mediaIds } }) : [];
    const mById = new Map(mediaDocs.map((m) => [String(m._id), m]));
    const jobs = await PublishJob.aggregate([
      { $match: { targetId: { $in: targets.map((t) => t._id) } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$targetId', id: { $first: '$_id' }, status: { $first: '$status' } } },
    ]);
    const jById = new Map(jobs.map((j) => [String(j._id), { id: String(j.id), status: j.status }]));
    const byPost = new Map();
    for (const t of targets) {
      const arr = byPost.get(String(t.postId)) ?? [];
      const a = aById.get(String(t.accountId));
      arr.push({
        ...t.toJSON(),
        job: jById.get(String(t._id)) ?? null,
        account: a ? { id: String(a._id), platform: a.platform, displayName: a.displayName, handle: a.handle, avatarUrl: a.avatarUrl, status: a.status } : null,
      });
      byPost.set(String(t.postId), arr);
    }
    return list.map((p) => ({
      ...p.toJSON(),
      media: p.mediaIds.map((id) => mById.get(String(id))).filter(Boolean).map((m) => m.toJSON()),
      targets: byPost.get(String(p._id)) ?? [],
    }));
  }

  /** Content for validation/publishing of one target. */
  async function contentFor(post, target, mediaDocs) {
    return {
      text: target.textOverride ?? post.text,
      media: mediaDocs.map((m) => ({ id: String(m._id), kind: m.kind, mimeType: m.mimeType, size: m.size, altText: m.altText })),
    };
  }

  async function validateTargets({ text, mediaDocs, targets }) {
    const out = [];
    for (const t of targets) {
      const adapter = adapters.get(t.account.platform);
      const issues = [];
      if (!adapter) {
        issues.push({ code: 'unknown_platform', severity: 'error', message: 'Unknown platform.' });
      } else if (!adapter.enabled) {
        issues.push({ code: 'integration_unavailable', severity: 'error', message: `${adapter.label} publishing is not implemented yet.` });
      } else {
        if (t.account.status === ACCOUNT_STATUS.NEEDS_REAUTHORIZATION) {
          issues.push({ code: 'needs_reauthorization', severity: 'error', message: 'This account needs to be reconnected.' });
        }
        issues.push(...(await adapter.validateContent(await contentFor({ text }, { textOverride: t.text ?? null }, mediaDocs), { account: { id: String(t.account._id), instance: t.account.instance, externalId: t.account.externalId } })));
      }
      out.push({
        accountId: String(t.account._id),
        platform: t.account.platform,
        valid: !issues.some((i) => i.severity === 'error'),
        issues,
      });
    }
    return out;
  }

  async function recompute(postId) {
    return publishing.refreshPostStatus(postId);
  }

  // ---------------------------------------------------------------- public API

  const service = {
    present,

    /** Validate content for the selected accounts without persisting anything. */
    async validate(ownerId, { text, mediaIds, targets }) {
      const mediaDocs = await media.getMany(ownerId, mediaIds);
      const accounts = await loadAccounts(ownerId, targets.map((t) => t.accountId));
      const aById = new Map(accounts.map((a) => [String(a._id), a]));
      return validateTargets({ text, mediaDocs, targets: targets.map((t) => ({ text: t.text, account: aById.get(String(t.accountId)) })) });
    },

    async create(ownerId, input, { requestId } = {}) {
      const mediaDocs = await media.getMany(ownerId, input.mediaIds);
      const accounts = await loadAccounts(ownerId, input.targets.map((t) => t.accountId));
      const post = await Post.create({
        ownerId,
        text: input.text,
        mediaIds: mediaDocs.map((m) => m._id),
        scheduledAt: input.scheduledAt ?? null,
        timezone: input.timezone,
      });
      const aById = new Map(accounts.map((a) => [String(a._id), a]));
      if (input.targets.length) {
        await PostTarget.insertMany(
          input.targets.map((t) => {
            const a = aById.get(String(t.accountId));
            return { postId: post._id, ownerId, accountId: a._id, platform: a.platform, textOverride: t.text ?? null };
          }),
        );
      }
      await audit.record({ actorId: ownerId, action: 'post.create', resourceType: 'post', resourceId: post._id, metadata: { targets: input.targets.length, media: mediaDocs.length }, requestId });
      return (await present(post))[0];
    },

    async get(ownerId, id) {
      return (await present(await loadOwnedPost(ownerId, id)))[0];
    },

    async list(ownerId, { page = 1, limit = 20, status, platform, from, to, q, sort = 'newest' } = {}) {
      const filter = { ownerId };
      if (status) filter.status = status;
      if (q) filter.text = { $regex: escapeRegex(q), $options: 'i' };
      if (platform) {
        const postIds = await PostTarget.find({ ownerId, platform }).distinct('postId');
        filter._id = { $in: postIds };
      }
      if (from || to) {
        const range = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
        filter.$or = [{ scheduledAt: range }, { publishedAt: range }];
      }
      const order = sort === 'oldest' ? { createdAt: 1 } : sort === 'scheduled' ? { scheduledAt: 1, createdAt: -1 } : { createdAt: -1 };
      const [posts, total] = await Promise.all([
        Post.find(filter).sort(order).skip((page - 1) * limit).limit(limit),
        Post.countDocuments(filter),
      ]);
      return { items: await present(posts), page, limit, total };
    },

    async update(ownerId, id, input, { requestId } = {}) {
      const post = await loadOwnedPost(ownerId, id);
      const existing = await PostTarget.find({ postId: post._id });
      const wasScheduled = post.status === 'scheduled';
      const contentChange = input.text !== undefined || input.mediaIds !== undefined || input.targets !== undefined;
      if (contentChange && existing.some((t) => LOCKED_FOR_EDIT.includes(t.status))) {
        throw conflict('This post is being published or has already been published and its content can no longer be edited.');
      }
      if (input.text !== undefined) post.text = input.text;
      if (input.timezone !== undefined) post.timezone = input.timezone;
      if (input.mediaIds !== undefined) {
        const docs = await media.getMany(ownerId, input.mediaIds);
        post.mediaIds = docs.map((d) => d._id);
      }

      if (input.targets !== undefined) {
        const accounts = await loadAccounts(ownerId, input.targets.map((t) => t.accountId));
        const aById = new Map(accounts.map((a) => [String(a._id), a]));
        const wanted = new Map(input.targets.map((t) => [String(t.accountId), t]));
        for (const t of existing) {
          if (!wanted.has(String(t.accountId))) {
            await publishing.cancelActiveJob(t._id);
            await PublishJob.deleteMany({ targetId: t._id });
            await PostTarget.deleteOne({ _id: t._id });
          } else {
            const w = wanted.get(String(t.accountId));
            await PostTarget.updateOne({ _id: t._id }, { textOverride: w.text ?? null });
          }
        }
        const have = new Set(existing.map((t) => String(t.accountId)));
        const fresh = input.targets.filter((t) => !have.has(String(t.accountId)));
        if (fresh.length) {
          await PostTarget.insertMany(
            fresh.map((t) => {
              const a = aById.get(String(t.accountId));
              return { postId: post._id, ownerId, accountId: a._id, platform: a.platform, textOverride: t.text ?? null };
            }),
          );
        }
      }
      await post.save();

      if (input.scheduledAt !== undefined) {
        if (input.scheduledAt === null) {
          post.scheduledAt = null;
          await post.save();
          for (const t of await PostTarget.find({ postId: post._id, status: T.SCHEDULED })) await publishing.unscheduleTarget(t);
        } else if (post.status === 'scheduled') {
          await this.schedule(ownerId, id, { scheduledAt: input.scheduledAt, timezone: input.timezone }, { requestId });
        } else {
          post.scheduledAt = input.scheduledAt;
          await post.save();
        }
      }
      if (wasScheduled && contentChange && input.scheduledAt === undefined && post.scheduledAt) {
        // Keep newly added or edited targets on the same schedule.
        await this.schedule(ownerId, id, { scheduledAt: post.scheduledAt }, { requestId, skipLeadCheck: true });
      }
      await recompute(post._id);
      await audit.record({ actorId: ownerId, action: 'post.update', resourceType: 'post', resourceId: post._id, requestId });
      return (await present(await Post.findById(post._id)))[0];
    },

    async remove(ownerId, id, { requestId } = {}) {
      const post = await loadOwnedPost(ownerId, id);
      const targets = await PostTarget.find({ postId: post._id });
      if (targets.some((t) => t.status === T.PUBLISHING)) throw conflict('This post is being published right now.');
      for (const t of targets) await publishing.cancelActiveJob(t._id);
      if (await PublishJob.exists({ postId: post._id, status: 'running' })) throw conflict('This post is being published right now.');
      await PublishJob.deleteMany({ postId: post._id });
      await PostTarget.deleteMany({ postId: post._id });
      await Post.deleteOne({ _id: post._id });
      await audit.record({ actorId: ownerId, action: 'post.delete', resourceType: 'post', resourceId: post._id, requestId });
    },

    /** Publish all eligible targets now. All-or-nothing validation: if any target is invalid, nothing is queued. */
    async publishNow(ownerId, id, { requestId } = {}) {
      const post = await loadOwnedPost(ownerId, id);
      const targets = await eligibleTargets(post);
      await assertValid(post, targets, ownerId);
      for (const t of targets) await publishing.enqueueTarget(t, { runAt: new Date() });
      await recompute(post._id);
      await audit.record({ actorId: ownerId, action: 'post.publish', resourceType: 'post', resourceId: post._id, metadata: { targets: targets.length }, requestId });
      return (await present(await Post.findById(post._id)))[0];
    },

    async schedule(ownerId, id, { scheduledAt, timezone }, { requestId, skipLeadCheck = false } = {}) {
      if (!skipLeadCheck && scheduledAt.getTime() < Date.now() + MIN_SCHEDULE_LEAD_MS) {
        throw unprocessable('Choose a time in the future.', { field: 'scheduledAt' });
      }
      const post = await loadOwnedPost(ownerId, id);
      const targets = await eligibleTargets(post, { allowScheduled: true });
      await assertValid(post, targets, ownerId);
      post.scheduledAt = scheduledAt;
      if (timezone) post.timezone = timezone;
      await post.save();
      for (const t of targets) {
        if (t.status === T.SCHEDULED) await publishing.cancelActiveJob(t._id);
        await publishing.enqueueTarget(t, { runAt: scheduledAt });
      }
      await recompute(post._id);
      await audit.record({ actorId: ownerId, action: 'post.schedule', resourceType: 'post', resourceId: post._id, metadata: { targets: targets.length, scheduledAt: scheduledAt.toISOString() }, requestId });
      return (await present(await Post.findById(post._id)))[0];
    },

    /** Cancel everything that has not started. Targets already published (or mid-publish) are left untouched. */
    async cancel(ownerId, id, { requestId } = {}) {
      const post = await loadOwnedPost(ownerId, id);
      const targets = await PostTarget.find({ postId: post._id, status: { $in: [T.DRAFT, T.SCHEDULED, T.QUEUED, T.FAILED, T.NEEDS_REAUTHORIZATION] } });
      if (!targets.length) throw conflict('Nothing to cancel: no target is waiting to be published.');
      let skipped = 0;
      for (const t of targets) {
        try {
          await publishing.cancelTarget(t, { reason: 'Cancelled by user.' });
        } catch (err) {
          if (err instanceof AppError && err.status === 409) skipped++;
          else throw err;
        }
      }
      await audit.record({ actorId: ownerId, action: 'post.cancel', resourceType: 'post', resourceId: post._id, metadata: { cancelled: targets.length - skipped, alreadyStarted: skipped }, requestId });
      return (await present(await Post.findById(post._id)))[0];
    },
  };

  async function eligibleTargets(post, { allowScheduled = false } = {}) {
    const all = await PostTarget.find({ postId: post._id });
    if (!all.length) throw badRequest('Select at least one account to publish to.');
    const ok = [T.DRAFT, T.FAILED, T.NEEDS_REAUTHORIZATION, T.CANCELLED, ...(allowScheduled ? [T.SCHEDULED] : [])];
    const targets = all.filter((t) => ok.includes(t.status));
    if (!targets.length) {
      if (all.some((t) => [T.QUEUED, T.PUBLISHING].includes(t.status))) throw conflict('This post is already being published.');
      if (all.every((t) => t.status === T.PUBLISHED)) throw conflict('This post has already been published.');
      throw conflict('There is nothing to publish.');
    }
    // Ambiguous failures are never re-queued implicitly; they need an explicit retry with acknowledgement.
    const ambiguous = targets.filter((t) => t.status === T.FAILED && t.errorClass === 'ambiguous');
    if (ambiguous.length) {
      throw new AppError(409, 'ambiguous_outcome', 'A previous attempt for this post may already have been published. Review the result and use Retry on that account to confirm.', { targetIds: ambiguous.map((t) => String(t._id)) });
    }
    return targets;
  }

  async function assertValid(post, targets, ownerId) {
    const mediaDocs = await media.getMany(ownerId, post.mediaIds);
    const accounts = await SocialAccount.find({ _id: { $in: targets.map((t) => t.accountId) } });
    const aById = new Map(accounts.map((a) => [String(a._id), a]));
    const results = await validateTargets({
      text: post.text,
      mediaDocs,
      targets: targets.map((t) => ({ text: t.textOverride, account: aById.get(String(t.accountId)) })),
    });
    if (results.some((r) => !r.valid)) {
      throw unprocessable('Some accounts cannot be published to. Fix the issues below and try again.', { targets: results });
    }
  }

  return service;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

