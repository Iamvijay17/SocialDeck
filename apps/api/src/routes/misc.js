import { Router } from 'express';
import { analyticsQuerySchema, paginationSchema, preferencesSchema, publicMediaSchema } from '@osh/validation';
import { User, pingDb } from '@osh/server-core';
import { requireOwner } from '../middleware/auth.js';
import { idParams, validate } from '../middleware/validate.js';
import { APP_VERSION } from '../version.js';

/** Unauthenticated: liveness, readiness and Bluesky OAuth client metadata. */
export function publicRoutes({ ctx }) {
  const r = Router();
  r.get('/health', (_req, res) => res.json({ status: 'ok' }));

  r.get('/ready', async (_req, res) => {
    const checks = { mongodb: false, redis: false };
    try {
      checks.mongodb = await pingDb();
    } catch { /* reported below */ }
    try {
      checks.redis = await ctx.queue.ping();
    } catch { /* reported below */ }
    const ok = checks.mongodb && checks.redis;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
  });

  // Served only so Bluesky's authorization server can read it when PUBLIC_URL is a public https origin.
  r.get('/oauth/bluesky/client-metadata.json', (_req, res, next) => {
    try {
      const adapter = ctx.adapters.get('bluesky');
      res.json(adapter.clientMetadata(`${ctx.config.publicUrl}/api/accounts/bluesky/callback`));
    } catch (err) {
      next(err);
    }
  });
  return r;
}

/** Owner-only: the users that exist besides the owner (trusted friend access). */
export function userRoutes({ ctx }) {
  const r = Router();
  r.get('/', async (_req, res) => {
    const users = await User.find({ isOwner: false }).sort({ createdAt: 1 });
    res.json({ enabled: ctx.config.friendAccessEnabled, items: users.map((u) => ctx.services.auth.publicUser(u)) });
  });
  return r;
}

export function platformRoutes({ ctx }) {
  const r = Router();
  r.get('/', (_req, res) => res.json({ items: ctx.adapters.describe() }));
  return r;
}

export function dashboardRoutes({ ctx }) {
  const r = Router();
  r.get('/summary', async (req, res) => res.json(await ctx.services.dashboard.summary(req.auth.user._id)));
  return r;
}

export function settingsRoutes({ ctx }) {
  const { config, services } = ctx;
  const r = Router();

  r.get('/', async (req, res) => {
    const [media, queueConnected, workerOnline] = await Promise.all([
      services.media.usage(req.auth.user._id),
      ctx.queue.ping().catch(() => false),
      ctx.queue.workerOnline().catch(() => false),
    ]);
    res.json({
      app: { name: config.appName, version: APP_VERSION, environment: config.env },
      user: services.auth.publicUser(req.auth.user),
      defaults: { timezone: config.defaultTimezone },
      publishing: { maxAttempts: config.publish.maxAttempts },
      media: { ...media, publicDeliveryConfigured: await services.media.isPublicDeliveryConfigured() },
      system: { queueConnected, workerOnline, mockPlatformEnabled: config.enableMockPlatform, publicUrl: config.publicUrl },
    });
  });

  // Public address of the media gateway (needed only for Instagram / Threads posts with media). Owner only.
  r.get('/public-media', requireOwner, async (_req, res) => {
    const baseUrl = await services.settings.publicMediaBaseUrl();
    res.json({ baseUrl, fromEnvironment: Boolean(baseUrl) && baseUrl === config.media.publicBaseUrl });
  });
  r.put('/public-media', requireOwner, validate({ body: publicMediaSchema }), async (req, res) => {
    res.json(await services.settings.setPublicMediaBaseUrl(req.valid.body.baseUrl, { actorId: req.auth.user._id, requestId: req.id }));
  });
  r.post('/public-media/test', requireOwner, validate({ body: publicMediaSchema.partial() }), async (req, res) => {
    res.json(await services.settings.testPublicMediaBaseUrl(req.valid.body.baseUrl));
  });

  r.patch('/preferences', validate({ body: preferencesSchema }), async (req, res) => {
    res.json({ user: await services.auth.updatePreferences(req.auth.user._id, req.valid.body) });
  });

  r.get('/audit-log', validate({ query: paginationSchema }), async (req, res) => {
    res.json(await services.audit.list({ ...req.valid.query, actorId: req.auth.user._id }));
  });

  return r;
}

export function analyticsRoutes({ ctx, limiters }) {
  const r = Router();
  r.get('/overview', validate({ query: analyticsQuerySchema }), async (req, res) => {
    res.json(await ctx.services.analytics.overview(req.auth.user._id, req.valid.query));
  });
  r.get('/targets/:id/metrics', limiters.metrics, validate({ params: idParams }), async (req, res) => {
    res.json(await ctx.services.analytics.targetMetrics(req.auth.user._id, req.valid.params.id));
  });
  return r;
}

