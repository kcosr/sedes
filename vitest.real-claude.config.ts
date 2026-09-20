import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/real-claude/**/*.test.ts"],
    testTimeout: 360_000,
    hookTimeout: 360_000,
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
