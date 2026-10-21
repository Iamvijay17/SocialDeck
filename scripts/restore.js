#!/usr/bin/env node
// Restores a backup made by scripts/backup.js:  node scripts/restore.js backups/<timestamp> --yes
// REPLACES the current database contents and media files. Requires the same ENCRYPTION_KEY that was in use at backup time.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const [src, flag] = process.argv.slice(2);
if (!src || flag !== '--yes') {
  console.error('Usage: node scripts/restore.js <backup-folder> --yes\nThis REPLACES the current database and media.');
  process.exit(1);
}
const dir = path.resolve(root, src);
const archive = path.join(dir, 'mongo.archive.gz');
if (!fs.existsSync(archive)) {
  console.error(`No mongo.archive.gz in ${dir}`);
  process.exit(1);
}

console.log('Restoring MongoDB (existing collections are dropped)…');
await new Promise((resolve, reject) => {
  const p = spawn('docker', ['compose', 'exec', '-T', 'mongo', 'sh', '-c', 'mongorestore --uri="mongodb://root:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/?authSource=admin" --archive --gzip --drop --nsInclude="private-social-manager.*"'], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
  fs.createReadStream(archive).pipe(p.stdin);
  p.on('error', reject);
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mongorestore failed with exit code ${code}`))));
});

const media = path.join(dir, 'media');
if (fs.existsSync(media)) {
  console.log('Restoring media…');
  const target = path.join(root, 'data', 'media');
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(media, target, { recursive: true });
}
console.log('Done. Restart the stack: docker compose restart api worker');
