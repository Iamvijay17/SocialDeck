#!/usr/bin/env node
// Backs up MongoDB (via mongodump inside the compose container) and the media folder into ./backups/<timestamp>/.
// Redis is not backed up: the queue is rebuilt from MongoDB on worker start.
// The .env file / ENCRYPTION_KEY is deliberately NOT copied: store it separately (password manager), otherwise the
// backup would carry both the encrypted tokens and the key that opens them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(root, 'backups', stamp);
fs.mkdirSync(dir, { recursive: true });

const archive = path.join(dir, 'mongo.archive.gz');
console.log('Dumping MongoDB…');
await new Promise((resolve, reject) => {
  const out = fs.createWriteStream(archive);
  const p = spawn('docker', ['compose', 'exec', '-T', 'mongo', 'sh', '-c', 'mongodump --uri="mongodb://root:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/?authSource=admin" --archive --gzip --db=private-social-manager'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.pipe(out);
  p.on('error', reject);
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mongodump failed with exit code ${code}. Is "docker compose up -d mongo" running?`))));
});

const mediaDir = path.join(root, 'data', 'media');
if (fs.existsSync(mediaDir)) {
  console.log('Copying media…');
  fs.cpSync(mediaDir, path.join(dir, 'media'), { recursive: true, filter: (src) => !src.includes(`${path.sep}.tmp`) });
}
fs.writeFileSync(path.join(dir, 'MANIFEST.txt'), `Private Social Manager backup\nCreated: ${new Date().toISOString()}\nContents: mongo.archive.gz, media/\nNot included: .env (keep ENCRYPTION_KEY separately)\n`);
console.log(`Backup written to ${dir}`);
