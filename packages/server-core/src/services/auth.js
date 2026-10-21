import { hash, verify } from '@node-rs/argon2';
import { badRequest, conflict, unauthorized } from '@osh/shared';
import { Session, User } from '../models/index.js';
import { randomToken, sha256Hex } from '../crypto.js';

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane).
const ARGON_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const TOUCH_INTERVAL_MS = 5 * 60_000;

export function createAuthService({ config, logger, audit }) {
  let dummyHash;

  async function dummyVerify(password) {
    dummyHash ??= await hash('not-a-real-password-for-timing', ARGON_OPTIONS);
    await verify(dummyHash, password).catch(() => false);
  }

  const publicUser = (u) => ({
    id: String(u._id),
    email: u.email,
    displayName: u.displayName ?? null,
    role: u.role,
    preferences: { timezone: u.preferences?.timezone ?? config.defaultTimezone, theme: u.preferences?.theme ?? 'dark' },
  });

  async function createSession(user, { userAgent } = {}) {
    const rawToken = randomToken(32);
    const now = Date.now();
    const session = await Session.create({
      tokenHash: sha256Hex(rawToken),
      userId: user._id,
      csrfToken: randomToken(24),
      expiresAt: new Date(now + config.session.idleMs),
      userAgent: userAgent?.slice(0, 300),
    });
    return { rawToken, csrfToken: session.csrfToken, maxAgeMs: config.session.maxAgeMs };
  }

  return {
    publicUser,

    /**
     * Create a user. There is deliberately no public registration: accounts are created from the environment at
     * first start (the owner) or with the `create-user` CLI (e.g. an optional trusted friend).
     */
    async createUser({ email, password, displayName, role = 'member', isOwner = false }) {
      if (password.length < 12) throw badRequest('Password must be at least 12 characters.');
      const passwordHash = await hash(password, ARGON_OPTIONS);
      try {
        const user = await User.create({
          email,
          displayName,
          passwordHash,
          role,
          isOwner,
          preferences: { timezone: config.defaultTimezone },
        });
        await audit.record({ actorId: user._id, action: 'auth.user_created', resourceType: 'user', resourceId: user._id, metadata: { role } });
        return user;
      } catch (err) {
        if (err?.code === 11000) throw conflict('A user with that email already exists (or the owner already exists).');
        throw err;
      }
    },

    /**
     * Environment-based initial setup: when the database has no users and OWNER_EMAIL / OWNER_PASSWORD are set,
     * create the single owner. Does nothing once any user exists, so a leftover env var cannot reset the owner.
     * @returns {Promise<'created'|'exists'|'not_configured'>}
     */
    async ensureOwner() {
      if (await User.exists({})) return 'exists';
      if (!config.owner) return 'not_configured';
      await this.createUser({ ...config.owner, role: 'owner', isOwner: true });
      logger.info('owner account created from environment');
      return 'created';
    },

    async login({ email, password }, { requestId, userAgent } = {}) {
      const user = await User.findOne({ email: String(email).toLowerCase() }).select('+passwordHash');
      if (!user) {
        await dummyVerify(password); // equalise timing between unknown user and wrong password
        await audit.record({ action: 'auth.login_failed', metadata: { reason: 'unknown_user' }, requestId });
        throw unauthorized('Invalid email or password.');
      }
      const ok = await verify(user.passwordHash, password).catch(() => false);
      if (!ok) {
        await audit.record({ actorId: user._id, action: 'auth.login_failed', resourceType: 'user', resourceId: user._id, requestId });
        throw unauthorized('Invalid email or password.');
      }
      user.lastLoginAt = new Date();
      await User.updateOne({ _id: user._id }, { lastLoginAt: user.lastLoginAt });
      await audit.record({ actorId: user._id, action: 'auth.login', resourceType: 'user', resourceId: user._id, requestId });
      const session = await createSession(user, { userAgent });
      return { user: publicUser(user), ...session };
    },

    /** Resolve a session cookie value into { user, session }, enforcing idle and absolute expiry. */
    async resolveSession(rawToken) {
      if (!rawToken || typeof rawToken !== 'string') return null;
      const session = await Session.findOne({ tokenHash: sha256Hex(rawToken) });
      if (!session) return null;
      const now = Date.now();
      if (session.expiresAt.getTime() <= now || now - session.createdAt.getTime() > config.session.maxAgeMs) {
        await Session.deleteOne({ _id: session._id });
        return null;
      }
      const user = await User.findById(session.userId);
      if (!user) {
        await Session.deleteOne({ _id: session._id });
        return null;
      }
      if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        const idleExpiry = Math.min(now + config.session.idleMs, session.createdAt.getTime() + config.session.maxAgeMs);
        await Session.updateOne({ _id: session._id }, { lastSeenAt: new Date(now), expiresAt: new Date(idleExpiry) });
      }
      return { user, session };
    },

    async logout(rawToken, { actorId, requestId } = {}) {
      if (!rawToken) return;
      await Session.deleteOne({ tokenHash: sha256Hex(rawToken) });
      if (actorId) await audit.record({ actorId, action: 'auth.logout', resourceType: 'user', resourceId: actorId, requestId });
    },

    async updatePreferences(userId, prefs) {
      const set = {};
      if (prefs.timezone) set['preferences.timezone'] = prefs.timezone;
      if (prefs.theme) set['preferences.theme'] = prefs.theme;
      if (!Object.keys(set).length) throw badRequest('No preferences supplied.');
      const user = await User.findByIdAndUpdate(userId, { $set: set }, { returnDocument: 'after' });
      return publicUser(user);
    },

    /** Used by the `reset-password` CLI. Invalidates all sessions. */
    async setPassword(email, newPassword) {
      const user = await User.findOne({ email: String(email).toLowerCase() });
      if (!user) throw badRequest('No such user.');
      const passwordHash = await hash(newPassword, ARGON_OPTIONS);
      await User.updateOne({ _id: user._id }, { passwordHash });
      await Session.deleteMany({ userId: user._id });
      await audit.record({ actorId: user._id, action: 'auth.password_reset_cli', resourceType: 'user', resourceId: user._id });
    },
  };
}
