import { defineConfig } from "vitest/config";

// Real speech server, real Sedes and optional packaged Android. Only model
// inference uses deterministic workers and a loopback model endpoint.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/native-voice/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
