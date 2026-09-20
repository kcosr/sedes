import type Database from "better-sqlite3";
import type {
  NormalizedAgentConfigurationDescriptor,
  NormalizedAgentConfigurationOverrides,
  SavedAgentBackendPresentation,
  SavedAgentBackendTypeId,
} from "../../shared/protocol/saved-agents.js";
import type { ValidatedWorkspace } from "../execution/contracts.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  AgentConnectionProfile,
  BackendCatalog,
  BackendKind,
} from "./contracts.js";

/**
 * Explicit handle proving that backend initialization is enlisted in the
 * caller-owned SQLite creation transaction. It performs no transaction
 * management itself.
 */
export class ConversationCreationTransaction {
  readonly database: Database.Database;

  private constructor(database: Database.Database) {
    this.database = database;
  }

  static fromActiveDatabase(
    database: Database.Database,
  ): ConversationCreationTransaction {
    if (!database.inTransaction) {
      throw new Error("conversation_creation_transaction_inactive");
    }
    return new ConversationCreationTransaction(database);
  }

  assertActive(): void {
    if (!this.database.inTransaction) {
      throw new Error("conversation_creation_transaction_inactive");
    }
  }
}

export interface CanonicalSavedAgentBackendOverrides {
  readonly backendTypeId: SavedAgentBackendTypeId;
  readonly schemaVersion: number;
  readonly overrides: NormalizedAgentConfigurationOverrides;
}

/**
 * Opaque, backend-owned defaults loaded before pure resolution. Pi uses this
 * seam for its principal/connection preferences; common orchestration never
 * inspects `value`.
 */
export interface PreparedSavedAgentBackendContext {
  readonly backendTypeId: SavedAgentBackendTypeId;
  readonly schemaVersion: number;
  readonly value: unknown;
}

/**
 * Complete target-specific configuration produced by one backend adapter.
 * `normalizedValues` is safe preview data; `value` remains backend-private and
 * is passed back only to that adapter for transactional initialization.
 */
export interface ResolvedSavedAgentBackendConfiguration {
  readonly backendTypeId: SavedAgentBackendTypeId;
  readonly schemaVersion: number;
  readonly normalizedValues: NormalizedAgentConfigurationOverrides;
  readonly value: unknown;
}

/**
 * Exact, backend-authored configuration captured from one existing thread.
 * The normalized overrides can be revalidated through ordinary Saved Agent
 * resolution; the revision fences the source selection until the child is
 * committed.
 */
export interface CapturedThreadBackendConfiguration {
  readonly backendTypeId: SavedAgentBackendTypeId;
  readonly schemaVersion: number;
  readonly settingsRevision: number;
  readonly overrides: NormalizedAgentConfigurationOverrides;
}

export interface SavedAgentBackendContextInput {
  readonly scope: RequestScope;
  readonly workspace: ValidatedWorkspace;
  readonly connection: AgentConnectionProfile;
  readonly catalog: BackendCatalog;
}

/**
 * Required compiled-backend contribution for SavedAgents. Preparation may
 * read backend-owned local database/configuration state but must not perform a
 * provider request or write. `resolve` and `describeEditor` are pure over the
 * supplied inputs. Initialization is persistence-only and must remain inside
 * the active SQLite transaction.
 */
export interface SavedAgentBackendAdapter {
  readonly typeId: SavedAgentBackendTypeId;
  readonly backendKind: BackendKind;
  readonly presentation: SavedAgentBackendPresentation;
  readonly overrideSchemaVersion: number;

  validateOverrides(input: {
    readonly overrides: NormalizedAgentConfigurationOverrides;
  }): CanonicalSavedAgentBackendOverrides;

  prepareResolutionContext(
    input: SavedAgentBackendContextInput,
  ): PreparedSavedAgentBackendContext;

  describeEditor(input: SavedAgentBackendContextInput & {
    readonly prepared: PreparedSavedAgentBackendContext;
    readonly overrides: CanonicalSavedAgentBackendOverrides;
  }): NormalizedAgentConfigurationDescriptor;

  resolve(input: SavedAgentBackendContextInput & {
    readonly prepared: PreparedSavedAgentBackendContext;
    readonly overrides: CanonicalSavedAgentBackendOverrides;
  }): ResolvedSavedAgentBackendConfiguration;

  captureThreadConfiguration(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly connection: AgentConnectionProfile;
  }): CapturedThreadBackendConfiguration;

  assertThreadConfigurationCapture(input: {
    readonly transaction: ConversationCreationTransaction;
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly connection: AgentConnectionProfile;
    readonly capture: CapturedThreadBackendConfiguration;
  }): void;

  initializeNewThread(input: {
    readonly transaction: ConversationCreationTransaction;
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly connection: AgentConnectionProfile;
    readonly resolved: ResolvedSavedAgentBackendConfiguration;
  }): void;
}

export function assertPreparedSavedAgentBackendContext(
  adapter: SavedAgentBackendAdapter,
  prepared: PreparedSavedAgentBackendContext,
): void {
  if (
    prepared.backendTypeId !== adapter.typeId ||
    prepared.schemaVersion !== adapter.overrideSchemaVersion
  ) {
    throw new Error("saved_agent_backend_prepared_context_invalid");
  }
}

export function assertResolvedSavedAgentBackendConfiguration(
  adapter: SavedAgentBackendAdapter,
  resolved: ResolvedSavedAgentBackendConfiguration,
): void {
  if (
    resolved.backendTypeId !== adapter.typeId ||
    resolved.schemaVersion !== adapter.overrideSchemaVersion
  ) {
    throw new Error("saved_agent_backend_resolution_invalid");
  }
}
