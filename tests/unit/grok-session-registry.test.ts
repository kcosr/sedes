import { describe, expect, it } from "vitest";
import { GrokSessionRegistry } from "../../src/server/backends/grok/grok-session-registry.js";
import type { ProviderTransportScope } from "../../src/server/provider-protocol/transport/assured-framed-transport.js";

const scope: ProviderTransportScope = Object.freeze({
  tenantId: "tenant-grok",
  principalId: "principal-grok",
  backendInstanceId: "backend-grok",
  executionEnvironmentId: "environment-grok",
});

function route(overrides: Partial<ReturnType<typeof baseRoute>> = {}) {
  return { ...baseRoute(), ...overrides };
}

function baseRoute() {
  return {
    scope,
    nativeNamespaceKey: "grok-store:tenant-principal",
    workspace: "/workspace/grok",
    connectionGeneration: 1,
    processOwnerId: "process-1",
    sessionId: "session-1",
  };
}

describe("Grok provider-private session registry", () => {
  it("authorizes replay on the provisional route before load responds", () => {
    const registry = new GrokSessionRegistry();
    const claim = registry.beginLoad(route());

    expect(registry.authorizeNotification(route())).toBe(true);
    expect(registry.state(route())).toMatchObject({
      residency: "provisional_load",
    });
    expect(registry.confirmLoad(claim)).toMatchObject({
      residency: "resident",
    });
    expect(registry.requireResident(route())).toMatchObject({
      residency: "resident",
    });
  });

  it("enforces one exact owner and rejects stale scope, workspace, generation, and process", () => {
    const registry = new GrokSessionRegistry();
    registry.confirmLoad(registry.beginLoad(route()));

    expect(() => registry.beginLoad(route())).toThrow(
      "grok_session_active_owner_exists",
    );
    expect(() =>
      registry.beginLoad(
        route({ workspace: "/workspace/other", connectionGeneration: 2 }),
      ),
    ).toThrow("grok_process_session_cardinality_exceeded");
    const otherPrincipal = route({
      scope: { ...scope, principalId: "other" },
      connectionGeneration: 2,
      processOwnerId: "other-principal-process",
    });
    expect(
      registry.confirmLoad(registry.beginLoad(otherPrincipal)),
    ).toMatchObject({ residency: "resident" });
    expect(() =>
      registry.beginLoad(
        route({ processOwnerId: "process-2", connectionGeneration: 2 }),
      ),
    ).toThrow("grok_session_active_owner_exists");
    expect(
      registry.authorizeNotification(
        route({ scope: { ...scope, principalId: "other" } }),
      ),
    ).toBe(false);
    expect(
      registry.authorizeNotification(route({ workspace: "/workspace/other" })),
    ).toBe(false);
    expect(
      registry.authorizeNotification(route({ connectionGeneration: 2 })),
    ).toBe(false);
    expect(
      registry.authorizeNotification(route({ processOwnerId: "process-2" })),
    ).toBe(false);
    expect(() =>
      registry.beginLoad(
        route({
          sessionId: "session-2",
          connectionGeneration: 2,
        }),
      ),
    ).toThrow("grok_process_session_cardinality_exceeded");

    registry.markSessionDormant(route());
    registry.confirmLoad(registry.beginLoad(route()));
    registry.markSessionDormant(route());
    const next = route({
      connectionGeneration: 2,
      processOwnerId: "process-2",
    });
    registry.confirmLoad(registry.beginLoad(next));
    expect(registry.requireResident(next)).toMatchObject({
      residency: "resident",
    });
  });

  it("fences every session in a failed process generation without touching another owner", () => {
    const registry = new GrokSessionRegistry();
    registry.confirmLoad(registry.beginLoad(route()));
    const other = route({
      sessionId: "session-2",
      processOwnerId: "process-2",
    });
    registry.confirmLoad(registry.beginLoad(other));
    const otherNamespace = route({
      nativeNamespaceKey: "grok-store:other",
      processOwnerId: "process-3",
    });
    registry.confirmLoad(registry.beginLoad(otherNamespace));

    const fenced = registry.fenceGeneration({
      scope,
      nativeNamespaceKey: "grok-store:tenant-principal",
      workspace: "/workspace/grok",
      connectionGeneration: 1,
      processOwnerId: "process-1",
    });
    expect(fenced.map(({ sessionId }) => sessionId)).toEqual(["session-1"]);
    expect(registry.authorizeNotification(route())).toBe(false);
    expect(() => registry.beginLoad(route())).toThrow(
      "grok_session_generation_stale",
    );
    expect(() => registry.requireResident(route())).toThrow(
      "grok_session_owner_mismatch",
    );
    expect(registry.requireResident(other)).toMatchObject({
      residency: "resident",
    });
    expect(registry.requireResident(otherNamespace)).toMatchObject({
      residency: "resident",
    });
  });

  it("does not let one owned process span native authority domains", () => {
    const registry = new GrokSessionRegistry();
    registry.confirmLoad(registry.beginLoad(route()));
    expect(() =>
      registry.beginLoad(
        route({
          nativeNamespaceKey: "grok-store:other",
          sessionId: "session-other",
        }),
      ),
    ).toThrow("grok_process_session_cardinality_exceeded");
    expect(() =>
      registry.beginLoad(route({ nativeNamespaceKey: "grok-store:other" })),
    ).toThrow("grok_process_session_cardinality_exceeded");
  });

  it("does not forget a process owner binding when its route changes generation", () => {
    const registry = new GrokSessionRegistry();
    registry.confirmLoad(registry.beginLoad(route()));
    registry.markSessionDormant(route());
    const replacement = route({
      connectionGeneration: 2,
      processOwnerId: "process-2",
    });
    registry.confirmLoad(registry.beginLoad(replacement));
    expect(() =>
      registry.beginLoad(
        route({
          nativeNamespaceKey: "grok-store:other",
          sessionId: "session-other",
          connectionGeneration: 2,
        }),
      ),
    ).toThrow("grok_process_session_cardinality_exceeded");
  });

  it("retires only the released process generation and permits reattach", () => {
    const registry = new GrokSessionRegistry();
    const owned = route();
    const unrelated = route({
      sessionId: "session-other",
      processOwnerId: "process-other",
    });
    registry.confirmLoad(registry.beginLoad(owned));
    registry.markSessionDormant(owned);
    registry.confirmLoad(registry.beginLoad(unrelated));

    registry.releaseProcessOwner({
      scope: owned.scope,
      nativeNamespaceKey: owned.nativeNamespaceKey,
      workspace: owned.workspace,
      connectionGeneration: owned.connectionGeneration,
      processOwnerId: owned.processOwnerId,
    });

    expect(registry.state(owned)).toBeUndefined();
    expect(registry.authorizeNotification(owned)).toBe(false);
    expect(() => registry.requireResident(owned)).toThrow(
      "grok_session_owner_mismatch",
    );
    expect(registry.requireResident(unrelated)).toMatchObject({
      residency: "resident",
    });

    const replacement = route({ connectionGeneration: 2 });
    registry.confirmLoad(registry.beginLoad(replacement));
    registry.releaseProcessOwner({
      scope: owned.scope,
      nativeNamespaceKey: owned.nativeNamespaceKey,
      workspace: owned.workspace,
      connectionGeneration: owned.connectionGeneration,
      processOwnerId: owned.processOwnerId,
    });
    expect(registry.requireResident(replacement)).toMatchObject({
      residency: "resident",
    });
    expect(registry.requireResident(unrelated)).toMatchObject({
      residency: "resident",
    });
  });

  it("atomically reserves provider-assigned creation for one process owner", () => {
    const registry = new GrokSessionRegistry();
    const owner = baseRoute();
    const first = registry.beginCreate({
      scope: owner.scope,
      nativeNamespaceKey: owner.nativeNamespaceKey,
      workspace: owner.workspace,
      connectionGeneration: owner.connectionGeneration,
      processOwnerId: owner.processOwnerId,
    });
    expect(() =>
      registry.beginCreate({
        scope: owner.scope,
        nativeNamespaceKey: owner.nativeNamespaceKey,
        workspace: owner.workspace,
        connectionGeneration: owner.connectionGeneration,
        processOwnerId: owner.processOwnerId,
      }),
    ).toThrow("grok_process_session_cardinality_exceeded");
    registry.cancelCreate(first);
    const second = registry.beginCreate({
      scope: owner.scope,
      nativeNamespaceKey: owner.nativeNamespaceKey,
      workspace: owner.workspace,
      connectionGeneration: owner.connectionGeneration,
      processOwnerId: owner.processOwnerId,
    });
    const provisional = registry.confirmCreate(second, "provider-assigned");
    expect(registry.confirmLoad(provisional)).toMatchObject({
      sessionId: "provider-assigned",
      residency: "resident",
    });
  });

  it("fences dormant sessions when their owned process generation dies", () => {
    const registry = new GrokSessionRegistry();
    registry.confirmLoad(registry.beginLoad(route()));
    registry.markSessionDormant(route());
    expect(
      registry.fenceGeneration({
        scope,
        nativeNamespaceKey: route().nativeNamespaceKey,
        workspace: route().workspace,
        connectionGeneration: 1,
        processOwnerId: route().processOwnerId,
      }),
    ).toMatchObject([{ residency: "lost" }]);
    expect(() => registry.beginLoad(route())).toThrow(
      "grok_session_generation_stale",
    );
  });

  it("does not couple viewer detach or failed load to provider close", () => {
    const registry = new GrokSessionRegistry();
    const claim = registry.beginLoad(route());
    registry.failLoad(claim);
    expect(registry.state(route())).toMatchObject({ residency: "dormant" });
    registry.confirmLoad(registry.beginLoad(route()));
    registry.markSessionDormant(route());

    const next = route({
      connectionGeneration: 2,
      processOwnerId: "process-2",
    });
    registry.confirmLoad(registry.beginLoad(next));
    // There is deliberately no viewer/handle API on the provider residency
    // registry; application detach leaves the exact provider owner resident.
    expect(registry.state(next)).toMatchObject({ residency: "resident" });
    expect(
      registry.state({ ...next, workspace: "/workspace/other" }),
    ).toBeUndefined();
    expect(registry.markSessionDormant(next)).toMatchObject({
      residency: "dormant",
    });
    expect(registry.markSessionDormant(next)).toMatchObject({
      residency: "dormant",
    });
  });

  it("rejects forged or replayed provisional claims", () => {
    const registry = new GrokSessionRegistry();
    const claim = registry.beginLoad(route());
    expect(() => registry.confirmLoad({ ...claim })).toThrow(
      "grok_session_load_claim_invalid",
    );
    registry.confirmLoad(claim);
    expect(() => registry.confirmLoad(claim)).toThrow(
      "grok_session_load_claim_invalid",
    );
  });
});
