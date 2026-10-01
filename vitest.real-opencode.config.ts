import { defineConfig } from "vitest/config";

// Native binary, isolated state and loopback model/MCP fixtures only. This is
// separate from the ordinary suite and never uses paid/authenticated inference.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/real-opencode/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 45_000,
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
