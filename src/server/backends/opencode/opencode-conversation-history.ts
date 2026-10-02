import { randomUUID } from "node:crypto";
import type { BackendCapabilityDocument } from "../../../shared/protocol/backend.js";
import type { UsageSnapshot } from "../../../shared/protocol/conversation.js";
import type { ConversationHistoryReader, EstablishProjectionInput, HistoryPageInput, LocateTurnInput, ReadConversationInput } from "../contracts.js";
import { openCodeConversationError, openCodeRuntimeTarget, requireOpenCodeBinding, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { mapOpenCodeConversationError } from "./opencode-conversation-error.js";
import { openCodeObservedActivity, waitOpenCode } from "./opencode-conversation-handle.js";
import { projectOpenCodeCurrentUsage } from "./opencode-current-usage.js";
import { OpenCodeHistoryProjection } from "./opencode-history-projection.js";
import { OPENCODE_HISTORY_LIMITS, OpenCodeHistoryError, readOpenCodeHistory } from "./opencode-history-reader.js";
import { OpenCodeInputEvidenceRepository } from "./opencode-input-evidence.js";
import type { OpenCodeModelCatalogRead } from "./opencode-model-catalog.js";
import { OpenCodeNativeApi } from "./opencode-native-api.js";
import { materializeOpenCodeViewedImages } from "./opencode-viewed-images.js";

interface HistoryCapture { readonly projection: OpenCodeHistoryProjection; readonly usage: UsageSnapshot; }

/** A finite native read with no execution handle, input tracker, or settings replay. */
export class OpenCodeConversationHistory implements ConversationHistoryReader {
  readonly #lifetime = new AbortController();
  readonly #generation = randomUUID();
  #capture?: Promise<HistoryCapture>;

  constructor(readonly context: OpenCodeDriverContext, readonly input: ReadConversationInput) {}

  async readSnapshot(input: EstablishProjectionInput) {
    return this.#run(input.signal, async signal => {
      const { projection } = await this.#load(signal);
      const { snapshot, previousCursor } = projection.snapshot({ signal });
      return { snapshot, history: { operational: true, ...(previousCursor ? { previousCursor } : {}) } };
    });
  }

  async history(input: HistoryPageInput) {
    return this.#run(input.signal, async signal => (await this.#load(signal)).projection.history({ ...input, signal }));
  }

  async locateTurn(input: LocateTurnInput) {
    return this.#run(input.signal, async signal => (await this.#load(signal)).projection.locateTurn({ ...input, signal }));
  }

  async usage() { return this.#run(undefined, async signal => (await this.#load(signal)).usage); }

  async backendCapabilities(): Promise<BackendCapabilityDocument> {
    this.#lifetime.signal.throwIfAborted();
    return { revision: "opencode-history-1", actions: [], deliveryModes: [], steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false }, nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false }, supportsHistory: true,
      branching: { availability: "unavailable", reason: { text: "This acquisition provides conversation history only." } },
      interactionKinds: [], usageSections: ["context", "counters"], usageAccounting: "supported",
      turnThroughput: "unsupported", effectiveSettings: {} };
  }

  async close(): Promise<void> {
    this.#lifetime.abort();
    const capture = this.#capture; this.#capture = undefined;
    await capture?.catch(() => undefined);
  }

  #load(signal: AbortSignal): Promise<HistoryCapture> {
    signal.throwIfAborted();
    // A successful native cut remains immutable until this reader is closed.
    this.#capture ??= this.#acquire(signal).catch(error => { this.#capture = undefined; throw error; });
    return waitOpenCode(this.#capture, signal);
  }

  async #acquire(signal: AbortSignal): Promise<HistoryCapture> {
    requireOpenCodeBinding(this.context, this.input); signal.throwIfAborted();
    const runtime = await waitOpenCode(this.context.runtime(), signal);
    if (runtime.nativeNamespaceKey !== this.context.nativeNamespaceKey) throw openCodeConversationError(
      "opencode_runtime_namespace_mismatch", "The OpenCode runtime does not match the bound native store.", "permission_denied");
    await waitOpenCode(runtime.start(), signal); signal.throwIfAborted();
    const lease = runtime.acquire(openCodeRuntimeTarget(this.input));
    const native = new OpenCodeNativeApi(lease.client);
    const sessionID = this.input.binding.backendConversationId;
    let observation: ReturnType<OpenCodeNativeApi["observe"]> | undefined;
    try {
      // A durable change could replace a record already fetched. Refuse that
      // acquisition instead of mixing cuts or waiting for native work to stop.
      observation = native.observe({ signal, include: event => "sessionID" in event.data && event.data.sessionID === sessionID && "durable" in event });
      await waitOpenCode(observation.ready, signal);
      const check = () => {
        signal.throwIfAborted();
        if (observation!.failure || observation!.drain().length) throw new OpenCodeHistoryError("invalidated");
      };
      await runtime.assertCurrent(signal); check();
      const session = await native.getSession(sessionID, signal); check();
      if (session.id !== sessionID || session.location.directory !== this.input.workspace.canonicalPath) throw openCodeConversationError(
        "opencode_session_location_changed", "The OpenCode conversation moved to another workspace.", "invalid_state");
      const retained = await readOpenCodeHistory(native, { sessionId: sessionID, signal, assertCurrent: check });
      const activity = await native.getActivity(sessionID, this.input.workspace.canonicalPath, signal); check();
      let catalog: OpenCodeModelCatalogRead | undefined;
      try { catalog = await this.context.catalog.read({ connection: this.context.connection, workspace: this.input.workspace,
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }); }
      catch { /* Missing model limits do not hide available transcript counters. */ }
      await runtime.assertCurrent(signal); check();
      const viewedImages = await materializeOpenCodeViewedImages({ messages: retained.messages,
        nativeNamespaceKey: this.context.nativeNamespaceKey, sessionID, scope: this.input.scope,
        threadId: this.input.binding.applicationThreadId, publisher: this.context.outputArtifacts,
        models: catalog?.modelsById ?? new Map(), signal,
        assertCurrent: async () => { await runtime.assertCurrent(signal); check(); } });
      check();
      const correlations = new Map<string, string>();
      for (const evidence of new OpenCodeInputEvidenceRepository(this.context.repository).list(this.input.scope, this.input.binding.applicationThreadId)) {
        if (evidence.consumedFingerprint && !evidence.payloadConflict && evidence.receipt.nativeSessionId === sessionID && evidence.receipt.nativeInputId) {
          correlations.set(evidence.receipt.nativeInputId, evidence.receipt.applicationOperationId);
        }
      }
      const suffix = retained.messages.slice(retained.messages.findLastIndex(message => message.type === "idle") + 1);
      const unfinished = suffix.some(message => ["user", "assistant", "synthetic", "compaction"].includes(message.type));
      const binding = this.input.binding;
      const projection = new OpenCodeHistoryProjection(retained, {
        bindingScope: [binding.tenantId, binding.ownerPrincipalId, binding.applicationThreadId, binding.backendInstanceId,
          binding.connectionProfileId, binding.executionEnvironmentId, this.context.nativeNamespaceKey],
        generation: this.#generation, activity: activity.active ? suffix.length ? "running" : "starting" : unfinished ? "unknown" : "idle",
        backgroundActivity: openCodeObservedActivity(activity), deliveryCorrelations: correlations,
        attachmentProvenanceKey: this.context.attachmentProvenanceKey, viewedImages, signal,
      });
      const usage = projectOpenCodeCurrentUsage({ messages: retained.messages, session, ...(catalog ? { catalog } : {}) });
      await runtime.assertCurrent(signal); check();
      return { projection, usage };
    } finally {
      try { await observation?.close(); } finally { lease.release(); }
    }
  }

  async #run<T>(parent: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(OPENCODE_HISTORY_LIMITS.milliseconds);
    const signal = AbortSignal.any([this.#lifetime.signal, timeout, ...(parent ? [parent] : [])]);
    try {
      signal.throwIfAborted();
      const result = await waitOpenCode(operation(signal), signal);
      signal.throwIfAborted(); return result;
    } catch (error) {
      if (timeout.aborted) throw new OpenCodeHistoryError("time");
      if (signal.aborted) throw new OpenCodeHistoryError("cancelled");
      throw mapOpenCodeConversationError(error);
    }
  }
}
