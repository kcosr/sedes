import type { PrincipalAgentToolClientRepository } from "../../db/repositories/principal-agent-tool-client-repository.js";
import type {
  ThreadAgentToolPolicyRecord,
  ThreadAgentToolPolicyRepository,
} from "../../db/repositories/thread-agent-tool-policy-repository.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { TrustedEnvironmentAuthorityGrant } from "../environment/environment-authority.js";

/** Child configurations may retain only authority the current caller still owns. */
export function assertToolPolicyWithinCaller(input: {
  readonly scope: RequestScope;
  readonly authority: TrustedEnvironmentAuthorityGrant;
  readonly requested: Pick<ThreadAgentToolPolicyRecord, "enabled" | "enabledToolIds" | "resourceScope">;
  readonly toolPolicies: Pick<ThreadAgentToolPolicyRepository, "getDurable">;
  readonly principalToolClients: Pick<PrincipalAgentToolClientRepository, "get">;
}): void {
  const { scope, authority, requested } = input;
  if (authority.defaults.kind === "principal_client") {
    if (authority.policyIdentity.ownerKind !== "principal_client") {
      throw new DomainError("conflict", "The tool client identity changed.");
    }
    const client = input.principalToolClients.get(scope, authority.policyIdentity.ownerId);
    if (!client.enabled || client.revokedAt !== undefined ||
      client.policyRevision !== authority.policyIdentity.revision ||
      client.credentialGeneration !== authority.policyIdentity.credentialGeneration) {
      throw new DomainError("conflict", "The tool client policy changed. Retry with its current permissions.");
    }
    if (requested.enabled && (requested.resourceScope.allowOtherEnvironments ||
      requested.enabledToolIds.some(id => !client.toolIds.includes(id)))) {
      throw new DomainError("invalid_transition", "A tool client cannot grant tools or all-environment access beyond its credential policy. Ask the user to change the policy.");
    }
    return;
  }
  const source = input.toolPolicies.getDurable(scope, authority.defaults.threadId);
  if (authority.policyIdentity.ownerKind !== "thread" ||
    authority.policyIdentity.ownerId !== authority.defaults.threadId ||
    source.revision !== authority.policyIdentity.revision) {
    throw new DomainError("conflict", "The source thread tool policy changed. Retry with its current permissions.");
  }
  if (!requested.enabled) return;
  const allowed = new Set(source.enabledToolIds);
  if (!source.enabled || requested.enabledToolIds.some(id => !allowed.has(id)) ||
    (requested.resourceScope.allowOtherEnvironments && !source.resourceScope.allowOtherEnvironments) ||
    (requested.resourceScope.allowOtherProjects && !source.resourceScope.allowOtherProjects)) {
    throw new DomainError("invalid_transition", "An agent cannot grant tools or resource access beyond its own thread policy. Ask the user to change the policy.");
  }
}
