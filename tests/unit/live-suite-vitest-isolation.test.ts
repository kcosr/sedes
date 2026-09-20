import { describe, expect, it } from "vitest";
import defaultConfig from "../../vitest.config.js";
import claudeConfig from "../../vitest.real-claude.config.js";
import codexAgentToolsConfig from "../../vitest.real-codex-agent-tools.config.js";
import piCliConfig from "../../vitest.real-pi-cli.config.js";

describe("Vitest live-suite isolation", () => {
  it("keeps provider-backed suites out of the default test command", () => {
    expect(defaultConfig).toMatchObject({
      test: {
        exclude: expect.arrayContaining([
          "tests/real-pi-cli/**",
          "tests/real-codex-agent-tools/**",
          "tests/real-claude/**",
        ]),
      },
    });
  });

  it("keeps each provider-backed suite explicitly reachable by its dedicated config", () => {
    expect(piCliConfig).toMatchObject({
      test: { include: ["tests/real-pi-cli/**/*.test.ts"] },
    });
    expect(codexAgentToolsConfig).toMatchObject({
      test: { include: ["tests/real-codex-agent-tools/**/*.test.ts"] },
    });
    expect(claudeConfig).toMatchObject({
      test: {
        include: ["tests/real-claude/**/*.test.ts"],
        fileParallelism: false,
        maxWorkers: 1,
        testTimeout: 360_000,
        hookTimeout: 360_000,
      },
    });
  });
});
