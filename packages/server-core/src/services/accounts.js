import { ACCOUNT_STATUS, AppError, TARGET_STATUS, badRequest, conflict, notFound } from '@osh/shared';
import { PlatformError } from '@osh/platform-core';
import { PostTarget, SocialAccount } from '../models/index.js';
import { callbackUrl } from '../adapters.js';

const CRED_AAD = 'social-account-credentials';

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
    async list(ownerId) {
      return SocialAccount.find({ ownerId }).sort({ platform: 1, displayName: 1 });
    },

    async get(ownerId, id) {
      const account = await SocialAccount.findOne({ _id: id, ownerId });
      if (!account) throw notFound('Account not found.');
      return account;
    },

    /** Load an account including its decrypted credentials. Server-side use only. */
    async getWithCredentials(accountId) {
      const account = await SocialAccount.findById(accountId).select('+credentials');
      if (!account) return null;
      return { account, credentials: cipher.decryptJson(account.credentials, CRED_AAD) };
    },

    async beginConnect(ownerId, platform, input = {}) {
      const adapter = adapterFor(platform);
      if (!adapter.enabled) {
        throw new AppError(501, 'integration_unavailable', `${adapter.label} publishing is not implemented yet. ${adapter.capabilities.notes?.[0] ?? ''}`.trim());
      }
      try {
        return await adapter.beginAuthorization({ ownerId: String(ownerId), redirectUri: callbackUrl(config, platform), input });
      } catch (err) {
        throw liftPlatformError(err);
      }
    },

    async completeConnect(ownerId, platform, query, { requestId } = {}) {
      const adapter = adapterFor(platform);
      let result;
      try {
        result = await adapter.completeAuthorization({ ownerId: String(ownerId), redirectUri: callbackUrl(config, platform), query });
      } catch (err) {
        throw liftPlatformError(err);
      }
      const { identity, credentials, scopes, expiresAt } = result;
      const account = await SocialAccount.findOneAndUpdate(
        { ownerId, platform, externalId: identity.externalId },
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
        metadata: { platform, scopes: scopes ?? [] },
        requestId,
      });
      return account;
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
          redirectUri: callbackUrl(config, account.platform),
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

