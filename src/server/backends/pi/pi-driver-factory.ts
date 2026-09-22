import type { ThreadEnvironmentResolver } from "../../environment-variables/runtime-environment.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBackendDriver,
} from "../contracts.js";
import { APPLICATION_ASSIGNED_CREATION_IDENTITY } from "../contracts.js";
import type { BackendDriverFactory } from "../registry.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { BackendAgentToolFacade } from "../../agent-tools/adapters/backend-facade.js";
import {
  PiConversationBackendDriver,
  type PiDriverOptions,
} from "./pi-conversation-driver.js";
import { PiSessionStore } from "./pi-session-store.js";
import {
  DefaultPiSdkSessionFactory,
  type PiSdkSessionFactory,
} from "./pi-sdk-session.js";
import { PiDiscoverySnapshotStore } from "./pi-discovery-snapshot-store.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { AgentToolSourceCapabilityIssuer } from "../../agent-tools/application/database-agent-tool-source-authority.js";
import type { PiIsolatedWorkspaceResolver } from "./pi-isolated-workspace.js";

/**
 * One process-wide driver instance per configured Pi connection. Repeated
 * registry resolution must share the handle ownership map; constructing a new
 * driver per request would permit two writers for one native session.
 */
import type { UsageSink } from "../../usage/contracts.js";

export class PiBackendDriverFactory implements BackendDriverFactory {
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly connectionKinds = ["pi_sdk"] as const;
  readonly supportsConversationCreation = true;
  readonly creationIdentity = APPLICATION_ASSIGNED_CREATION_IDENTITY;
  readonly #usage: UsageSink;
  readonly #resolveThreadEnvironment: ThreadEnvironmentResolver;
  readonly #store: PiSessionStore;
  readonly #sessionFactory: PiSdkSessionFactory;
  readonly #toolProvenanceKey: Uint8Array;
  readonly #toolAccessPolicy: PiDriverOptions["toolAccessPolicy"];
  readonly #onEffectiveSettings: PiDriverOptions["onEffectiveSettings"];
  readonly #agentTools: BackendAgentToolFacade;
  readonly #agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
  readonly #agentToolCli: NonNullable<PiDriverOptions["agentToolCli"]>;
  readonly #nativeDiscoveryNamespaceKey: string;
  readonly #resolveRemoteWorkspace?: PiDriverOptions["resolveRemoteWorkspace"];
  readonly #isolatedWorkspaces?: PiIsolatedWorkspaceResolver;
  readonly #discoverySnapshots = new PiDiscoverySnapshotStore();
  readonly #drivers = new Map<string, PiConversationBackendDriver>();
  readonly #modelPolicy: CompiledBackendModelPolicy;

  constructor(input: {
    readonly usage: UsageSink;
    readonly resolveThreadEnvironment?: ThreadEnvironmentResolver;
    readonly instance: AgentBackendInstance;
    readonly scope: RequestScope;
    readonly nativeDiscoveryNamespaceKey: string;
    readonly agentDir?: string;
    readonly sessionDirectory?: string;
    readonly workspacePathMode?: PiDriverOptions["workspacePathMode"];
    readonly sessionFactory?: PiSdkSessionFactory;
    readonly resolveRemoteWorkspace?: PiDriverOptions["resolveRemoteWorkspace"];
    readonly isolatedWorkspaces?: PiIsolatedWorkspaceResolver;
    readonly toolProvenanceKey: Uint8Array;
    readonly toolAccessPolicy: PiDriverOptions["toolAccessPolicy"];
    readonly onEffectiveSettings?: PiDriverOptions["onEffectiveSettings"];
    readonly agentTools: BackendAgentToolFacade;
    readonly agentToolSourceCapabilities: AgentToolSourceCapabilityIssuer;
    readonly agentToolCli: NonNullable<PiDriverOptions["agentToolCli"]>;
    readonly now?: PiDriverOptions["now"];
    readonly modelPolicy: CompiledBackendModelPolicy;
  }) {
    this.#usage = input.usage;
    this.scope = input.scope;
    this.#resolveThreadEnvironment = input.resolveThreadEnvironment ?? (async () => Object.freeze({}));
    this.instance = input.instance;
    this.#nativeDiscoveryNamespaceKey = input.nativeDiscoveryNamespaceKey;
    this.#resolveRemoteWorkspace = input.resolveRemoteWorkspace;
    this.#isolatedWorkspaces = input.isolatedWorkspaces;
    this.#store = new PiSessionStore({
      ...(input.sessionDirectory
        ? { sessionDirectory: input.sessionDirectory }
        : {}),
      ...(input.workspacePathMode
        ? { workspacePathMode: input.workspacePathMode }
        : {}),
    });
    this.#sessionFactory =
      input.sessionFactory ??
      new DefaultPiSdkSessionFactory({
        ...(input.agentDir ? { agentDir: input.agentDir } : {}),
      });
    this.#toolProvenanceKey = new Uint8Array(input.toolProvenanceKey);
    this.#toolAccessPolicy = input.toolAccessPolicy;
    this.#onEffectiveSettings = input.onEffectiveSettings;
    this.#agentTools = input.agentTools;
    this.#agentToolSourceCapabilities = input.agentToolSourceCapabilities;
    this.#agentToolCli = input.agentToolCli;
    this.#modelPolicy = input.modelPolicy;
    this.now = input.now;
  }

  readonly now: PiDriverOptions["now"];

  create(connection: AgentConnectionProfile): ConversationBackendDriver {
    if (
      connection.tenantId !== this.instance.tenantId ||
      connection.ownerPrincipalId !== this.scope.principalId ||
      connection.backendInstanceId !== this.instance.id
    ) {
      throw new Error("pi_driver_factory_connection_mismatch");
    }
    let driver = this.#drivers.get(connection.id);
    if (!driver) {
      driver = new PiConversationBackendDriver({
        usage: this.#usage,
        resolveThreadEnvironment: this.#resolveThreadEnvironment,
        instance: this.instance,
        connection,
        nativeDiscoveryNamespaceKey: this.#nativeDiscoveryNamespaceKey,
        discoverySnapshots: this.#discoverySnapshots,
        store: this.#store,
        sessionFactory: this.#sessionFactory,
        toolProvenanceKey: this.#toolProvenanceKey,
        toolAccessPolicy: this.#toolAccessPolicy,
        onEffectiveSettings: this.#onEffectiveSettings,
        agentTools: this.#agentTools,
        agentToolSourceCapabilities: this.#agentToolSourceCapabilities,
        agentToolCli: this.#agentToolCli,
        modelPolicy: this.#modelPolicy,
        ...(this.#resolveRemoteWorkspace
          ? { resolveRemoteWorkspace: this.#resolveRemoteWorkspace }
          : {}),
        ...(this.#isolatedWorkspaces
          ? { isolatedWorkspaces: this.#isolatedWorkspaces }
          : {}),
        ...(this.now ? { now: this.now } : {}),
      });
      this.#drivers.set(connection.id, driver);
    } else if (
      driver.connection.configurationRevision !==
      connection.configurationRevision
    ) {
      throw new Error("pi_driver_factory_configuration_changed");
    }
    return driver;
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#drivers.values()].map((driver) => driver.close()),
    );
    this.#discoverySnapshots.close();
    this.#drivers.clear();
  }
}
