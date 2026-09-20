import { describe, expect, it, vi } from "vitest";
import {
  AgentBackendRegistry,
  type BackendDriverFactory,
} from "../../src/server/backends/registry.js";
import { APPLICATION_ASSIGNED_CREATION_IDENTITY } from "../../src/server/backends/contracts.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBackendDriver,
} from "../../src/server/backends/contracts.js";

const instance: AgentBackendInstance = {
  id: "local-pi",
  tenantId: "tenant-1",
  kind: "pi",
  label: "Pi",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: "0.86.0",
};

const connection: AgentConnectionProfile = {
  id: "connection-1",
  tenantId: "tenant-1",
  ownerPrincipalId: "principal-1",
  templateId: "local-pi-sdk",
  kind: "pi_sdk",
  backendInstanceId: instance.id,
  executionEnvironmentId: "environment-1",
  label: "Local SDK",
  enabled: true,
  configurationRevision: 1,
};
const scope = {
  tenantId: connection.tenantId,
  principalId: connection.ownerPrincipalId,
};

describe("AgentBackendRegistry", () => {
  it("fences borrowed drivers, drains admitted calls, and keeps nested scopes independent", async () => {
    const registry = new AgentBackendRegistry();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const factory: BackendDriverFactory = {
      scope,
      instance,
      connectionKinds: ["pi_sdk"],
      supportsConversationCreation: true,
      creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
      create: () =>
        ({
          instance,
          connection,
          health: () => pending,
        }) as unknown as ConversationBackendDriver,
    };
    registry.register(factory);
    const borrowed = registry.driver(connection);
    const health = borrowed.health;
    const admitted = health();
    const outer = registry.suspend(scope, instance.id);
    const inner = registry.suspend(scope, instance.id);
    let drained = false;
    void outer.drained.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(() => registry.driver(connection)).toThrow(
      expect.objectContaining({ code: "runtime_unavailable", retryable: true }),
    );
    expect(() => health()).toThrow("Configuration change pending");
    finish();
    await admitted;
    await outer.drained;
    outer.release();
    outer.release();
    expect(() => health()).toThrow("Configuration change pending");
    inner.release();
    await expect(health()).resolves.toBeUndefined();
    const foreignFence = registry.suspend(
      { ...scope, principalId: "foreign" },
      instance.id,
    );
    expect(() => registry.driver(connection)).not.toThrow();
    foreignFence.release();
    expect(() =>
      registry.unregister(
        { ...scope, principalId: "foreign" },
        instance.id,
        factory,
      ),
    ).toThrow("backend_registry_generation_changed");
    registry.unregister(scope, instance.id, factory);
    expect(() => health()).toThrow("backend_registry_generation_changed");
  });

  it("resolves a scoped configured connection through its factory", () => {
    const driver = { instance, connection } as ConversationBackendDriver;
    const create = vi.fn(() => driver);
    const registry = new AgentBackendRegistry();
    registry.register({
      scope,
      instance,
      connectionKinds: ["pi_sdk"],
      supportsConversationCreation: true,
      creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
      create,
    });

    expect(registry.driver(connection)).toEqual(driver);
    expect(registry.supportsConversationCreation(connection)).toBe(true);
    expect(create).toHaveBeenCalledWith(connection);
    expect(registry.instances(scope)).toEqual([instance]);
    expect(registry.instances({ ...scope, tenantId: "other-tenant" })).toEqual(
      [],
    );
  });

  it("rejects duplicate, missing, disabled, and cross-tenant targets", () => {
    const factory: BackendDriverFactory = {
      scope,
      instance,
      connectionKinds: ["pi_sdk"],
      supportsConversationCreation: true,
      creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
      create: (candidate) =>
        ({ instance, connection: candidate }) as ConversationBackendDriver,
    };
    const registry = new AgentBackendRegistry();
    registry.register(factory);

    expect(() => registry.register(factory)).toThrow(/already registered/i);
    expect(() =>
      registry.driver({ ...connection, tenantId: "other-tenant" }),
    ).toThrow(/not registered/i);
    expect(() =>
      registry.driver({
        ...connection,
        ownerPrincipalId: "other-principal",
      }),
    ).toThrow(/not registered/i);
    expect(() =>
      registry.supportsConversationCreation({
        ...connection,
        ownerPrincipalId: "other-principal",
      }),
    ).toThrow(/not registered/i);
    expect(() => registry.driver({ ...connection, enabled: false })).toThrow(
      /disabled/i,
    );
  });

  it("rejects a factory whose principal scope does not match its tenant", () => {
    const registry = new AgentBackendRegistry();
    expect(() =>
      registry.register({
        scope: { ...scope, tenantId: "other-tenant" },
        instance,
        connectionKinds: ["pi_sdk"],
        supportsConversationCreation: true,
        creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
        create: (candidate: AgentConnectionProfile) =>
          ({ instance, connection: candidate }) as ConversationBackendDriver,
      }),
    ).toThrow(/scope does not match/i);
  });

  it("uses factory-declared compatibility without provider conditionals", () => {
    const registry = new AgentBackendRegistry();
    registry.register({
      scope,
      instance,
      connectionKinds: ["pi_sdk"],
      supportsConversationCreation: true,
      creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
      create: (candidate) =>
        ({ instance, connection: candidate }) as ConversationBackendDriver,
    });

    expect(() =>
      registry.driver({
        ...connection,
        kind: "incompatible" as AgentConnectionProfile["kind"],
      }),
    ).toThrow(/incompatible/i);
  });

  it("rejects a factory that returns a driver for a different target", () => {
    const registry = new AgentBackendRegistry();
    registry.register({
      scope,
      instance,
      connectionKinds: ["pi_sdk"],
      supportsConversationCreation: true,
      creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
      create: () =>
        ({
          instance,
          connection: { ...connection, id: "wrong-connection" },
        }) as ConversationBackendDriver,
    });

    expect(() => registry.driver(connection)).toThrow(
      /different configured target/i,
    );
  });

  it("rejects empty and duplicate compatibility declarations", () => {
    const registry = new AgentBackendRegistry();
    const create = (candidate: AgentConnectionProfile) =>
      ({ instance, connection: candidate }) as ConversationBackendDriver;

    expect(() =>
      registry.register({
        scope,
        instance,
        connectionKinds: [],
        supportsConversationCreation: true,
        creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
        create,
      }),
    ).toThrow(/connection kinds are invalid/i);
    expect(() =>
      registry.register({
        scope,
        instance,
        connectionKinds: ["pi_sdk", "pi_sdk"],
        supportsConversationCreation: true,
        creationIdentity: APPLICATION_ASSIGNED_CREATION_IDENTITY,
        create,
      }),
    ).toThrow(/connection kinds are invalid/i);
  });

  it("rejects a missing creation capability declaration", () => {
    const registry = new AgentBackendRegistry();

    expect(() =>
      registry.register({
        scope,
        instance,
        connectionKinds: ["pi_sdk"],
        create: (candidate: AgentConnectionProfile) =>
          ({ instance, connection: candidate }) as ConversationBackendDriver,
      } as unknown as BackendDriverFactory),
    ).toThrow(/creation capability is invalid/i);
  });
});
