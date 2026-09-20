import { CanonicalAgentToolRequestError } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import type { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import type { AgentToolRouterDependencies } from "../../src/server/agent-tools/http/agent-tool-router.js";
import { DomainError } from "../../src/server/domain/errors.js";

/** Required normalized-app dependency for fixtures that do not exercise tools. */
export function unavailableAgentToolRouterDependencies(): AgentToolRouterDependencies {
  return {
    sources: {
      async resolve() {
        throw new CanonicalAgentToolRequestError(
          "not_found",
          "The source thread was not found.",
        );
      },
    },
    tools: new PolicyCheckedAgentToolHttpService({
      catalogSummaries: () => [],
      describeMany: () => {
        throw new CanonicalAgentToolRequestError(
          "not_found",
          "The requested tool is unavailable.",
        );
      },
      invoke: async () => {
        throw new CanonicalAgentToolRequestError(
          "permission_denied",
          "The tool is not exposed to this thread.",
        );
      },
    } as unknown as SourceScopedAgentToolService),
    clients: unavailablePrincipalAgentToolClientService(),
  };
}

export function unavailablePrincipalAgentToolClientService(): AgentToolRouterDependencies["clients"] {
  return {
    catalogSummaries() {
      throw new CanonicalAgentToolRequestError(
        "unauthenticated",
        "The tool client credential is invalid.",
      );
    },
    describeMany() {
      throw new CanonicalAgentToolRequestError(
        "unauthenticated",
        "The tool client credential is invalid.",
      );
    },
    async invoke() {
      throw new CanonicalAgentToolRequestError(
        "unauthenticated",
        "The tool client credential is invalid.",
      );
    },
    options() {
      throw new DomainError("runtime_unavailable", "Tool clients are unavailable.");
    },
    list() {
      throw new DomainError("runtime_unavailable", "Tool clients are unavailable.");
    },
    get() {
      throw new DomainError("runtime_unavailable", "Tool clients are unavailable.");
    },
    createForManagement() {
      throw new DomainError("runtime_unavailable", "Tool clients are unavailable.");
    },
    replaceForManagement() {
      throw new DomainError("runtime_unavailable", "Tool clients are unavailable.");
    },
    rotateForManagement() {
      throw new DomainError("runtime_unavailable", "Tool clients are unavailable.");
    },
    revokeForManagement() {
      throw new DomainError("runtime_unavailable", "Tool clients are unavailable.");
    },
  };
}
