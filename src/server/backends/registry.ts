import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConnectionKind,
  ConversationBackendDriver,
  ConversationCreationIdentity,
} from "./contracts.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";

export interface BackendDriverFactory {
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly connectionKinds: readonly ConnectionKind[];
  readonly supportsConversationCreation: boolean;
  /**
   * Closed creation identity for backends that support create. Required when
   * `supportsConversationCreation` is true.
   */
  readonly creationIdentity?: ConversationCreationIdentity;
  create(connection: AgentConnectionProfile): ConversationBackendDriver;
}

function backendKey(scope: RequestScope, backendInstanceId: string): string {
  return `${scope.tenantId}\0${scope.principalId}\0${backendInstanceId}`;
}

export class AgentBackendRegistry {
  private readonly factories = new Map<string, BackendDriverFactory>();
  readonly #suspensions = new Map<string, Set<symbol>>();
  readonly #inFlight = new Map<string, Set<Promise<void>>>();

  /** Blocks both fresh selection and previously borrowed driver calls. Drain
   * admitted driver operations before retiring actors; live handles remain the
   * caller's responsibility. Nested fences release independently. */
  suspend(
    scope: RequestScope,
    backendInstanceId: string,
  ): {
    readonly drained: Promise<void>;
    release(): void;
  } {
    const key = backendKey(scope, backendInstanceId);
    const token = Symbol();
    const tokens = this.#suspensions.get(key) ?? new Set<symbol>();
    tokens.add(token);
    this.#suspensions.set(key, tokens);
    return {
      drained: Promise.all([...(this.#inFlight.get(key) ?? [])]).then(
        () => undefined,
      ),
      release: () => {
        tokens.delete(token);
        if (tokens.size === 0 && this.#suspensions.get(key) === tokens)
          this.#suspensions.delete(key);
      },
    };
  }

  register(factory: BackendDriverFactory): void {
    if (
      factory.connectionKinds.length === 0 ||
      new Set(factory.connectionKinds).size !== factory.connectionKinds.length
    ) {
      throw new Error("Backend factory connection kinds are invalid.");
    }
    if (typeof factory.supportsConversationCreation !== "boolean") {
      throw new Error("Backend factory creation capability is invalid.");
    }
    if (factory.supportsConversationCreation) {
      if (
        !factory.creationIdentity ||
        (factory.creationIdentity.assignment !== "application" &&
          factory.creationIdentity.assignment !== "provider")
      ) {
        throw new Error("Backend factory creation identity is invalid.");
      }
    } else if (factory.creationIdentity !== undefined) {
      throw new Error(
        "Backend factory creation identity requires conversation creation support.",
      );
    }
    if (factory.scope.tenantId !== factory.instance.tenantId) {
      throw new Error("Backend factory scope does not match its instance.");
    }
    const key = backendKey(factory.scope, factory.instance.id);
    if (this.factories.has(key)) {
      throw new Error(
        `Backend instance "${factory.instance.id}" is already registered.`,
      );
    }
    this.factories.set(key, factory);
  }

  /** Caller must hold admission/retirement authority before withdrawal. */
  unregister(
    scope: RequestScope,
    backendInstanceId: string,
    expected: BackendDriverFactory,
  ): void {
    const key = backendKey(scope, backendInstanceId);
    if (this.factories.get(key) !== expected) {
      throw new Error("backend_registry_generation_changed");
    }
    this.factories.delete(key);
  }

  driver(connection: AgentConnectionProfile): ConversationBackendDriver {
    const factory = this.#factory(connection);
    const driver = factory.create(connection);
    if (
      !sameBackendInstance(driver.instance, factory.instance) ||
      !sameConnection(driver.connection, connection)
    ) {
      throw new Error(
        "The backend factory returned a driver for a different configured target.",
      );
    }
    // Borrowed drivers cannot initiate work after their factory is withdrawn.
    // Existing handles are retired by the caller's admission fence, not here.
    return new Proxy(driver, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const key = backendKey(factory.scope, factory.instance.id);
          if (this.#suspensions.has(key))
            throw new DomainError("runtime_unavailable", "Configuration change pending for this backend.", true);
          if (this.factories.get(key) !== factory) {
            throw new Error("backend_registry_generation_changed");
          }
          const result: unknown = Reflect.apply(value, target, args);
          const pending = this.#inFlight.get(key) ?? new Set<Promise<void>>();
          this.#inFlight.set(key, pending);
          const settled = Promise.resolve(result)
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => {
              pending.delete(settled);
              if (pending.size === 0 && this.#inFlight.get(key) === pending)
                this.#inFlight.delete(key);
            });
          pending.add(settled);
          return result;
        };
      },
    });
  }

  supportsConversationCreation(connection: AgentConnectionProfile): boolean {
    return this.#factory(connection).supportsConversationCreation;
  }

  creationIdentity(
    connection: AgentConnectionProfile,
  ): ConversationCreationIdentity {
    const factory = this.#factory(connection);
    if (!factory.supportsConversationCreation || !factory.creationIdentity) {
      throw new Error(
        "The selected backend connection does not support conversation creation.",
      );
    }
    return factory.creationIdentity;
  }

  instances(scope: RequestScope): readonly AgentBackendInstance[] {
    return [...this.factories.values()]
      .filter(
        (factory) =>
          factory.scope.tenantId === scope.tenantId &&
          factory.scope.principalId === scope.principalId,
      )
      .map(({ instance }) => instance)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  #factory(connection: AgentConnectionProfile): BackendDriverFactory {
    if (
      this.#suspensions.has(
        backendKey(
          {
            tenantId: connection.tenantId,
            principalId: connection.ownerPrincipalId,
          },
          connection.backendInstanceId,
        ),
      )
    ) {
      throw new DomainError("runtime_unavailable", "Configuration change pending for this backend.", true);
    }
    const factory = this.factories.get(
      backendKey(
        {
          tenantId: connection.tenantId,
          principalId: connection.ownerPrincipalId,
        },
        connection.backendInstanceId,
      ),
    );
    if (!factory) {
      throw new Error("The selected backend instance is not registered.");
    }
    if (!factory.instance.enabled || !connection.enabled) {
      throw new Error("The selected backend connection is disabled.");
    }
    if (!factory.connectionKinds.includes(connection.kind)) {
      throw new Error("The selected backend connection is incompatible.");
    }
    return factory;
  }
}

function sameBackendInstance(
  left: AgentBackendInstance,
  right: AgentBackendInstance,
): boolean {
  return (
    left.id === right.id &&
    left.tenantId === right.tenantId &&
    left.kind === right.kind &&
    left.label === right.label &&
    left.enabled === right.enabled &&
    left.configurationRevision === right.configurationRevision &&
    left.protocolRelease === right.protocolRelease
  );
}

function sameConnection(
  left: AgentConnectionProfile,
  right: AgentConnectionProfile,
): boolean {
  return (
    left.id === right.id &&
    left.tenantId === right.tenantId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.templateId === right.templateId &&
    left.kind === right.kind &&
    left.backendInstanceId === right.backendInstanceId &&
    left.executionEnvironmentId === right.executionEnvironmentId &&
    left.label === right.label &&
    left.enabled === right.enabled &&
    left.configurationRevision === right.configurationRevision
  );
}
