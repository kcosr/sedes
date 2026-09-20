import { describe, expect, it } from "vitest";
import { sanitizedLocalWorkerEnvironment } from "../../src/server/managed-workers/local-launcher.js";

describe("local managed worker environment", () => {
  it("preserves only registered provider environment authority", () => {
    expect(sanitizedLocalWorkerEnvironment({
      HOME: "/account",
      CLAUDE_CONFIG_DIR: "/account/custom claude",
      ANTHROPIC_API_KEY: "not-admitted",
      NODE_OPTIONS: "--inspect",
    }, ["CLAUDE_CONFIG_DIR"])).toEqual({
      HOME: "/account", CLAUDE_CONFIG_DIR: "/account/custom claude",
    });
    expect(sanitizedLocalWorkerEnvironment({
      HOME: "/account", CLAUDE_CONFIG_DIR: "/other/account\n",
    }, [])).toEqual({ HOME: "/account" });
    expect(sanitizedLocalWorkerEnvironment({ HOME: "/account" }, ["CLAUDE_CONFIG_DIR"]))
      .toEqual({ HOME: "/account" });
  });

  it.each(["/other/account\n", "/other/account\r", "/other/account\0", "x".repeat(4097)])(
    "rejects malformed registered authority instead of selecting a default store (%#)", value => {
      expect(() => sanitizedLocalWorkerEnvironment({ HOME: "/account", CLAUDE_CONFIG_DIR: value }, ["CLAUDE_CONFIG_DIR"]))
        .toThrow("managed_worker_inherited_environment_invalid");
    },
  );

  it("propagates only the exact Electron Node runtime mode", () => {
    expect(
      sanitizedLocalWorkerEnvironment(
        { HOME: "/home/test", ELECTRON_RUN_AS_NODE: "1" },
        [],
      ),
    ).toMatchObject({
      HOME: "/home/test",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(
      sanitizedLocalWorkerEnvironment({ ELECTRON_RUN_AS_NODE: "true" }, [
        "ELECTRON_RUN_AS_NODE",
      ]),
    ).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  });
});
