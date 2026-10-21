#!/usr/bin/env node
// Creates .env from .env.example with freshly generated secrets. Never overwrites an existing .env.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, '.env');
if (fs.existsSync(target)) {
  console.log('.env already exists - leaving it untouched.');
  process.exit(0);
}

const email = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'owner@example.com';
const password = randomBytes(15).toString('base64url');
const set = (text, key, value) => text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
let env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
env = set(env, 'ENCRYPTION_KEY', randomBytes(32).toString('hex'));
env = set(env, 'MEDIA_SIGNING_KEY', randomBytes(32).toString('hex'));
env = set(env, 'OAUTH_REDIRECT_BASE_URL', 'http://localhost:5173');
env = set(env, 'MONGO_PASSWORD', randomBytes(18).toString('hex'));
env = set(env, 'REDIS_PASSWORD', randomBytes(18).toString('hex'));
env = set(env, 'ENABLE_MOCK_PLATFORM', process.argv.includes('--demo') ? 'true' : 'false');
env = set(env, 'OWNER_EMAIL', email);
env = set(env, 'OWNER_PASSWORD', password);
fs.writeFileSync(target, env, { mode: 0o600 });

console.log(`Created .env with a new ENCRYPTION_KEY.

  Owner login   ${email}
  Password      ${password}

Save the password somewhere safe, start the app once, then delete the OWNER_PASSWORD line from .env.
Back up ENCRYPTION_KEY too: without it stored social connections cannot be decrypted.`);
