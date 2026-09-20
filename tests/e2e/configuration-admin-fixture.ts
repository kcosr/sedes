import { mergeEnvironmentVariableOverrides } from "../../src/shared/protocol/environment-variables.js";
import { randomUUID } from "node:crypto";
import {
  ConfigurationAdminService, type ConfigurationRuntimeAdapter,
} from "../../src/server/configuration-admin/configuration-admin-service.js";
import type { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import type { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { runtimeConfigurationFingerprint } from "../../src/server/configuration-admin/configuration-identities.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import type { ConfigurationDocument, ConfigurationRuntimeState, ConfigurationSnapshot } from "../../src/shared/protocol/configuration-admin.js";

/**
 * The existing scripted drivers are real fixture resources. A newly configured
 * provider/SSH host is not: saving it cannot invent a successful connection.
 * This adapter implements local attachment preferences, deterministic
 * unreachable SSH Connect, and one explicitly scripted uncertain connection
 * receipt with scoped Stop. It never starts an external provider or network.
 */
export async function createConfigurationAdminFixture(input: {
  readonly scope: RequestScope;
  readonly repository: ConfigurationRepository;
  readonly projection: ConfigurationProjection;
  readonly initial: ConfigurationSnapshot;
  readonly provisionedConfiguration: ConfigurationDocument;
  readonly activeResources: (kind: ConfigurationRuntimeState["resourceKind"], id: string) => Promise<number>;
  readonly onReconciled: (scope: RequestScope) => Promise<void>;
}): Promise<ConfigurationAdminService> {
  const incarnation = randomUUID();
  const scriptedUncertainHost = (snapshot: ConfigurationSnapshot, id: string) => snapshot.configuration.executionEnvironments.some(
    environment => environment.id === id && environment.kind === "ssh" && environment.hostAlias === "e2e-unknown-lifecycle",
  );
  const known = new Map([
    ...input.provisionedConfiguration.executionEnvironments.map(item => ({ kind: "environment" as const, id: item.id })),
    ...input.provisionedConfiguration.backends.map(item => ({ kind: "backend" as const, id: item.id })),
  ].map(resource => [`${resource.kind}:${resource.id}`, runtimeConfigurationFingerprint(input.provisionedConfiguration, resource.kind, resource.id)]));
  const assertScope = (scope: RequestScope) => {
    if (scope.tenantId !== input.scope.tenantId || scope.principalId !== input.scope.principalId) throw new DomainError("not_found", "Fixture configuration is unavailable in this scope.");
  };
  const fence = (runtime: ConfigurationRuntimeState) => configurationFingerprint({
    resourceKind: runtime.resourceKind, resourceId: runtime.resourceId,
    incarnation: runtime.incarnation, activeResources: runtime.activeResources,
  });
  const startupFingerprint = (configuration: ConfigurationDocument, backendId: string) => {
    const backend = configuration.backends.find(item => item.id === backendId);
    if (!backend || backend.kind === "pi" || (backend.kind === "codex_app_server" && backend.moduleConfiguration.connection.ownership === "external")) return undefined;
    const environmentId = configuration.targets.find(item => item.backendInstanceId === backendId)?.executionEnvironmentId;
    const environment = configuration.executionEnvironments.find(item => item.id === environmentId);
    return configurationFingerprint(mergeEnvironmentVariableOverrides(environment?.environmentVariables?.startup ?? {}, backend.environmentVariables?.startup ?? {}));
  };
  const adapter: ConfigurationRuntimeAdapter = {
    async observe(scope, snapshot) {
      assertScope(scope);
      return Promise.all(snapshot.runtimes.map(async runtime => {
        const baseline = known.get(`${runtime.resourceKind}:${runtime.resourceId}`);
        const current = runtimeConfigurationFingerprint(snapshot.configuration, runtime.resourceKind, runtime.resourceId);
        const environment = runtime.resourceKind === "environment"
          ? snapshot.configuration.executionEnvironments.find(candidate => candidate.id === runtime.resourceId) : undefined;
        if (runtime.resourceKind === "environment" && scriptedUncertainHost(snapshot, runtime.resourceId)) {
          return { ...runtime, applyState: "unavailable" as const, effectiveRevision: null,
            connectionState: runtime.preference === "stopped" ? "stopped" as const : "unknown" as const,
            incarnation: `${incarnation}:scripted:${runtime.resourceId}`, softwareVersion: "scripted-e2e", upgradeState: "current" as const,
            activeResources: runtime.preference === "stopped" ? 0 : 1, supportedActions: ["connect" as const, "stop" as const],
            lastError: runtime.preference === "stopped" ? null : "This scripted host has one unconfirmed connection outcome.",
          };
        }
        if (baseline === undefined) {
          return { ...runtime, applyState: "unavailable" as const, effectiveRevision: null,
            connectionState: runtime.preference === "disconnected" ? "disconnected" as const
              : runtime.connectionState === "unreachable" ? "unreachable" as const : "unknown" as const,
            incarnation: null, softwareVersion: null, upgradeState: "unknown" as const, activeResources: 0,
            supportedActions: environment?.kind === "ssh" ? ["connect" as const, "disconnect" as const] : [],
            lastError: environment?.kind === "ssh" ? "This scripted fixture has no provisioned SSH service." : "No scripted backend is provisioned for this definition.",
          };
        }
        const startupEnvironmentPending = runtime.resourceKind === "backend" && startupFingerprint(snapshot.configuration, runtime.resourceId) !== startupFingerprint(input.provisionedConfiguration, runtime.resourceId);
        return { ...runtime, ...(startupEnvironmentPending || runtime.startupEnvironmentPending !== undefined ? {startupEnvironmentPending} : {}),
          applyState: baseline === current && !startupEnvironmentPending ? "applied" as const : "pending" as const,
          effectiveRevision: baseline === current ? runtime.desiredRevision : runtime.effectiveRevision,
          connectionState: "connected" as const, incarnation: `${incarnation}:${runtime.resourceKind}:${runtime.resourceId}`,
          softwareVersion: "scripted-e2e", upgradeState: "current" as const,
          activeResources: await input.activeResources(runtime.resourceKind, runtime.resourceId),
          supportedActions: [],
          lastError: baseline === current ? null : "Saved configuration is pending; the scripted fixture does not replace live provider drivers.",
        };
      }));
    },
    async reconcile(scope, snapshot) {
      for (const runtime of await adapter.observe(scope, snapshot)) input.repository.observe(scope, runtime);
      await input.onReconciled(scope);
    },
    async impact(scope, request, runtime) {
      assertScope(scope);
      if (!runtime.supportedActions.includes(request.action)) throw new DomainError("bad_request", "This fixture does not implement the selected lifecycle action.");
      return { runtime, fence: fence(runtime), interruptions: scriptedUncertainHost(input.repository.get(scope), request.resourceId)
        ? ["One retained connection has an unknown outcome. Stop ends this scripted runtime without repeating its connection command."] : [] };
    },
    async execute(scope, { request, runtime, expectedFence }) {
      assertScope(scope);
      if (expectedFence !== null && expectedFence !== fence(runtime)) return {
        mutationId: request.mutationId, state: "rejected", runtime: { ...runtime, applyState: "rejected", lastError: "The fixture runtime changed after impact inspection." },
      };
      if (request.resourceKind === "environment" && scriptedUncertainHost(input.repository.get(scope), request.resourceId)) {
        if (request.action === "connect") throw new Error("The scripted connection response was lost after admission.");
        if (request.action !== "stop") throw new DomainError("bad_request", "The scripted host only supports Connect and Stop.");
        for (const previous of input.repository.pendingLifecycle(scope)) {
          if (previous.request.mutationId === request.mutationId || previous.request.resourceKind !== "environment" || previous.request.resourceId !== request.resourceId) continue;
          input.repository.completeLifecycle(scope, previous.request, { ...previous.result, state: "rejected",
            runtime: { ...previous.result.runtime, lastError: "The earlier scripted connection was withdrawn by Stop." },
          });
        }
        return { mutationId: request.mutationId, state: "applied", runtime: {
          ...runtime, preference: "stopped", connectionState: "stopped", activeResources: 0, lastError: null,
        } };
      }
      if (request.resourceKind !== "environment" || !["connect", "disconnect"].includes(request.action)) throw new DomainError("bad_request", "The fixture cannot execute this lifecycle action.");
      if (request.action === "disconnect") return {
        mutationId: request.mutationId, state: "applied", runtime: {
          ...runtime, preference: "disconnected", connectionState: "disconnected", applyState: "unavailable", effectiveRevision: null,
          lastError: "Automatic connection is suspended; no SSH service was provisioned by this fixture.",
        },
      };
      return { mutationId: request.mutationId, state: "unavailable", runtime: {
        ...runtime, preference: "automatic", connectionState: "unreachable", applyState: "unavailable", effectiveRevision: null,
        lastError: "The configured SSH host is unreachable in this scripted fixture.",
      } };
    },
  };
  const service = new ConfigurationAdminService(input.repository, {
    authorize: scope => assertScope(scope), projection: input.projection, runtime: adapter,
  });
  await adapter.reconcile(input.scope, input.initial);
  return service;
}
