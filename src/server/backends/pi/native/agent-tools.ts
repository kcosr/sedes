import { createHash } from "node:crypto";
import { z } from "zod";
import { isAgentToolCliEndpoint } from "../../../../internal/agent-tool-cli-protocol/local-endpoint.js";
import { normalizedAbsolutePath } from "../../../../shared/absolute-path.js";
import { BackendAgentToolRequestError, type BackendAgentToolFacade, type BackendAgentToolAccessDecisionAuthority, type TrustedAgentToolSource } from "../../../agent-tools/adapters/backend-facade.js";
import type { AgentToolContractArtifact, AgentToolDescription, SedesToolInvocationResult } from "../../../agent-tools/contracts/agent-tool-contracts.js";
import type { AgentToolSourceCapabilityIssuer } from "../../../agent-tools/application/database-agent-tool-source-authority.js";
import { compileCanonicalAgentToolSchema } from "../../../agent-tools/schema/canonical-json-schema.js";
import { deterministicJson } from "../../../canonical-json.js";
import type { AttachConversationInput } from "../../contracts.js";
import type { AgentToolCliAvailability, AgentToolCliRuntimeResolution, BackendAgentToolRuntimeContext } from "../../module.js";
import type { PiNativeAttachment, PiNativeHistory, PiNativePort } from "./port.js";
import type { PiManagedEvent } from "./rpc/pi-managed-protocol.js";
import type { PiNativeToolCall } from "./tool-provenance.js";
import { companion } from "./driver/port-session.js";

type Mode = "read_only" | "ask" | "full";
type Call = Extract<PiManagedEvent, { type: "agent_tool_call" }>;
function callIdentity(call: Pick<Call, "assistantEntryId" | "userEntryId" | "toolCallId">): string {
  return deterministicJson([call.assistantEntryId, call.userEntryId, call.toolCallId]);
}
type ManifestTool = { name: string; label: string; description: string; parameters: Readonly<Record<string, unknown>>; readOnly: boolean };
const envelope = z.strictObject({ toolId: z.string().min(1).max(128), schemaVersion: z.number().int().min(1).max(1_000_000), input: z.record(z.string(), z.unknown()) });
const catalogInput = z.union([z.strictObject({ action: z.literal("list") }), z.strictObject({ action: z.literal("describe"), toolIds: z.array(z.string().min(1).max(128)).min(1).max(16).refine(ids => new Set(ids).size === ids.length) })]);
const envelopeParameters = { type: "object", additionalProperties: false, required: ["toolId", "schemaVersion", "input"], properties: {
  toolId: { type: "string", minLength: 1, maxLength: 128 }, schemaVersion: { type: "integer", minimum: 1, maximum: 1_000_000 }, input: { type: "object" },
} };
const catalogParameters = { type: "object", additionalProperties: false, required: ["action"], properties: {
  action: { type: "string", enum: ["list", "describe"] }, toolIds: { type: "array", minItems: 1, maxItems: 16, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } },
} };
const scrubbedEnvironment = Object.freeze({ SEDES_AGENT_TOOL_ENDPOINT: null, SEDES_AGENT_TOOL_SOURCE_CAPABILITY: null,
  SEDES_AGENT_TOOL_CLIENT_TOKEN: null, SEDES_AGENT_TOOL_CLI_MODE: null });

function source(input: AttachConversationInput): TrustedAgentToolSource {
  return Object.freeze({ scope: input.scope, sourceThreadId: input.binding.applicationThreadId,
    sourceWorkspaceId: input.workspace.summary.id, sourceEnvironmentId: input.workspace.summary.environmentId, backendKind: "pi_native" });
}
function readOnly(value: Pick<AgentToolDescription, "effects">): boolean {
  return value.effects.application === "read" && value.effects.external === "none" && value.effects.modelUsage === "none";
}
function unavailable(): BackendAgentToolRequestError {
  return new BackendAgentToolRequestError({ code: "not_found", message: "The requested Sedes tool is unavailable.", retryable: false });
}
function resultContent(result: SedesToolInvocationResult<unknown>, description: Pick<AgentToolDescription, "id" | "schemaVersion">) {
  const agentToolInvocation = { toolId: description.id, schemaVersion: description.schemaVersion, invocationId: result.invocationId };
  if (result.state === "completed") {
    const { modelContent, ...invocation } = result;
    return { result: { content: [{ type: "text" as const, text: deterministicJson(result.output) }, ...(modelContent ?? [])],
      details: { invocation, agentToolInvocation }, structuredContent: result.output }, isError: false };
  }
  if (result.state === "failed" || result.state === "uncertain" || result.state === "cancelled") {
    return { result: { content: [{ type: "text" as const, text: result.error.message }], details: { invocation: result, agentToolInvocation } }, isError: true };
  }
  return { result: { content: [{ type: "text" as const, text: deterministicJson(result) }], details: { invocation: result, agentToolInvocation }, structuredContent: result }, isError: false };
}

/** The main process supplies authority; the companion supplies exact native call identity. */
export class PiNativeAgentToolService {
  readonly #lifetime = new AbortController();
  #lease?: Extract<AgentToolCliRuntimeResolution, { availability: "available" }>;
  #acquiring?: Promise<AgentToolCliRuntimeResolution>;
  #closed = false;
  constructor(readonly input: {
    readonly facade: BackendAgentToolFacade;
    readonly cli: AgentToolCliAvailability;
    readonly sourceCapabilities: AgentToolSourceCapabilityIssuer;
    readonly remote: boolean;
  }) {}

  availability(input: BackendAgentToolRuntimeContext): { availability: "available" } | { availability: "unavailable"; reason: string } {
    if (input.isolatedWorkspace) return { availability: "unavailable", reason: "Pi does not support isolated workspaces." };
    if (input.presentation.surface === "native") return { availability: "available" };
    if (this.input.cli.availability === "available" || (this.input.cli.availability === "managed" && this.input.cli.provider.inspect?.().availability === "available"))
      return { availability: "available" };
    return { availability: "unavailable", reason: "Sedes CLI tools require an available endpoint on the execution host." };
  }

  async prepareLaunch(conversation: AttachConversationInput): Promise<{ environment: Readonly<Record<string, string | null>> }> {
    if (this.#closed) throw new Error("pi_native_agent_tool_service_closed");
    const policy = this.input.facade.readPolicy(source(conversation));
    // The resident process must already have its scoped endpoint if tools are
    // enabled later. Current enablement and tool selection are checked on use.
    if (policy.presentation.surface !== "cli") return { environment: scrubbedEnvironment };
    const available = this.input.cli.availability === "managed" ? await this.#managedEndpoint() : this.input.cli;
    if (this.#closed) throw new Error("pi_native_agent_tool_service_closed");
    if (available.availability !== "available") return { environment: scrubbedEnvironment };
    this.#validateEndpoint(available);
    const capability = this.input.sourceCapabilities.issue(source(conversation),
      this.input.remote ? "execution_environment_sidecar" : "management_http", "cli");
    return { environment: Object.freeze({ ...scrubbedEnvironment,
      SEDES_AGENT_TOOL_ENDPOINT: available.endpoint, SEDES_AGENT_TOOL_SOURCE_CAPABILITY: capability,
      SEDES_AGENT_TOOL_CLI_MODE: policy.presentation.mode,
      PATH: available.inheritedPath ? `${available.executableDirectory}:${available.inheritedPath}` : available.executableDirectory,
    }) };
  }

  #validateEndpoint(available: Extract<AgentToolCliAvailability | AgentToolCliRuntimeResolution, { availability: "available" }>): void {
    if (!normalizedAbsolutePath(available.executableDirectory) || available.executableDirectory.includes("\\") ||
        available.inheritedPath.includes("\0") || available.inheritedPath.length > 65_536 ||
        !(this.input.remote ? isAgentToolCliEndpoint(available.endpoint) : validLocalEndpoint(available.endpoint)))
      throw new Error("pi_native_cli_environment_invalid");
  }

  async #managedEndpoint(): Promise<AgentToolCliRuntimeResolution> {
    if (this.#lease) return this.#lease;
    this.#acquiring ??= this.#acquireEndpoint().finally(() => { this.#acquiring = undefined; });
    const available = await this.#acquiring;
    if (available.availability === "available" && this.#lease !== available)
      throw new Error("pi_native_cli_endpoint_closed");
    return available;
  }

  async #acquireEndpoint(): Promise<AgentToolCliRuntimeResolution> {
    if (this.input.cli.availability !== "managed") throw new Error("pi_native_cli_endpoint_unmanaged");
    const available = await this.input.cli.provider.acquire({ signal: this.#lifetime.signal });
    if (available.availability !== "available") return available;
    try {
      if (this.#closed) throw new Error("pi_native_agent_tool_service_closed");
      this.#validateEndpoint(available);
      // A detached native process can still invoke the CLI. The runtime owns
      // this hold until its port closes; individual conversation handles do not.
      this.#lease = available;
      const discard = () => {
        if (this.#lease !== available) return;
        this.#lease = undefined;
        available.release();
      };
      void available.closed.then(discard, discard);
      return available;
    } catch (error) { available.release(); throw error; }
  }

  /** Called only after the native runtime port has closed successfully. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#lifetime.abort();
    await this.#acquiring?.catch(() => undefined);
    const lease = this.#lease;
    this.#lease = undefined;
    lease?.release();
  }

  createBridge(input: { attachment: PiNativeAttachment; conversation: AttachConversationInput; port: PiNativePort; getToolMode: () => Mode;
    clientControlAuthority: (userEntryId: string) => BackendAgentToolAccessDecisionAuthority }): PiNativeAgentToolBridge {
    return new PiNativeAgentToolBridge(this.input.facade, input);
  }
}

export class PiNativeAgentToolBridge {
  readonly #source;
  readonly #calls = new Map<string, { event: Call; controller: AbortController }>();
  #completedCalls = new Map<string, PiNativeToolCall>();
  readonly #artifacts: ReadonlyMap<string, AgentToolContractArtifact>;
  #closed = false;
  constructor(readonly facade: BackendAgentToolFacade, readonly input: {
    attachment: PiNativeAttachment; conversation: AttachConversationInput; port: PiNativePort; getToolMode: () => Mode;
    clientControlAuthority: (userEntryId: string) => BackendAgentToolAccessDecisionAuthority;
  }) {
    this.#source = source(input.conversation);
    const entries = facade.eligibleCatalog("pi_rpc").map(artifact => {
      const name = artifact.adapters.pi?.name;
      if (!artifact.exposure.adapters.includes("pi_rpc") || !name || !/^sedes_[a-z][a-z0-9_]{0,119}$/u.test(name) ||
          ["sedes_catalog", "sedes_read", "sedes_act"].includes(name)) throw new Error("pi_native_agent_tool_catalog_invalid");
      return [name, artifact] as const;
    });
    this.#artifacts = new Map(entries);
    if (this.#artifacts.size !== entries.length) throw new Error("pi_native_agent_tool_catalog_ambiguous");
  }

  async configure(): Promise<readonly string[]> {
    if (this.#closed) throw new Error("pi_native_agent_tool_bridge_closed");
    const policy = this.facade.readPolicy(this.#source);
    const allowed = new Set(policy.enabledToolIds);
    const artifacts = [...this.#artifacts.values()].filter(artifact => allowed.has(artifact.id) && (this.input.getToolMode() !== "read_only" || readOnly(artifact)));
    const tools: ManifestTool[] = [];
    let instructions = "";
    if (policy.enabled && policy.presentation.surface === "native") {
      if (policy.presentation.mode === "individual") {
        for (const artifact of artifacts) tools.push({ name: artifact.adapters.pi!.name, label: artifact.adapters.pi!.label,
          description: artifact.description, parameters: { ...artifact.inputSchema }, readOnly: readOnly(artifact) });
      } else {
        tools.push({ name: "sedes_catalog", label: "Sedes tool catalog", description: "List the available Sedes operations, then describe selected operation IDs before invoking them.", parameters: catalogParameters, readOnly: true });
        if (artifacts.some(readOnly)) tools.push({ name: "sedes_read", label: "Sedes read", description: "Invoke one described Sedes operation with no write, external, or model-usage effects.", parameters: envelopeParameters, readOnly: true });
        if (artifacts.some(artifact => !readOnly(artifact))) tools.push({ name: "sedes_act", label: "Sedes action", description: "Invoke one described Sedes operation with write, external, or model-usage effects.", parameters: envelopeParameters, readOnly: false });
        instructions = "Use sedes_catalog to list the current Sedes operations, then describe the selected IDs. Pass the exact described toolId, schemaVersion, and input to sedes_read for side-effect-free reads or sedes_act for other operations. Treat the described scope, effects and input schema as authoritative.";
      }
    } else if (policy.enabled && policy.presentation.surface === "cli") {
      instructions = "Sedes operations are available through the sedes CLI on this execution host. Use `sedes tool list --json`, then `sedes tool describe TOOL_ID --json`, then `sedes tool invoke TOOL_ID --input-file PATH --json` with the described input schema. The environment supplies the current thread authority; do not copy credentials into prompts or files.";
    }
    await companion(this.input.port, this.input.attachment, { type: "configure_agent_tools", tools, instructions });
    return tools.map(tool => tool.name);
  }

  hasPendingCalls(): boolean { return this.#calls.size > 0; }

  /** These call/result records have already been authenticated by the native host. */
  reconcileHistory(history: Pick<PiNativeHistory, "sessionId" | "toolCalls" | "toolResults">): void {
    if (this.#closed) return;
    if (history.sessionId !== this.input.attachment.sessionId) throw new Error("pi_native_agent_tool_history_mismatch");
    const results = new Set(history.toolResults.map(callIdentity));
    this.#completedCalls = new Map(history.toolCalls.filter(call => call.managed === "agent" && results.has(callIdentity(call)))
      .map(call => [callIdentity(call), call]));
    for (const [id, pending] of this.#calls) {
      if (!this.#completed(pending.event)) continue;
      pending.controller.abort();
      this.#calls.delete(id);
    }
  }

  #completed(event: Call): boolean {
    const call = this.#completedCalls.get(callIdentity(event));
    return call !== undefined && call.toolName === event.name && call.parentToolCallId === event.parentToolCallId &&
      call.arguments !== undefined && deterministicJson(call.arguments) === deterministicJson(event.arguments);
  }

  onEvent(event: PiManagedEvent): void {
    if (this.#closed) return;
    if (event.type === "agent_tool_cancelled") { this.#calls.get(event.id)?.controller.abort(); this.#calls.delete(event.id); return; }
    if (event.type !== "agent_tool_call" || this.#calls.has(event.id) || this.#completed(event)) return;
    const controller = new AbortController();
    this.#calls.set(event.id, { event, controller });
    // This callback must never hold up draining the provider event stream.
    void this.#execute(event, controller.signal).then(async result => {
      if (this.#closed || controller.signal.aborted) return;
      await companion(this.input.port, this.input.attachment, { type: "resolve_agent_tool", id: event.id, ...result });
      if (this.#calls.get(event.id)?.controller === controller) this.#calls.delete(event.id);
    }).catch(() => {
      // Losing the result channel leaves the native call unresolved. The exact
      // canonical request ID makes a retained event safe to reconcile later.
      // Keep the event cursor pinned until cancellation or an authenticated
      // native result proves this exact call finished despite the lost reply.
    });
  }

  async #execute(call: Call, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      const policy = this.facade.readPolicy(this.#source);
      if (!policy.enabled || policy.presentation.surface !== "native") throw unavailable();
      if (call.name === "sedes_catalog") {
        if (policy.presentation.mode !== "progressive") throw unavailable();
        const request = catalogInput.parse(call.arguments);
        const summaries = this.facade.catalogSummaries(this.#source, "pi_rpc").filter(summary =>
          policy.enabledToolIds.includes(summary.id) && (this.input.getToolMode() !== "read_only" || readOnly(summary)));
        if (request.action === "describe" && request.toolIds.some(id => !summaries.some(summary => summary.id === id))) throw unavailable();
        const output = request.action === "list" ? summaries : this.facade.describeMany(this.#source, "pi_rpc", request.toolIds);
        return { result: { content: [{ type: "text" as const, text: deterministicJson(output) }], structuredContent: { tools: output } }, isError: false };
      }
      let description: AgentToolDescription | AgentToolContractArtifact;
      let parameters: unknown;
      if (call.name === "sedes_read" || call.name === "sedes_act") {
        if (policy.presentation.mode !== "progressive") throw unavailable();
        const request = envelope.parse(call.arguments);
        if (!policy.enabledToolIds.includes(request.toolId)) throw unavailable();
        const candidate = this.facade.describeMany(this.#source, "pi_rpc", [request.toolId])[0];
        if (!candidate || candidate.schemaVersion !== request.schemaVersion || (call.name === "sedes_read") !== readOnly(candidate)) throw unavailable();
        description = candidate; parameters = request.input;
      } else {
        if (policy.presentation.mode !== "individual") throw unavailable();
        const artifact = this.#artifacts.get(call.name);
        if (!artifact || !policy.enabledToolIds.includes(artifact.id)) throw unavailable();
        description = artifact; parameters = call.arguments;
      }
      if (this.input.getToolMode() === "read_only" && !readOnly(description)) throw unavailable();
      if (!compileCanonicalAgentToolSchema(description.inputSchema).check(parameters) ||
          Buffer.byteLength(deterministicJson(parameters)) > description.execution.maximumInputBytes)
        throw new BackendAgentToolRequestError({ code: "invalid_input", message: "The Sedes tool input is invalid.", retryable: false });
      if (!call.assistantEntryId || !call.userEntryId || !call.toolCallId) throw unavailable();
      const requestId = `pi_${createHash("sha256").update(deterministicJson([
        this.input.attachment.sessionId, call.assistantEntryId, call.toolCallId,
      ])).digest("hex")}`;
      // A retained native call names its originating user entry. Never let a
      // newly current normalized turn become authority for an older call.
      const accessDecisionAuthority = description.id.startsWith("client.")
        ? this.input.clientControlAuthority(call.userEntryId) : undefined;
      if (description.id.startsWith("client.") && !accessDecisionAuthority) throw unavailable();
      const result = await this.facade.invoke({ source: this.#source, adapter: "pi_rpc", signal,
        request: { toolId: description.id, schemaVersion: description.schemaVersion, requestId, input: parameters },
        ...(accessDecisionAuthority ? { accessDecisionAuthority } : {}),
      });
      return resultContent(result, description);
    } catch (error) {
      return { result: { content: [{ type: "text" as const, text: error instanceof BackendAgentToolRequestError ? error.toolError.message :
        error instanceof z.ZodError ? "The Sedes tool input is invalid." : "The Sedes tool invocation could not be completed." }] }, isError: true };
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const { controller } of this.#calls.values()) controller.abort();
    this.#calls.clear();
    this.#completedCalls.clear();
  }
}

function validLocalEndpoint(value: string): boolean {
  try { const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port) &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && url.origin === value;
  } catch { return false; }
}
