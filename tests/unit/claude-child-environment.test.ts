import { describe, expect, it } from "vitest";
import {
  assertClaudeSdkHelperEnvironment,
  captureClaudeChildEnvironment,
  claudeConfigDirectory,
} from "../../src/server/backends/claude/claude-child-environment.js";

describe("Claude child environment", () => {
  it("captures one immutable environment and resolves its provider home", () => {
    const source = {
      HOME: "/operator",
      CLAUDE_CONFIG_DIR: "/operator/.claude-custom",
      LANG: "en_US.UTF-8",
    };
    const captured = captureClaudeChildEnvironment(source);
    source.CLAUDE_CONFIG_DIR = "/changed";

    expect(captured).toEqual({
      HOME: "/operator",
      CLAUDE_CONFIG_DIR: "/operator/.claude-custom",
      LANG: "en_US.UTF-8",
    });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(claudeConfigDirectory(captured)).toBe(
      "/operator/.claude-custom",
    );
  });

  it("fails closed when SDK filesystem helpers would read another store", () => {
    expect(() =>
      assertClaudeSdkHelperEnvironment(
        captureClaudeChildEnvironment(process.env),
      ),
    ).not.toThrow();
    expect(() =>
      assertClaudeSdkHelperEnvironment({
        ...process.env,
        CLAUDE_CONFIG_DIR: "/definitely/not/the/ambient/claude-store",
      }),
    ).toThrow("claude_sdk_helper_environment_mismatch");
  });
});
