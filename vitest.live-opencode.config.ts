import { defineConfig } from "vitest/config";

// Authenticated inference is a separate explicit opt-in, never part of test:real-opencode.
export default defineConfig({
  test: {
    environment: "node", include: ["tests/live-opencode/**/*.test.ts"],
    // The runner's 45-second budget includes setup. Allow independent bounded
    // startup settlement and owned-process cleanup after caller cancellation.
    testTimeout: 180_000, hookTimeout: 45_000,
    pool: "forks", fileParallelism: false, maxWorkers: 1, retry: 0,
  },
});
