import type { EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import {
  SAVED_AGENT_PAGE_MAX_ITEMS,
  savedAgentDeleteResultSchema,
  savedAgentListPageSchema,
  savedAgentSchema,
  type AgentToolBootstrapPolicy,
  type NormalizedAgentConfigurationOverrides,
  type SavedAgent,
  type SavedAgentBackendTypeId,
  type SavedAgentDeleteResult,
  type SavedAgentListPage,
  type SavedAgentSummary,
} from "../../shared/protocol/saved-agents.js";
import type { SavedAgentBackendAdapterRegistry } from "../backends/saved-agent-adapter-registry.js";
import type {
  CanonicalSavedAgentBackendOverrides,
  SavedAgentBackendAdapter,
} from "../backends/saved-agent-adapter.js";
import {
  canonicalSavedAgentSedesTools,
  canonicalSavedAgentOverrides,
  type SavedAgentRecord,
  type SavedAgentRepository,
} from "../db/repositories/saved-agent-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "./errors.js";

export interface CreateSavedAgentFields {
  readonly name: string;
  readonly description?: string;
  /** Derived from the trusted temporary authoring target, never browser authority. */
  readonly backendTypeId: SavedAgentBackendTypeId;
  readonly backendOverrides: NormalizedAgentConfigurationOverrides;
  readonly environmentVariables?: EnvironmentVariableOverrides;
  readonly sedesTools?: AgentToolBootstrapPolicy;
}

export interface UpdateSavedAgentFields {
  readonly expectedRevision: number;
  readonly name?: string;
  /** Null clears the optional description. */
  readonly description?: string | null;
  readonly backendOverrides?: NormalizedAgentConfigurationOverrides;
  /** Null restores ordinary new-thread tool-policy inheritance. */
  readonly environmentVariables?: EnvironmentVariableOverrides;
  readonly sedesTools?: AgentToolBootstrapPolicy | null;
}

function sameOverrides(
  left: NormalizedAgentConfigurationOverrides,
  right: NormalizedAgentConfigurationOverrides,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireCanonicalResult(
  adapter: SavedAgentBackendAdapter,
  result: CanonicalSavedAgentBackendOverrides,
): CanonicalSavedAgentBackendOverrides {
  const overrides = canonicalSavedAgentOverrides(result.overrides);
  if (
    result.backendTypeId !== adapter.typeId ||
    result.schemaVersion !== adapter.overrideSchemaVersion ||
    !sameOverrides(result.overrides, overrides)
  ) {
    throw new Error("saved_agent_backend_validation_result_invalid");
  }
  return { ...result, overrides };
}

function descriptionExcerpt(description: string): string | undefined {
  if (!description) return undefined;
  let excerpt = description.slice(0, 240);
  const finalCode = excerpt.charCodeAt(excerpt.length - 1);
  if (finalCode >= 0xd800 && finalCode <= 0xdbff) {
    excerpt = excerpt.slice(0, -1);
  }
  return excerpt || undefined;
}

export class SavedAgentService {
  constructor(
    readonly repository: SavedAgentRepository,
    readonly adapters: SavedAgentBackendAdapterRegistry,
  ) {}

  list(
    scope: RequestScope,
    input: {
      readonly backendTypeId?: SavedAgentBackendTypeId;
      readonly nameSearch?: string;
      readonly cursor?: string;
      readonly pageSize?: number;
    } = {},
  ): SavedAgentListPage {
    if (input.backendTypeId) {
      this.#adapter(input.backendTypeId);
    }
    const page = this.repository.listPage(scope, {
      ...(input.backendTypeId
        ? { backendTypeId: input.backendTypeId }
        : {}),
      ...(input.nameSearch ? { nameSearch: input.nameSearch } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      pageSize: input.pageSize ?? 50,
    });
    return savedAgentListPageSchema.parse({
      items: page.items.map((record) => this.#summary(record)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }

  get(scope: RequestScope, agentId: string): SavedAgent {
    return this.#present(this.repository.get(scope, agentId));
  }

  create(
    scope: RequestScope,
    input: CreateSavedAgentFields,
    now = Date.now(),
  ): SavedAgent {
    const adapter = this.#adapter(input.backendTypeId);
    const canonical = requireCanonicalResult(
      adapter,
      adapter.validateOverrides({
        overrides: canonicalSavedAgentOverrides(input.backendOverrides),
      }),
    );
    return this.#present(
      this.repository.create(scope, {
        name: input.name,
        description: input.description ?? "",
        backendTypeId: adapter.typeId,
        backendOverridesSchemaVersion: canonical.schemaVersion,
        backendOverrides: canonical.overrides,
        environmentVariables: input.environmentVariables,
        sedesTools:
          input.sedesTools === undefined
            ? null
            : canonicalSavedAgentSedesTools(input.sedesTools),
        now,
      }),
    );
  }

  update(
    scope: RequestScope,
    agentId: string,
    input: UpdateSavedAgentFields,
    now = Date.now(),
  ): SavedAgent {
    if (
      input.name === undefined &&
      input.description === undefined &&
      input.backendOverrides === undefined &&
      input.sedesTools === undefined && input.environmentVariables === undefined
    ) {
      throw new DomainError(
        "invalid_transition",
        "A Saved Agent update must replace at least one field.",
      );
    }
    const current = this.#validateRecord(this.repository.get(scope, agentId));
    const adapter = this.#adapter(current.backendTypeId);
    const replacement =
      input.backendOverrides === undefined
        ? undefined
        : requireCanonicalResult(
            adapter,
            adapter.validateOverrides({
              overrides: canonicalSavedAgentOverrides(input.backendOverrides),
            }),
          );
    return this.#present(
      this.repository.update(scope, agentId, {
        expectedRevision: input.expectedRevision,
        environmentVariables: input.environmentVariables,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined
          ? {}
          : { description: input.description ?? "" }),
        ...(replacement
          ? {
              backendOverrides: {
                schemaVersion: replacement.schemaVersion,
                values: replacement.overrides,
              },
            }
          : {}),
        ...(input.sedesTools === undefined
          ? {}
          : {
              sedesTools:
                input.sedesTools === null
                  ? null
                  : canonicalSavedAgentSedesTools(input.sedesTools),
            }),
        now,
      }),
    );
  }

  delete(
    scope: RequestScope,
    agentId: string,
    expectedRevision: number,
  ): SavedAgentDeleteResult {
    this.repository.delete(scope, agentId, { expectedRevision });
    return savedAgentDeleteResultSchema.parse({ deleted: true, agentId });
  }

  #adapter(typeId: SavedAgentBackendTypeId): SavedAgentBackendAdapter {
    const adapter = this.adapters.findByTypeId(typeId);
    if (!adapter) {
      throw new DomainError(
        "invalid_transition",
        "The Saved Agent backend type is not available.",
      );
    }
    if (
      adapter.presentation.typeId !== adapter.typeId ||
      adapter.presentation.brand.length === 0 ||
      adapter.presentation.label.text.length === 0
    ) {
      throw new Error("saved_agent_backend_presentation_invalid");
    }
    return adapter;
  }

  #validateRecord(record: SavedAgentRecord): SavedAgentRecord {
    const adapter = this.#adapter(record.backendTypeId);
    if (record.backendOverridesSchemaVersion !== adapter.overrideSchemaVersion) {
      throw new Error("saved_agent_backend_schema_version_unsupported");
    }
    const validated = requireCanonicalResult(
      adapter,
      adapter.validateOverrides({ overrides: record.backendOverrides }),
    );
    if (!sameOverrides(validated.overrides, record.backendOverrides)) {
      throw new Error("saved_agent_backend_durable_overrides_invalid");
    }
    return record;
  }

  #present(record: SavedAgentRecord): SavedAgent {
    const validated = this.#validateRecord(record);
    const adapter = this.#adapter(validated.backendTypeId);
    return savedAgentSchema.parse({
      id: validated.id,
      name: validated.name,
      ...(validated.description
        ? { description: validated.description }
        : {}),
      backendTypeId: validated.backendTypeId,
      backend: adapter.presentation,
      backendOverrides: validated.backendOverrides,
      ...(Object.keys(validated.environmentVariables ?? {}).length ? { environmentVariables: validated.environmentVariables } : {}),
      ...(validated.sedesTools
        ? { sedesTools: validated.sedesTools }
        : {}),
      revision: validated.revision,
      createdAt: new Date(validated.createdAt).toISOString(),
      updatedAt: new Date(validated.updatedAt).toISOString(),
    });
  }

  #summary(record: SavedAgentRecord): SavedAgentSummary {
    const validated = this.#validateRecord(record);
    const adapter = this.#adapter(validated.backendTypeId);
    const excerpt = descriptionExcerpt(validated.description);
    return {
      id: validated.id,
      name: validated.name,
      ...(excerpt ? { descriptionExcerpt: excerpt } : {}),
      backendTypeId: validated.backendTypeId,
      backend: adapter.presentation,
      overrideCount: validated.backendOverrides.length,
      sedesTools: validated.sedesTools
        ? {
            enabled: validated.sedesTools.enabled,
            selectedToolCount: validated.sedesTools.enabledToolIds.length,
            presentation: validated.sedesTools.presentation,
            accessBoundary: validated.sedesTools.accessBoundary,
          }
        : null,
      revision: validated.revision,
      createdAt: new Date(validated.createdAt).toISOString(),
      updatedAt: new Date(validated.updatedAt).toISOString(),
    };
  }
}

export const SAVED_AGENT_DEFAULT_PAGE_SIZE = 50;
export { SAVED_AGENT_PAGE_MAX_ITEMS };
