import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  remotePiNativeStoreNamespace,
  resolveRemotePiStorage,
} from "../../src/server/backends/pi/pi-storage.js";

describe("remote Pi native session storage", () => {
  it("derives a bounded deterministic main-host namespace from backend and environment identities", () => {
    const first = remotePiNativeStoreNamespace({
      backendInstanceId: "pi-remote",
      executionEnvironmentId: "11111111-1111-4111-8111-111111111111",
    });
    const repeated = remotePiNativeStoreNamespace({
      backendInstanceId: "pi-remote",
      executionEnvironmentId: "11111111-1111-4111-8111-111111111111",
    });
    const otherEnvironment = remotePiNativeStoreNamespace({
      backendInstanceId: "pi-remote",
      executionEnvironmentId: "22222222-2222-4222-8222-222222222222",
    });
    const otherBackend = remotePiNativeStoreNamespace({
      backendInstanceId: "pi-other",
      executionEnvironmentId: "11111111-1111-4111-8111-111111111111",
    });
    const delimiterBoundaryA = remotePiNativeStoreNamespace({
      backendInstanceId: "a",
      executionEnvironmentId: "bc",
    });
    const delimiterBoundaryB = remotePiNativeStoreNamespace({
      backendInstanceId: "ab",
      executionEnvironmentId: "c",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(repeated).toBe(first);
    expect(otherEnvironment).not.toBe(first);
    expect(otherBackend).not.toBe(first);
    expect(delimiterBoundaryA).not.toBe(delimiterBoundaryB);
  });

  it("keeps remote paths and local Pi session overrides out of the installation-owned pathname", () => {
    const stateDirectory = path.resolve("/var/lib/sedes-state");
    const storage = resolveRemotePiStorage(
      {
        installationStateDirectory: stateDirectory,
        backendInstanceId: "pi-remote",
        executionEnvironmentId: "11111111-1111-4111-8111-111111111111",
      },
      {
        PI_CODING_AGENT_DIR: "/var/lib/pi-agent",
        PI_CODING_AGENT_SESSION_DIR: "/remote-looking/project/sessions",
      },
    );

    expect(storage.agentDir).toBe("/var/lib/pi-agent");
    expect(storage.sessionDirectory).toMatch(
      /^\/var\/lib\/sedes-state\/remote-pi-native-sessions\/v1\/[a-f0-9]{64}\/sessions$/u,
    );
    expect(storage.sessionDirectory).not.toContain("remote-looking");
    expect(storage.sessionDirectoryOverride).toBe(storage.sessionDirectory);
  });
});
