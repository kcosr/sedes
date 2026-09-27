import { z } from "zod";
import { BackendError, type AttachConversationInput, type BackendActionResult, type BackendMutationReconciliation,
  type RegisteredBackendActionInput } from "../contracts.js";
import { openCodeConversationError, requireOpenCodeBinding, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import type { OpenCodeExecutionSettings } from "./opencode-execution-settings.js";
import { openCodeOperationFingerprint } from "./opencode-input-evidence.js";
import { OpenCodeMutationEvidenceRepository } from "./opencode-mutation-evidence.js";
import { OpenCodeNativeApi } from "./opencode-native-api.js";
import { OpenCodeNativeMutations } from "./opencode-native-mutations.js";
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
      if (previous.disposition !== "prepared") throw uncertain();
    }
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
    const { scope, binding } = this.input;
    this.context.repository.database.transaction(() => {
      this.context.repository.reserveOperation(scope, {
        applicationThreadId: binding.applicationThreadId, connectionProfileId: binding.connectionProfileId,
        executionEnvironmentId: binding.executionEnvironmentId, nativeSessionId: binding.backendConversationId,
        applicationOperationId: input.applicationOperationId, operationKind: "action", nativeInputId: null,
        requestFingerprint: openCodeOperationFingerprint(input), requestSource: null, deadlineAt: null,
      }, Date.now());
      this.#evidence.prepare(scope, binding.applicationThreadId, input.applicationOperationId, "action", payload);
    }).immediate();
    await this.settings.assertCurrent();
    if (!this.context.repository.markDispatched(scope, binding.applicationThreadId, input.applicationOperationId, "action", Date.now())) throw uncertain();
    try {
      if (payload.kind === "rename") {
        await this.#native.renameSession(binding.backendConversationId, payload.title);
        const session = await this.#api.getSession(binding.backendConversationId);
        await this.settings.assertCurrent();
        if (session.location.directory !== this.input.workspace.canonicalPath || session.title !== payload.title) throw uncertain();
      } else await this.settings.apply(payload.selection, read);
      this.#accept(input.applicationOperationId, payload);
      return { accepted: true };
    } catch (cause) { throw uncertain(cause); }
  }
  async reconcile(input: RegisteredBackendActionInput): Promise<BackendMutationReconciliation> {
    requireOpenCodeBinding(this.context, this.input);
    const receipt = this.#receipt(input);
    if (!receipt || receipt.disposition === "prepared" || receipt.disposition === "not_applied") return { outcome: "not_applied" };
    if (receipt.disposition === "accepted") return { outcome: "accepted" };
    const payload = this.#payload(input.applicationOperationId);
    try {
      const read = await this.settings.observe();
      const matches = payload.kind === "rename" ? read.session.title === payload.title
        : read.observed.classification === "recognized" && sameOpenCodeSelection(read.session.model ?? null, payload.selection);
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
    this.context.repository.recordOutcome(scope, binding.applicationThreadId, operationId, "action", {
      expected: receipt.disposition, disposition: "accepted", nativeEvidenceFingerprint: openCodeOperationFingerprint(payload), now: Date.now(),
    });
  }
}
function uncertain(cause?: unknown): BackendError {
  return new BackendError({ category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false,
    backendCode: "opencode_action_unconfirmed", safeMessage: "The OpenCode action could not be confirmed. Nothing was repeated." }, cause === undefined ? undefined : { cause });
}
