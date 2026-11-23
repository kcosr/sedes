import { randomUUID } from "node:crypto";
import {
  executionPolicyBytes,
  executionPolicyDigest,
  type ExecutionPolicySnapshot,
  policyReadOperation,
  policyStageOperation,
  policyApplyOperation,
  POLICY_BLOCK_BYTES,
} from "../../src/internal/sidecar-protocol/execution-policy.js";
import type { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import type { SidecarServiceConfiguration } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import type { SidecarProtocolPeer } from "../../src/internal/sidecar-protocol/protocol-peer.js";

export function attachFixturePolicy(
  service: PersistentSidecarServiceRegistry,
  configuration: SidecarServiceConfiguration,
  mode: "normal" | "recovery" = "normal",
  snapshot: ExecutionPolicySnapshot = {
    roots: [],
    capabilities: [],
    backends: [],
  },
): number {
  const epoch = service.attach(configuration, mode);
  if (mode === "normal") installFixturePolicy(service, epoch, configuration, snapshot);
  return epoch;
}

export function installFixturePolicy(
  service: PersistentSidecarServiceRegistry,
  epoch: number,
  configuration: SidecarServiceConfiguration,
  snapshot: ExecutionPolicySnapshot,
): void {
  const { installed, incarnation } = service.readPolicy(epoch, () => "ready");
  const bytes = executionPolicyBytes(snapshot),
    digest = executionPolicyDigest(snapshot);
  const binding = {
    incarnation,
    controllerEpoch: epoch,
    revision: (installed?.revision ?? 0) + 1,
    digest,
    transferId: randomUUID(),
  };
  for (let offset = 0; offset < bytes.length; offset += POLICY_BLOCK_BYTES) {
    service.stagePolicy(epoch, {
      ...binding,
      length: bytes.length,
      offset,
      block: bytes
        .subarray(offset, offset + POLICY_BLOCK_BYTES)
        .toString("base64"),
    });
  }
  service.applyPolicy(epoch, { ...binding, base: installed, configuration });
}
export async function installFramedFixturePolicy(
  peer: SidecarProtocolPeer,
  snapshot: ExecutionPolicySnapshot,
) {
  const { installed, incarnation, controllerEpoch, configuration } =
    await peer.call(policyReadOperation, {});
  const bytes = executionPolicyBytes(snapshot),
    digest = executionPolicyDigest(snapshot);
  const binding = {
    incarnation,
    controllerEpoch,
    revision: (installed?.revision ?? 0) + 1,
    digest,
    transferId: randomUUID(),
  };
  for (let offset = 0; offset < bytes.length; offset += POLICY_BLOCK_BYTES)
    await peer.call(policyStageOperation, {
      ...binding,
      length: bytes.length,
      offset,
      block: bytes
        .subarray(offset, offset + POLICY_BLOCK_BYTES)
        .toString("base64"),
    });
  return peer.call(policyApplyOperation, {
    ...binding,
    base: installed,
    configuration,
  });
}
