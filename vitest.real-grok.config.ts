import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/real-grok/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
