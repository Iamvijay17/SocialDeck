import http from 'node:http';
import path from 'node:path';
import { createGatewayHandler } from './handler.js';

const host = process.env.GATEWAY_HOST ?? '127.0.0.1';
const port = Number(process.env.GATEWAY_PORT ?? 4100);
const mediaDir = process.env.MEDIA_DIR;
const keyHex = process.env.MEDIA_SIGNING_KEY ?? '';

if (!mediaDir) {
  console.error('MEDIA_DIR is required.');
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
  console.error('MEDIA_SIGNING_KEY must be 64 hex characters (run `npm run setup:env`, or add one to .env).');
  process.exit(1);
}

const log = (level, msg, extra = {}) => process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), name: 'media-gateway', msg, ...extra })}\n`);
const handler = createGatewayHandler({
  mediaDir: path.resolve(mediaDir),
  signingKey: Buffer.from(keyHex, 'hex'),
  logger: { error: (extra, msg) => log('error', msg, extra) },
});

const server = http.createServer(handler);
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.listen(port, host, () => log('info', 'media gateway listening', { host, port }));

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
