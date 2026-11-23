import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SidecarProtocolPeer } from "../../internal/sidecar-protocol/protocol-peer.js";
import {
  SidecarOperationRegistry,
  SidecarOperationError,
} from "../../internal/sidecar-protocol/operation-registry.js";
import type { PersistentSidecarServiceRegistry } from "./persistent-sidecar-service-registry.js";
import type { ExecutionPolicyRoutes } from "./execution-policy-routes.js";
import { agentToolsCatalogOperation } from "../../internal/sidecar-protocol/agent-tools-v6.js";
import { openCodeToolInvokeOperation } from "../backends/opencode/opencode-tool-relay-wire.js";
import {
  ExecutionPolicyReadPages,
  policyReadOperation,
  policyStageOperation,
  policyApplyOperation,
  policyAcquireRouteOperation,
  policyAcquireOpenCodeRouteOperation,
} from "../../internal/sidecar-protocol/execution-policy.js";
import { providerRuntimeCapabilities } from "../../internal/sidecar-protocol/execution-policy-admission.js";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";
import {
  authorizeVariableResolutionOperation,
  environmentVariablesResolveOperation,
} from "../../internal/sidecar-protocol/environment-variables-v1.js";
import { resolveEnvironmentVariables } from "../environment-variables/runtime-environment.js";
export function registerPersistentExecutionPolicy({
  registry,
  peer,
  serviceRegistry,
  controllerEpoch,
  policyRoutes,
  observeBackend,
}: {
  readonly registry: SidecarOperationRegistry;
  readonly peer: Pick<
    SidecarProtocolPeer,
    "supportsOperation" | "supportsIncomingOperation"
  >;
  readonly serviceRegistry: PersistentSidecarServiceRegistry;
  readonly controllerEpoch: number;
  readonly policyRoutes: ExecutionPolicyRoutes;
  readonly observeBackend?: (id: string, kind: string) => string | null | undefined;
}): void {
  const getExecutionPolicy = () =>
    serviceRegistry.executionPolicy(controllerEpoch);
  let probes:
    | Map<
        string,
        { capabilityId: string; majorVersion: number; operation: string }
      >
    | undefined;
  const supports = (id: string | undefined) => {
    if (!id) return false;
    probes ??= new Map(
      registry
        .capabilities()
        .map((c) => [c.capabilityId, { ...c, operation: c.operations[0]! }]),
    );
    const probe = probes.get(id);
    return !!probe && peer.supportsIncomingOperation(probe);
  };
  const refreshRoutes = (snapshot: ReturnType<typeof getExecutionPolicy>) =>
    policyRoutes.refresh({
      ...snapshot,
      backends: snapshot.backends.filter((b) =>
        supports(providerRuntimeCapabilities[b.kind]),
      ),
      capabilities: peer.supportsOperation(agentToolsCatalogOperation)
        ? snapshot.capabilities
        : [],
    });
  const readStatus = () =>
    serviceRegistry.readPolicy(
      controllerEpoch,
      (category, id, kind, snapshot) => {
        if (category === "root")
          return kind && path.isAbsolute(kind) && path.normalize(kind) === kind
            ? "ready"
            : "unsupported";
        if (category === "backend" && kind === "pi") {
          return ["workspace_tools", "workspace_context"].every(
            (cap) =>
              supports(cap) && snapshot.capabilities.some((c) => c.id === cap),
          )
            ? "ready"
            : "unsupported";
        }
        if (category === "managed_tui")
          return supports("codex_managed_tui") ? "ready" : "unsupported";
        if (category === "route")
          return peer.supportsOperation(agentToolsCatalogOperation)
            ? policyRoutes.state(id)
            : "unsupported";
        if (id === "agent_tools_cli" && category === "capability")
          return peer.supportsOperation(agentToolsCatalogOperation)
            ? policyRoutes.state()
            : "unsupported";
        const cap =
          category === "backend" ? providerRuntimeCapabilities[kind!] : id;
        return supports(cap) ? "ready" : "unsupported";
      },
      observeBackend,
    );
  const pages = new ExecutionPolicyReadPages();
  registry.register(policyReadOperation, async ({ cursor }) => {
    serviceRegistry.assertController(controllerEpoch);
    if (cursor) return pages.next(cursor);
    if (!serviceRegistry.recoveryController) {
      let current;
      try {
        current = getExecutionPolicy();
      } catch {
        /* New attachment must confirm its base first. */
      }
      if (current) {
        await policyRoutes.checkReadiness();
        refreshRoutes(getExecutionPolicy());
      }
    }
    return pages.begin(readStatus());
  });
  registry.register(policyStageOperation, (request) =>
    serviceRegistry.stagePolicy(controllerEpoch, request),
  );
  registry.register(policyApplyOperation, (request) => {
    serviceRegistry.applyPolicy(controllerEpoch, request);
    pages.reset();
    const snapshot = getExecutionPolicy();
    refreshRoutes(snapshot);
    return pages.begin(readStatus());
  });
  registry.register(policyAcquireOpenCodeRouteOperation, (subject) => {
    const backend = getExecutionPolicy().backends.find(
      (b) => b.id === subject.backendInstanceId,
    );
    if (
      backend?.kind !== "opencode" ||
      !peer.supportsOperation(openCodeToolInvokeOperation) ||
      policyRoutes.binding(backend.id).capabilityGeneration !==
        subject.generation
    )
      throw new SidecarOperationError("sidecar_policy_route_denied");
    return {
      ...subject,
      capabilityId: "opencode_tools",
      majorVersion: 3,
      operation: "tools.invoke",
    } as const;
  });
  registry.register(policyAcquireRouteOperation, async (subject) => {
    await policyRoutes.checkReadiness(subject.backendInstanceId);
    getExecutionPolicy();
    if (
      subject.capabilityId !== "agent_tools_cli" ||
      !peer.supportsOperation(agentToolsCatalogOperation)
    )
      throw new SidecarOperationError("sidecar_policy_route_denied");
    return policyRoutes.descriptor(subject);
  });
  // Tickets are local to this authenticated attachment. Main issues them only
  // from the privileged immutable thread snapshot, never from a provider RPC.
  const variableTickets = new Map<
    string,
    {
      backendInstanceId: string;
      threadId: string;
      digest: string;
      generation: number;
      expires: number;
    }
  >();
  registry.register(authorizeVariableResolutionOperation, (request) => {
    const generation = getExecutionPolicy().backends.find(
      (b) => b.id === request.backendInstanceId,
    )?.generation;
    if (!generation)
      throw new SidecarOperationError("sidecar_policy_backend_denied");
    const now = Date.now();
    for (const [key, ticket] of variableTickets)
      if (ticket.expires <= now) variableTickets.delete(key);
    if (variableTickets.size >= 64)
      throw new SidecarOperationError(
        "sidecar_policy_variable_ticket_capacity",
      );
    const ticket = randomUUID();
    variableTickets.set(ticket, {
      ...request,
      generation,
      expires: now + 10_000,
    });
    return { ticket };
  });
  registry.register(
    environmentVariablesResolveOperation,
    async ({ backendInstanceId, threadId, ticket, overrides }) => {
      const grant = variableTickets.get(ticket);
      variableTickets.delete(ticket);
      if (
        !grant ||
        grant.expires <= Date.now() ||
        grant.backendInstanceId !== backendInstanceId ||
        grant.threadId !== threadId ||
        grant.digest !== configurationFingerprint(overrides)
      )
        throw new SidecarOperationError(
          "sidecar_policy_variable_ticket_denied",
        );
      const check = () => {
        if (
          !getExecutionPolicy().backends.some(
            (b) =>
              b.id === backendInstanceId && b.generation === grant.generation,
          )
        )
          throw new SidecarOperationError("sidecar_policy_backend_denied");
      };
      check();
      const values = await resolveEnvironmentVariables(overrides);
      check();
      return { values };
    },
  );
}
