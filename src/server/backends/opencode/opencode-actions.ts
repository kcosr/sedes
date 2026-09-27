import { z } from "zod";
import { BackendError, type AttachConversationInput, type BackendActionResult, type BackendMutationReconciliation,
  type RegisteredBackendActionInput } from "../contracts.js";
import { openCodeConversationError, requireOpenCodeBinding, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { mapOpenCodeConversationError } from "./opencode-conversation-error.js";
import type { OpenCodeExecutionSettings } from "./opencode-execution-settings.js";
import { openCodeOperationFingerprint } from "./opencode-input-evidence.js";
import { OpenCodeMutationEvidenceRepository } from "./opencode-mutation-evidence.js";
import { OpenCodeNativeApi } from "./opencode-native-api.js";
import { OpenCodeNativeMutationInputError, OpenCodeNativeMutations } from "./opencode-native-mutations.js";
import { openCodeSelectionSchema, qualifiedOpenCodeModelId, resolveOpenCodeSelection, sameOpenCodeSelection } from "./opencode-model-selection.js";
import type { OpenCodeOperationReceipt } from "./opencode-thread-repository.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

const payloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("rename"), title: z.string().min(1).max(16_384).refine(value => value.trim().length > 0) }),
  z.strictObject({ kind: z.literal("model"), selection: openCodeSelectionSchema }),
  z.strictObject({ kind: z.literal("compact"), id: z.string().regex(/^msg_[a-f0-9]{64}$/u), delivery: z.literal("steer") }),
]);
type Payload = z.infer<typeof payloadSchema>;

export class OpenCodeActions {
  readonly #evidence;
  readonly #api;
  readonly #native;
  constructor(readonly context: OpenCodeDriverContext, readonly input: AttachConversationInput,
    readonly settings: OpenCodeExecutionSettings) {
    this.#evidence = new OpenCodeMutationEvidenceRepository(context.repository);
    this.#api = new OpenCodeNativeApi(settings.client); this.#native = new OpenCodeNativeMutations(settings.client);
  }
  async perform(input: RegisteredBackendActionInput): Promise<BackendActionResult> {
    requireOpenCodeBinding(this.context, this.input);
    const previous = this.#receipt(input);
    if (previous) {
      const proof = await this.reconcile(input);
      if (proof.outcome === "accepted") return { accepted: true };
      if (previous.disposition === "not_applied") throw notApplied();
      if (previous.disposition !== "prepared") throw uncertain();
    }
    const { scope, binding } = this.input;
    let claimed = false;
    try {
      const read = await this.settings.observe();
      const payload: Payload = previous ? this.#payload(input.applicationOperationId) : (() => {
        if (input.action === "rename") return payloadSchema.parse({ kind: "rename", title: input.title });
        if (input.action === "compact") {
          if (input.instructions?.trim()) throw openCodeConversationError("opencode_compact_instructions_unsupported",
            "OpenCode compaction does not support custom instructions.", "invalid_state");
          return { kind: "compact", delivery: "steer", id: `msg_${openCodeOperationFingerprint({ scope,
            namespace: this.context.nativeNamespaceKey, threadId: binding.applicationThreadId,
            sessionId: binding.backendConversationId, operationId: input.applicationOperationId, kind: "compact" })}` };
        }
        if (input.action === "set_model" && input.provider === this.context.connection.id) {
          return { kind: "model", selection: resolveOpenCodeSelection({ connection: this.context.connection,
            catalog: read.catalog.catalog, modelId: input.modelId, modelPolicy: this.context.modelPolicy }) };
        }
        if (input.action === "set_thinking_level" && read.settings.desired) {
          return { kind: "model", selection: resolveOpenCodeSelection({ connection: this.context.connection,
            catalog: read.catalog.catalog, modelId: qualifiedOpenCodeModelId(read.settings.desired),
            variant: input.level, modelPolicy: this.context.modelPolicy }) };
        }
        throw openCodeConversationError("opencode_action_unsupported", "This OpenCode action is unavailable.", "invalid_state");
      })();
      this.context.repository.database.transaction(() => {
        this.context.repository.reserveOperation(scope, {
          applicationThreadId: binding.applicationThreadId, connectionProfileId: binding.connectionProfileId,
          executionEnvironmentId: binding.executionEnvironmentId, nativeSessionId: binding.backendConversationId,
          applicationOperationId: input.applicationOperationId, operationKind: "action", nativeInputId: payload.kind === "compact" ? payload.id : null,
          requestFingerprint: openCodeOperationFingerprint(input), requestSource: null, deadlineAt: null,
        }, Date.now());
        this.#evidence.prepare(scope, binding.applicationThreadId, input.applicationOperationId, "action", payload);
      }).immediate();
      const dispatch = () => {
        this.settings.assertCurrentSync();
        claimed = this.context.repository.markDispatched(scope, binding.applicationThreadId, input.applicationOperationId, "action", Date.now());
        if (!claimed) throw uncertain();
      };
      if (payload.kind === "rename") {
        await this.settings.assertCurrent();
        dispatch();
        await this.#native.renameSession(binding.backendConversationId, payload.title, this.settings.lifetime);
        const session = await this.#api.getSession(binding.backendConversationId, this.settings.lifetime);
        await this.settings.assertCurrent();
        if (session.location.directory !== this.input.workspace.canonicalPath || session.title !== payload.title) throw uncertain();
      } else if (payload.kind === "compact") {
        // Compaction starts provider work, but cannot silently repair or adopt
        // custom native settings. Unlike ordinary input it never switches model.
        if (!read.settings.desired || read.observed.classification !== "recognized" ||
            !sameOpenCodeSelection(read.observed.resolvedSelection, read.settings.desired)) throw openCodeConversationError(
          "opencode_compact_settings_unavailable", "Choose matching supported OpenCode settings before compacting.", "invalid_state");
        resolveOpenCodeSelection({ connection: this.context.connection, catalog: read.catalog.catalog,
          modelId: qualifiedOpenCodeModelId(read.settings.desired), variant: read.settings.desired.variant, modelPolicy: this.context.modelPolicy });
        const [session, pending] = await Promise.all([this.#api.getSession(binding.backendConversationId, this.settings.lifetime),
          this.#api.getPending(binding.backendConversationId, this.settings.lifetime)]);
        if (session.location.directory !== this.input.workspace.canonicalPath || session.revert ||
            pending.some(item => item.type === "compaction" || item.id === payload.id)) throw openCodeConversationError(
          "opencode_compact_conflict", "Clear the staged revert or pending compaction before compacting.", "invalid_state");
        if (!sameOpenCodeSelection(session.model ?? null, read.settings.desired)) throw openCodeConversationError(
          "opencode_compact_settings_changed", "The active OpenCode settings changed before compaction.", "invalid_state");
        try { await this.#api.getMessage(binding.backendConversationId, payload.id, this.settings.lifetime); throw new Error("occupied"); }
        catch (error) {
          if (!(error instanceof OpenCodeRuntimeError) || error.code !== "opencode_native_not_found") throw openCodeConversationError(
            "opencode_compact_identity_unavailable", "The OpenCode compaction identity could not be reserved.", "invalid_state");
        }
        await this.settings.assertCurrent();
        if (this.context.settings.get(scope, binding.applicationThreadId).revision !== read.settings.revision) throw openCodeConversationError(
          "opencode_compact_settings_changed", "The desired OpenCode settings changed before compaction.", "invalid_state");
        dispatch();
        await this.#native.compact({ sessionID: binding.backendConversationId, id: payload.id, delivery: payload.delivery }, this.settings.lifetime);
        await this.settings.assertCurrent();
      } else await this.settings.apply(payload.selection, read, undefined, dispatch);
      this.#accept(input.applicationOperationId, payload);
      return { accepted: true };
    } catch (cause) {
      const current = this.#receipt(input);
      if (current?.disposition === "accepted") return { accepted: true };
      // A concurrent caller may own an effect; only this caller's local input
      // validation failure can undo its own claim before native dispatch.
      if (current?.disposition === "prepared" || current?.disposition === "dispatched" && claimed && cause instanceof OpenCodeNativeMutationInputError) {
        this.context.repository.recordOutcome(scope, binding.applicationThreadId, input.applicationOperationId, "action", {
          expected: current.disposition, disposition: "not_applied", nativeEvidenceFingerprint: null, now: Date.now(),
        });
      } else if (current && current.disposition !== "not_applied") throw uncertain(cause);
      throw cause instanceof OpenCodeNativeMutationInputError ? notApplied() : mapOpenCodeConversationError(cause);
    }
  }
  async reconcile(input: RegisteredBackendActionInput): Promise<BackendMutationReconciliation> {
    requireOpenCodeBinding(this.context, this.input);
    const receipt = this.#receipt(input);
    if (!receipt || receipt.disposition === "prepared" || receipt.disposition === "not_applied") return { outcome: "not_applied" };
    if (receipt.disposition === "accepted") return { outcome: "accepted" };
    const payload = this.#payload(input.applicationOperationId);
    try {
      await this.settings.assertCurrent();
      const session = await this.#api.getSession(this.input.binding.backendConversationId, this.settings.lifetime);
      await this.settings.assertCurrent();
      if (session.location.directory !== this.input.workspace.canonicalPath) return { outcome: "unknown" };
      const matches = payload.kind === "compact" ? await this.#compactAdmitted(payload)
        : payload.kind === "rename" ? session.title === payload.title
        : sameOpenCodeSelection(session.model ?? null, payload.selection);
      if (!matches) return { outcome: "unknown" };
      await this.settings.assertCurrent();
      this.#accept(input.applicationOperationId, payload);
      return { outcome: "accepted" };
    } catch { return { outcome: "unknown" }; }
  }
  async #compactAdmitted(payload: Extract<Payload, { kind: "compact" }>): Promise<boolean> {
    const sessionID = this.input.binding.backendConversationId;
    const pending = await this.#api.getPending(sessionID, this.settings.lifetime);
    const exact = pending.find(item => item.id === payload.id);
    if (exact) return exact.type === "compaction" && exact.delivery === payload.delivery;
    try { return (await this.#api.getMessage(sessionID, payload.id, this.settings.lifetime)).type === "compaction"; }
    catch (error) { if (error instanceof OpenCodeRuntimeError && error.code === "opencode_native_not_found") return false; throw error; }
  }
  /** Stop cleanup is exact private ownership, never a blanket inbox clear. */
  async withdrawPendingCompactions(signal: AbortSignal, deadlineAt: number): Promise<void> {
    if (Date.now() >= deadlineAt) throw new DOMException("Stop deadline expired", "TimeoutError");
    const budget = AbortSignal.any([this.settings.lifetime, signal, AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()))]);
    await this.settings.assertCurrent(budget);
    const pending = await this.#api.getPending(this.input.binding.backendConversationId, budget);
    await this.settings.assertCurrent(budget);
    for (const item of pending) {
      if (item.type !== "compaction") continue;
      const receipt = this.context.repository.findDispatchedAction(this.input.scope, this.input.binding.applicationThreadId,
        this.input.binding.backendConversationId, item.id);
      if (!receipt) continue;
      const payload = this.#payload(receipt.applicationOperationId);
      if (payload.kind !== "compact" || payload.id !== item.id || payload.delivery !== item.delivery) continue;
      await this.settings.assertCurrent(budget); budget.throwIfAborted();
      if (Date.now() >= deadlineAt) throw new DOMException("Stop deadline expired", "TimeoutError");
      await this.#native.cancelInput({ sessionID: item.sessionID, inboxID: item.id }, budget);
      // A 204 is not cancellation proof. The immutable receipt still records
      // admission, and native history remains authority for execution outcome.
    }
  }
  #receipt(input: RegisteredBackendActionInput): Readonly<OpenCodeOperationReceipt> | undefined {
    const receipt = this.context.repository.readOperation(this.input.scope, this.input.binding.applicationThreadId, input.applicationOperationId, "action");
    if (receipt && receipt.requestFingerprint !== openCodeOperationFingerprint(input)) throw openCodeConversationError(
      "opencode_action_replay_changed", "The OpenCode action differs from its original request.", "invalid_state");
    return receipt;
  }
  #payload(operationId: string): Payload {
    return payloadSchema.parse(this.#evidence.find(this.input.scope, this.input.binding.applicationThreadId, operationId, "action"));
  }
  #accept(operationId: string, payload: Payload): void {
    const { scope, binding } = this.input;
    const receipt = this.context.repository.requireOperation(scope, binding.applicationThreadId, operationId, "action");
    if (receipt.disposition === "accepted") return;
    if (receipt.disposition !== "dispatched" && receipt.disposition !== "unknown") throw uncertain();
    if (!this.context.repository.recordOutcome(scope, binding.applicationThreadId, operationId, "action", {
      expected: receipt.disposition, disposition: "accepted", nativeEvidenceFingerprint: openCodeOperationFingerprint(payload), now: Date.now(),
    })) throw uncertain();
  }
}
function notApplied(): BackendError {
  return openCodeConversationError("opencode_action_not_applied", "The OpenCode action was not sent. Start a new action to retry.", "invalid_state");
}
function uncertain(cause?: unknown): BackendError {
  return new BackendError({ category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false,
    backendCode: "opencode_action_unconfirmed", safeMessage: "The OpenCode action could not be confirmed. Nothing was repeated." }, cause === undefined ? undefined : { cause });
}
