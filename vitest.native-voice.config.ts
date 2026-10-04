import { defineConfig } from "vitest/config";

// Real adapter, real Sedes and optional packaged Android. Only external model,
// ASR and TTS boundaries are deterministic loopback fixtures.
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
