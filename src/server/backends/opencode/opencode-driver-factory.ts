import type { BackendDriverFactory } from "../registry.js";
import { BackendError, type AgentBackendInstance, type AgentConnectionProfile, type BackendHealth } from "../contracts.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { OpenCodeConversationBackendDriver } from "./opencode-conversation-driver.js";

export class OpenCodeBackendDriverFactory implements BackendDriverFactory {
  readonly connectionKinds = ["opencode_http"] as const;
  readonly supportsConversationCreation = false;
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly #connections: ReadonlyMap<string, AgentConnectionProfile>;
  constructor(readonly input: { scope: RequestScope; instance: AgentBackendInstance; connections: readonly AgentConnectionProfile[]; health(): Promise<BackendHealth> }) {
    this.scope = Object.freeze({ ...input.scope }); this.instance = input.instance;
    this.#connections = new Map(input.connections.map(connection => [connection.id, Object.freeze({ ...connection })]));
  }
  create(connection: AgentConnectionProfile): OpenCodeConversationBackendDriver {
    const admitted = this.#connections.get(connection.id);
    if (!admitted || (["tenantId", "ownerPrincipalId", "templateId", "kind", "backendInstanceId", "executionEnvironmentId", "enabled", "configurationRevision"] as const)
          .some(key => admitted[key] !== connection[key]) || !connection.enabled || !this.instance.enabled ||
        this.instance.kind !== "opencode" || this.instance.tenantId !== this.scope.tenantId ||
        connection.kind !== "opencode_http" || connection.backendInstanceId !== this.instance.id ||
        connection.tenantId !== this.scope.tenantId || connection.ownerPrincipalId !== this.scope.principalId) {
      throw new BackendError({ category: "permission_denied", retryable: false, crossedSubmissionBoundary: false,
        backendCode: "opencode_connection_authority_invalid", safeMessage: "The OpenCode connection is unavailable." });
    }
    return new OpenCodeConversationBackendDriver({ ...this.input, connection: admitted });
  }
}
