import {
  executionPolicyDigest,
  type ExecutionPolicyStatus,
  type InstalledExecutionPolicy,
} from "../../src/internal/sidecar-protocol/execution-policy.js";
import type {
  SidecarServiceConfiguration,
  SidecarServiceStatus,
} from "../../src/internal/sidecar-protocol/service-management-v1.js";

export function ownerPolicy(
  capabilities: readonly string[] = [],
  configuration: SidecarServiceConfiguration = {
    environmentRevision: 1,
    operationsRevision: 1,
  },
): InstalledExecutionPolicy {
  const snapshot = {
    roots: [],
    capabilities: capabilities.map((id) => ({ id, generation: 1 })),
    backends: [
      {
        id: "backend",
        kind: "pi_native",
        generation: 1,
        launchDigest: "0".repeat(64),
        targets: [],
      },
    ],
  };
  return {
    snapshot,
    configuration,
    revision:
      configuration.environmentRevision + configuration.operationsRevision,
    digest: executionPolicyDigest(snapshot),
  };
}

export function ownerPolicyPeer(
  service: Pick<
    SidecarServiceStatus,
    "controllerEpoch" | "serviceIncarnation" | "effectiveConfiguration"
  >,
  supported: (id: string) => boolean = () => true,
) {
  let installed: InstalledExecutionPolicy | undefined;
  const readPolicy = async (): Promise<ExecutionPolicyStatus> => ({
    incarnation: service.serviceIncarnation,
    controllerEpoch: service.controllerEpoch,
    installed: installed
      ? { revision: installed.revision, digest: installed.digest }
      : null,
    configuration: installed?.configuration ?? service.effectiveConfiguration,
    readiness: installed
      ? [
          ...installed.snapshot.capabilities.map((entry) => ({
            ...entry,
            id: `capability:${entry.id}`,
            state: supported(entry.id)
              ? ("ready" as const)
              : ("unsupported" as const),
          })),
          { id: "backend:backend", generation: 1, state: "ready" },
          {
            id: "route:backend",
            generation: 1,
            state: supported("agent_tools_cli") ? "ready" : "unsupported",
          },
        ]
      : [],
  });
  return {
    readPolicy,
    applyPolicy: async (desired: InstalledExecutionPolicy) => {
      installed = desired;
      return await readPolicy();
    },
  };
}
