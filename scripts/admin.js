#!/usr/bin/env node
// Administration CLI. Usage: node scripts/admin.js <command> [options]
//   create-user      --email <e> [--name <n>] [--role friend|member]   (prompts for the password)
//   reset-password   --email <e>                                       (prompts for the new password, ends all sessions)
//   list-users
//   rotate-key                                                         (re-encrypts stored secrets with the current ENCRYPTION_KEY)
//   cleanup-media    [--hours 1]                                       (removes files on disk unknown to the database)
//   grant            --email <e> --account <accountId>                 (friend access: allow publishing to an account)
//   revoke           --email <e> --account <accountId>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { KeyValue, SocialAccount, User, createContext, createLogger, createMemoryQueue, loadConfig } from '@osh/server-core';

const root = path.resolve(import.meta.dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const [command, ...rest] = process.argv.slice(2);
const opts = Object.fromEntries(
  rest.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true]] : [])),
);

function promptHidden(question) {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
    process.stdout.write(question);
  });
}

async function readPassword() {
  const a = await promptHidden('Password (min 12 characters): ');
  const b = await promptHidden('Repeat password: ');
  if (a !== b) throw new Error('Passwords do not match.');
  return a;
}

const commands = {
  async 'create-user'({ services }) {
    if (!opts.email) throw new Error('--email is required');
    const role = opts.role ?? 'friend';
    if (!['friend', 'member'].includes(role)) throw new Error('--role must be friend or member (the owner is created from .env)');
    if (role === 'friend' && !config.friendAccessEnabled) throw new Error('Set ENABLE_FRIEND_ACCESS=true in .env first (see docs/friend-access.md).');
    const user = await services.auth.createUser({ email: String(opts.email).toLowerCase(), displayName: opts.name, password: await readPassword(), role });
    console.log(`Created ${role} ${user.email}. They have no access to any social account until you run: grant --email ${user.email} --account <id>`);
  },

  async 'reset-password'({ services }) {
    if (!opts.email) throw new Error('--email is required');
    await services.auth.setPassword(opts.email, await readPassword());
    console.log('Password changed and all sessions for that user were ended.');
  },

  async 'list-users'() {
    for (const u of await User.find().sort({ createdAt: 1 })) console.log(`${u.role.padEnd(7)} ${u.email}  (${u.id})`);
  },

  async 'rotate-key'({ cipher }) {
    let accounts = 0;
    let kv = 0;
    for (const a of await SocialAccount.find().select('+credentials')) {
      if (!cipher.needsRotation(a.credentials)) continue;
      a.credentials = cipher.encryptJson(cipher.decryptJson(a.credentials, 'social-account-credentials'), 'social-account-credentials');
      await a.save();
      accounts++;
    }
    for (const doc of await KeyValue.find()) {
      if (!cipher.needsRotation(doc.value)) continue;
      doc.value = cipher.encryptJson(cipher.decryptJson(doc.value, doc.key), doc.key);
      await doc.save();
      kv++;
    }
    console.log(`Re-encrypted ${accounts} account credential(s) and ${kv} stored session(s) with key ${cipher.currentKeyId}. You may now remove ENCRYPTION_KEY_PREVIOUS.`);
  },

  async 'cleanup-media'({ services }) {
    const hours = Number(opts.hours ?? 1);
    console.log(await services.media.cleanupOrphans({ olderThanMs: hours * 3_600_000 }));
  },

  async grant({ services }) {
    console.log(await services.accounts.setGrant(opts.email, opts.account, true));
  },
  async revoke({ services }) {
    console.log(await services.accounts.setGrant(opts.email, opts.account, false));
  },
};

if (!commands[command]) {
  console.error(`Unknown command "${command ?? ''}". Available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

let config;
try {
  config = loadConfig(process.env, { cwd: root });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const ctx = await createContext(config, { logger: createLogger({ level: 'warn' }), queue: createMemoryQueue() });
try {
  await commands[command](ctx);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await ctx.close();
}
