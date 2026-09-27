import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { OpenCodeHttpClient } from "./opencode-http-client.js";
import { boundedOpenCodeProcessFile, canonicalOpenCodeStore, readOpenCodeNativeIdentity, sameOpenCodeNativeIdentity, type OpenCodeNativeIdentity } from "./opencode-native-identity.js";
import { createOpenCodeNativeStoreLifecycle, openCodeNativeStoreNamespaceKey, type OpenCodeNativeStoreLease } from "./opencode-native-store.js";
import { startOpenCodeOwnedProcess, type OpenCodeOwnedProcess } from "./opencode-owned-process.js";
import { admitOpenCodeNativeProfile, OpenCodeRuntimeError } from "./opencode-release.js";

export interface OpenCodeRuntimeAuthority {
  readonly tenantId: string;
  readonly principalId: string;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
}
export type OpenCodeRuntimeConnection =
  | { readonly ownership: "owned"; readonly channel: { readonly type: "process_stdio"; readonly executablePath: string; readonly workingDirectory: string } }
  | { readonly ownership: "external"; readonly channel: { readonly type: "http"; readonly url: string } };
export interface OpenCodeRuntimeInput {
  readonly authority: OpenCodeRuntimeAuthority;
  readonly nativeStorePath: string;
  readonly configDirectory?: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly connection: OpenCodeRuntimeConnection;
  readonly externalPassword?: () => Promise<string>;
  /** When supplied, the module startup stack owns release after proved runtime cleanup. */
  readonly storeLease?: OpenCodeNativeStoreLease;
}
export interface OpenCodeRuntimeSnapshot {
  readonly state: "stopped" | "starting" | "ready" | "disconnected" | "cleanup_unproved";
  readonly ownership: "owned" | "external";
  readonly generation?: string;
  readonly references: number;
  readonly identity?: OpenCodeNativeIdentity;
}
export interface OpenCodeRuntimeLease {
  readonly client: OpenCodeHttpClient;
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
  readonly nativeNamespaceKey: string;
  #state: OpenCodeRuntimeSnapshot["state"] = "stopped";
  #generation?: string;
  #identity?: OpenCodeNativeIdentity;
  #client?: OpenCodeHttpClient;
  #owned?: OpenCodeOwnedProcess;
  #lease?: OpenCodeNativeStoreLease;
  #references = 0;
  #starting?: Promise<void>;
  #stopping?: Promise<OpenCodeRuntimeStopResult>;

  constructor(input: OpenCodeRuntimeInput) {
    if (Object.values(input.authority).some(value => typeof value !== "string" || !value || value.length > 256)) throw new OpenCodeRuntimeError("opencode_runtime_authority_invalid");
    this.#input = { ...input, authority: { ...input.authority }, environment: { ...input.environment },
      connection: input.connection.ownership === "owned"
        ? { ownership: "owned", channel: { ...input.connection.channel } }
        : { ownership: "external", channel: { ...input.connection.channel } } };
    this.nativeNamespaceKey = openCodeRuntimeNamespaceKey(input.authority.executionEnvironmentId, input.nativeStorePath);
  }

  snapshot(): OpenCodeRuntimeSnapshot {
    return Object.freeze({ state: this.#state, ownership: this.#input.connection.ownership,
      references: this.#references, ...(this.#generation ? { generation: this.#generation } : {}),
      ...(this.#identity ? { identity: this.#identity } : {}) });
  }

  async health(): Promise<{ readonly available: boolean; readonly checkedAt: string }> {
    try { await this.assertCurrent(); return { available: true, checkedAt: new Date().toISOString() }; }
    catch { return { available: false, checkedAt: new Date().toISOString() }; }
  }

  start(): Promise<void> {
    if (this.#stopping) return Promise.reject(new OpenCodeRuntimeError("opencode_runtime_stopping"));
    if (this.#state === "ready") return this.assertCurrent();
    if (this.#state === "cleanup_unproved" || this.#state === "disconnected") return Promise.reject(new OpenCodeRuntimeError("opencode_runtime_requires_explicit_cleanup"));
    if (this.#starting) return this.#starting;
    this.#state = "starting";
    this.#starting = this.#start().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #start(): Promise<void> {
    try {
      if (process.platform !== "linux") throw new OpenCodeRuntimeError("opencode_local_process_identity_unavailable");
      const store = await canonicalOpenCodeStore(this.#input.nativeStorePath, this.#input.connection.ownership === "owned");
      if (this.#input.storeLease) {
        if (this.#input.storeLease.canonicalStorePath !== store || this.#input.storeLease.namespaceKey !== openCodeNativeStoreNamespaceKey(store)) throw new OpenCodeRuntimeError("opencode_native_store_lease_mismatch");
        this.#lease = this.#input.storeLease;
      } else {
        this.#lease = await createOpenCodeNativeStoreLifecycle({ canonicalStorePath: store, label: "OpenCode native store" }).acquire();
      }
      let endpoint: string;
      let password: string | undefined;
      const connection = this.#input.connection;
      if (connection.ownership === "owned") {
        const home = this.#input.environment.HOME;
        if (!home || !path.isAbsolute(home)) throw new OpenCodeRuntimeError("opencode_native_home_required");
        const configDirectory = this.#input.configDirectory ?? path.join(this.#input.environment.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode");
        this.#owned = await startOpenCodeOwnedProcess({ ...connection.channel,
          nativeStorePath: store, configDirectory, environment: this.#input.environment });
        endpoint = this.#owned.endpoint;
      } else {
        endpoint = connection.channel.url;
        password = await this.#input.externalPassword?.() ?? "";
      }
      this.#client = this.#owned?.client ?? new OpenCodeHttpClient({ endpoint, password: password ?? "" });
      await this.#client.requireAuthentication();
      const info = await this.#client.info();
      if (this.#owned && info.pid !== this.#owned.pid) throw new OpenCodeRuntimeError("opencode_owned_pid_mismatch");
      const identity = await readOpenCodeNativeIdentity({ pid: info.pid, nativeStorePath: store,
        ...(this.#owned ? { expectedExecutablePath: this.#owned.executablePath } : {}) });
      await this.#admitNativeProfile(identity);
      this.#identity = identity;
      this.#generation = randomUUID();
      this.#state = "ready";
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

  acquire(): OpenCodeRuntimeLease {
    if (this.#stopping || this.#state !== "ready" || !this.#client || !this.#identity || !this.#generation) throw new OpenCodeRuntimeError("opencode_runtime_unavailable");
    this.#references += 1;
    let released = false;
    return Object.freeze({ client: this.#client, identity: this.#identity, generation: this.#generation,
      release: () => { if (!released) { released = true; this.#references -= 1; } } });
  }

  async assertCurrent(signal?: AbortSignal): Promise<void> {
    if (this.#state !== "ready" || !this.#client || !this.#identity) throw new OpenCodeRuntimeError("opencode_runtime_unavailable");
    const client = this.#client;
    const identity = this.#identity;
    try {
      const info = await client.info(signal);
      const observed = await readOpenCodeNativeIdentity({ pid: info.pid, nativeStorePath: this.#input.nativeStorePath,
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
    this.#stopping = this.#close().finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }

  async #close(): Promise<OpenCodeRuntimeStopResult> {
    await this.#starting?.catch(() => undefined);
    if (this.#state === "cleanup_unproved") throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved");
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
    this.#client = undefined;
    this.#identity = undefined;
    this.#generation = undefined;
    this.#state = "stopped";
    return { cleanup: "proved", nativeInterrupts };
  }

  async #releaseStore(): Promise<void> {
    if (this.#lease && !this.#input.storeLease) await this.#lease.release();
    this.#lease = undefined;
  }
}
