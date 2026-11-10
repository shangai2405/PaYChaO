import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/server.ts', 'src/migrate.ts'], thresholds: { lines: 80 } },
  },
});
