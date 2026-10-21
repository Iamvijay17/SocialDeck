import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { loadSession, requireAuth, requireCsrf, requireOwner } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { createRateLimiters } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { accountRoutes } from './routes/accounts.js';
import { authRoutes } from './routes/auth.js';
import { mediaRoutes, publicMediaRoutes } from './routes/media.js';
import { analyticsRoutes, dashboardRoutes, platformRoutes, publicRoutes, settingsRoutes, userRoutes } from './routes/misc.js';
import { postRoutes } from './routes/posts.js';
import { publishingRoutes } from './routes/publishing.js';

/**
 * Build the Express application from an application context (see @osh/server-core createContext).
 * Kept free of listen()/process concerns so tests can drive it with Supertest.
 *
 * @param {object} ctx
 * @param {{rateLimits?: object}} [opts]
 */
export function createApp(ctx, { rateLimits } = {}) {
  const { config, logger } = ctx;
  const app = express();
  const limiters = createRateLimiters(rateLimits);

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestId());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      // Never log query strings: OAuth callbacks carry authorization codes there.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.cookieSecure ? undefined : false,
    }),
  );
  app.use(
    cors({
      // Strict allowlist. Same-origin deployments (the default) never need CORS at all.
      origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', limiters.api);
  app.use('/api', loadSession({ services: ctx.services }));

  // Public
  app.use('/api', publicRoutes({ ctx }));
  app.use('/api/auth', authRoutes({ ctx, limiters }));
  app.use('/api/public-media', publicMediaRoutes({ ctx }));
  app.use('/api/accounts', accountRoutes({ ctx }));

  // Authenticated
  const authed = [requireAuth, requireCsrf];
  app.use('/api/platforms', ...authed, platformRoutes({ ctx }));
  app.use('/api/posts', ...authed, postRoutes({ ctx }));
  app.use('/api/publishing', ...authed, publishingRoutes({ ctx }));
  app.use('/api/media', ...authed, mediaRoutes({ ctx }));
  app.use('/api/dashboard', ...authed, dashboardRoutes({ ctx }));
  app.use('/api/settings', ...authed, settingsRoutes({ ctx }));
  app.use('/api/users', ...authed, requireOwner, userRoutes({ ctx }));
  app.use('/api/analytics', ...authed, analyticsRoutes({ ctx, limiters }));

  app.use(notFoundHandler());
  app.use(errorHandler({ logger, isProduction: config.isProduction }));
  return app;
}
