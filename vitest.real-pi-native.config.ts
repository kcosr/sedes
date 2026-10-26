import { defineConfig } from "vitest/config";

// Stock CLI, private native state, and loopback fixtures only. This is not a
// live-provider suite and must never inherit operator credentials.
export default defineConfig({ test: { environment: "node", include: ["tests/real-pi-native/**/*.test.ts"],
  testTimeout: 60_000, hookTimeout: 30_000, pool: "forks", fileParallelism: false, maxWorkers: 1 } });
