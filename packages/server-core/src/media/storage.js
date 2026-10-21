import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const KEY_RE = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

/**
 * Local filesystem media storage. Storage keys are generated here (never from user input) and every path is
 * resolved and verified to stay inside the media root, which defends against path traversal even if a key
 * stored in the database were tampered with.
 */
export function createMediaStorage({ dir }) {
  const root = path.resolve(dir);
  const tmpDir = path.join(root, '.tmp');

  function absolutePath(key) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error('Invalid storage key');
    const abs = path.resolve(root, key);
    if (!abs.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return abs;
  }

  return {
    root,
    tmpDir,
    async ensure() {
      await fsp.mkdir(tmpDir, { recursive: true });
    },
    newKey(ext, now = new Date()) {
      const yyyy = String(now.getUTCFullYear());
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      return `${yyyy}/${mm}/${randomUUID()}.${ext}`;
    },
    absolutePath,
    /** Atomically move a validated temp file into place. */
    async commit(tmpPath, key) {
      const abs = absolutePath(key);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.rename(tmpPath, abs);
    },
    async remove(key) {
      try {
        await fsp.unlink(absolutePath(key));
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    },
    createReadStream(key, range) {
      return fs.createReadStream(absolutePath(key), range);
    },
    async blob(key, type) {
      return fs.openAsBlob(absolutePath(key), { type });
    },
    async exists(key) {
      try {
        await fsp.access(absolutePath(key));
        return true;
      } catch {
        return false;
      }
    },
    /** Free/total bytes of the volume holding the media directory (best effort). */
    async diskSpace() {
      try {
        const s = await fsp.statfs(root);
        return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
      } catch {
        return null;
      }
    },
    /** All stored files (relative keys) with mtime, excluding the temp directory. */
    async listFiles() {
      const out = [];
      async function walk(current) {
        let entries;
        try {
          entries = await fsp.readdir(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const abs = path.join(current, e.name);
          if (abs === tmpDir) continue;
          if (e.isDirectory()) await walk(abs);
          else if (e.isFile()) {
            const st = await fsp.stat(abs);
            out.push({ key: path.relative(root, abs).split(path.sep).join('/'), mtimeMs: st.mtimeMs, size: st.size });
          }
        }
      }
      await walk(root);
      return out;
    },
    async listTempFiles() {
      try {
        const names = await fsp.readdir(tmpDir);
        return Promise.all(
          names.map(async (name) => {
            const abs = path.join(tmpDir, name);
            const st = await fsp.stat(abs);
            return { path: abs, mtimeMs: st.mtimeMs };
          }),
        );
      } catch {
        return [];
      }
    },
  };
}
