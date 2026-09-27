import type { ThreadBackendPresentationProvider } from "../../conversations/database-thread-application-readers.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export class OpenCodeThreadPresentationProvider implements ThreadBackendPresentationProvider {
  constructor(readonly scope: RequestScope, readonly backendInstanceId: string) {}
  async read(input: Parameters<ThreadBackendPresentationProvider["read"]>[0]) {
    if (input.scope.tenantId !== this.scope.tenantId || input.scope.principalId !== this.scope.principalId ||
        input.backend.id !== this.backendInstanceId || input.backend.kind !== "opencode" ||
        input.backend.tenantId !== this.scope.tenantId || input.connection.kind !== "opencode_http" ||
        input.connection.backendInstanceId !== this.backendInstanceId || input.connection.tenantId !== this.scope.tenantId ||
        input.connection.ownerPrincipalId !== this.scope.principalId) {
      throw new DomainError("conflict", "The OpenCode thread target does not match its authority.");
    }
    return {
      revision: `opencode_unavailable_${input.backend.configurationRevision}_${input.connection.configurationRevision}`,
      backend: { label: boundDisplayText(input.backend.label), brand: "opencode" as const },
      interactionMode: "interactive" as const,
      settings: { revision: 0, values: [] }, settingDescriptors: [], nextTurnSettingIds: [],
      automationAllowed: false, providerFeatureCapabilities: [], providerFeatureStates: [], composerCommands: [], skills: [],
    };
  }
}
