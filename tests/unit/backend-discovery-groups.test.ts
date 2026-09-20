import { describe, expect, it } from "vitest";
import type { AgentConnectionProfile } from "../../src/server/backends/contracts.js";
import { groupBackendDiscoveryProfiles } from "../../src/server/runtime/backend-discovery-groups.js";

function profile(
  id: string,
  backendInstanceId: string,
  executionEnvironmentId = "environment-1",
): AgentConnectionProfile {
  return {
    id,
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
    templateId: `${id}-template`,
    kind:
      backendInstanceId === "pi" ? "pi_sdk" : "codex_app_server",
    backendInstanceId,
    executionEnvironmentId,
    label: id,
    enabled: true,
    configurationRevision: 0,
  };
}

describe("groupBackendDiscoveryProfiles", () => {
  it("deduplicates a namespace and prefers its configured default", () => {
    const first = profile("first", "pi");
    const selected = profile("selected", "pi");

    expect(
      groupBackendDiscoveryProfiles([
        {
          profile: first,
          nativeNamespaceKey: "shared",
          isDefault: false,
        },
        {
          profile: selected,
          nativeNamespaceKey: "shared",
          isDefault: true,
        },
      ]),
    ).toEqual([
      {
        profile: selected,
        connectionProfileIds: ["first", "selected"],
      },
    ]);
  });

  it("keeps identical native IDs isolated by backend and environment namespace", () => {
    const localPi = profile("pi-local", "pi");
    const remotePi = profile("pi-remote", "pi", "environment-2");
    const codex = profile("codex-local", "codex");

    const groups = groupBackendDiscoveryProfiles(
      [localPi, remotePi, codex].map((candidate) => ({
        profile: candidate,
        nativeNamespaceKey: "same-native-namespace-label",
        isDefault: false,
      })),
    );

    expect(groups).toHaveLength(3);
    expect(
      groups.map(({ connectionProfileIds }) => connectionProfileIds),
    ).toEqual([["codex-local"], ["pi-local"], ["pi-remote"]]);
  });
});
