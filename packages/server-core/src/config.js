import path from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const int = (def, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().min(1).max(60).default('Private Social Manager'),

  HOST: z.string().default('127.0.0.1'),
  PORT: int(4000, 1, 65535),
  PUBLIC_URL: z.url().default('http://127.0.0.1:5173'),
  ALLOWED_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().default('false'),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),

  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/open-social-hub'),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required (run `npm run setup:env` to generate one)'),
  ENCRYPTION_KEY_PREVIOUS: z.string().default(''),
  OWNER_EMAIL: z.string().default(''),
  OWNER_PASSWORD: z.string().default(''),
  OWNER_NAME: z.string().default(''),
  ENABLE_FRIEND_ACCESS: bool.default(false),

  SESSION_MAX_AGE_HOURS: int(24 * 7, 1),
  SESSION_IDLE_HOURS: int(24, 1),

  MEDIA_DIR: z.string().default('./data/media'),
  MAX_IMAGE_MB: int(10, 1),
  MAX_VIDEO_MB: int(100, 1),
  PUBLIC_MEDIA_BASE_URL: z.string().default(''),
  PUBLIC_MEDIA_URL_TTL_SECONDS: int(900, 60),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  PUBLISH_MAX_ATTEMPTS: int(5, 1, 20),
  PUBLISH_RETRY_BASE_SECONDS: int(30, 1),
  PUBLISH_RETRY_MAX_SECONDS: int(900, 1),
  WORKER_CONCURRENCY: int(4, 1, 64),
  STALE_JOB_SECONDS: int(120, 30),

  DEFAULT_TIMEZONE: z.string().default('UTC'),

  ENABLE_MOCK_PLATFORM: bool.default(false),
  ALLOW_PRIVATE_NETWORK_TARGETS: bool.default(false),
  BLUESKY_OAUTH_SCOPE: z.string().default(''),
});

/**
 * Parse and validate environment variables. Throws a readable error listing every problem so a
 * misconfigured installation fails at startup, not at first use.
 */
export function loadConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;

  const key = decodeKey(e.ENCRYPTION_KEY);
  const previousKeys = e.ENCRYPTION_KEY_PREVIOUS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(decodeKey);

  const publicUrl = new URL(e.PUBLIC_URL);
  const isHttps = publicUrl.protocol === 'https:';
  const isProd = e.NODE_ENV === 'production';
  const cookieSecure = e.COOKIE_SECURE === 'auto' ? isHttps : e.COOKIE_SECURE === 'true';

  const problems = [];
  if (isProd && !isHttps && !isLoopback(publicUrl.hostname)) {
    problems.push('PUBLIC_URL must use https:// in production unless it is a loopback address.');
  }
  if (!isValidTimezone(e.DEFAULT_TIMEZONE)) problems.push(`DEFAULT_TIMEZONE "${e.DEFAULT_TIMEZONE}" is not a valid IANA timezone.`);
  if (e.PUBLIC_MEDIA_BASE_URL && !e.PUBLIC_MEDIA_BASE_URL.startsWith('https://')) {
    problems.push('PUBLIC_MEDIA_BASE_URL must be an https:// URL.');
  }
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  const trustProxy = e.TRUST_PROXY === 'true' ? true : e.TRUST_PROXY === 'false' ? false : /^\d+$/.test(e.TRUST_PROXY) ? Number(e.TRUST_PROXY) : e.TRUST_PROXY;

  return Object.freeze({
    env: e.NODE_ENV,
    isProduction: isProd,
    isTest: e.NODE_ENV === 'test',
    appName: e.APP_NAME,
    host: e.HOST,
    port: e.PORT,
    publicUrl: publicUrl.origin,
    allowedOrigins: [publicUrl.origin, ...e.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)],
    trustProxy,
    cookieSecure,
    mongodbUri: e.MONGODB_URI,
    redisUrl: e.REDIS_URL,
    encryptionKey: key,
    previousEncryptionKeys: previousKeys,
    owner: e.OWNER_EMAIL && e.OWNER_PASSWORD ? { email: e.OWNER_EMAIL.toLowerCase(), password: e.OWNER_PASSWORD, displayName: e.OWNER_NAME || null } : null,
    friendAccessEnabled: e.ENABLE_FRIEND_ACCESS,
    session: { maxAgeMs: e.SESSION_MAX_AGE_HOURS * 3_600_000, idleMs: e.SESSION_IDLE_HOURS * 3_600_000 },
    media: {
      dir: path.resolve(cwd, e.MEDIA_DIR),
      maxImageBytes: e.MAX_IMAGE_MB * 1024 * 1024,
      maxVideoBytes: e.MAX_VIDEO_MB * 1024 * 1024,
      publicBaseUrl: e.PUBLIC_MEDIA_BASE_URL ? e.PUBLIC_MEDIA_BASE_URL.replace(/\/+$/, '') : null,
      publicUrlTtlSeconds: e.PUBLIC_MEDIA_URL_TTL_SECONDS,
    },
    logLevel: e.LOG_LEVEL,
    publish: {
      maxAttempts: e.PUBLISH_MAX_ATTEMPTS,
      retryBaseMs: e.PUBLISH_RETRY_BASE_SECONDS * 1000,
      retryMaxMs: e.PUBLISH_RETRY_MAX_SECONDS * 1000,
      workerConcurrency: e.WORKER_CONCURRENCY,
      staleJobMs: e.STALE_JOB_SECONDS * 1000,
    },
    defaultTimezone: e.DEFAULT_TIMEZONE,
    enableMockPlatform: e.ENABLE_MOCK_PLATFORM,
    allowPrivateNetworkTargets: e.ALLOW_PRIVATE_NETWORK_TARGETS,
    blueskyScope: e.BLUESKY_OAUTH_SCOPE || null,
  });
}

function decodeKey(value) {
  const buf = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (buf.length !== 32) {
    throw new Error('Invalid configuration:\n  - ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters or base64). Generate one with `npm run setup:env`.');
  }
  return buf;
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
