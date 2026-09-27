import { z } from "zod";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { type AgentBackendInstance, type AgentConnectionProfile, type BackendHealth, type ConversationBackendDriver,
  type AttachConversationInput, type DiscoverConversationsInput, type ReadConversationInput, type ReleaseConversationResidencyInput } from "../contracts.js";
import { assertOpenCodeWorkspace, openCodeConversationError, requireOpenCodeBinding, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { OpenCodeNativeApi } from "./opencode-native-api.js";
import { OpenCodeConversationHandle, openCodeUnsupported, waitOpenCode } from "./opencode-conversation-handle.js";
import { serializeOpenCodeBindingDetail } from "./opencode-binding-detail.js";
import { openCodeHistoryFingerprint } from "./opencode-history-reader.js";

const cursorSchema = z.strictObject({ v: z.literal(1), scope: z.string().length(43), native: z.string().min(1).max(16_384) });

/** Scope validation always precedes runtime acquisition or provider effects. */
export class OpenCodeConversationBackendDriver implements ConversationBackendDriver {
  readonly instance: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  constructor(readonly input: OpenCodeDriverContext) {
    this.instance = input.instance; this.connection = input.connection;
  }
  async health(): Promise<BackendHealth> {
    try { const runtime = await this.input.runtime(); await runtime.start(); return await runtime.health(); }
    catch { return { available: false, checkedAt: new Date().toISOString() }; }
  }
  async catalog(..._input: Parameters<ConversationBackendDriver["catalog"]>): Promise<never> { throw openCodeUnsupported(); }
  async create(..._input: Parameters<ConversationBackendDriver["create"]>): Promise<never> { throw openCodeUnsupported(); }
  async resolveBranchCheckpoint(..._input: Parameters<ConversationBackendDriver["resolveBranchCheckpoint"]>): Promise<never> { throw openCodeUnsupported(); }
  async branchConversation(..._input: Parameters<ConversationBackendDriver["branchConversation"]>): Promise<never> { throw openCodeUnsupported(); }
  async reconcileSubmission(..._input: Parameters<ConversationBackendDriver["reconcileSubmission"]>): Promise<never> { throw openCodeUnsupported(); }

  async discover(input: DiscoverConversationsInput) {
    assertOpenCodeWorkspace(this.input, input); input.signal.throwIfAborted();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) throw openCodeUnsupported();
    const scope = openCodeHistoryFingerprint([this.input.scope, this.instance.id, this.connection.id,
      this.input.nativeNamespaceKey, input.workspace.canonicalPath]);
    let cursor: string | undefined;
    if (input.cursor !== undefined) {
      try {
        if (input.cursor.length > 24_000 || !/^[A-Za-z0-9_-]+$/u.test(input.cursor)) throw new Error();
        const parsed = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
        if (parsed.scope !== scope) throw new Error();
        cursor = parsed.native;
      } catch { throw openCodeConversationError("opencode_discovery_cursor_invalid", "The OpenCode discovery cursor is invalid.", "invalid_state"); }
    }
    const runtime = await waitOpenCode(this.#runtime(), input.signal);
    await waitOpenCode(runtime.start(), input.signal); input.signal.throwIfAborted();
    const lease = runtime.acquire();
    try {
      const api = new OpenCodeNativeApi(lease.client);
      const page = await api.listSessions({ ...(cursor ? { cursor } : { directory: input.workspace.canonicalPath }), limit: input.limit, signal: input.signal });
      if (page.data.some(session => session.location.directory !== input.workspace.canonicalPath)) throw openCodeConversationError(
        "opencode_discovery_location_invalid", "OpenCode returned a conversation outside the selected workspace.", "incompatible_protocol");
      await runtime.assertCurrent(input.signal); input.signal.throwIfAborted();
      return { conversations: page.data.map(session => ({
        backendConversationId: session.id, canonicalWorkspacePath: input.workspace.canonicalPath,
        title: boundDisplayText(session.title).text, updatedAt: new Date(session.time.updated).toISOString(),
        opaqueBindingDetail: serializeOpenCodeBindingDetail({ version: 1, sessionId: session.id,
          tenantId: input.scope.tenantId, principalId: input.scope.principalId, backendInstanceId: this.instance.id,
          connectionProfileId: this.connection.id, executionEnvironmentId: this.connection.executionEnvironmentId,
          canonicalWorkspacePath: input.workspace.canonicalPath, nativeNamespaceKey: this.input.nativeNamespaceKey }),
        ...(session.parentID ? { nativeAncestry: { method: "provider_native" as const, parentBackendConversationId: session.parentID } } : {}),
      })), ...(page.cursor.next ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, scope, native: page.cursor.next })).toString("base64url") } : {}) };
    } finally { lease.release(); }
  }

  async attach(input: AttachConversationInput): Promise<OpenCodeConversationHandle> {
    requireOpenCodeBinding(this.input, input);
    const runtime = await this.#runtime(); await runtime.start();
    const lease = runtime.acquire();
    let handle: OpenCodeConversationHandle | undefined;
    try {
      const session = await new OpenCodeNativeApi(lease.client).getSession(input.binding.backendConversationId);
      if (session.location.directory !== input.workspace.canonicalPath) throw openCodeConversationError(
        "opencode_session_location_changed", "The OpenCode conversation moved to another workspace.", "invalid_state");
      await runtime.assertCurrent();
      handle = new OpenCodeConversationHandle(this.input, input, runtime, lease);
      input.onControlReady?.(handle.control);
      return handle;
    } catch (error) {
      if (handle) await handle.close(); else lease.release();
      throw error;
    }
  }

  async read(input: ReadConversationInput) {
    const handle = await this.attach(input);
    try {
      const result = await handle.establishProjection({ signal: handle.control.lifetime });
      return { snapshot: result.snapshot, usage: await handle.usage() };
    } finally { await handle.close(); }
  }

  async releaseConversationResidency(input: ReleaseConversationResidencyInput): Promise<"released" | "busy" | "undelivered"> {
    requireOpenCodeBinding(this.input, input);
    const runtime = await this.#runtime(); await runtime.start();
    const lease = runtime.acquire();
    try {
      const api = new OpenCodeNativeApi(lease.client);
      const [session, activity, pending, interactions] = await Promise.all([
        api.getSession(input.binding.backendConversationId), api.getActivity(input.binding.backendConversationId, input.workspace.canonicalPath),
        api.getPending(input.binding.backendConversationId), api.getInteractions(input.binding.backendConversationId),
      ]);
      await runtime.assertCurrent();
      if (session.location.directory !== input.workspace.canonicalPath || activity.active || activity.activeChildren.length ||
          activity.shells.some(shell => shell.status === "running") || pending.length || interactions.permissions.length || interactions.forms.length) return "busy";
      // This releases client residency only; neither ownership mode retires the daemon here.
      return "released";
    } catch { return "busy"; }
    finally { lease.release(); }
  }

  async #runtime() {
    const runtime = await this.input.runtime();
    if (runtime.nativeNamespaceKey !== this.input.nativeNamespaceKey) throw openCodeConversationError(
      "opencode_runtime_namespace_mismatch", "The OpenCode runtime does not match the bound native store.", "permission_denied");
    return runtime;
  }
}
