import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AttachConversationInput } from "../contracts.js";
import type { AgentToolCliAvailability } from "../module.js";
import { BackendAgentToolRequestError, type BackendAgentToolAccessDecisionAuthority,
  type BackendAgentToolFacade, type TrustedAgentToolSource } from "../../agent-tools/adapters/backend-facade.js";
import { requireOpenCodeBinding, type OpenCodeConversationRuntime, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { acquireOpenCodeInputObserver } from "./opencode-input-observer.js";
import type { OpenCodeHttpClient } from "./opencode-http-client.js";
import type { OpenCodeRuntimeLease } from "./opencode-runtime.js";
import { OpenCodeNativeApi } from "./opencode-native-api.js";
import { OpenCodeMcpIngress, type OpenCodeMcpChannel } from "./opencode-mcp-ingress.js";
import { OPENCODE_MCP_STARTUP_MS, OPENCODE_MCP_WATCHDOG_MS, type OpenCodeMcpRequest } from "../../../internal/opencode-mcp/contracts.js";

const inventorySchema = z.object({ location: z.object({ directory: z.string().optional() }).strict(),
  data: z.array(z.object({ name: z.string().max(256), status: z.object({ status: z.enum(["connected", "pending", "disabled", "failed", "needs_auth"]), error: z.string().max(65_536).optional() }).strict(), integrationID: z.string().max(256).optional() }).passthrough()).max(256) }).strict();
interface Admission { readonly context: OpenCodeDriverContext; readonly input: AttachConversationInput;
  readonly runtime: OpenCodeConversationRuntime; readonly lease: OpenCodeRuntimeLease;
  readonly observation: ReturnType<typeof acquireOpenCodeInputObserver>; readonly owner: AbortController;
  readonly source: TrustedAgentToolSource; readonly onOwnerLost: () => void; diagnostic?: string; }
interface Registration { readonly name: string; readonly channel: OpenCodeMcpChannel;
  readonly ready: Promise<void>; readonly createdAt: number; }
interface LocationState { admissionCount: number; registration?: Registration; retryAfter: number; }

/** Provider-owned routing/observation survives idle actor eviction, but never residency release. */
export class OpenCodeAgentTools {
  readonly #ingress = new OpenCodeMcpIngress();
  readonly #sessions = new Map<string, Admission>();
  readonly #admitting = new Map<string, Promise<void>>();
  readonly #admissionOwners = new Map<string, AbortController>();
  readonly #locations = new WeakMap<OpenCodeHttpClient, Map<string, LocationState>>();
  readonly #registrationTasks = new WeakMap<OpenCodeHttpClient, Map<string, Promise<void>>>();
  readonly #registrations = new Set<Registration>();
  #closed = false;
  #admissions = 0;
  constructor(readonly options: { readonly facade: BackendAgentToolFacade; readonly cli: AgentToolCliAvailability }) {}

  admit(context: OpenCodeDriverContext, input: AttachConversationInput, runtime: OpenCodeConversationRuntime, signal?: AbortSignal): Promise<void> {
    requireOpenCodeBinding(context, input); signal?.throwIfAborted();
    const threadId = input.binding.applicationThreadId;
    const pending = this.#admitting.get(threadId); if (pending) return pending;
    const owner = new AbortController();
    this.#admissionOwners.set(threadId, owner);
    const task = this.#admit(context, input, runtime,
      signal ? AbortSignal.any([signal, owner.signal]) : owner.signal).finally(() => {
      if (this.#admitting.get(threadId) === task) this.#admitting.delete(threadId);
      if (this.#admissionOwners.get(threadId) === owner) this.#admissionOwners.delete(threadId);
    });
    this.#admitting.set(threadId, task); return task;
  }
  async #admit(context: OpenCodeDriverContext, input: AttachConversationInput, runtime: OpenCodeConversationRuntime, signal?: AbortSignal): Promise<void> {
    if (this.#closed) return;
    const source: TrustedAgentToolSource = { scope: context.scope, sourceThreadId: input.binding.applicationThreadId,
      sourceWorkspaceId: input.workspace.summary.id, sourceEnvironmentId: input.binding.executionEnvironmentId, backendKind: "opencode" };
    // Imports/children are not assigned another root's privileges by native metadata.
    if (!context.repository.hasCreatedRoot(input.scope, input.binding.applicationThreadId, input.binding.backendConversationId)) return;
    let admission = this.#sessions.get(source.sourceThreadId);
    if (admission && (admission.lease.generation !== runtime.snapshot().generation || admission.lease.client.lifetime.aborted ||
        admission.input.opaqueBindingDetail !== input.opaqueBindingDetail)) { this.#releaseSession(source.sourceThreadId); admission = undefined; }
    if (!admission) {
      if (this.#sessions.size >= 1_000) return;
      const lease = runtime.acquire(); const owner = new AbortController();
      try {
        const session = await new OpenCodeNativeApi(lease.client).getSession(input.binding.backendConversationId, signal);
        await runtime.assertCurrent(signal); requireOpenCodeBinding(context, input);
        signal?.throwIfAborted();
        if (this.#closed || session.parentID || session.location.directory !== input.workspace.canonicalPath) { lease.release(); return; }
        const observation = acquireOpenCodeInputObserver(context, input, runtime, lease, owner.signal);
        const onOwnerLost = () => { if (this.#sessions.get(source.sourceThreadId)?.lease === lease) this.release(source.sourceThreadId); };
        admission = { context, input, runtime, lease, owner, observation, source, onOwnerLost };
        this.#sessions.set(source.sourceThreadId, admission);
        lease.client.lifetime.addEventListener("abort", onOwnerLost, { once: true });
        await observation.observer.start(AbortSignal.any([AbortSignal.timeout(OPENCODE_MCP_STARTUP_MS), ...(signal ? [signal] : [])]));
      } catch {
        // Tool startup does not take conversation controls down with it.
        if (admission) admission.diagnostic = "Sedes OpenCode tools could not establish current input tracking. Send a later message to retry.";
        else { owner.abort(); lease.release(); }
        return;
      }
    }
    const policy = this.options.facade.readPolicy(source);
    if (!policy.enabled || policy.presentation.surface !== "native") return;
    try { await this.#register(admission, signal); admission.diagnostic = undefined; }
    catch { admission.diagnostic = "Sedes OpenCode tools are unavailable. Conversation controls remain available; retry tool admission on a later message."; }
  }
  release(threadId: string): void {
    this.#admissionOwners.get(threadId)?.abort();
    this.#admissionOwners.delete(threadId);
    this.#admitting.delete(threadId);
    this.#releaseSession(threadId);
  }
  #releaseSession(threadId: string): void {
    const entry = this.#sessions.get(threadId); if (!entry) return;
    this.#sessions.delete(threadId); entry.lease.client.lifetime.removeEventListener("abort", entry.onOwnerLost); entry.owner.abort(); entry.observation.release(); entry.lease.release();
  }
  diagnostic(threadId: string): string | undefined { return this.#sessions.get(threadId)?.diagnostic; }
  gatewayAction(threadId: string, action: string): string | undefined {
    const entry = this.#sessions.get(threadId); if (!entry) return undefined;
    const registration = this.#locations.get(entry.lease.client)?.get(entry.input.workspace.canonicalPath)?.registration;
    if (!registration || registration.channel.revoked) return undefined;
    const names = { sedes_catalog: "Sedes tool catalog", sedes_read: "Sedes read", sedes_act: "Sedes action" };
    for (const [gateway, title] of Object.entries(names)) if (action === `${registration.name}_${gateway}`) return title;
    return undefined;
  }
  accessDecisionAuthority(source: TrustedAgentToolSource): BackendAgentToolAccessDecisionAuthority {
    return { acquire: async signal => {
      const entry = this.#sessions.get(source.sourceThreadId);
      if (!entry || !sameSource(entry.source, source)) throw denied();
      await this.#assertCurrent(entry, signal);
      return entry.observation.observer.accessDecisionAuthority().acquire(signal);
    } };
  }
  async close(): Promise<void> {
    this.#closed = true;
    const pending = [...this.#admitting.values()];
    for (const owner of this.#admissionOwners.values()) owner.abort();
    this.#admissionOwners.clear();
    for (const registration of this.#registrations) registration.channel.revoke();
    for (const threadId of this.#sessions.keys()) this.release(threadId);
    await this.#ingress.close();
    await Promise.allSettled(pending);
  }
  async #assertCurrent(entry: Admission, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#closed || this.#sessions.get(entry.source.sourceThreadId) !== entry || entry.owner.signal.aborted ||
        entry.lease.client.lifetime.aborted || entry.runtime.snapshot().generation !== entry.lease.generation) throw denied();
    requireOpenCodeBinding(entry.context, entry.input);
    await entry.runtime.assertCurrent(signal);
    const session = await new OpenCodeNativeApi(entry.lease.client).getSession(entry.input.binding.backendConversationId, signal);
    await entry.runtime.assertCurrent(signal);
    if (session.parentID || session.location.directory !== entry.input.workspace.canonicalPath) throw denied();
    signal.throwIfAborted(); requireOpenCodeBinding(entry.context, entry.input);
    if (this.#sessions.get(entry.source.sourceThreadId) !== entry || entry.owner.signal.aborted || entry.lease.client.lifetime.aborted ||
        entry.runtime.snapshot().generation !== entry.lease.generation) throw denied();
  }
  async #call(client: OpenCodeHttpClient, directory: string, request: OpenCodeMcpRequest, signal: AbortSignal): Promise<unknown> {
    const entries = [...this.#sessions.values()].filter(entry => entry.lease.client === client &&
      entry.input.workspace.canonicalPath === directory && entry.input.binding.backendConversationId === request.sessionID);
    if (entries.length !== 1) throw denied();
    const entry = entries[0]!;
    await this.#assertCurrent(entry, signal);
    switch (request.operation) {
      case "list": return { tools: this.options.facade.catalogSummaries(entry.source, "mcp") };
      case "describe": return { tools: this.options.facade.describeMany(entry.source, "mcp", request.toolIds) };
      case "invoke": return this.options.facade.invoke({ source: entry.source, adapter: "mcp", request: request.request,
        signal: AbortSignal.any([signal, entry.owner.signal]), accessDecisionAuthority: this.accessDecisionAuthority(entry.source) });
    }
  }
  #register(entry: Admission, signal?: AbortSignal): Promise<void> {
    const client = entry.lease.client; const directory = entry.input.workspace.canonicalPath;
    let tasks = this.#registrationTasks.get(client); if (!tasks) { tasks = new Map(); this.#registrationTasks.set(client, tasks); }
    const existing = tasks.get(directory); if (existing) return existing;
    const task = this.#createRegistration(entry, signal).finally(() => { if (tasks!.get(directory) === task) tasks!.delete(directory); });
    tasks.set(directory, task); return task;
  }
  async #createRegistration(entry: Admission, signal?: AbortSignal): Promise<void> {
    const client = entry.lease.client; const directory = entry.input.workspace.canonicalPath;
    let locations = this.#locations.get(client); if (!locations) { locations = new Map(); this.#locations.set(client, locations); }
    let location = locations.get(directory);
    if (!location) { if (locations.size >= 64) throw denied(); location = { admissionCount: 0, retryAfter: 0 }; locations.set(directory, location); }
    if (location.registration && !location.registration.channel.revoked) {
      const existing = location.registration;
      try { await existing.ready; } catch (error) { if (!existing.channel.connected) throw error; }
      return;
    }
    if (location.registration) {
      location.retryAfter = Math.max(location.retryAfter, Date.now() + OPENCODE_MCP_WATCHDOG_MS);
      this.#registrations.delete(location.registration); location.registration = undefined;
    }
    if (Date.now() < location.retryAfter || location.admissionCount >= 8 || this.#admissions >= 64) throw denied();
    const cli = this.options.cli;
    if (cli.availability !== "available" || !path.isAbsolute(cli.executableDirectory)) throw denied();
    const name = `sedes_${randomBytes(24).toString("hex")}`;
    // GET is an absence preflight, not ownership proof. Never delete or replace an observed entry.
    const inventory = await client.call((native, signal) => native.mcp.list({ location: { directory } }, { signal }),
      value => inventorySchema.parse(value), signal);
    if (inventory.location.directory !== directory || inventory.data.some(item => item.name === name)) throw denied();
    await this.#assertCurrent(entry, signal ?? client.lifetime);
    const catalog = this.options.facade.eligibleCatalog("mcp").map(({ id, schemaVersion, catalog, description, effects }) =>
      ({ id, schemaVersion, label: catalog.label, description, group: { id: catalog.groupId, order: catalog.order }, effects }));
    const channel = await this.#ingress.admit({ catalog, invoke: (request, signal) => this.#call(client, directory, request, signal) });
    try { await this.#assertCurrent(entry, signal ?? client.lifetime); }
    catch (error) { channel.revoke(); throw error; }
    location.admissionCount++; this.#admissions++;
    const ready = client.call((native, signal) => native.mcp.add({ server: name, location: { directory }, config: {
      type: "local", command: [path.join(cli.executableDirectory, "sedes"), "opencode-mcp"], environment: { ...channel.environment },
      codemode: false, protocol: "legacy", timeout: { startup: OPENCODE_MCP_STARTUP_MS, catalog: OPENCODE_MCP_STARTUP_MS, execution: 86_400_000 },
    } }, { signal }), value => { if (value !== undefined) throw new Error("opencode_mcp_ack_invalid"); }, signal);
    const registration: Registration = { name, channel, ready, createdAt: Date.now() };
    location.registration = registration; this.#registrations.add(registration);
    client.lifetime.addEventListener("abort", () => channel.revoke(), { once: true });
    await ready;
  }
}
function sameSource(a: TrustedAgentToolSource, b: TrustedAgentToolSource): boolean {
  return a.scope.tenantId === b.scope.tenantId && a.scope.principalId === b.scope.principalId &&
    a.backendKind === b.backendKind && a.sourceThreadId === b.sourceThreadId && a.sourceEnvironmentId === b.sourceEnvironmentId &&
    a.sourceWorkspaceId === b.sourceWorkspaceId;
}
function denied() { return new BackendAgentToolRequestError({ code: "permission_denied", retryable: false,
  message: "This OpenCode session is not admitted to Sedes tools." }); }
