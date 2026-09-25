import {
  CANONICAL_AGENT_TOOL_GROUPS,
  CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES,
} from "../agent-tools/registry/canonical-agent-tool-manifest.js";
import type { BackendKind } from "../backends/contracts.js";
import type { AgentToolPresentationOption } from "../../shared/protocol/conversation.js";
import type { ThreadAgentToolEligibilityPolicy } from "../db/repositories/thread-agent-tool-policy-repository.js";
import type { ThreadAgentToolCatalogReader } from "./database-thread-application-readers.js";

function presentationOptionsForBackend(
  backendKind: BackendKind,
  environmentKind: "local" | "ssh" | "outbound",
): readonly AgentToolPresentationOption[] {
  switch (backendKind) {
    case "pi":
      return environmentKind === "local"
        ? ([
            { surface: "native", modes: ["progressive", "individual"] },
            { surface: "cli", modes: ["progressive", "individual"] },
          ])
        : ([
            { surface: "native", modes: ["progressive", "individual"] },
          ]);
    // Codex and Claude load Native tools through the stdio `sedes mcp`
    // server. The first surface and its first mode are the default, so they
    // default to Native/Individual; migration 115 applies it to new threads.
    case "codex_app_server":
    case "claude_agent_sdk":
      return [
        { surface: "native", modes: ["individual", "progressive"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ];
    case "grok_build":
      return [
        { surface: "cli", modes: ["progressive", "individual"] },
      ];
    default: {
      const unsupportedBackend: never = backendKind;
      throw new Error(
        `agent_tool_backend_disposition_missing:${unsupportedBackend}`,
      );
    }
  }
}

/**
 * Code-defined deployment ceiling for the first application tool slice.
 * Policy metadata comes directly from the same static contracts as execution.
 */
export function createThreadAgentToolPolicyDependencies(
  runtimeAvailability: ReadonlyMap<
    string,
    { readonly available: boolean; readonly reason?: string }
  > = new Map(),
): {
  readonly eligibility: ThreadAgentToolEligibilityPolicy;
  readonly catalog: ThreadAgentToolCatalogReader;
} {
  const groupOrders = new Map(
    CANONICAL_AGENT_TOOL_GROUPS.map(({ id, order }) => [id, order] as const),
  );
  const definitions = CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.filter(
    ({ deployment, callerEligibility }) =>
      deployment?.eligible === true &&
      callerEligibility.some((caller) => caller === "thread_agent"),
  ).sort(
    (left, right) =>
      (groupOrders.get(left.catalog.groupId) ?? Number.MAX_SAFE_INTEGER) -
        (groupOrders.get(right.catalog.groupId) ?? Number.MAX_SAFE_INTEGER) ||
      left.catalog.order - right.catalog.order ||
      left.id.localeCompare(right.id),
  );
  const eligibleToolIds = new Set(definitions.map(({ id }) => id));
  const groups = CANONICAL_AGENT_TOOL_GROUPS.flatMap((group) => {
    const tools = definitions
      .filter((definition) => definition.catalog.groupId === group.id)
      .map((definition) => ({
        id: definition.id,
        label: definition.catalog.label,
        description: definition.description,
        order: definition.catalog.order,
        effects: definition.effects,
        available:
          runtimeAvailability.get(definition.id)?.available !== false,
        ...(runtimeAvailability.get(definition.id)?.reason
          ? {
              unavailableReason: runtimeAvailability.get(definition.id)!
                .reason,
            }
          : {}),
      }));
    return tools.length === 0 ? [] : [{ ...group, tools }];
  });
  return Object.freeze({
    eligibility: Object.freeze({
      eligibleToolIds,
      presentationOptions: presentationOptionsForBackend,
    }),
    catalog: Object.freeze({ list: () => ({ groups }) }),
  });
}

export function createPrincipalAgentToolClientEligibility(): {
  readonly eligibleToolIds: ReadonlySet<string>;
} {
  return Object.freeze({
    eligibleToolIds: new Set(
      CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.filter(
        ({ deployment, callerEligibility }) =>
          deployment?.eligible === true &&
          callerEligibility.some((caller) => caller === "principal_client"),
      ).map(({ id }) => id),
    ),
  });
}
