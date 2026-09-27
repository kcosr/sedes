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

const payloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("rename"), title: z.string().min(1).max(16_384).refine(value => value.trim().length > 0) }),
  z.strictObject({ kind: z.literal("model"), selection: openCodeSelectionSchema }),
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
          applicationOperationId: input.applicationOperationId, operationKind: "action", nativeInputId: null,
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
      const matches = payload.kind === "rename" ? session.title === payload.title
        : sameOpenCodeSelection(session.model ?? null, payload.selection);
      if (!matches) return { outcome: "unknown" };
      this.#accept(input.applicationOperationId, payload);
      return { outcome: "accepted" };
    } catch { return { outcome: "unknown" }; }
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
