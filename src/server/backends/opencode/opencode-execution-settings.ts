import { openCodeOperationControl } from "./opencode-operation-control.js";
import type { OpenCodeMutationControl } from "./opencode-native-port.js";
import type { AttachConversationInput } from "../contracts.js";
import type { OpenCodeNativePort } from "./opencode-native-port.js";
import { OpenCodeNativeApi, type OpenCodeNativeSession } from "./opencode-native-api.js";
import { OpenCodeNativeMutations } from "./opencode-native-mutations.js";
import { openCodeConversationError, requireOpenCodeBinding, type OpenCodeConversationRuntime, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { classifyObserved, decodeOpenCodeModelId, qualifiedOpenCodeModelId, resolveOpenCodeSelection,
  sameOpenCodeSelection, type OpenCodeObservation, type OpenCodeSelection } from "./opencode-model-selection.js";
import type { OpenCodeModelCatalogRead } from "./opencode-model-catalog.js";
import type { OpenCodeOperationSettingsSnapshot, OpenCodeThreadSettingsRecord } from "./opencode-thread-settings-repository.js";

export interface OpenCodeObservedSettings {
  readonly session: OpenCodeNativeSession;
  readonly catalog: OpenCodeModelCatalogRead;
  readonly settings: OpenCodeThreadSettingsRecord;
  readonly observed: OpenCodeObservation;
}

/** Desired state is application authority. Native observations never adopt it. */
export class OpenCodeExecutionSettings {
  readonly #api: OpenCodeNativeApi;
  readonly #native: OpenCodeNativeMutations;
  readonly lifetime: AbortSignal;
  #observationSequence = 0;
  constructor(readonly context: OpenCodeDriverContext, readonly input: AttachConversationInput,
    readonly runtime: OpenCodeConversationRuntime, readonly client: OpenCodeNativePort, readonly generation: string, lifetime: AbortSignal) {
    this.#api = new OpenCodeNativeApi(client); this.#native = new OpenCodeNativeMutations(client);
    this.lifetime = AbortSignal.any([client.lifetime, lifetime]);
  }

  async observe(signal?: AbortSignal): Promise<OpenCodeObservedSettings> {
    signal = this.#signal(signal);
    const sequence = ++this.#observationSequence;
    await this.assertCurrent(signal);
    const settings = this.context.settings.get(this.input.scope, this.input.binding.applicationThreadId);
    if (settings.observationGeneration !== this.generation) {
      if (!this.context.settings.beginObservation(this.input.scope, settings.applicationThreadId,
        { expectedRevision: settings.revision, generation: this.generation, now: Date.now() })) throw changed();
    }
    const [session, catalog] = await Promise.all([
      this.#api.getSession(this.input.binding.backendConversationId, signal),
      this.context.catalog.read({ connection: this.context.connection, workspace: this.input.workspace, ...(signal ? { signal } : {}) }),
    ]);
    this.#assertSession(session);
    await this.assertCurrent(signal);
    const observed = classifyObserved({ selection: nativeSelection(session, catalog), catalog });
    this.#publishObserved(settings, observed, sequence);
    return { session, catalog, settings, observed };
  }

  async prepare(operationId: string, kind: "submit" | "steer", signal?: AbortSignal): Promise<{
    readonly snapshot: OpenCodeOperationSettingsSnapshot; readonly catalog: OpenCodeModelCatalogRead;
  }> {
    const read = await this.observe(signal);
    if (!read.settings.desired) throw unavailable("Choose supported OpenCode settings before sending input.");
    const desired = resolveOpenCodeSelection({ connection: this.context.connection, catalog: read.catalog.catalog,
      modelId: qualifiedOpenCodeModelId(read.settings.desired), variant: read.settings.desired.variant, modelPolicy: this.context.modelPolicy });
    if (read.observed.classification !== "recognized") throw unavailable(
      "OpenCode has custom or unavailable native settings. Choose a supported model or Default effort before sending input.");
    const snapshot = this.context.settings.captureOperation(this.input.scope, {
      applicationThreadId: read.settings.applicationThreadId, applicationOperationId: operationId,
      operationKind: kind, expectedRevision: read.settings.revision, now: Date.now(),
    });
    if (!sameOpenCodeSelection(snapshot.selection, desired)) throw changed();
    if (!sameOpenCodeSelection(read.observed.resolvedSelection, desired)) {
      if (kind === "steer") throw unavailable("The desired and active OpenCode settings differ. Steering cannot change the active model.");
      await this.apply(desired, read, openCodeOperationControl(snapshot, "prepare-model"), signal);
    }
    return { snapshot, catalog: read.catalog };
  }

  /** Explicit settings actions may repair custom native state; ordinary work may not. */
  async apply(selection: OpenCodeSelection, read: OpenCodeObservedSettings, control: OpenCodeMutationControl, signal?: AbortSignal, beforeDispatch?: () => void): Promise<void> {
    signal = this.#signal(signal);
    const desired = resolveOpenCodeSelection({ connection: this.context.connection, catalog: read.catalog.catalog,
      modelId: qualifiedOpenCodeModelId(selection), variant: selection.variant, modelPolicy: this.context.modelPolicy });
    await this.assertCurrent(signal);
    if (this.context.settings.get(this.input.scope, read.settings.applicationThreadId).revision !== read.settings.revision) throw changed();
    // Receipt ownership is claimed only after every asynchronous admission check.
    beforeDispatch?.();
    const sequence = ++this.#observationSequence;
    await this.#native.setModel({ sessionID: this.input.binding.backendConversationId, model: desired }, control, signal);
    const session = await this.#api.getSession(this.input.binding.backendConversationId, signal);
    this.#assertSession(session); await this.assertCurrent(signal);
    // A native no-op still gets a readback; 204 and ModelSelected alone do not prove selection.
    if (!sameOpenCodeSelection(session.model ?? null, desired)) throw unavailable("The requested OpenCode model selection could not be confirmed.");
    const observed = classifyObserved({ selection: desired, catalog: read.catalog });
    this.#publishObserved(read.settings, observed, sequence);
    // The observed settings row is mutable, so it cannot release exact host
    // evidence. The enclosing action or input admission commits that fence.
  }

  async assertCurrent(signal?: AbortSignal): Promise<void> {
    signal = this.#signal(signal);
    this.assertCurrentSync(signal);
    await this.runtime.assertCurrent(signal);
    this.assertCurrentSync(signal);
  }
  assertCurrentSync(signal?: AbortSignal): void {
    requireOpenCodeBinding(this.context, this.input); this.lifetime.throwIfAborted(); signal?.throwIfAborted();
  }
  #signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.lifetime, signal]) : this.lifetime;
  }
  #publishObserved(settings: OpenCodeThreadSettingsRecord, observed: OpenCodeObservation, sequence: number): void {
    const current = this.context.settings.get(this.input.scope, settings.applicationThreadId);
    if (current.revision !== settings.revision || current.observationGeneration !== this.generation) throw changed();
    // A newer background read controls publication, not this caller's valid
    // admission result. Only real desired/binding-generation changes reject it.
    if (sequence !== this.#observationSequence) return;
    if (!this.context.settings.recordObserved(this.input.scope, settings.applicationThreadId,
      { expectedRevision: settings.revision, generation: this.generation, observed, now: Date.now() })) throw changed();
  }
  markUnknown(): void {
    const settings = this.context.settings.get(this.input.scope, this.input.binding.applicationThreadId);
    this.context.settings.markUnknown(this.input.scope, settings.applicationThreadId,
      { expectedRevision: settings.revision, generation: this.generation, now: Date.now() });
  }
  #assertSession(session: OpenCodeNativeSession): void {
    if (session.id !== this.input.binding.backendConversationId || session.location.directory !== this.input.workspace.canonicalPath) {
      throw openCodeConversationError("opencode_session_location_changed", "The OpenCode conversation moved to another workspace.", "permission_denied");
    }
  }
}

function nativeSelection(session: OpenCodeNativeSession, catalog: OpenCodeModelCatalogRead): OpenCodeSelection | null {
  if (session.model) return session.model;
  // Absence uses the authoritative location default, never the first catalog entry.
  const model = catalog.catalog.models.find(model => model.isDefault);
  return model ? decodeOpenCodeModelId(model.id) : null;
}
function changed() { return openCodeConversationError("opencode_settings_changed", "The OpenCode settings changed while this operation was being prepared.", "invalid_state"); }
function unavailable(message: string) { return openCodeConversationError("opencode_settings_unavailable", message, "invalid_state"); }
