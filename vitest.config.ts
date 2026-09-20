import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@client": path.resolve(rootDirectory, "src/client"),
      "@shared": path.resolve(rootDirectory, "src/shared"),
    },
  },
  test: {
    environment: "node",
    maxWorkers: 8,
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx,mjs}"],
    exclude: [
      "tests/e2e/**",
      "tests/real-pi/**",
      "tests/real-pi-cli/**",
      "tests/real-codex-agent-tools/**",
      "tests/real-claude/**",
      "tests/real-grok/**",
      "**/node_modules/**",
      "dist/**",
    ],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
