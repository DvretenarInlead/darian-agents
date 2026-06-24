import { defineConfig } from 'vitest/config';

// Integration suite: real Postgres. Run with `pnpm test:integration` and
// INTEGRATION_DATABASE_URL set. Kept separate from the default unit run so
// `pnpm test` stays fast and DB-free.
export default defineConfig({
  test: {
    include: ['src/**/*.itest.ts'],
    environment: 'node',
    globals: false,
    // DB tests share a schema; run them serially to avoid cross-test races.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
