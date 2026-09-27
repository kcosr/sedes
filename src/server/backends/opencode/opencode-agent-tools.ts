import type { AttachConversationInput } from "../contracts.js";
import type { AgentToolSourceCapabilityIssuer, AgentToolSourceCapabilityTransport } from "../../agent-tools/application/database-agent-tool-source-authority.js";
import { BackendAgentToolRequestError, type BackendAgentToolAccessDecisionAuthority,
  type BackendAgentToolFacade, type TrustedAgentToolSource } from "../../agent-tools/adapters/backend-facade.js";
import { openCodeRuntimeTarget, requireOpenCodeBinding, type OpenCodeConversationRuntime, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { findOpenCodeInputObserver } from "./opencode-input-observer.js";
import type { OpenCodeNativePort } from "./opencode-native-port.js";
import { OpenCodeNativeApi } from "./opencode-native-api.js";
import type { OpenCodeMcpRequest } from "../../../internal/opencode-mcp/contracts.js";
import type { OpenCodeHostToolAdmissionResult } from "./opencode-host-agent-tools.js";
import { acknowledgeOpenCodeMutation } from "./opencode-operation-control.js";

interface Admission { readonly context: OpenCodeDriverContext; readonly input: AttachConversationInput;
  readonly runtime: OpenCodeConversationRuntime; readonly client: OpenCodeNativePort; readonly generation: string;
  readonly owner: AbortController; readonly sourceCapability: string;
  readonly releaseLease: () => void;
  readonly source: TrustedAgentToolSource; readonly onOwnerLost: () => void;
  host?: OpenCodeHostToolAdmissionResult; diagnostic?: string; }

/** Main owns application admission and current policy; the execution host owns the MCP process. */
export class OpenCodeAgentTools {
  readonly #sessions = new Map<string, Admission>();
  readonly #admitting = new Map<string, Promise<void>>();
  readonly #admissionOwners = new Map<string, AbortController>();
  #closed = false;
  constructor(readonly options: { readonly facade: BackendAgentToolFacade;
    readonly sourceCapabilities: AgentToolSourceCapabilityIssuer;
    readonly sourceCapabilityTransport: AgentToolSourceCapabilityTransport }) {}

  admit(context: OpenCodeDriverContext, input: AttachConversationInput, runtime: OpenCodeConversationRuntime, signal?: AbortSignal): Promise<void> {
    requireOpenCodeBinding(context, input); signal?.throwIfAborted();
    const threadId = input.binding.applicationThreadId;
    const pending = this.#admitting.get(threadId); if (pending) return pending;
    const owner = new AbortController(); this.#admissionOwners.set(threadId, owner);
    const task = this.#admit(context, input, runtime, signal ? AbortSignal.any([signal, owner.signal]) : owner.signal).finally(() => {
      if (this.#admitting.get(threadId) === task) this.#admitting.delete(threadId);
      if (this.#admissionOwners.get(threadId) === owner) this.#admissionOwners.delete(threadId);
    });
    this.#admitting.set(threadId, task); return task;
  }
  async #admit(context: OpenCodeDriverContext, input: AttachConversationInput, runtime: OpenCodeConversationRuntime, signal?: AbortSignal): Promise<void> {
    if (this.#closed) return;
    const source: TrustedAgentToolSource = { scope: context.scope, sourceThreadId: input.binding.applicationThreadId,
      sourceWorkspaceId: input.workspace.summary.id, sourceEnvironmentId: input.binding.executionEnvironmentId, backendKind: "opencode" };
    if (!context.repository.hasCreatedRoot(input.scope, source.sourceThreadId, input.binding.backendConversationId)) return;
    let admission = this.#sessions.get(source.sourceThreadId);
    if (admission && (admission.generation !== runtime.snapshot().generation || admission.client.lifetime.aborted ||
        admission.input.opaqueBindingDetail !== input.opaqueBindingDetail)) { this.#releaseSession(source.sourceThreadId); admission = undefined; }
    if (!admission) {
      if (this.#sessions.size >= 1_000) return;
      const lease = runtime.acquire(openCodeRuntimeTarget(input)); const owner = new AbortController();
      try {
        const session = await new OpenCodeNativeApi(lease.client).getSession(input.binding.backendConversationId, signal);
        await runtime.assertCurrent(signal); requireOpenCodeBinding(context, input); signal?.throwIfAborted();
        if (this.#closed || session.parentID || session.fork || session.location.directory !== input.workspace.canonicalPath) return;
        const onOwnerLost = () => { if (this.#sessions.get(source.sourceThreadId) === admission) this.release(source.sourceThreadId); };
        admission = { context, input, runtime, client: lease.client, generation: lease.generation, owner, source, onOwnerLost,
          releaseLease: lease.release, sourceCapability: this.options.sourceCapabilities.issue(source, this.options.sourceCapabilityTransport, "mcp") };
        this.#sessions.set(source.sourceThreadId, admission);
        lease.client.lifetime.addEventListener("abort", onOwnerLost, { once: true });
      } catch { owner.abort(); return; }
      finally { if (!admission) lease.release(); }
    }
    const policy = this.options.facade.readPolicy(source);
    if (!policy.enabled) return;
    try {
      const catalog = this.options.facade.eligibleCatalog("mcp").map(({ id, schemaVersion, catalog, description, effects }) =>
        ({ id, schemaVersion, label: catalog.label, description, group: { id: catalog.groupId, order: catalog.order }, effects }));
      const cli = policy.presentation.surface === "cli" ? {
        sourceCapability: this.options.sourceCapabilities.issue(source, this.options.sourceCapabilityTransport, "cli"), mode: policy.presentation.mode,
      } : undefined;
      const previousHost = admission.host;
      admission.host = await runtime.admitToolSession(openCodeRuntimeTarget(input), {
        sourceCapability: admission.sourceCapability, catalog, ...(cli ? { cli } : {}),
      }, signal);
      if (policy.presentation.surface === "native" && JSON.stringify(previousHost?.registrationControl) !== JSON.stringify(admission.host.registrationControl)) {
        try { await admission.client.mutate("ensureMcpRegistration", {
          directory: input.workspace.canonicalPath, registrationAdmissionId: admission.host.registrationAdmissionId,
        }, admission.host.registrationControl, { signal }); }
        finally {
          // Registration has host-owned retry/lifetime proof. Release this
          // attempt on either outcome, and never ACK a cached nondispatch.
          await acknowledgeOpenCodeMutation(admission.client, "ensureMcpRegistration", admission.host.registrationControl);
        }
      }
      admission.diagnostic = undefined;
    } catch {
      // A retry receives a fresh host operation identity even when refusal
      // happened before the registration hook could mark its location failed.
      runtime.releaseToolSession(openCodeRuntimeTarget(input)); admission.host = undefined;
      admission.diagnostic = "Sedes OpenCode tools are unavailable. Conversation controls remain available; retry tool admission on a later message.";
    }
  }
  release(threadId: string): void {
    this.#admissionOwners.get(threadId)?.abort(); this.#admissionOwners.delete(threadId); this.#admitting.delete(threadId);
    this.#releaseSession(threadId);
  }
  #releaseSession(threadId: string): void {
    const entry = this.#sessions.get(threadId); if (!entry) return;
    this.#sessions.delete(threadId); entry.client.lifetime.removeEventListener("abort", entry.onOwnerLost); entry.owner.abort();
    entry.runtime.releaseToolSession(openCodeRuntimeTarget(entry.input));
    entry.releaseLease();
  }
  diagnostic(threadId: string): string | undefined { return this.#sessions.get(threadId)?.diagnostic; }
  cliAdmission(threadId: string): string | null { return this.#sessions.get(threadId)?.host?.cliAdmissionId ?? null; }
  gatewayAction(threadId: string, action: string): string | undefined {
    const name = this.#sessions.get(threadId)?.host?.registrationName;
    if (!name) return undefined;
    for (const [gateway, title] of Object.entries({ sedes_catalog: "Sedes tool catalog", sedes_read: "Sedes read", sedes_act: "Sedes action" })) {
      if (action === `${name}_${gateway}`) return title;
    }
    return undefined;
  }
  accessDecisionAuthority(source: TrustedAgentToolSource): BackendAgentToolAccessDecisionAuthority {
    return { acquire: async signal => {
      const entry = this.#sessions.get(source.sourceThreadId);
      if (!entry || !sameSource(entry.source, source)) throw denied();
      await this.#assertCurrent(entry, signal);
      const observer = findOpenCodeInputObserver(entry.client, entry.input);
      if (!observer) throw denied();
      return observer.accessDecisionAuthority().acquire(signal);
    } };
  }
  /** Local composition uses this same capability-shaped relay as remote hosts. */
  async callHostTool(sourceCapability: string, request: OpenCodeMcpRequest, signal: AbortSignal): Promise<unknown> {
    const entries = [...this.#sessions.values()].filter(entry => entry.sourceCapability === sourceCapability &&
      entry.input.binding.backendConversationId === request.sessionID);
    if (entries.length !== 1) throw denied();
    const entry = entries[0]!; await this.#assertCurrent(entry, signal);
    switch (request.operation) {
      case "list": return { tools: this.options.facade.catalogSummaries(entry.source, "mcp") };
      case "describe": return { tools: this.options.facade.describeMany(entry.source, "mcp", request.toolIds) };
      case "invoke": return this.options.facade.invoke({ source: entry.source, adapter: "mcp", request: request.request,
        signal: AbortSignal.any([signal, entry.owner.signal]), accessDecisionAuthority: this.accessDecisionAuthority(entry.source) });
    }
  }
  async close(): Promise<void> {
    this.#closed = true; const pending = [...this.#admitting.values()];
    for (const owner of this.#admissionOwners.values()) owner.abort();
    this.#admissionOwners.clear(); for (const threadId of this.#sessions.keys()) this.release(threadId);
    await Promise.allSettled(pending);
  }
  async #assertCurrent(entry: Admission, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#closed || this.#sessions.get(entry.source.sourceThreadId) !== entry || entry.owner.signal.aborted ||
        entry.client.lifetime.aborted || entry.runtime.snapshot().generation !== entry.generation) throw denied();
    const lease = entry.runtime.acquire(openCodeRuntimeTarget(entry.input));
    try {
      if (lease.client.ownerKey !== entry.client.ownerKey || lease.generation !== entry.generation) throw denied();
      requireOpenCodeBinding(entry.context, entry.input); await entry.runtime.assertCurrent(signal);
      const session = await new OpenCodeNativeApi(lease.client).getSession(entry.input.binding.backendConversationId, signal);
      await entry.runtime.assertCurrent(signal); signal.throwIfAborted(); requireOpenCodeBinding(entry.context, entry.input);
      if (session.parentID || session.fork || session.location.directory !== entry.input.workspace.canonicalPath ||
          this.#sessions.get(entry.source.sourceThreadId) !== entry || entry.owner.signal.aborted || entry.client.lifetime.aborted) throw denied();
    } finally { lease.release(); }
  }
}
function sameSource(a: TrustedAgentToolSource, b: TrustedAgentToolSource): boolean {
  return a.scope.tenantId === b.scope.tenantId && a.scope.principalId === b.scope.principalId && a.backendKind === b.backendKind &&
    a.sourceThreadId === b.sourceThreadId && a.sourceEnvironmentId === b.sourceEnvironmentId && a.sourceWorkspaceId === b.sourceWorkspaceId;
}
function denied() { return new BackendAgentToolRequestError({ code: "permission_denied", retryable: false,
  message: "This OpenCode session is not admitted to Sedes tools." }); }
