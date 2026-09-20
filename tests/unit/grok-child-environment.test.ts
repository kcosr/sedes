import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildGrokChildEnvironment,
  grokOwnedStdioArguments,
} from "../../src/server/backends/grok/grok-child-environment.js";

describe("Grok child process policy scaffold", () => {
  it("preserves native Grok homes while omitting unrelated ambient authority", () => {
    const environment = buildGrokChildEnvironment({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      HOME: "/home/operator",
      GROK_HOME: "/home/operator/.local/grok",
      XAI_API_KEY: "secret-xai",
      SEDES_ADMIN_TOKEN: "secret-sedes",
      GROK_PLUGIN_PATH: "/ambient/plugins",
      CLAUDE_CONFIG_DIR: "/ambient/claude",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      HOME: "/home/operator",
      GROK_HOME: "/home/operator/.local/grok",
      NO_COLOR: "1",
      TERM: "dumb",
      GROK_OAUTH2_REFERRER: "sedes",
    });
  });

  it("does not invent GROK_HOME when the native installation uses HOME", () => {
    expect(
      buildGrokChildEnvironment({ HOME: "/home/operator", PATH: "/bin" }),
    ).toMatchObject({ HOME: "/home/operator", PATH: "/bin" });
    expect(
      buildGrokChildEnvironment({ HOME: "/home/operator", PATH: "/bin" }),
    ).not.toHaveProperty("GROK_HOME");
  });

  it("uses the operating-system home when the launch environment omits HOME", () => {
    expect(buildGrokChildEnvironment({ PATH: "/bin" }).HOME).toBe(os.homedir());
  });

  it("keeps production Grok source independent from probe homes and credential files", async () => {
    const directory = fileURLToPath(
      new URL("../../src/server/backends/grok/", import.meta.url),
    );
    const source = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith(".ts"))
        .map(async (name) => await readFile(`${directory}/${name}`, "utf8")),
    );
    expect(source.join("\n")).not.toMatch(/scripts\/grok-probes|auth\.json/u);
  });

  it("owns the exact no-update/no-leader stdio argv", () => {
    expect(grokOwnedStdioArguments({ sandboxProfile: "off" })).toEqual([
      "--no-auto-update",
      "--permission-mode",
      "bypassPermissions",
      "--sandbox",
      "off",
      "agent",
      "--no-leader",
      "stdio",
    ]);
  });
});
