import { ACCOUNT_STATUS, POST_STATUS, PUBLISH_JOB_STATUS, TARGET_STATUS, notFound } from '@osh/shared';
import { PlatformError } from '@osh/platform-core';
import { Post, PostTarget, PublishJob, SocialAccount } from '../models/index.js';

export function createDashboardService({ queue, accounts, adapters }) {
  return {
    async summary(ownerId) {
      const now = new Date();
      const [accountDocs, published, scheduled, failedTargets, recent, upcoming, jobCounts] = await Promise.all([
        SocialAccount.find({ $or: [{ ownerId }, { 'grants.userId': ownerId }], status: { $ne: ACCOUNT_STATUS.REVOKED } }).sort({ platform: 1 }),
        Post.countDocuments({ ownerId, status: { $in: [POST_STATUS.PUBLISHED, POST_STATUS.PARTIALLY_PUBLISHED] } }),
        Post.countDocuments({ ownerId, status: POST_STATUS.SCHEDULED }),
        PostTarget.countDocuments({ ownerId, status: { $in: [TARGET_STATUS.FAILED, TARGET_STATUS.NEEDS_REAUTHORIZATION] } }),
        PostTarget.find({ ownerId, status: { $in: [TARGET_STATUS.PUBLISHED, TARGET_STATUS.FAILED, TARGET_STATUS.NEEDS_REAUTHORIZATION, TARGET_STATUS.PUBLISHING, TARGET_STATUS.QUEUED] } })
          .sort({ updatedAt: -1 })
          .limit(10),
        Post.find({ ownerId, status: POST_STATUS.SCHEDULED, scheduledAt: { $gte: now } }).sort({ scheduledAt: 1 }).limit(8),
        PublishJob.aggregate([{ $match: { ownerId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      ]);

      const aById = new Map(accountDocs.map((a) => [String(a._id), a]));
      const missing = recent.map((t) => String(t.accountId)).filter((id) => !aById.has(id));
      if (missing.length) {
        for (const a of await SocialAccount.find({ _id: { $in: missing } })) aById.set(String(a._id), a);
      }
      const postDocs = await Post.find({ _id: { $in: recent.map((t) => t.postId) } }).select('text');
      const pById = new Map(postDocs.map((p) => [String(p._id), p]));

      let queueOk = false;
      let workerOnline = false;
      try {
        queueOk = await queue.ping();
        workerOnline = await queue.workerOnline();
      } catch {
        /* reported as offline */
      }

      return {
        counts: {
          connectedAccounts: accountDocs.filter((a) => a.status === ACCOUNT_STATUS.ACTIVE).length,
          accountsNeedingAttention: accountDocs.filter((a) => a.status !== ACCOUNT_STATUS.ACTIVE).length,
          publishedPosts: published,
          scheduledPosts: scheduled,
          failedTargets,
        },
        recentActivity: recent.map((t) => ({
          targetId: String(t._id),
          postId: String(t.postId),
          status: t.status,
          platform: t.platform,
          account: aById.get(String(t.accountId))?.displayName ?? null,
          excerpt: (pById.get(String(t.postId))?.text ?? '').slice(0, 100),
          remoteUrl: t.remoteUrl ?? null,
          errorMessage: t.errorMessage ?? null,
          at: t.publishedAt ?? t.updatedAt,
        })),
        upcoming: upcoming.map((p) => ({ id: String(p._id), text: p.text.slice(0, 120), scheduledAt: p.scheduledAt })),
        integrations: accountDocs.map((a) => ({
          id: String(a._id),
          platform: a.platform,
          displayName: a.displayName,
          handle: a.handle,
          status: a.status,
          statusReason: a.statusReason ?? null,
          tokenExpiresAt: a.tokenExpiresAt,
          lastVerifiedAt: a.lastVerifiedAt,
        })),
        jobs: Object.fromEntries(Object.values(PUBLISH_JOB_STATUS).map((s) => [s, jobCounts.find((c) => c._id === s)?.count ?? 0])),
        system: { queueConnected: queueOk, workerOnline },
      };
    },

    async accountsMissing() {
      return accounts;
    },
  };
}

export function createAnalyticsService({ adapters, accounts }) {
  return {
    /**
     * Everything here is derived from data this app actually holds (publishing results) or from official platform
     * APIs on request. Nothing is estimated or generated.
     */
    async overview(ownerId, { days = 30 } = {}) {
      const since = new Date(Date.now() - days * 86_400_000);
      const [byStatus, perDay] = await Promise.all([
        PostTarget.aggregate([
          { $match: { ownerId, updatedAt: { $gte: since } } },
          { $group: { _id: { platform: '$platform', status: '$status' }, count: { $sum: 1 } } },
        ]),
        PostTarget.aggregate([
          { $match: { ownerId, status: TARGET_STATUS.PUBLISHED, publishedAt: { $gte: since } } },
          { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$publishedAt' } }, platform: '$platform' }, count: { $sum: 1 } } },
          { $sort: { '_id.day': 1 } },
        ]),
      ]);
      return {
        days,
        publishing: byStatus.map((r) => ({ platform: r._id.platform, status: r._id.status, count: r.count })),
        publishedPerDay: perDay.map((r) => ({ day: r._id.day, platform: r._id.platform, count: r.count })),
        platformMetrics: adapters.describe().map((p) => ({
          platform: p.id,
          label: p.label,
          enabled: p.enabled,
          // The list of engagement metrics the official API exposes AND this app can fetch; empty = none available.
          availableMetrics: p.enabled ? p.capabilities.analytics.postMetrics : [],
        })),
      };
    },

    /** Fetch live engagement metrics for one published target from the platform's official API. */
    async targetMetrics(ownerId, targetId) {
      const target = await PostTarget.findOne({ _id: targetId, ownerId });
      if (!target) throw notFound('Post target not found.');
      if (target.status !== TARGET_STATUS.PUBLISHED || !target.remoteId) {
        return { available: false, reason: 'This post has not been published to the platform.' };
      }
      const adapter = adapters.get(target.platform);
      if (!adapter?.enabled || !adapter.capabilities.analytics.postMetrics.length) {
        return { available: false, reason: `${adapter?.label ?? target.platform} does not expose metrics through this integration.` };
      }
      const loaded = await accounts.getWithCredentials(target.accountId);
      if (!loaded) return { available: false, reason: 'The account is no longer connected.' };
      try {
        const metrics = await adapter.fetchPostMetrics({
          credentials: loaded.credentials,
          account: accounts.accountContext(loaded.account),
          remoteId: target.remoteId,
        });
        return { available: true, fetchedAt: new Date(), metrics };
      } catch (err) {
        if (err instanceof PlatformError) return { available: false, reason: err.message };
        throw err;
      }
    },
  };
}
