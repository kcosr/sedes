import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundledAgentToolCliDirectory,
  managedSshAgentToolCliAvailability,
  resolveLocalAgentToolCliAvailability,
} from "../../src/server/runtime/agent-tool-cli-availability.js";

describe("agent tool CLI availability", () => {
  it("resolves source and compiled modules to the build-owned provider bin", () => {
    const repository = path.resolve("/tmp/sedes-agent-tools-test");
    expect(
      bundledAgentToolCliDirectory(
        new URL(`file://${repository}/src/server/runtime/module.ts`).href,
      ),
    ).toBe(path.join(repository, "dist/cli/provider-bin"));
    expect(
      bundledAgentToolCliDirectory(
        new URL(`file://${repository}/dist/server/runtime/module.js`).href,
      ),
    ).toBe(path.join(repository, "dist/cli/provider-bin"));
  });

  it("fails closed until the exact Sedes executable exists and is executable", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "sedes-agent-tool-cli-"),
    );
    try {
      const input = {
        endpoint: "http://127.0.0.1:4784",
        inheritedPath: "/usr/bin",
        executableDirectory: directory,
      };
      await expect(
        resolveLocalAgentToolCliAvailability(input),
      ).resolves.toEqual({
        availability: "unavailable",
        reason: "cli_unavailable",
      });

      const executable = path.join(directory, "sedes");
      await writeFile(executable, "#!/bin/sh\n", { mode: 0o644 });
      await expect(
        resolveLocalAgentToolCliAvailability(input),
      ).resolves.toEqual({
        availability: "unavailable",
        reason: "cli_unavailable",
      });

      await chmod(executable, 0o755);
      await expect(
        resolveLocalAgentToolCliAvailability(input),
      ).resolves.toEqual({
        availability: "available",
        endpoint: input.endpoint,
        executableDirectory: directory,
        inheritedPath: input.inheritedPath,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adapts one verified managed-sidecar lease and releases it idempotently", async () => {
    let releases = 0;
    const closed = Promise.resolve({ reason: "test" });
    const runtime = {
      acquireAgentTools: async () => ({
        session: {
          closed,
          agentToolCli: {
            endpoint: "unix:///run/user/1000/sedes-agent-tools.sock",
            executableDirectory: "/home/agent/.local/state/sedes/sidecar/bin",
            inheritedPath: "/usr/local/bin:/usr/bin",
          },
        },
        release: () => {
          releases += 1;
        },
      }),
    };
    const availability = managedSshAgentToolCliAvailability({
      scope: { tenantId: "tenant-1", principalId: "principal-1" },
      executionEnvironmentId: "environment-1",
      runtime,
    });
    expect(availability.availability).toBe("managed");
    if (availability.availability !== "managed") throw new Error("unreachable");

    const acquired = await availability.provider.acquire();
    expect(acquired).toMatchObject({
      availability: "available",
      endpoint: "unix:///run/user/1000/sedes-agent-tools.sock",
      executableDirectory: "/home/agent/.local/state/sedes/sidecar/bin",
      inheritedPath: "/usr/local/bin:/usr/bin",
      closed,
    });
    if (acquired.availability !== "available") throw new Error("unreachable");
    acquired.release();
    acquired.release();
    expect(releases).toBe(1);
  });

  it("releases and fails closed when a sidecar lease omits verified CLI metadata", async () => {
    let releases = 0;
    const availability = managedSshAgentToolCliAvailability({
      scope: { tenantId: "tenant-1", principalId: "principal-1" },
      executionEnvironmentId: "environment-1",
      runtime: {
        acquireAgentTools: async () => ({
          session: { closed: Promise.resolve() },
          release: () => {
            releases += 1;
          },
        }),
      },
    });
    if (availability.availability !== "managed") throw new Error("unreachable");

    await expect(availability.provider.acquire()).resolves.toEqual({
      availability: "unavailable",
      reason: "sidecar_unavailable",
    });
    expect(releases).toBe(1);
  });

  it.each([
    {
      endpoint: "http://127.0.0.1:4784",
      executableDirectory: "/home/agent/bin",
      inheritedPath: "/usr/bin",
    },
    {
      endpoint: "unix:///run/user/1000/sedes.sock",
      executableDirectory: "relative/bin",
      inheritedPath: "/usr/bin",
    },
    {
      endpoint: "unix:///run/user/1000/sedes.sock",
      executableDirectory: "/home/agent/bin",
      inheritedPath: "/usr/bin\npoisoned",
    },
  ])("fails closed for invalid managed metadata %#", async (agentToolCli) => {
    let releases = 0;
    const availability = managedSshAgentToolCliAvailability({
      scope: { tenantId: "tenant-1", principalId: "principal-1" },
      executionEnvironmentId: "environment-1",
      runtime: {
        acquireAgentTools: async () => ({
          session: { closed: Promise.resolve(), agentToolCli },
          release: () => {
            releases += 1;
          },
        }),
      },
    });
    if (availability.availability !== "managed") throw new Error("unreachable");
    await expect(availability.provider.acquire()).resolves.toEqual({
      availability: "unavailable",
      reason: "sidecar_unavailable",
    });
    expect(releases).toBe(1);
  });
});
