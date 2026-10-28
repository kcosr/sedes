import { defineConfig } from "vitest/config";

// Opt-in cross-repository check: real speech API and supervised deterministic
// workers, without Electron, OpenCode, microphone hardware, or live providers.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/native-voice/electron-speech.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
