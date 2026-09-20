import type { BackendModuleRuntime } from "../backends/module.js";
import type { DatabaseConversationTargetStore } from "../conversations/database-conversation-adapters.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import {
  ManagedTerminalCarrierError,
  type ManagedTerminalResourceAuthority,
  type ManagedTerminalServerEvent,
  type ManagedTerminalViewerSession,
} from "./managed-terminal-carrier.js";

/**
 * Production terminal authority selected from the durable, scoped thread
 * binding. Browser requests carry only the normalized application thread ID;
 * backend instance and provider-native identities never cross the HTTP or
 * WebSocket boundary.
 */
export class ProductionManagedTerminalAuthority implements ManagedTerminalResourceAuthority {
  readonly #targets: DatabaseConversationTargetStore;
  readonly #runtimes: ReadonlyMap<string, BackendModuleRuntime>;

  constructor(input: {
    readonly targets: DatabaseConversationTargetStore;
    readonly runtimes: ReadonlyMap<string, BackendModuleRuntime>;
  }) {
    this.#targets = input.targets;
    this.#runtimes = input.runtimes;
  }

  async authorizeAdmission(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
  }): Promise<{ readonly resourceGeneration: number }> {
    const authority = await this.#resolve(
      input.scope,
      input.applicationThreadId,
    );
    this.#assertProjectActive(input.scope, input.applicationThreadId);
    const admission = await authority.authorizeAdmission(input);
    this.#assertProjectActive(input.scope, input.applicationThreadId);
    return admission;
  }

  async attachViewer(
    input: {
      readonly scope: RequestScope;
      readonly applicationThreadId: string;
      readonly resourceGeneration: number;
      readonly viewerId: string;
    },
    emit: (event: ManagedTerminalServerEvent) => void,
  ): Promise<ManagedTerminalViewerSession> {
    const authority = await this.#resolve(
      input.scope,
      input.applicationThreadId,
    );
    this.#assertProjectActive(input.scope, input.applicationThreadId);
    const viewer = await authority.attachViewer(input, emit);
    try {
      this.#assertProjectActive(input.scope, input.applicationThreadId);
    } catch (error) {
      await viewer.close();
      throw error;
    }
    const assertActive = () =>
      this.#assertProjectActive(input.scope, input.applicationThreadId);
    return {
      sendInput: bytes => {
        assertActive();
        return viewer.sendInput(bytes);
      },
      resize: dimensions => {
        assertActive();
        return viewer.resize(dimensions);
      },
      requestSync: () => {
        assertActive();
        return viewer.requestSync();
      },
      requestRefit: dimensions => {
        assertActive();
        return viewer.requestRefit(dimensions);
      },
      close: () => viewer.close(),
    };
  }

  async #resolve(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ManagedTerminalResourceAuthority> {
    this.#assertProjectActive(scope, applicationThreadId);
    const target = await this.#targets.actor(scope, applicationThreadId);
    this.#assertProjectActive(scope, applicationThreadId);
    const runtime = this.#runtimes.get(target.binding.backendInstanceId);
    if (
      !runtime ||
      runtime.instance.id !== target.binding.backendInstanceId ||
      runtime.scope.tenantId !== scope.tenantId ||
      runtime.scope.principalId !== scope.principalId
    ) {
      throw new ManagedTerminalCarrierError(
        "terminal_unavailable",
        "The thread's managed terminal backend is unavailable.",
        true,
      );
    }
    return runtime.managedProviderTerminals;
  }

  #assertProjectActive(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    try {
      this.#targets.assertThreadWorkspaceActive(scope, applicationThreadId);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      throw new ManagedTerminalCarrierError(
        "terminal_unavailable",
        "The thread's project is unavailable for terminal access.",
        false,
      );
    }
  }
}
