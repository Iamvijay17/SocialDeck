#!/usr/bin/env node
// Prints the public address of the Cloudflare quick tunnel started with `docker compose --profile tunnel up -d`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const r = spawnSync('docker', ['compose', '--profile', 'tunnel', 'logs', 'cloudflared', '--no-log-prefix', '--tail', '200'], { cwd: root, encoding: 'utf8' });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const urls = [...out.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)].map((m) => m[0]);
if (!urls.length) {
  console.error('No tunnel address found yet. Start it with: docker compose --profile tunnel up -d   (then wait a few seconds and retry)');
  process.exit(1);
}
const url = urls.at(-1);
console.log(`${url}

Paste this into the dashboard: Settings -> Public media address -> Save -> Test.
It changes every time the tunnel restarts, and only serves signed links to individual media files.`);
