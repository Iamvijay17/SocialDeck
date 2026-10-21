import { createContext, createLogger, loadConfig } from '@osh/server-core';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  // Fail fast with a readable message; no logger exists yet.
  console.error(err.message);
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, name: 'osh-api' });
const ctx = await createContext(config, { logger });
const app = createApp(ctx);

// Environment-based initial setup: there is no public registration or setup page.
const ownerState = await ctx.services.auth.ensureOwner();
if (ownerState === 'not_configured') {
  logger.warn('No users exist yet. Set OWNER_EMAIL and OWNER_PASSWORD in .env and restart, or run: npm run create-user -- --owner');
}

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, publicUrl: config.publicUrl, env: config.env }, 'api listening');
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  server.close(async () => {
    try {
      await ctx.close();
    } finally {
      process.exit(0);
    }
  });
  server.closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
