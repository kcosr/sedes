import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { OpenCodeHttpClient } from "./opencode-http-client.js";
import { boundedOpenCodeProcessFile, canonicalOpenCodeStore, readOpenCodeNativeIdentity, sameOpenCodeNativeIdentity, type OpenCodeNativeIdentity } from "./opencode-native-identity.js";
import { openCodeNativeStoreNamespaceKey } from "./opencode-native-store.js";
import { createOpenCodeRuntimeOwnershipLifecycle, openCodeRuntimeAuthorityKey, type OpenCodeRuntimeOwnershipLease } from "./opencode-runtime-ownership.js";
import { startOpenCodeOwnedProcess, OpenCodeOwnedCleanupUnprovedError, type OpenCodeOwnedProcess } from "./opencode-owned-process.js";
import { admitOpenCodeNativeProfile, OpenCodeRuntimeError } from "./opencode-release.js";
import { mergeResolvedEnvironment, resolveEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { OpenCodeHttpNativeAdapter } from "./opencode-http-native-adapter.js";
import { OpenCodeNativeHost, type OpenCodeRuntimeTarget } from "./opencode-native-host.js";
import type { OpenCodeMutationInput, OpenCodeNativeAuthority, OpenCodeNativePort } from "./opencode-native-port.js";
import { OpenCodeHostAgentTools, type OpenCodeHostToolAdmission, type OpenCodeHostToolAdmissionResult,
  type OpenCodeHostToolInvoker, type OpenCodeHostToolTarget, type OpenCodeHostToolEndpoint } from "./opencode-host-agent-tools.js";
import type { OpenCodeToolInvocationStamp } from "./opencode-tool-invocation.js";
import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import { OpenCodeNativeMutationDeliveryError } from "./opencode-native-codecs.js";

export interface OpenCodeRuntimeAuthority {
  readonly tenantId: string;
  readonly principalId: string;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
}
export type OpenCodeRuntimeConnection =
  | { readonly ownership: "owned"; readonly channel: { readonly type: "process_stdio"; readonly executablePath?: string; readonly workingDirectory?: string } }
  | { readonly ownership: "external"; readonly channel: { readonly type: "http"; readonly url: string } };
export interface OpenCodeRuntimeInput {
  readonly hostIncarnation: string;
  /** Host admission is checked synchronously immediately before every launch. */
  readonly assertLaunchAdmission?: () => void;
  readonly authority: OpenCodeRuntimeAuthority;
  readonly nativeStorePath?: string;
  readonly configDirectory?: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly connection: OpenCodeRuntimeConnection;
  readonly externalPassword?: (signal?: AbortSignal) => Promise<string>;
  readonly agentTools?: { readonly cli: () => OpenCodeHostToolEndpoint | undefined; readonly invoke: OpenCodeHostToolInvoker };
  /** When supplied, the module startup stack owns release after proved runtime cleanup. */
  readonly ownershipLease?: OpenCodeRuntimeOwnershipLease;
  /** Host-owned Sedes lifecycle storage; independent of native provider paths. */
  readonly ownershipDirectory?: string;
}
export interface OpenCodeRuntimeSnapshot {
  readonly state: "stopped" | "starting" | "ready" | "disconnected" | "cleanup_unproved";
  readonly ownership: "owned" | "external";
  readonly generation?: string;
  readonly references: number;
  readonly identity?: OpenCodeNativeIdentity;
}
export interface OpenCodeRuntimeLease {
  readonly client: OpenCodeNativePort;
  readonly generation: string;
  readonly identity: OpenCodeNativeIdentity;
  release(): void;
}
export interface OpenCodeRuntimeStopResult {
  readonly cleanup: "proved";
  readonly nativeInterrupts: "complete" | "incomplete" | "not_owned";
}

export function openCodeRuntimeNamespaceKey(executionEnvironmentId: string, nativeStorePath: string): string {
  if (!executionEnvironmentId || executionEnvironmentId.length > 256) throw new OpenCodeRuntimeError("opencode_runtime_authority_invalid");
  return createHash("sha256").update(JSON.stringify([
    "sedes.opencode.native.v2", executionEnvironmentId,
    openCodeNativeStoreNamespaceKey(nativeStorePath),
  ])).digest("hex");
}

/** A resident native owner. Conversation reference release never retires this process. */
export class OpenCodeRuntime {
  readonly #input: OpenCodeRuntimeInput;
  #nativeNamespaceKey?: string;
  #state: OpenCodeRuntimeSnapshot["state"] = "stopped";
  #generation?: string;
  #identity?: OpenCodeNativeIdentity;
  #client?: OpenCodeHttpClient;
  #adapter?: OpenCodeHttpNativeAdapter;
  #host?: OpenCodeNativeHost;
  #tools?: OpenCodeHostAgentTools;
  readonly #toolScopes = new Map<string, { readonly target: OpenCodeHostToolTarget;
    readonly host: OpenCodeNativeHost; readonly port: OpenCodeNativePort }>();
  readonly #runtimeId = randomUUID();
  #owned?: OpenCodeOwnedProcess;
  #retryLaunchCleanup?: () => Promise<void>;
  #lease?: OpenCodeRuntimeOwnershipLease;
  #references = 0;
  #starting?: Promise<void>;
  #startupLifetime?: AbortController;
  #stopping?: Promise<OpenCodeRuntimeStopResult>;

  constructor(input: OpenCodeRuntimeInput) {
    if (!input.hostIncarnation || input.hostIncarnation.length > 256) throw new OpenCodeRuntimeError("opencode_runtime_authority_invalid");
    if (Object.values(input.authority).some(value => typeof value !== "string" || !value || value.length > 256)) throw new OpenCodeRuntimeError("opencode_runtime_authority_invalid");
    this.#input = { ...input, authority: { ...input.authority }, environment: { ...input.environment },
      connection: input.connection.ownership === "owned"
        ? { ownership: "owned", channel: { ...input.connection.channel } }
        : { ownership: "external", channel: { ...input.connection.channel } } };
  }

  get nativeNamespaceKey(): string {
    if (!this.#nativeNamespaceKey) throw new OpenCodeRuntimeError("opencode_runtime_not_started");
    return this.#nativeNamespaceKey;
  }

  get runtimeId(): string { return this.#runtimeId; }
  get nativeHost(): OpenCodeNativeHost | undefined { return this.#host; }

  snapshot(): OpenCodeRuntimeSnapshot {
    return Object.freeze({ state: this.#state, ownership: this.#input.connection.ownership,
      references: this.#references, ...(this.#generation ? { generation: this.#generation } : {}),
      ...(this.#identity ? { identity: this.#identity } : {}) });
  }

  async health(): Promise<{ readonly available: boolean; readonly checkedAt: string }> {
    try { await this.assertCurrent(); return { available: true, checkedAt: new Date().toISOString() }; }
    catch { return { available: false, checkedAt: new Date().toISOString() }; }
  }

  async admitToolSession(target: OpenCodeHostToolTarget, admission: OpenCodeHostToolAdmission,
    signal?: AbortSignal): Promise<OpenCodeHostToolAdmissionResult> {
    if (!this.#host || !this.#tools) throw new OpenCodeRuntimeError("opencode_runtime_unavailable");
    const host = this.#host, tools = this.#tools, port = host.acquire(target);
    let retained = false, admitted = false;
    try {
      await this.assertCurrent(signal);
      const result = await tools.admit(target, admission, signal);
      admitted = true;
      if (this.#host !== host || port.lifetime.aborted) throw new OpenCodeRuntimeError("opencode_runtime_unavailable");
      const key = target.session.applicationThreadId, previous = this.#toolScopes.get(key);
      this.#toolScopes.set(key, { target: structuredClone(target), host, port }); retained = true;
      previous?.host.release(previous.port);
      // Once committed, a cancelled caller only loses its response. The host
      // continues owning its routing scope and native helper lifetime.
      signal?.throwIfAborted();
      return result;
    } finally {
      if (!retained) { if (admitted) tools.release(target); host.release(port); }
    }
  }

  captureToolInvocation(target: OpenCodeHostToolTarget): OpenCodeToolInvocationStamp {
    if (this.#state !== "ready" || !this.#host) throw new OpenCodeRuntimeError("opencode_runtime_unavailable");
    return this.#host.captureToolInvocation(target);
  }
  ownsCliCapability(sourceCapability: string): boolean { return this.#tools?.ownsCliCapability(sourceCapability) ?? false; }
  captureCliInvocation(sourceCapability: string): OpenCodeToolInvocationStamp | undefined {
    if (!this.#tools?.ownsCliCapability(sourceCapability)) return undefined;
    if (this.#state !== "ready" || !this.#host) throw new OpenCodeRuntimeError("opencode_runtime_unavailable");
    return this.#tools.captureCliInvocation(sourceCapability);
  }

  releaseToolSession(target: OpenCodeHostToolTarget): void {
    this.#tools?.release(target);
    const key = target.session.applicationThreadId, scope = this.#toolScopes.get(key);
    if (!scope || configurationFingerprint(scope.target) !== configurationFingerprint(target)) return;
    this.#toolScopes.delete(key); scope.host.release(scope.port);
  }

  /** Full-map replacement is resolved and composed only on the execution host. */
  async #installSessionEnvironment(authority: OpenCodeNativeAuthority,
    input: OpenCodeMutationInput<"installSessionEnvironment">, signal: AbortSignal): Promise<void> {
    let adapter: OpenCodeHttpNativeAdapter, variables: Readonly<Record<string, string>>;
    try {
      if (this.#input.connection.ownership !== "owned" || !this.#owned || !this.#adapter ||
          this.#state !== "ready" || this.#generation !== authority.nativeGeneration ||
          authority.session?.nativeSessionID !== input.sessionID) throw new OpenCodeRuntimeError("opencode_environment_topology_unsupported");
      if (configurationFingerprint(input.definitions) !== input.definitionFingerprint) throw new OpenCodeRuntimeError("opencode_request_authority_mismatch");
      const owner = this.#owned; adapter = this.#adapter;
      const session = await adapter.read("getSession", { sessionID: input.sessionID }, signal);
      if (session.parentID || session.fork || session.location.directory !== authority.directory) throw new OpenCodeRuntimeError("opencode_environment_topology_unsupported");
      const overrides = await resolveEnvironmentVariables(input.definitions, this.#input.environment);
      signal.throwIfAborted();
      const cli = input.cliAdmissionId === null ? undefined : this.#tools?.cliEnvironment(
        { directory: authority.directory, session: authority.session }, input.cliAdmissionId);
      if (input.cliAdmissionId !== null && !cli) throw new OpenCodeRuntimeError("opencode_request_authority_mismatch");
      const merged = mergeResolvedEnvironment(mergeResolvedEnvironment(owner.shellEnvironment, overrides), cli?.generated ?? {});
      variables = !cli ? merged : { ...merged,
        PATH: merged.PATH ? `${cli.executableDirectory}${path.delimiter}${merged.PATH}` : cli.executableDirectory };
      await this.assertCurrent(signal);
      if (owner !== this.#owned || adapter !== this.#adapter || this.#generation !== authority.nativeGeneration) throw new OpenCodeRuntimeError("opencode_runtime_identity_changed");
    } catch (error) {
      // No native environment write has been attempted. Keep secret lookup and
      // topology/admission failures distinguishable from uncertain native PUTs.
      throw new OpenCodeNativeMutationDeliveryError("not_sent", error instanceof OpenCodeRuntimeError
        ? error.code : "opencode_environment_resolution_failed");
    }
    await adapter.setEnvironmentVariables({ sessionID: input.sessionID, variables }, signal);
    await this.assertCurrent(signal);
  }

  start(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new OpenCodeRuntimeError("opencode_request_aborted"));
    if (this.#stopping) return Promise.reject(new OpenCodeRuntimeError("opencode_runtime_stopping"));
    if (this.#state === "ready") return this.assertCurrent(signal);
    if (this.#state === "cleanup_unproved" || this.#state === "disconnected") return Promise.reject(new OpenCodeRuntimeError("opencode_runtime_requires_explicit_cleanup"));
    if (this.#starting) return this.#starting;
    this.#state = "starting";
    this.#startupLifetime = new AbortController();
    const budget = AbortSignal.any([this.#startupLifetime.signal, AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]);
    this.#starting = this.#start(budget).finally(() => { this.#starting = undefined; this.#startupLifetime = undefined; });
    return this.#starting;
  }

  async #start(signal: AbortSignal): Promise<void> {
    const assertActive = () => { if (signal.aborted) throw new OpenCodeRuntimeError("opencode_request_aborted"); };
    try {
      assertActive();
      if (process.platform !== "linux") throw new OpenCodeRuntimeError("opencode_local_process_identity_unavailable");
      if (this.#input.ownershipLease) {
        if (this.#input.ownershipLease.authorityKey !== openCodeRuntimeAuthorityKey(this.#input.authority)) throw new OpenCodeRuntimeError("opencode_runtime_owner_lease_mismatch");
        this.#lease = this.#input.ownershipLease;
      } else {
        this.#lease = await createOpenCodeRuntimeOwnershipLifecycle({ authority: this.#input.authority,
          ...(this.#input.ownershipDirectory ? { ownershipDirectory: this.#input.ownershipDirectory } : {}),
          label: "OpenCode runtime", ownership: this.#input.connection.ownership, hostIncarnation: this.#input.hostIncarnation }).acquire();
      }
      assertActive();
      const store = this.#input.nativeStorePath === undefined ? undefined
        : await canonicalOpenCodeStore(this.#input.nativeStorePath, this.#input.connection.ownership === "owned");
      let endpoint: string;
      let password: string | undefined;
      const connection = this.#input.connection;
      if (connection.ownership === "owned") {
        if (!this.#lease.processMarker) throw new OpenCodeRuntimeError("opencode_runtime_owner_lease_mismatch");
        this.#owned = await startOpenCodeOwnedProcess({ ...connection.channel,
          ...(store === undefined ? {} : { nativeStorePath: store }),
          ...(this.#input.configDirectory === undefined ? {} : { configDirectory: this.#input.configDirectory }),
          environment: this.#input.environment,
          processMarker: this.#lease.processMarker, assertLaunchAdmission: this.#input.assertLaunchAdmission, signal });
        endpoint = this.#owned.endpoint;
      } else {
        endpoint = connection.channel.url;
        password = await this.#readExternalPassword(signal);
      }
      assertActive();
      if (!this.#owned) this.#input.assertLaunchAdmission?.();
      this.#client = this.#owned?.client ?? new OpenCodeHttpClient({ endpoint, password: password ?? "" });
      await this.#client.requireAuthentication(signal);
      const info = await this.#client.info(signal);
      if (this.#owned && info.pid !== this.#owned.pid) throw new OpenCodeRuntimeError("opencode_owned_pid_mismatch");
      const identity = await readOpenCodeNativeIdentity({ pid: info.pid, ...(store === undefined ? {} : { nativeStorePath: store }),
        ...(this.#owned ? { expectedExecutablePath: this.#owned.executablePath } : {}) });
      await this.#admitNativeProfile(identity);
      assertActive();
      const namespace = openCodeRuntimeNamespaceKey(this.#input.authority.executionEnvironmentId, identity.nativeStorePath);
      if (this.#nativeNamespaceKey && this.#nativeNamespaceKey !== namespace) throw new OpenCodeRuntimeError("opencode_runtime_namespace_changed");
      this.#nativeNamespaceKey = namespace;
      this.#identity = identity;
      this.#generation = randomUUID();
      this.#state = "ready";
      this.#adapter = new OpenCodeHttpNativeAdapter(this.#client);
      if (this.#input.agentTools) this.#tools = new OpenCodeHostAgentTools({ adapter: this.#adapter,
        cli: this.#input.agentTools.cli, invoke: this.#input.agentTools.invoke,
        capture: target => this.captureToolInvocation(target), assertCurrent: signal => this.assertCurrent(signal) });
      this.#host = new OpenCodeNativeHost({ ...this.#input.authority, runtimeId: this.#runtimeId,
        nativeGeneration: this.#generation }, this.#adapter, {
        assertCurrent: signal => this.assertCurrent(signal),
        installSessionEnvironment: (authority, input, signal) => this.#installSessionEnvironment(authority, input, signal),
        ensureMcpRegistration: async (authority, input, signal) => {
          if (!this.#tools || !authority.session) throw new OpenCodeNativeMutationDeliveryError("not_sent", "opencode_agent_tools_unavailable");
          await this.#tools.ensureRegistration({ directory: authority.directory, session: authority.session }, input.registrationAdmissionId, signal);
        },
      }, this.#client.lifetime);
      const owned = this.#owned;
      if (owned) void owned.exited.then(() => {
        if (this.#owned !== owned || this.#stopping) return;
        this.#state = "disconnected";
        this.#client?.close();
      });
    } catch (cause) {
      this.#client?.close();
      // A launcher cleanup failure may occur before it can return an owner.
      if (cause instanceof OpenCodeRuntimeError && cause.code === "opencode_owned_cleanup_unproved") {
        this.#state = "cleanup_unproved";
        if (cause instanceof OpenCodeOwnedCleanupUnprovedError) this.#retryLaunchCleanup = cause.retryCleanup;
        throw cause;
      }
      try { await this.#owned?.stop(); await this.#releaseStore(); }
      catch { this.#state = "cleanup_unproved"; throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved"); }
      this.#owned = undefined;
      this.#client = undefined;
      this.#state = "stopped";
      throw cause instanceof OpenCodeRuntimeError ? cause : new OpenCodeRuntimeError("opencode_runtime_start_failed");
    }
  }

  async #readExternalPassword(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new OpenCodeRuntimeError("opencode_request_aborted");
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new OpenCodeRuntimeError("opencode_request_aborted"));
      signal.addEventListener("abort", aborted, { once: true });
      void Promise.resolve().then(() => {
        if (signal.aborted) throw new OpenCodeRuntimeError("opencode_request_aborted");
        return this.#input.externalPassword?.(signal) ?? "";
      }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }

  async #admitNativeProfile(identity: OpenCodeNativeIdentity): Promise<void> {
    // Read only the launch fields needed for qualification; never expose the
    // native environment or retain credential values in diagnostics/state.
    try {
      const bytes = await boundedOpenCodeProcessFile(`/proc/${identity.pid}/environ`, 1_048_576);
      admitOpenCodeNativeProfile(bytes.toString("utf8").split("\0"));
    } catch (cause) {
      if (cause instanceof OpenCodeRuntimeError) throw cause;
      throw new OpenCodeRuntimeError("opencode_native_profile_unproved");
    }
  }

  acquire(target: OpenCodeRuntimeTarget): OpenCodeRuntimeLease {
    if (this.#stopping || this.#state !== "ready" || !this.#host || !this.#identity || !this.#generation) throw new OpenCodeRuntimeError("opencode_runtime_unavailable");
    const host = this.#host, client = host.acquire(target);
    this.#references += 1;
    let released = false;
    return Object.freeze({ client, identity: this.#identity, generation: this.#generation,
      release: () => { if (!released) { released = true; this.#references -= 1; host.release(client); } } });
  }

  async assertCurrent(signal?: AbortSignal): Promise<void> {
    if (this.#state !== "ready" || !this.#client || !this.#identity) throw new OpenCodeRuntimeError("opencode_runtime_unavailable");
    const client = this.#client;
    const identity = this.#identity;
    try {
      const info = await client.info(signal);
      const observed = await readOpenCodeNativeIdentity({ pid: info.pid, nativeStorePath: identity.nativeStorePath,
        ...(this.#owned ? { expectedExecutablePath: this.#owned.executablePath } : {}) });
      if (this.#client !== client || this.#identity !== identity || !sameOpenCodeNativeIdentity(identity, observed)) throw new Error();
      if (signal?.aborted) throw new OpenCodeRuntimeError("opencode_request_aborted");
    } catch (cause) {
      // Cancelling this observation alone proves nothing about native identity.
      // Genuine identity failures still revoke authority, including when the
      // caller happens to abort while the process/file checks are completing.
      if (signal?.aborted && !client.lifetime.aborted && cause instanceof OpenCodeRuntimeError &&
          cause.code === "opencode_request_aborted") throw cause;
      // A delayed observation must never disconnect a replacement generation.
      if (this.#client === client && this.#identity === identity) this.#state = "disconnected";
      client.close();
      throw new OpenCodeRuntimeError("opencode_runtime_identity_changed");
    }
  }

  /** Explicit backend Stop. External owners support Disconnect through close(). */
  stop(): Promise<OpenCodeRuntimeStopResult> {
    if (this.#input.connection.ownership !== "owned") return Promise.reject(new OpenCodeRuntimeError("opencode_external_stop_forbidden"));
    return this.close();
  }

  close(): Promise<OpenCodeRuntimeStopResult> {
    if (this.#stopping) return this.#stopping;
    this.#startupLifetime?.abort();
    // Fence existing leases synchronously, before native cleanup takes its
    // active-session snapshot. Cleanup alone retains the raw control client.
    this.#host?.close();
    this.#stopping = this.#close().finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }

  async #close(): Promise<OpenCodeRuntimeStopResult> {
    await this.#starting?.catch(() => undefined);
    if (this.#state === "cleanup_unproved" && !this.#owned) {
      if (!this.#retryLaunchCleanup) throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved");
      try { await this.#retryLaunchCleanup(); }
      catch { throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved"); }
      this.#retryLaunchCleanup = undefined;
    }
    this.#host?.close();
    await this.#tools?.close();
    for (const scope of this.#toolScopes.values()) scope.host.release(scope.port);
    this.#toolScopes.clear();
    let nativeInterrupts: OpenCodeRuntimeStopResult["nativeInterrupts"] = this.#owned ? "incomplete" : "not_owned";
    if (this.#owned && this.#client && this.#state === "ready") {
      const deadline = AbortSignal.timeout(5_000);
      try {
        await this.assertCurrent(deadline);
        deadline.throwIfAborted();
        const active = await this.#client.call((client, signal) => client.session.active({ signal }),
          value => z.record(z.string().min(1).max(256), z.object({ type: z.literal("running") }).strict()).parse(value), deadline);
        const ids = Object.keys(active);
        if (ids.length > 256) throw new Error();
        for (let index = 0; index < ids.length; index += 16) {
          deadline.throwIfAborted();
          await Promise.all(ids.slice(index, index + 16).map(sessionID => this.#client!.call(
            (client, signal) => client.session.interrupt({ sessionID }, { signal }),
            value => z.object({ interrupted: z.boolean() }).strict().parse(value), deadline)));
        }
        nativeInterrupts = "complete";
      } catch { nativeInterrupts = "incomplete"; }
    }
    this.#client?.close();
    try { await this.#owned?.stop(); await this.#releaseStore(); }
    catch { this.#state = "cleanup_unproved"; throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved"); }
    this.#owned = undefined;
    this.#host = undefined; this.#adapter = undefined; this.#tools = undefined;
    this.#client = undefined;
    this.#identity = undefined;
    this.#generation = undefined;
    this.#state = "stopped";
    return { cleanup: "proved", nativeInterrupts };
  }

  async #releaseStore(): Promise<void> {
    if (this.#lease && !this.#input.ownershipLease) await this.#lease.release();
    this.#lease = undefined;
  }
}
