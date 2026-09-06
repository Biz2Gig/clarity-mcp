import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    // Integration suites share one database; run files sequentially so a
    // `resetDb()` in one file cannot truncate tables mid-test in another.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
