import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/real-codex-agent-tools/**/*.test.ts"],
    testTimeout: 420_000,
    hookTimeout: 420_000,
    pool: "forks",
    maxWorkers: 1,
  },
});
