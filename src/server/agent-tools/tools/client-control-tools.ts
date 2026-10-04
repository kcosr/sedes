import { Type, type TProperties } from "typebox";
import { clientVoicePatchSchema } from "../../../shared/protocol/client-controls.js";
import type { ClientControlService } from "../../domain/client-control-service.js";
import type { ThreadActivityService } from "../../conversations/thread-activity-service.js";
import type { ConversationActorManager } from "../../conversations/conversation-actor-manager.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { DomainError } from "../../domain/errors.js";
import type { AgentToolDefinition, TrustedToolInvocationContext, TrustedClientTurn } from "../contracts/agent-tool-contracts.js";
import type { AgentToolEnvironmentAuthorityReader } from "../environment/environment-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";
import { AGENT_TOOL_JSON_SCHEMA_DIALECT, normalizeCanonicalAgentToolSchema } from "../schema/canonical-json-schema.js";

const ids = ["client.list", "client.end_interaction", "client.switch_thread", "client.settings.get", "client.settings.update"] as const;
type Id = typeof ids[number];
const str = (maxLength = 128) => Type.String({ minLength: 1, maxLength });
const object = (properties: TProperties) => Type.Object(properties, { additionalProperties: false, maxProperties: Object.keys(properties).length });
const voice = {
  audioMode: Type.String({ enum: ["off", "manual", "response"], maxLength: 8 }),
  voiceThreadId: Type.Union([str(), Type.Null()]), pinDefaultVoiceThread: Type.Boolean(),
  autoListen: Type.Boolean(), onlyVoiceThread: Type.Boolean(), ignoreOtherDevices: Type.Boolean(), followComposerMode: Type.Boolean(),
};
const runtime = object({ foreground: Type.Boolean(), voiceReady: Type.Boolean(), interactionActive: Type.Boolean() });
const settings = Type.Union([object({ revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), voice: object(voice) }), Type.Null()]);
const state = object({ runtime, settings });
const client = object({ clientId: str(), name: str(256), platform: Type.String({ enum: ["browser", "electron", "android"], maxLength: 8 }),
  paired: Type.Boolean(), online: Type.Boolean(), capabilities: object({ navigate: Type.Boolean(), voice: Type.Boolean(), voiceSettings: Type.Boolean() }), runtime, settings });
const result = object({ client, state, status: Type.String({ enum: ["applied", "accepted", "noop", "failed"], maxLength: 8 }), reason: Type.Optional(str(160)) });
const patch = object({ voice: Type.Object(Object.fromEntries(Object.entries(voice).map(([key, value]) => [key, Type.Optional(value)])),
  { additionalProperties: false, minProperties: 1, maxProperties: 7 }) });

export class ClientControlToolService {
  constructor(readonly clients: ClientControlService,
    readonly actors: Pick<ConversationActorManager, "observeInputRuntime">,
    readonly activity: Pick<ThreadActivityService, "originForTurn">,
    readonly authority: Pick<AgentToolEnvironmentAuthorityReader, "resolveThread">) {}

  capture(scope: RequestScope, threadId: string): TrustedClientTurn {
    const observed = this.actors.observeInputRuntime(scope, threadId);
    if (!observed?.authoritative || observed.runState !== "running" || !observed.sourceTurnId || observed.settled ||
        observed.activeTurnId !== observed.sourceTurnId || observed.sourceTurnStatus !== "in_progress" || !observed.firstInput) {
      throw new DomainError("runtime_unavailable", "Client controls require a current user turn.");
    }
    const origin = this.activity.originForTurn(scope, threadId, observed.sourceTurnId);
    return Object.freeze({ threadId, turnId: observed.sourceTurnId, ownerGeneration: observed.ownerGeneration,
      ...(origin ? { clientId: origin.clientId } : {}) });
  }

  async execute(id: Id, raw: unknown, context: TrustedToolInvocationContext): Promise<unknown> {
    const turn = context.clientTurn;
    if (!turn || context.subject.kind !== "thread_agent" || context.subject.sourceThreadId !== turn.threadId) {
      throw new DomainError("runtime_unavailable", "The current client context is unavailable.");
    }
    const scope = { tenantId: context.tenantId, principalId: context.principalId };
    const current = this.capture(scope, turn.threadId);
    if (current.turnId !== turn.turnId || current.ownerGeneration !== turn.ownerGeneration) {
      throw new DomainError("runtime_unavailable", "The originating turn changed.");
    }
    const input = raw as { clientId?: string; threadId?: string; listen?: boolean; expectedRevision?: number; patch?: { voice: unknown } };
    if (id === "client.list") return { clients: this.clients.list(scope) };
    const target = this.clients.target(scope, input.clientId ?? turn.clientId);
    const action = id.slice("client.".length) as "settings.get" | "settings.update" | "switch_thread" | "end_interaction";
    const voicePatch = input.patch ? clientVoicePatchSchema.parse(input.patch.voice) : undefined;
    const threadId = input.threadId ?? voicePatch?.voiceThreadId;
    const thread = threadId ? this.authority.resolveThread(scope, threadId) : undefined;
    if (threadId && (!thread || !context.environmentAuthority.admittedEnvironmentIds.includes(thread.environmentId))) {
      throw new DomainError("not_found", "The requested thread is unavailable.");
    }
    const result = await this.clients.request(target, {
      action, sourceThreadId: turn.threadId, sourceTurnId: turn.turnId,
      ...(input.threadId ? { threadId: input.threadId, listen: input.listen ?? false } : {}),
      ...(threadId ? { threadTitle: thread?.label?.slice(0, 512).replace(/[\uD800-\uDBFF]$/u, "") || null } : {}),
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      ...(voicePatch ? { patch: voicePatch } : {}),
    }, context.abortSignal);
    if (result.status === "failed") throw new DomainError(result.reason === "settings_revision_conflict" ? "conflict" : "runtime_unavailable",
      `The client rejected the request: ${result.reason ?? "client_action_failed"}.`);
    return result;
  }
}

export function createClientControlToolDefinitions(service?: ClientControlToolService): AgentToolDefinition[] {
  return ids.map(id => {
    const manifest = CANONICAL_AGENT_TOOL_MANIFEST[id];
    const fields: TProperties = id === "client.list" ? {} : { clientId: Type.Optional(str()) };
    if (id === "client.switch_thread") Object.assign(fields, { threadId: str(), listen: Type.Optional(Type.Boolean()) });
    if (id === "client.settings.update") Object.assign(fields, { expectedRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), patch });
    const schema = (value: unknown) => normalizeCanonicalAgentToolSchema({ ...value as object, $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT });
    const name = `sedes_${id.replaceAll(".", "_")}`;
    return {
      ...manifest, inputSchema: schema(object(fields)),
      outputSchema: schema(id === "client.list" ? object({ clients: Type.Array(client, { maxItems: 128 }) }) : result),
      requiredCapabilities: [],
      execution: { form: "inline", adapterWaitCeilingMilliseconds: { pi_sdk: 30_000, mcp: 30_000, http: 30_000, cli: 30_000 },
        supportsCancellation: true, idempotency: "not_applicable", progress: "none", maximumInputBytes: 4096, maximumOutputBytes: 131072,
        concurrencyClass: "client_control", uncertainExternalOutcome: id !== "client.list" && id !== "client.settings.get" },
      exposure: { adapters: ["pi_sdk", "mcp", "http", "cli"] },
      adapters: { pi: { name, label: manifest.catalog.label, promptSnippet: manifest.description },
        mcp: { name }, http: { invocation: "inline" }, cli: { command: id } },
      async execute(input, context) {
        if (!service) throw new DomainError("runtime_unavailable", "Client controls are unavailable.");
        return service.execute(id, input, context);
      },
    };
  });
}
