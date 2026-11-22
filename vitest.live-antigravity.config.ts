import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["tests/live-antigravity/**/*.test.ts"],
  testTimeout: 240_000, hookTimeout: 30_000, pool: "forks", fileParallelism: false, maxWorkers: 1, reporters: ["verbose"] } });
