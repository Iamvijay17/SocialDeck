import { ACCOUNT_STATUS, AppError, TARGET_STATUS, badRequest, conflict, notFound } from '@osh/shared';
import { PlatformError } from '@osh/platform-core';
import { PostTarget, SocialAccount, User } from '../models/index.js';
import { callbackUrl } from '../adapters.js';

const CRED_AAD = 'social-account-credentials';

const accessibleFilter = (userId) => ({ $or: [{ ownerId: userId }, { 'grants.userId': userId }] });

/** Shape an account for a viewer: owners see who it is shared with; everyone else only sees that it is shared. */
function present(account, viewerId) {
  const json = account.toJSON();
  const isOwner = String(account.ownerId) === String(viewerId);
  json.shared = !isOwner;
  json.grants = isOwner ? (account.grants ?? []).map((g) => ({ userId: String(g.userId), permissions: g.permissions })) : undefined;
  return json;
}

export function createAccountService({ config, logger, cipher, adapters, audit, publishing }) {
  function adapterFor(platform) {
    const adapter = adapters.get(platform);
    if (!adapter) throw badRequest(`Unknown platform "${platform}".`);
    return adapter;
  }

  function liftPlatformError(err) {
    if (err instanceof PlatformError) return new AppError(err.kind === 'transient' ? 502 : 400, `platform_${err.code ?? 'error'}`, err.message);
    return err;
  }

  async function loadOwned(ownerId, id) {
    const loaded = await service.getWithCredentials(id);
    if (!loaded || String(loaded.account.ownerId) !== String(ownerId)) throw notFound('Account not found.');
    return loaded;
  }

  const service = {
    /** Accounts the user owns plus accounts the owner explicitly granted to them. */
    async list(userId) {
      const accounts = await SocialAccount.find(accessibleFilter(userId)).sort({ platform: 1, displayName: 1 });
      return accounts.map((a) => present(a, userId));
    },

    async get(userId, id) {
      const account = await SocialAccount.findOne({ _id: id, ...accessibleFilter(userId) });
      if (!account) throw notFound('Account not found.');
      return present(account, userId);
    },

    /**
     * Friend access (owner only): allow or stop another user publishing to an account.
     * Revoking cancels that user's queued/scheduled posts for the account.
     */
    async setGrant(userRef, accountId, on, { actorId, requestId } = {}) {
      if (!config.friendAccessEnabled) throw conflict('Friend access is disabled (ENABLE_FRIEND_ACCESS=false).');
      const user = /^[a-f0-9]{24}$/i.test(String(userRef)) ? await User.findById(userRef) : await User.findOne({ email: String(userRef ?? '').toLowerCase() });
      if (!user) throw notFound('User not found.');
      if (user.isOwner) throw badRequest('The owner already has access to every account.');
      const account = await SocialAccount.findById(accountId);
      if (!account || (actorId && String(account.ownerId) !== String(actorId))) throw notFound('Account not found.');
      if (on) {
        if (account.status === ACCOUNT_STATUS.REVOKED) throw conflict('This account has been disconnected.');
        await SocialAccount.updateOne({ _id: account._id, 'grants.userId': { $ne: user._id } }, { $push: { grants: { userId: user._id, permissions: ['publish'] } } });
      } else {
        await SocialAccount.updateOne({ _id: account._id }, { $pull: { grants: { userId: user._id } } });
        const pending = await PostTarget.find({ accountId: account._id, ownerId: user._id, status: { $in: [TARGET_STATUS.QUEUED, TARGET_STATUS.SCHEDULED] } });
        for (const t of pending) await publishing.cancelTarget(t, { reason: 'Access to this account was revoked.' }).catch(() => {});
      }
      await audit.record({ actorId, action: on ? 'account.grant' : 'account.revoke_grant', resourceType: 'account', resourceId: account._id, metadata: { userId: String(user._id) }, requestId });
      return { accountId: String(account._id), userId: String(user._id), granted: on };
    },

    /** Load an account including its decrypted credentials. Server-side use only. */
    async getWithCredentials(accountId) {
      const account = await SocialAccount.findById(accountId).select('+credentials');
      if (!account) return null;
      return { account, credentials: cipher.decryptJson(account.credentials, CRED_AAD) };
    },

    async beginConnect(ownerId, platform, input = {}) {
      const adapter = adapterFor(platform);
      if (!adapter.capabilities.implemented) {
        throw new AppError(501, 'integration_unavailable', `${adapter.label} publishing is not available. ${adapter.capabilities.notes?.[0] ?? ''}`.trim());
      }
      if (!adapter.configuration.configured) {
        throw new AppError(
          409,
          'platform_not_configured',
          `${adapter.label} is not set up yet. Add ${adapter.configuration.missing.join(' and ')} to .env (see docs/platforms.md) and restart.`,
          { missing: adapter.configuration.missing },
        );
      }
      try {
        return await adapter.beginAuthorization({ ownerId: String(ownerId), redirectUri: callbackUrl(config, platform, adapter), input });
      } catch (err) {
        throw liftPlatformError(err);
      }
    },

    /**
     * Who is completing this OAuth flow? Taken from the single-use state the provider echoes back, so the callback
     * also works when the provider redirects to a different origin than the dashboard (no session cookie there).
     */
    async ownerFromCallback(platform, query) {
      const adapter = adapters.get(platform);
      return adapter ? adapter.ownerFromCallback(query) : null;
    },

    /**
     * Finish the OAuth flow. A login can yield several accounts (Meta: every shared Page and its Instagram account),
     * so this returns a list of upserted accounts.
     */
    async completeConnect(ownerId, platform, query, { requestId } = {}) {
      const adapter = adapterFor(platform);
      let result;
      try {
        result = await adapter.completeAuthorization({ ownerId: String(ownerId), redirectUri: callbackUrl(config, platform, adapter), query });
      } catch (err) {
        throw liftPlatformError(err);
      }
      const entries = result.accounts ?? [result];
      const saved = [];
      for (const entry of entries) {
        const accountPlatform = entry.platform ?? adapter.id;
        const { identity, credentials, scopes, expiresAt } = entry;
        const account = await SocialAccount.findOneAndUpdate(
          { ownerId, platform: accountPlatform, externalId: identity.externalId },
          {
            $set: {
              displayName: identity.displayName,
              handle: identity.handle,
              avatarUrl: identity.avatarUrl,
              instance: identity.instance,
              credentials: cipher.encryptJson(credentials, CRED_AAD),
              scopes: scopes ?? [],
              tokenExpiresAt: expiresAt ?? null,
              status: ACCOUNT_STATUS.ACTIVE,
              statusReason: null,
              lastVerifiedAt: new Date(),
              connectedAt: new Date(),
            },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        );
        await audit.record({
          actorId: ownerId,
          action: 'account.connect',
          resourceType: 'account',
          resourceId: account._id,
          metadata: { platform: accountPlatform, scopes: scopes ?? [] },
          requestId,
        });
        saved.push(account);
      }
      return saved;
    },

    /**
     * Refresh credentials that expire (Threads: 60-day tokens) before they lapse. Run daily by the worker.
     * Accounts that cannot be refreshed are flagged so the dashboard asks for a reconnect while there is still time.
     */
    async refreshExpiring({ withinMs = 14 * 86_400_000 } = {}) {
      const summary = { refreshed: 0, failed: 0, reauthorize: 0 };
      const due = await SocialAccount.find({ status: ACCOUNT_STATUS.ACTIVE, tokenExpiresAt: { $ne: null, $lt: new Date(Date.now() + withinMs) } });
      for (const a of due) {
        const adapter = adapters.get(a.platform);
        if (!adapter?.enabled || adapter.capabilities.tokenRefresh !== 'automatic') continue;
        const loaded = await service.getWithCredentials(a._id);
        try {
          const fresh = await adapter.refreshCredentials({ credentials: loaded.credentials, account: service.accountContext(a) });
          await service.updateCredentials(a._id, fresh.credentials, fresh.expiresAt);
          await SocialAccount.updateOne({ _id: a._id }, { lastVerifiedAt: new Date() });
          summary.refreshed++;
        } catch (err) {
          if (err instanceof PlatformError && err.kind === 'auth') {
            await service.markNeedsReauthorization(a._id, err.message);
            summary.reauthorize++;
          } else {
            logger.warn({ platform: a.platform, code: err.code }, 'credential refresh failed; will retry');
            summary.failed++;
          }
        }
      }
      if (summary.refreshed || summary.failed || summary.reauthorize) logger.info(summary, 'credential refresh sweep');
      return summary;
    },

    /** Check the stored credentials with the platform and update the account status accordingly. */
    async verify(ownerId, id, { requestId } = {}) {
      const { account, credentials } = await loadOwned(ownerId, id);
      if (account.status === ACCOUNT_STATUS.REVOKED) throw conflict('This account has been disconnected.');
      const adapter = adapterFor(account.platform);
      try {
        const { expiresAt } = await adapter.verifyCredentials({
          credentials,
          account: this.accountContext(account),
          ownerId: String(ownerId),
          redirectUri: callbackUrl(config, account.platform, adapter),
          onCredentialsUpdated: (c, exp) => this.updateCredentials(account._id, c, exp),
        });
        await SocialAccount.updateOne({ _id: account._id }, { status: ACCOUNT_STATUS.ACTIVE, statusReason: null, lastVerifiedAt: new Date(), tokenExpiresAt: expiresAt ?? null });
      } catch (err) {
        if (err instanceof PlatformError && err.kind === 'auth') {
          await this.markNeedsReauthorization(account._id, err.message);
        } else if (!(err instanceof PlatformError)) {
          throw err;
        } else {
          throw liftPlatformError(err);
        }
      }
      await audit.record({ actorId: ownerId, action: 'account.verify', resourceType: 'account', resourceId: account._id, requestId });
      return this.get(ownerId, id);
    },

    accountContext(account) {
      return {
        id: String(account._id),
        ownerId: String(account.ownerId),
        externalId: account.externalId,
        displayName: account.displayName,
        handle: account.handle,
        instance: account.instance,
      };
    },

    async updateCredentials(accountId, credentials, expiresAt) {
      await SocialAccount.updateOne(
        { _id: accountId },
        { credentials: cipher.encryptJson(credentials, CRED_AAD), ...(expiresAt !== undefined ? { tokenExpiresAt: expiresAt } : {}) },
      );
    },

    async markNeedsReauthorization(accountId, reason) {
      await SocialAccount.updateOne(
        { _id: accountId, status: { $ne: ACCOUNT_STATUS.REVOKED } },
        { status: ACCOUNT_STATUS.NEEDS_REAUTHORIZATION, statusReason: String(reason ?? '').slice(0, 500) },
      );
    },

    /**
     * Disconnect an account safely:
     *  - refuse while a publish is in progress for it,
     *  - cancel queued/scheduled work that would use it,
     *  - revoke platform-side authorization (best effort),
     *  - keep the (credential-less) record if posts reference it so history stays intact, otherwise delete it.
     */
    async disconnect(ownerId, id, { requestId } = {}) {
      const { account, credentials } = await loadOwned(ownerId, id);
      const publishingNow = await PostTarget.countDocuments({ accountId: account._id, status: TARGET_STATUS.PUBLISHING });
      if (publishingNow > 0) throw conflict('A post is being published to this account right now. Try again in a moment.');

      const pending = await PostTarget.find({ accountId: account._id, status: { $in: [TARGET_STATUS.QUEUED, TARGET_STATUS.SCHEDULED] } });
      for (const target of pending) {
        await publishing.cancelTarget(target, { reason: 'Account was disconnected.' });
      }

      if (account.status !== ACCOUNT_STATUS.REVOKED) {
        const adapter = adapters.get(account.platform);
        if (adapter) {
          await adapter
            .revoke({ credentials, ownerId: String(ownerId), account: this.accountContext(account) })
            .catch((err) => logger.warn({ err, platform: account.platform }, 'platform revocation failed'));
        }
      }

      const referenced = await PostTarget.exists({ accountId: account._id });
      if (referenced) {
        await SocialAccount.updateOne(
          { _id: account._id },
          { status: ACCOUNT_STATUS.REVOKED, statusReason: 'Disconnected by user', credentials: cipher.encryptJson({}, CRED_AAD), scopes: [], tokenExpiresAt: null },
        );
      } else {
        await SocialAccount.deleteOne({ _id: account._id });
      }
      await audit.record({ actorId: ownerId, action: 'account.disconnect', resourceType: 'account', resourceId: account._id, metadata: { platform: account.platform }, requestId });
      return { id: String(account._id), disconnected: true };
    },
  };
  return service;
}

