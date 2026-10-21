import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.js', 'apps/api/**/*.test.js', 'apps/worker/**/*.test.js', 'tests/integration/**/*.test.js'],
    exclude: ['**/node_modules/**', 'tests/e2e/**', 'apps/web/**'],
    globalSetup: ['./tests/helpers/global-setup.js'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one MongoDB server but each file uses its own database.
    pool: 'forks',
    fileParallelism: true,
  },
});
