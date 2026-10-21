import { createAdapterRegistry } from './adapters.js';
import { createCipher } from './crypto.js';
import { connectDb, disconnectDb } from './db.js';
import { createLogger } from './logger.js';
import { createMediaStorage } from './media/storage.js';
import { createBullQueue, createRedisConnection } from './queue.js';
import { createAccountService } from './services/accounts.js';
import { createAuditService } from './services/audit.js';
import { createAuthService } from './services/auth.js';
import { createAnalyticsService, createDashboardService } from './services/dashboard.js';
import { createMediaService } from './services/media.js';
import { createPostService } from './services/posts.js';
import { createPublishingService } from './services/publishing.js';

const HEARTBEAT_KEY = 'osh:worker:heartbeat';

/**
 * Wire up the application: configuration -> infrastructure (db, queue, storage) -> services.
 * Both the API and the worker call this, so they share exactly the same business logic.
 *
 * @param {object} config result of loadConfig()
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {object} [opts.queue]     inject a queue (tests use createMemoryQueue)
 * @param {object} [opts.adapterDeps] forwarded to createAdapterRegistry (tests)
 * @param {boolean} [opts.connect=true] connect to MongoDB
 * @param {() => number} [opts.now]
 */
export async function createContext(config, { logger = createLogger({ level: config.logLevel }), queue, adapterDeps = {}, connect = true, now } = {}) {
  const cipher = createCipher({ key: config.encryptionKey, previousKeys: config.previousEncryptionKeys });
  if (connect) await connectDb(config.mongodbUri, { logger });

  const storage = createMediaStorage({ dir: config.media.dir });
  await storage.ensure();

  let redis = null;
  if (!queue) {
    redis = createRedisConnection(config.redisUrl);
    redis.on('error', (err) => logger.error({ err }, 'redis error'));
    queue = createBullQueue({ connection: redis, logger });
    queue.workerOnline = async () => Boolean(await redis.get(HEARTBEAT_KEY));
    queue.setWorkerHeartbeat = (ttlSeconds = 30) => redis.set(HEARTBEAT_KEY, String(Date.now()), 'EX', ttlSeconds);
  } else {
    queue.workerOnline ??= async () => true;
    queue.setWorkerHeartbeat ??= async () => {};
  }

  const adapters = createAdapterRegistry({ config, logger, cipher, ...adapterDeps });
  const audit = createAuditService({ logger });
  const auth = createAuthService({ config, logger, audit });
  const media = createMediaService({ config, storage, cipher, audit, logger });

  // publishing <-> accounts reference each other; resolve the cycle lazily.
  const ref = {};
  const publishing = createPublishingService({ config, logger, adapters, queue, storage, media, audit, getAccounts: () => ref.accounts, now });
  const accounts = createAccountService({ config, logger, cipher, adapters, audit, publishing });
  ref.accounts = accounts;
  const posts = createPostService({ adapters, media, audit, publishing });
  const dashboard = createDashboardService({ queue });
  const analytics = createAnalyticsService({ adapters, accounts });

  async function close() {
    await queue.close?.();
    if (redis) await redis.quit().catch(() => redis.disconnect());
    if (connect) await disconnectDb();
  }

  return { config, logger, cipher, adapters, queue, redis, storage, services: { audit, auth, media, accounts, posts, publishing, dashboard, analytics }, close };
}
