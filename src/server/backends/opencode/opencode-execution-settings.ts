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
import { OpenCodeIdentityProofScope } from "./opencode-identity-proof.js";
import type { OpenCodeOperationSettingsSnapshot, OpenCodeThreadSettingsRecord } from "./opencode-thread-settings-repository.js";

/** Settings frozen for one Submit/Steer invocation. Only that invocation may pass it to prepare(). */
export interface OpenCodeSettingsCapture {
  readonly snapshot: OpenCodeOperationSettingsSnapshot;
  readonly catalog: OpenCodeModelCatalogRead;
}
// A capture's catalog may be relied on only this long, measured on a monotonic
// clock from before its catalog read until after the dispatch-time session read.
// Slow capture, attachment, collision or session reads repeat the full check.
const CAPTURE_REUSE_MILLISECONDS = 5_000;
interface CapturedSettings {
  /** Monotonic time taken before the capture's catalog read began. */
  readonly startedAt: number;
  readonly operationId: string;
  readonly kind: "submit" | "steer";
  readonly read: OpenCodeObservedSettings;
  readonly desired: OpenCodeSelection;
  readonly snapshot: OpenCodeOperationSettingsSnapshot;
}

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
  readonly #captures = new WeakMap<OpenCodeSettingsCapture, CapturedSettings>();
  constructor(readonly context: OpenCodeDriverContext, readonly input: AttachConversationInput,
    readonly runtime: OpenCodeConversationRuntime, readonly client: OpenCodeNativePort, readonly generation: string, lifetime: AbortSignal) {
    this.#api = new OpenCodeNativeApi(client); this.#native = new OpenCodeNativeMutations(client);
    this.lifetime = AbortSignal.any([client.lifetime, lifetime]);
  }

  async observe(signal?: AbortSignal): Promise<OpenCodeObservedSettings> {
    signal = this.#signal(signal);
    const sequence = ++this.#observationSequence;
    const proofs = new OpenCodeIdentityProofScope();
    await this.assertCurrent(signal, proofs);
    const settings = this.context.settings.get(this.input.scope, this.input.binding.applicationThreadId);
    if (settings.observationGeneration !== this.generation) {
      if (!this.context.settings.beginObservation(this.input.scope, settings.applicationThreadId,
        { expectedRevision: settings.revision, generation: this.generation, now: Date.now() })) throw changed();
    }
    const [session, catalog] = await Promise.all([
      this.#api.getSession(this.input.binding.backendConversationId, signal),
      this.context.catalog.read({ connection: this.context.connection, workspace: this.input.workspace, proofs, ...(signal ? { signal } : {}) }),
    ]);
    this.#assertSession(session);
    await this.assertCurrent(signal, proofs);
    const observed = classifyObserved({ selection: nativeSelection(session, catalog), catalog });
    this.#publishObserved(settings, observed, sequence);
    return { session, catalog, settings, observed };
  }

  /** `fresh` is this invocation's own capture; a replay or another invocation passes none. */
  async prepare(operationId: string, kind: "submit" | "steer", signal?: AbortSignal, fresh?: OpenCodeSettingsCapture): Promise<{
    readonly snapshot: OpenCodeOperationSettingsSnapshot; readonly catalog: OpenCodeModelCatalogRead;
  }> {
    const captured = fresh ? this.#captures.get(fresh) : undefined;
    if (fresh) this.#captures.delete(fresh);
    const reusable = captured && captured.operationId === operationId && captured.kind === kind && withinReuseWindow(captured);
    const { read, desired, snapshot } = reusable ? await this.#recheck(captured, signal) : await this.#capture(operationId, kind, signal);
    if (!sameOpenCodeSelection(read.observed.resolvedSelection, desired)) {
      if (kind === "steer") throw unavailable("The desired and active OpenCode settings differ. Steering cannot change the active model.");
      await this.apply(desired, read, openCodeOperationControl(snapshot, "prepare-model"), signal);
    }
    return { snapshot, catalog: read.catalog };
  }

  /** Freeze request identity without issuing writes before an input receipt exists. */
  async capture(operationId: string, kind: "submit" | "steer", signal?: AbortSignal): Promise<OpenCodeSettingsCapture> {
    const startedAt = performance.now();
    const captured = await this.#capture(operationId, kind, signal);
    const result: OpenCodeSettingsCapture = Object.freeze({ snapshot: captured.snapshot, catalog: captured.read.catalog });
    this.#captures.set(result, { startedAt, operationId, kind, ...captured });
    return result;
  }

  /** Dispatch-time check for this invocation's capture. Desired settings, model
   * policy and catalog come from that capture; the native session is read again
   * because another client can change its model without a Sedes settings write.
   * A session without an explicit model inherits the location's current default,
   * which only a fresh catalog read can show, so it takes the full check. */
  async #recheck(captured: CapturedSettings, signal?: AbortSignal) {
    signal = this.#signal(signal);
    const settings = this.context.settings.get(this.input.scope, this.input.binding.applicationThreadId);
    if (settings.revision !== captured.read.settings.revision || settings.revision !== captured.snapshot.settingsRevision ||
        settings.observationGeneration !== this.generation) return this.#capture(captured.operationId, captured.kind, signal);
    const sequence = ++this.#observationSequence;
    this.assertCurrentSync(signal);
    // The capture's trailing identity proof precedes this read; this proof follows it.
    const session = await this.#api.getSession(this.input.binding.backendConversationId, signal);
    this.#assertSession(session);
    await this.assertCurrent(signal);
    if (!session.model || !withinReuseWindow(captured)) return this.#capture(captured.operationId, captured.kind, signal);
    const catalog = captured.read.catalog;
    const observed = classifyObserved({ selection: nativeSelection(session, catalog), catalog });
    this.#publishObserved(settings, observed, sequence);
    if (observed.classification !== "recognized") throw unrecognized();
    return { read: { session, catalog, settings, observed }, desired: captured.desired, snapshot: captured.snapshot };
  }

  async #capture(operationId: string, kind: "submit" | "steer", signal?: AbortSignal) {
    const read = await this.observe(signal);
    if (!read.settings.desired) throw unavailable("Choose supported OpenCode settings before sending input.");
    const desired = resolveOpenCodeSelection({ connection: this.context.connection, catalog: read.catalog.catalog,
      modelId: qualifiedOpenCodeModelId(read.settings.desired), variant: read.settings.desired.variant, modelPolicy: this.context.modelPolicy });
    if (read.observed.classification !== "recognized") throw unrecognized();
    const snapshot = this.context.settings.captureOperation(this.input.scope, {
      applicationThreadId: read.settings.applicationThreadId, applicationOperationId: operationId,
      operationKind: kind, expectedRevision: read.settings.revision, now: Date.now(),
    });
    if (!sameOpenCodeSelection(snapshot.selection, desired)) throw changed();
    return { read, desired, snapshot };
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

  async assertCurrent(signal?: AbortSignal, proofs?: OpenCodeIdentityProofScope): Promise<void> {
    signal = this.#signal(signal);
    this.assertCurrentSync(signal);
    await this.runtime.assertCurrent(signal, proofs);
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
function withinReuseWindow(captured: CapturedSettings): boolean {
  return performance.now() - captured.startedAt <= CAPTURE_REUSE_MILLISECONDS;
}
function unrecognized() {
  return unavailable("OpenCode has custom or unavailable native settings. Choose a supported model or Default effort before sending input.");
}
function unavailable(message: string) { return openCodeConversationError("opencode_settings_unavailable", message, "invalid_state"); }
