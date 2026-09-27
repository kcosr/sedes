import type { FormDetail, FormInfo, PermissionRequest } from "@opencode/client";
import { z } from "zod";
import { interactionResponseInputSchema, type BackendConversationEvent, type DriverInteraction } from "../../../shared/protocol/backend.js";
import type { BoundedDisplayText } from "../../../shared/protocol/payload.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { snapshotBoundedJson } from "../../provider-protocol/json/bounded-json-snapshot.js";
import { BackendError, type AttachConversationInput, type BackendMutationReconciliation, type InteractionResponseInput } from "../contracts.js";
import { requireOpenCodeBinding, type OpenCodeConversationRuntime, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { openCodeOperationFingerprint } from "./opencode-input-evidence.js";
import { mapOpenCodeForm, mapOpenCodePermission, OpenCodeInteractionMappingError, resolveOpenCodeInteractionResponse,
  type OpenCodeInteractionAuthority, type OpenCodeInteractionMapResult, type OpenCodeInteractionNativeResponse } from "./opencode-interaction-mapper.js";
import { OpenCodeMutationEvidenceRepository } from "./opencode-mutation-evidence.js";
import { OpenCodeNativeApi, OpenCodeNativeProtocolError, type OpenCodeNativeEvent, type OpenCodeNativeInteractions } from "./opencode-native-api.js";
import { OpenCodeNativeMutations, OpenCodeNativeMutationInputError } from "./opencode-native-mutations.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import type { OpenCodeRuntimeLease } from "./opencode-runtime.js";
import type { OpenCodeOperationReceipt } from "./opencode-thread-repository.js";

type Mapped = Extract<OpenCodeInteractionMapResult, { status: "mapped" }>;
type Source = "permission" | "form";
interface Gate { readonly source: Source; readonly nativeId: string; readonly mapped: Mapped; }
const MAX_GATES = 1_000;
const jsonLimits = { maximumDepth: 32, maximumObjectProperties: 10_000, maximumArrayItems: 10_000,
  maximumTotalNodes: 100_000, maximumStringBytes: 1_048_576, maximumEncodedBytes: 1_048_576 };
const nativeResponseSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("permission_reply"), input: z.strictObject({ sessionID: z.string(), requestID: z.string(), decision: z.enum(["once", "reject"]) }) }),
  z.strictObject({ kind: z.literal("form_reply"), input: z.strictObject({ sessionID: z.string(), formID: z.string(), answer: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())])) }) }),
  z.strictObject({ kind: z.literal("form_cancel"), input: z.strictObject({ sessionID: z.string(), formID: z.string() }) }),
]);
const intentSchema = z.strictObject({ version: z.literal(1), source: z.enum(["permission", "form"]), nativeId: z.string().min(1).max(256),
  requestFingerprint: z.string().regex(/^ocif_[A-Za-z0-9_-]{43}$/u), generation: z.string().min(1).max(512),
  interactionId: z.string().min(1).max(512), responseFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), automatic: z.boolean(),
  nativeResponse: nativeResponseSchema });
type Intent = z.infer<typeof intentSchema>;

/** Exact session-owned native gates; history and transcript state are not authority. */
export class OpenCodeInteractions {
  readonly #api: OpenCodeNativeApi;
  readonly #native: OpenCodeNativeMutations;
  readonly #evidence: OpenCodeMutationEvidenceRepository;
  readonly #authority: OpenCodeInteractionAuthority;
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  readonly #gates = new Map<string, Gate>();
  readonly #notices = new Set<string>();
  readonly #operations = new Map<string, { readonly fingerprint: string; readonly promise: Promise<void> }>();
  #refresh: Promise<void> | undefined;
  #refreshAgain = false;
  #closed = false;

  constructor(readonly context: OpenCodeDriverContext, readonly attach: AttachConversationInput,
    readonly runtime: OpenCodeConversationRuntime, readonly lease: OpenCodeRuntimeLease, lifetime: AbortSignal,
    readonly generation: string, readonly emit: (event: BackendConversationEvent) => void) {
    const detail = requireOpenCodeBinding(context, attach);
    this.#authority = { ...context.scope, applicationThreadId: attach.binding.applicationThreadId,
      backendInstanceId: context.instance.id, sessionID: detail.sessionId, generation };
    this.#api = new OpenCodeNativeApi(lease.client); this.#native = new OpenCodeNativeMutations(lease.client);
    this.#evidence = new OpenCodeMutationEvidenceRepository(context.repository);
    this.#signal = AbortSignal.any([lifetime, lease.client.lifetime, this.#controller.signal]);
    this.#signal.addEventListener("abort", () => this.close(), { once: true });
  }

  async refresh(inventory?: OpenCodeNativeInteractions): Promise<void> {
    this.#assertOpen();
    if (this.#refresh) { this.#refreshAgain = true; return this.#refresh; }
    const reading = (async () => {
      let supplied = inventory;
      do {
        this.#refreshAgain = false; await this.#assertCurrent();
        const current = supplied ?? await this.#api.getInteractions(this.#authority.sessionID, this.#signal); supplied = undefined;
        this.#assertOpen();
        if (current.permissions.length + current.forms.length > MAX_GATES) throw new OpenCodeNativeProtocolError();
        const next = new Map<string, Gate>();
        for (const request of current.permissions) this.#include(next, "permission", request);
        for (const request of current.forms) this.#include(next, "form", request);
        for (const id of this.#gates.keys()) if (!next.has(id)) this.#send({ type: "interaction_resolved", backendInteractionId: id });
        for (const [id, gate] of next) if (!this.#gates.has(id)) this.#send({ type: "interaction_opened", interaction: gate.mapped.interaction });
        this.#gates.clear(); for (const [id, gate] of next) this.#gates.set(id, gate);
      } while (this.#refreshAgain && !this.#signal.aborted);
    })();
    this.#refresh = reading;
    try { await reading; } finally { if (this.#refresh === reading) this.#refresh = undefined; }
  }

  observe(event: OpenCodeNativeEvent): void {
    if (this.#closed) return;
    if (event.type === "form.created" && event.data.form.sessionID !== this.#authority.sessionID) {
      const result = mapOpenCodeForm({ request: event.data.form, authority: this.#authority, openedAt: new Date().toISOString() });
      if (result.status === "unowned") this.#notice(`unowned:${event.data.form.id}`, result.notice);
      return;
    }
    const relevant = event.type === "form.created" ? event.data.form.sessionID === this.#authority.sessionID
      : ["form.replied", "form.cancelled", "permission.asked", "permission.replied"].includes(event.type) &&
        "sessionID" in event.data && event.data.sessionID === this.#authority.sessionID;
    if (relevant) void this.refresh().catch(() => this.#notice("refresh_failed", boundDisplayText("OpenCode's pending interactions could not be refreshed. Reconnect before answering a stale request.")));
  }

  snapshotInteractions(): DriverInteraction[] { this.#assertOpen(); return [...this.#gates.values()].map(gate => gate.mapped.interaction); }

  async respond(input: InteractionResponseInput): Promise<void> {
    this.#assertOpen(); const response = this.#parseResponse(input);
    const fingerprint = openCodeOperationFingerprint(response);
    const previous = this.#receipt(response.applicationOperationId);
    if (previous) {
      if (previous.requestFingerprint !== fingerprint) throw invalid("The interaction response differs from its reserved operation.");
      if (previous.disposition === "accepted") return;
      if (previous.disposition === "not_applied") throw invalid("This interaction response was not applied.");
      if (previous.disposition !== "prepared") {
        const result = await this.reconcileInteractionResponse(response);
        if (result.outcome === "accepted") return;
        throw unknown();
      }
    }
    const gate = this.#gates.get(response.interactionId);
    if (!gate) throw invalid("This OpenCode interaction is no longer pending in this conversation.");
    let nativeResponse: OpenCodeInteractionNativeResponse;
    try { nativeResponse = resolveOpenCodeInteractionResponse({ mapping: gate.mapped.mapping, authority: this.#authority,
      requestFingerprint: gate.mapped.requestFingerprint, response }); }
    catch (error) {
      if (error instanceof OpenCodeInteractionMappingError && error.code === "permission_cancel_unsupported") {
        this.#notice(`permission_cancel:${response.interactionId}`, error.notice!);
        throw new BackendError({ category: "invalid_state", crossedSubmissionBoundary: false, retryable: false,
          backendCode: "opencode_permission_cancel_unsupported", safeMessage: error.notice!.text });
      }
      throw invalid("The interaction response does not satisfy the original OpenCode request.");
    }
    const intent: Intent = { version: 1, source: gate.source, nativeId: gate.nativeId,
      requestFingerprint: gate.mapped.requestFingerprint, generation: this.generation, interactionId: response.interactionId,
      responseFingerprint: fingerprint, automatic: false, nativeResponse: nativeResponseSchema.parse(nativeResponse) };
    if (previous) {
      const stored = this.#intent(response.applicationOperationId);
      if (openCodeOperationFingerprint(stored) !== openCodeOperationFingerprint(intent)) throw invalid("The reserved OpenCode interaction belongs to a different request or generation.");
    }
    await this.#dispatch(response.applicationOperationId, intent);
  }

  async reconcileInteractionResponse(input: InteractionResponseInput): Promise<BackendMutationReconciliation> {
    this.#assertOpen(); const response = this.#parseResponse(input); const receipt = this.#receipt(response.applicationOperationId);
    if (!receipt) return { outcome: "not_applied" };
    if (receipt.requestFingerprint !== openCodeOperationFingerprint(response)) throw invalid("The interaction response differs from its reserved operation.");
    return this.#reconcile(receipt, this.#intent(response.applicationOperationId));
  }

  close(): void {
    if (this.#closed) return; this.#closed = true; this.#controller.abort(); this.#gates.clear(); this.#notices.clear();
  }

  #include(next: Map<string, Gate>, source: Source, request: PermissionRequest | FormInfo): void {
    const old = [...this.#gates.values()].find(gate => gate.source === source && gate.nativeId === request.id);
    const openedAt = old?.mapped.interaction.openedAt ?? new Date().toISOString();
    const result = this.#map(source, request, openedAt);
    if (result.status === "mapped") {
      if (next.has(result.interaction.backendInteractionId)) throw new OpenCodeNativeProtocolError();
      next.set(result.interaction.backendInteractionId, { source, nativeId: request.id, mapped: result }); return;
    }
    this.#notice(`${source}:${request.id}:${result.status}`, result.notice);
    if (result.status !== "unsupported") return;
    const operationId = `oc_form_cleanup_${openCodeOperationFingerprint({ scope: this.context.scope,
      threadId: this.#authority.applicationThreadId, sessionID: this.#authority.sessionID, id: request.id, request: result.requestFingerprint })}`;
    const existing = this.#receipt(operationId);
    // A refreshed gate is not authorization to retry a previously dispatched
    // cancellation, even if its response was lost or native state still says pending.
    if (existing && existing.disposition !== "prepared") return;
    const nativeResponse = { kind: "form_cancel" as const, input: result.cancel };
    const intent: Intent = { version: 1, source: "form", nativeId: request.id, requestFingerprint: result.requestFingerprint,
      generation: this.generation, interactionId: `oci_cleanup_${openCodeOperationFingerprint(result.cancel)}`,
      responseFingerprint: openCodeOperationFingerprint({ automatic: true, requestFingerprint: result.requestFingerprint, nativeResponse }),
      automatic: true, nativeResponse };
    // No history hydration or actor mailbox waits for the exact form cleanup.
    void this.#dispatch(operationId, intent).catch(() => this.#notice(`cleanup_unknown:${operationId}`,
      boundDisplayText("The unsupported OpenCode form could not be confirmed cancelled. Its exact response was not retried; reconnect or use the native client to inspect it.")));
  }

  #map(source: Source, request: PermissionRequest | FormInfo, openedAt: string): OpenCodeInteractionMapResult {
    return source === "permission" ? mapOpenCodePermission({ request: request as PermissionRequest, authority: this.#authority, openedAt })
      : mapOpenCodeForm({ request: request as FormInfo, authority: this.#authority, openedAt });
  }
  #parseResponse(input: unknown): InteractionResponseInput {
    try { return interactionResponseInputSchema.parse(snapshotBoundedJson(input, jsonLimits)); }
    catch { throw invalid("The interaction response is invalid."); }
  }
  #receipt(operationId: string): Readonly<OpenCodeOperationReceipt> | undefined {
    return this.context.repository.readOperation(this.context.scope, this.#authority.applicationThreadId, operationId, "interaction");
  }
  #intent(operationId: string): Intent {
    const intent = intentSchema.parse(snapshotBoundedJson(this.#evidence.find(this.context.scope, this.#authority.applicationThreadId, operationId, "interaction"), jsonLimits));
    const native = intent.nativeResponse;
    if (native.input.sessionID !== this.#authority.sessionID ||
        (native.kind === "permission_reply" ? intent.source !== "permission" || native.input.requestID !== intent.nativeId
          : intent.source !== "form" || native.input.formID !== intent.nativeId)) throw new OpenCodeNativeProtocolError();
    return intent;
  }
  async #fresh(intent: Intent): Promise<{ request: PermissionRequest | FormInfo; detail?: FormDetail }> {
    if (intent.source === "permission") return { request: await this.#native.getPermission({ sessionID: this.#authority.sessionID, requestID: intent.nativeId }, this.#signal) };
    const detail = await this.#native.getForm({ sessionID: this.#authority.sessionID, formID: intent.nativeId }, this.#signal);
    const { state: _state, ...request } = detail; return { request, detail };
  }
  #sameRequest(intent: Intent, request: PermissionRequest | FormInfo): boolean {
    const result = this.#map(intent.source, request, new Date().toISOString());
    return result.status !== "unowned" && result.requestFingerprint === intent.requestFingerprint;
  }
  async #dispatch(operationId: string, intent: Intent): Promise<void> {
    const fingerprint = openCodeOperationFingerprint(intent);
    const running = this.#operations.get(operationId);
    if (running) { if (running.fingerprint !== fingerprint) throw invalid("The interaction response differs from its in-flight operation."); return running.promise; }
    if (this.#operations.size >= MAX_GATES) throw new OpenCodeNativeProtocolError();
    const dispatching = (async () => {
      this.#assertOpen();
      if (intent.generation !== this.generation) throw invalid("This OpenCode interaction belongs to a stale generation.");
      await this.#assertCurrent();
      const current = await this.#fresh(intent); await this.#assertCurrent();
      if (!this.#sameRequest(intent, current.request) || current.detail && current.detail.state.status !== "pending") throw invalid("The native OpenCode request has changed or is already settled.");
      const receipt = this.context.repository.reserveOperation(this.context.scope, {
        applicationThreadId: this.#authority.applicationThreadId, connectionProfileId: this.attach.binding.connectionProfileId,
        executionEnvironmentId: this.attach.binding.executionEnvironmentId, nativeSessionId: this.#authority.sessionID,
        applicationOperationId: operationId, operationKind: "interaction", nativeInputId: `${intent.source}:${intent.nativeId}`,
        requestFingerprint: intent.responseFingerprint, requestSource: null, deadlineAt: null,
      }, Date.now());
      this.#evidence.prepare(this.context.scope, this.#authority.applicationThreadId, operationId, "interaction", intent);
      if (receipt.disposition === "accepted") return;
      if (receipt.disposition !== "prepared") throw unknown();
      this.#assertOpen();
      if (!this.context.repository.markDispatched(this.context.scope, this.#authority.applicationThreadId, operationId, "interaction", Date.now())) throw unknown();
      try {
        if (intent.nativeResponse.kind === "permission_reply") await this.#native.replyPermission(intent.nativeResponse.input, this.#signal);
        else if (intent.nativeResponse.kind === "form_reply") await this.#native.replyForm(intent.nativeResponse.input, this.#signal);
        else await this.#native.cancelForm(intent.nativeResponse.input, this.#signal);
        await this.#assertCurrent();
        this.#outcome(operationId, "accepted", openCodeOperationFingerprint({ kind: "native_response_ack", intent }));
        this.#resolveGate(intent.interactionId);
        // Reject may settle several permission requests. Refresh presentation
        // without forging response receipts for those external settlements.
        void this.refresh().catch(() => undefined);
      } catch (error) {
        if (error instanceof OpenCodeNativeMutationInputError) {
          this.#outcome(operationId, "not_applied", null); throw invalid("The OpenCode response was rejected before dispatch.");
        }
        this.#outcome(operationId, "unknown", null); throw unknown();
      }
    })();
    this.#operations.set(operationId, { fingerprint, promise: dispatching });
    try { await dispatching; } finally { if (this.#operations.get(operationId)?.promise === dispatching) this.#operations.delete(operationId); }
  }

  async #reconcile(receipt: Readonly<OpenCodeOperationReceipt>, intent: Intent): Promise<BackendMutationReconciliation> {
    if (receipt.disposition === "accepted") return { outcome: "accepted" };
    if (receipt.disposition === "prepared" || receipt.disposition === "not_applied") return { outcome: "not_applied" };
    if (intent.source === "permission") return { outcome: "unknown" };
    try {
      await this.#assertCurrent(); const current = await this.#fresh(intent); await this.#assertCurrent();
      if (!this.#sameRequest(intent, current.request) || !current.detail) return { outcome: "unknown" };
      const state = current.detail.state; const response = intent.nativeResponse;
      const accepted = response.kind === "form_cancel" && state.status === "cancelled" ||
        response.kind === "form_reply" && state.status === "answered" && openCodeOperationFingerprint(state.answer) === openCodeOperationFingerprint(response.input.answer);
      if (!accepted) return { outcome: "unknown" };
      this.#outcome(receipt.applicationOperationId, "accepted", openCodeOperationFingerprint({ kind: "exact_form_terminal", intent, state }));
      this.#resolveGate(intent.interactionId); return { outcome: "accepted" };
    } catch { return { outcome: "unknown" }; }
  }
  #outcome(operationId: string, disposition: "accepted" | "not_applied" | "unknown", fingerprint: string | null): void {
    const receipt = this.#receipt(operationId)!;
    if (receipt.disposition === "accepted" || receipt.disposition === "not_applied") return;
    this.context.repository.recordOutcome(this.context.scope, this.#authority.applicationThreadId, operationId, "interaction", {
      expected: receipt.disposition, disposition, nativeEvidenceFingerprint: fingerprint, now: Date.now(),
    });
  }
  #assertOpen(): void {
    this.#signal.throwIfAborted();
    if (this.#closed || this.runtime.nativeNamespaceKey !== this.context.nativeNamespaceKey || this.runtime.snapshot().generation !== this.lease.generation) throw new OpenCodeRuntimeError("opencode_interaction_generation_stale");
    requireOpenCodeBinding(this.context, this.attach);
  }
  async #assertCurrent(): Promise<void> { this.#assertOpen(); await this.runtime.assertCurrent(this.#signal); this.#assertOpen(); }
  #resolveGate(id: string): void { if (this.#gates.delete(id)) this.#send({ type: "interaction_resolved", backendInteractionId: id }); }
  #notice(key: string, message: BoundedDisplayText): void {
    if (this.#closed || this.#notices.has(key)) return;
    if (this.#notices.size >= MAX_GATES) this.#notices.delete(this.#notices.values().next().value!);
    this.#notices.add(key); this.#send({ type: "notice", notice: { id: `ocn_${openCodeOperationFingerprint(key)}`, tone: "warning", message, createdAt: new Date().toISOString() } });
  }
  #send(event: BackendConversationEvent): void {
    if (this.#closed) return;
    try { void Promise.resolve(this.emit(event)).catch(() => undefined); } catch { /* Listener failures do not change native response authority. */ }
  }
}
function invalid(message: string): BackendError {
  return new BackendError({ category: "invalid_state", crossedSubmissionBoundary: false, retryable: false, backendCode: "opencode_interaction_invalid", safeMessage: message });
}
function unknown(): BackendError {
  return new BackendError({ category: "submission_unknown", crossedSubmissionBoundary: true, retryable: false,
    backendCode: "opencode_interaction_response_unknown", safeMessage: "OpenCode did not confirm this interaction response. It has not been retried." });
}
