import type { SavedAgentBackendAdapter } from "./saved-agent-adapter.js";
import type { SavedAgentBackendTypeId } from "../../shared/protocol/saved-agents.js";
import { savedAgentBackendPresentationSchema } from "../../shared/protocol/saved-agents.js";

export class SavedAgentBackendAdapterRegistry {
  readonly #byBackendInstanceId = new Map<string, SavedAgentBackendAdapter>();
  readonly #byTypeId = new Map<
    SavedAgentBackendTypeId,
    SavedAgentBackendAdapter
  >();

  constructor(
    registrations: readonly {
      readonly backendInstanceId: string;
      readonly adapter: SavedAgentBackendAdapter;
    }[],
  ) {
    for (const { backendInstanceId, adapter } of registrations) {
      if (
        !backendInstanceId ||
        this.#byBackendInstanceId.has(backendInstanceId)
      ) {
        throw new Error("saved_agent_backend_instance_duplicate");
      }
      if (
        !Number.isSafeInteger(adapter.overrideSchemaVersion) ||
        adapter.overrideSchemaVersion < 1
      ) {
        throw new Error("saved_agent_backend_schema_version_invalid");
      }
      const presentation = savedAgentBackendPresentationSchema.parse(
        adapter.presentation,
      );
      if (presentation.typeId !== adapter.typeId) {
        throw new Error("saved_agent_backend_presentation_invalid");
      }
      const representative = this.#byTypeId.get(adapter.typeId);
      if (
        representative &&
        (representative.backendKind !== adapter.backendKind ||
          representative.overrideSchemaVersion !==
            adapter.overrideSchemaVersion ||
          JSON.stringify(
            savedAgentBackendPresentationSchema.parse(
              representative.presentation,
            ),
          ) !== JSON.stringify(presentation))
      ) {
        throw new Error("saved_agent_backend_type_contract_conflict");
      }
      this.#byBackendInstanceId.set(backendInstanceId, adapter);
      if (!representative) this.#byTypeId.set(adapter.typeId, adapter);
    }
  }

  /** Validate the complete next contribution set before changing live lookups. */
  replaceAll(
    registrations: readonly {
      readonly backendInstanceId: string;
      readonly adapter: SavedAgentBackendAdapter;
    }[],
  ): void {
    const next = new SavedAgentBackendAdapterRegistry(registrations);
    this.#byBackendInstanceId.clear();
    this.#byTypeId.clear();
    for (const [id, adapter] of next.#byBackendInstanceId)
      this.#byBackendInstanceId.set(id, adapter);
    for (const [id, adapter] of next.#byTypeId) this.#byTypeId.set(id, adapter);
  }

  list(): readonly SavedAgentBackendAdapter[] {
    return Object.freeze(
      [...this.#byTypeId.values()].sort((left, right) =>
        left.typeId < right.typeId ? -1 : left.typeId > right.typeId ? 1 : 0,
      ),
    );
  }

  findByTypeId(
    typeId: SavedAgentBackendTypeId,
  ): SavedAgentBackendAdapter | undefined {
    return this.#byTypeId.get(typeId);
  }

  requireByTypeId(typeId: SavedAgentBackendTypeId): SavedAgentBackendAdapter {
    const adapter = this.findByTypeId(typeId);
    if (!adapter) throw new Error("saved_agent_backend_type_not_installed");
    return adapter;
  }

  findByBackendInstanceId(
    backendInstanceId: string,
  ): SavedAgentBackendAdapter | undefined {
    return this.#byBackendInstanceId.get(backendInstanceId);
  }

  requireByBackendInstanceId(
    backendInstanceId: string,
  ): SavedAgentBackendAdapter {
    const adapter = this.findByBackendInstanceId(backendInstanceId);
    if (!adapter) throw new Error("saved_agent_backend_instance_not_installed");
    return adapter;
  }
}
