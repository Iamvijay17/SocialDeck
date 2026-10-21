#!/usr/bin/env node
// Optional: a real (persistent) MongoDB for development without Docker, using the mongod binary that
// mongodb-memory-server downloads. Data lives in ./data/mongo-dev. For anything beyond development use the
// MongoDB container from docker-compose.yml.
import fs from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const dbPath = path.resolve(import.meta.dirname, '../data/mongo-dev');
fs.mkdirSync(dbPath, { recursive: true });
const mongod = await MongoMemoryServer.create({ instance: { port: 27017, ip: '127.0.0.1', dbPath, storageEngine: 'wiredTiger' } });
console.log(`MongoDB running at ${mongod.getUri()} (data: ${dbPath}). Press Ctrl+C to stop.`);

const stop = async () => {
  await mongod.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
