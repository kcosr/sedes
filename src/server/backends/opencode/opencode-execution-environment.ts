import { createHash } from "node:crypto";
import { environmentVariableOverridesSchema, type EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import type { OpenCodeMutationControl } from "./opencode-native-port.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AttachConversationInput } from "../contracts.js";
import { requireOpenCodeBinding, openCodeRuntimeTarget, openCodeConversationError, type OpenCodeDriverContext, type OpenCodeConversationRuntime } from "./opencode-conversation-context.js";
import { serializeOpenCodeBindingDetail } from "./opencode-binding-detail.js";
import { OpenCodeNativeApi, type OpenCodeNativeSession } from "./opencode-native-api.js";
import { OpenCodeNativeMutations } from "./opencode-native-mutations.js";
import { hasUnfinishedNativePeriod } from "./opencode-conversation-driver.js";
import type { OpenCodeCliEnvironment, OpenCodeCliPlan } from "./opencode-cli-environment.js";

export interface OpenCodeEnvironmentPreparation {
  readonly context: OpenCodeDriverContext;
  readonly input: AttachConversationInput;
  readonly runtime: OpenCodeConversationRuntime;
  readonly operation: "submit" | "steer" | "compact";
  readonly signal: AbortSignal;
  readonly control: OpenCodeMutationControl;
}
interface Installation { readonly generation: string; readonly definition: string; readonly binding: string; readonly cli: string | null; readonly released: boolean; }

/** Owned by the module/runtime, so actor eviction cannot discard an installed map. */
export class OpenCodeExecutionEnvironment {
  readonly #installed = new Map<string, Installation>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #preparations = new Map<string, AbortController>();
  readonly #lifetime = new AbortController();
  constructor(readonly options: {
    readonly scope: RequestScope;
    readonly ownership: "owned" | "external";
    readonly readDefinitions: (applicationThreadId: string) => EnvironmentVariableOverrides;
    readonly cli?: OpenCodeCliEnvironment;
  }) {}

  /** Cheap immutable-definition admission, before runtime launch or secret resolution. */
  assertDefinitionSupport(scope: RequestScope, applicationThreadId: string): EnvironmentVariableOverrides {
    this.#lifetime.signal.throwIfAborted();
    if (scope.tenantId !== this.options.scope.tenantId || scope.principalId !== this.options.scope.principalId) throw unavailable();
    let definitions: EnvironmentVariableOverrides;
    try { definitions = environmentVariableOverridesSchema.parse(this.options.readDefinitions(applicationThreadId)); }
    catch { throw unavailable(); }
    if (Object.keys(definitions).length && this.options.ownership !== "owned") throw unsupported();
    return definitions;
  }

  async prepare(request: OpenCodeEnvironmentPreparation): Promise<void> {
    const detail = requireOpenCodeBinding(request.context, request.input);
    const definitions = this.assertDefinitionSupport(request.input.scope, request.input.binding.applicationThreadId);
    const cli = this.options.cli?.plan(request.context, request.input);
    if (cli && this.options.ownership !== "owned") throw unsupported();
    const installed = this.#installed.get(request.input.binding.applicationThreadId);
    // Imported empty snapshots preserve the native map. Discovery/read/control never call this service.
    if (!Object.keys(definitions).length && !cli && !installed?.cli) { request.signal.throwIfAborted(); return; }
    const key = request.input.binding.applicationThreadId;
    const prior = this.#pending.get(key);
    request.signal.throwIfAborted();
    let controller = this.#preparations.get(key);
    if (!controller) { controller = new AbortController(); this.#preparations.set(key, controller); }
    const signal = AbortSignal.any([request.signal, this.#lifetime.signal, controller.signal]);
    signal.throwIfAborted();
    const work = (prior ?? Promise.resolve()).catch(() => undefined).then(() => {
      signal.throwIfAborted();
      return this.#prepare({ ...request, signal }, definitions, serializeOpenCodeBindingDetail(detail), cli);
    });
    this.#pending.set(key, work);
    try { await work; }
    finally {
      if (this.#pending.get(key) === work) {
        this.#pending.delete(key);
        if (this.#preparations.get(key) === controller) this.#preparations.delete(key);
      }
    }
  }

  release(applicationThreadId: string): void {
    this.options.cli?.release(applicationThreadId);
    this.#preparations.get(applicationThreadId)?.abort();
    this.#preparations.delete(applicationThreadId);
    const prior = this.#installed.get(applicationThreadId);
    if (prior) this.#installed.set(applicationThreadId, { ...prior, released: true });
  }
  diagnostic(applicationThreadId: string): string | undefined { return this.options.cli?.diagnostic(applicationThreadId); }
  close(): void { this.#lifetime.abort(); this.#preparations.clear(); this.#installed.clear(); this.options.cli?.close(); }

  async #prepare(request: OpenCodeEnvironmentPreparation, definitions: EnvironmentVariableOverrides, binding: string, cli: OpenCodeCliPlan | undefined): Promise<void> {
    const { input, runtime, signal, operation } = request;
    const thread = input.binding.applicationThreadId, sessionID = input.binding.backendConversationId;
    const generation = runtime.snapshot().generation;
    if (!generation || runtime.snapshot().ownership !== "owned" || this.options.ownership !== "owned") throw unsupported();
    await runtime.assertCurrent(signal); signal.throwIfAborted();
    const lease = runtime.acquire(openCodeRuntimeTarget(input));
    try {
      if (lease.generation !== generation) throw unavailable();
      const api = new OpenCodeNativeApi(lease.client), native = new OpenCodeNativeMutations(lease.client);
      const session = await api.getSession(sessionID, signal);
      assertRoot(session, input.workspace.canonicalPath);
      const definition = configurationFingerprint(definitions);
      if (cli) await request.context.tools.admit(request.context, input, runtime, signal);
      signal.throwIfAborted();
      const cliAdmissionId = cli ? request.context.tools.cliAdmission(thread) : null;
      if (cli && !cliAdmissionId) this.options.cli?.unavailable(thread);
      const cliIdentity = cli && cliAdmissionId ? createHash("sha256").update(JSON.stringify(cli)).digest("hex") : null;
      const installed = this.#installed.get(thread);
      if (operation === "steer") {
        if (!installed || installed.released || installed.generation !== generation || installed.definition !== definition || installed.binding !== binding ||
            installed.cli !== cliIdentity || !deniesChildren(session)) throw unavailable();
        await runtime.assertCurrent(signal); requireOpenCodeBinding(request.context, input); signal.throwIfAborted();
        return;
      }
      await assertIdle(api, sessionID, input.workspace.canonicalPath, signal);
      // Read and preserve all operator rules. A final exact deny protects the unsupported child path.
      if (!deniesChildren(session)) {
        const permissions = [...(session.permissions ?? []), { action: "subagent", resource: "*", effect: "deny" as const }];
        await runtime.assertCurrent(signal); requireOpenCodeBinding(request.context, input); signal.throwIfAborted();
        await native.setPermissions({ sessionID, permissions }, { ...request.control, identity: { ...request.control.identity, step: "prepare-permissions" } }, signal);
        const readback = await api.getSession(sessionID, signal);
        assertRoot(readback, input.workspace.canonicalPath);
        if (!deniesChildren(readback)) throw unavailable();
      }
      // Frozen definitions cross the port; secret references resolve only on the execution host.
      signal.throwIfAborted();
      await assertIdle(api, sessionID, input.workspace.canonicalPath, signal);
      await runtime.assertCurrent(signal); requireOpenCodeBinding(request.context, input); signal.throwIfAborted();
      if (runtime.snapshot().generation !== generation) throw unavailable();
      await lease.client.mutate("installSessionEnvironment", { sessionID, definitions, definitionFingerprint: definition, cliAdmissionId },
        { ...request.control, identity: { ...request.control.identity, step: "install-environment" } }, { signal });
      requireOpenCodeBinding(request.context, input); signal.throwIfAborted();
      if (runtime.snapshot().generation !== generation) throw unavailable();
      this.#installed.set(thread, { generation, definition, binding, cli: cliIdentity, released: false });
    } finally { lease.release(); }
  }
}

function assertRoot(session: OpenCodeNativeSession, directory: string): void {
  // Public native locations omit workspaceID. Stock CLI has no registered
  // workspace drivers: such imported sessions fail native location admission.
  if (session.location.directory !== directory || session.parentID || session.fork) throw unsupported();
}
function deniesChildren(session: OpenCodeNativeSession): boolean {
  const rule = session.permissions?.at(-1);
  return rule?.action === "subagent" && rule.resource === "*" && rule.effect === "deny";
}
async function assertIdle(api: OpenCodeNativeApi, sessionID: string, directory: string, signal: AbortSignal): Promise<void> {
  const [unfinished, activity, pending, interactions] = await Promise.all([
    hasUnfinishedNativePeriod(api, sessionID, signal), api.getActivity(sessionID, directory, signal),
    api.getPending(sessionID, signal), api.getInteractions(sessionID, signal),
  ]);
  if (unfinished || activity.active || activity.activeChildren.length || activity.shells.some(shell => shell.status === "running") ||
      pending.length || interactions.permissions.length || interactions.forms.length) throw unavailable();
}
function unsupported() { return openCodeConversationError("opencode_environment_unsupported", "Scoped variables require an owned OpenCode root session.", "invalid_state"); }
function unavailable() { return openCodeConversationError("opencode_environment_unavailable", "The OpenCode execution environment could not be safely prepared. No input was sent.", "invalid_state"); }
