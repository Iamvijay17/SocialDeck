import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod;

/**
 * Provides a MongoDB server to integration tests. In CI an external server can be used by setting
 * TEST_MONGODB_URI (e.g. a service container); otherwise an ephemeral in-memory mongod is started.
 */
export async function setup() {
  if (process.env.TEST_MONGODB_URI) return;
  mongod = await MongoMemoryServer.create();
  process.env.TEST_MONGODB_URI = mongod.getUri();
}

export async function teardown() {
  await mongod?.stop();
}
