import type { ValidatedWorkspace } from "./contracts.js";
import type { WorkspaceContextReader } from "../workspace-context/contracts.js";
import type { WorkspaceToolExecutor } from "../workspace-tools/contracts.js";
import type { WorkspaceSkillReader } from "../workspace-skills/contracts.js";

export type EnvironmentOperationDisposition<Operation> =
  | Readonly<{
      availability: "available";
      implementation: "direct" | "sidecar";
      forWorkspace(workspace: ValidatedWorkspace): Operation;
    }>
  | Readonly<{
      availability: "unavailable";
      reason: "not_configured";
    }>;

/**
 * Exact environment-owned operation contribution supplied to backend modules.
 * Backends remain responsible for explicitly consuming or ignoring it; an
 * available contribution never implies backend support by itself.
 */
export interface EnvironmentOperations {
  readonly environmentId: string;
  readonly environmentKind: "local" | "ssh" | "outbound";
  readonly environmentLabel: string;
  readonly workspaceTools: EnvironmentOperationDisposition<WorkspaceToolExecutor>;
  readonly workspaceContext: EnvironmentOperationDisposition<WorkspaceContextReader>;
  readonly workspaceSkills: EnvironmentOperationDisposition<WorkspaceSkillReader>;
}

export function unavailableEnvironmentOperations(input: {
  readonly environmentId: string;
  readonly environmentKind: "local" | "ssh" | "outbound";
  readonly environmentLabel: string;
}): EnvironmentOperations {
  const unavailable = Object.freeze({
    availability: "unavailable" as const,
    reason: "not_configured" as const,
  });
  return Object.freeze({
    ...input,
    workspaceTools: unavailable,
    workspaceContext: unavailable,
    workspaceSkills: unavailable,
  });
}
