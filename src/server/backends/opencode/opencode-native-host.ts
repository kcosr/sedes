import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import { OpenCodeHttpNativeAdapter } from "./opencode-http-native-adapter.js";
import { OpenCodeObservationHub } from "./opencode-observation-hub.js";
import { OPENCODE_CONTROL_MUTATIONS } from "./opencode-native-port.js";
import { OpenCodeMutationJournal } from "./opencode-mutation-journal.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import { openCodeNativeAuthoritySchema, parseOpenCodeApplicationOperationIdentity, parseOpenCodeReadInput, parseOpenCodeMutationInput,
  parseOpenCodeMutationControl, OpenCodeNativeMutationInputError, OpenCodeNativeMutationDeliveryError, type OpenCodeNativeEvent, type OpenCodeNativeActivity } from "./opencode-native-codecs.js";
import type { OpenCodeApplicationOperationIdentity, OpenCodeMutationControl, OpenCodeMutationInput, OpenCodeMutationMethod, OpenCodeMutationOutput,
  OpenCodeNativeAuthority, OpenCodeNativePort, OpenCodePortObservation, OpenCodeReadInput,
  OpenCodeReadMethod, OpenCodeReadOutput } from "./opencode-native-port.js";

export type OpenCodeRuntimeTarget = Pick<OpenCodeNativeAuthority, "directory" | "session">;
export type OpenCodeNativeOwner = Omit<OpenCodeNativeAuthority, "directory" | "session">;
export interface OpenCodeNativeHostHooks {
  readonly assertCurrent: (signal?: AbortSignal) => Promise<void>;
  readonly installSessionEnvironment: (authority: OpenCodeNativeAuthority,
    input: OpenCodeMutationInput<"installSessionEnvironment">, signal: AbortSignal) => Promise<void>;
  readonly ensureMcpRegistration: (authority: OpenCodeNativeAuthority,
    input: OpenCodeMutationInput<"ensureMcpRegistration">, signal: AbortSignal) => Promise<void>;
}
interface NativeScope {
  readonly port: OpenCodeNativePort;
  readonly lifetime: AbortController;
  references: number;
  operations: number;
  observations: number;
}

/** One provider-private dispatcher on the execution host. Local clients enter
 * directly; sidecar handlers enter the same closed methods after carrier scope
 * admission. The HTTP adapter and resolved host credentials never leave here. */
export class OpenCodeNativeHost {
  readonly #journal = new OpenCodeMutationJournal({ onReleased: authority => this.#collectScope(authority) });
  readonly #scopes = new Map<string, NativeScope>();
  readonly #routes = new Map<string, ReturnType<typeof eventFilter>>();
  readonly #lifetime = new AbortController();
  readonly #observations = new Set<OpenCodePortObservation>();
  readonly #hub: OpenCodeObservationHub;
  #frozen = false;
  #inventory?: { readonly observationRevision: number; readonly journalRevision: number; readonly pendingInteractions: number; readonly activeWork: number };
  constructor(readonly owner: OpenCodeNativeOwner, readonly adapter: OpenCodeHttpNativeAdapter,
    readonly hooks: OpenCodeNativeHostHooks, nativeLifetime: AbortSignal) {
    this.#hub = new OpenCodeObservationHub(adapter, {
      route: (authority, event) => this.#routes.get(configurationFingerprint(authority))?.accept(event) ?? false,
      onRetentionChanged: () => { for (const scope of this.#scopes.values()) this.#collectScope(scope.port.authority); },
    });
    nativeLifetime.addEventListener("abort", () => this.close(), { once: true });
    if (nativeLifetime.aborted) this.close();
  }

  acquire(target: OpenCodeRuntimeTarget): OpenCodeNativePort {
    this.#assertOpen();
    let authority: OpenCodeNativeAuthority;
    try { authority = openCodeNativeAuthoritySchema.parse({ ...this.owner, ...target }); }
    catch { throw denied(); }
    Object.freeze(authority.session); Object.freeze(authority);
    const key = configurationFingerprint(authority);
    const existing = this.#scopes.get(key);
    if (existing) { existing.references++; return existing.port; }
    if (this.#frozen) throw new OpenCodeRuntimeError("opencode_mutation_admission_closed");
    if (this.#scopes.size >= 4_096) throw new OpenCodeRuntimeError("opencode_native_scope_capacity");
    const lifetime = new AbortController();
    const port: OpenCodeNativePort = Object.freeze({ authority, ownerKey: `${this.owner.runtimeId}:${this.owner.nativeGeneration}`,
      lifetime: AbortSignal.any([this.#lifetime.signal, lifetime.signal]),
      read: <K extends OpenCodeReadMethod>(method: K, input: OpenCodeReadInput<K>, options?: { signal?: AbortSignal; deadlineAt?: number }) =>
        this.read(authority, method, input, options),
      mutate: <K extends OpenCodeMutationMethod>(method: K, input: OpenCodeMutationInput<K>, control: OpenCodeMutationControl, options?: { signal?: AbortSignal }) =>
        lifetime.signal.aborted
          ? Promise.reject(new OpenCodeNativeMutationDeliveryError("sent_outcome_unknown", "opencode_mutation_outcome_unknown"))
          : this.mutate(authority, method, input, control, options?.signal),
      outcome: async <K extends OpenCodeMutationMethod>(method: K, identity: OpenCodeMutationControl["identity"]) => {
        this.#assertAuthority(authority); return this.#journal.outcome(authority, method, identity);
      },
      acknowledgeMutation: async (method: OpenCodeMutationMethod, identity: OpenCodeMutationControl["identity"]) => {
        this.#assertAuthority(authority); this.#journal.acknowledge(authority, method, identity);
      },
      acknowledgeOperation: async (identity: OpenCodeApplicationOperationIdentity) => {
        this.#assertAuthority(authority);
        this.#journal.acknowledgeOperation(authority, parseOpenCodeApplicationOperationIdentity(identity));
      },
      observe: (input: Parameters<OpenCodeNativePort["observe"]>[0]) => this.observe(authority, input),
    });
    this.#scopes.set(key, { port, lifetime, references: 1, operations: 0, observations: 0 });
    if (authority.session) this.#routes.set(key, eventFilter(authority.session.nativeSessionID));
    try { this.#hub.admitScope(authority); }
    catch (error) { this.#scopes.delete(key); this.#routes.delete(key); lifetime.abort(); throw error; }
    return port;
  }

  /** Recovery may borrow only a still-retained exact thread authority. It
   * cannot create a fresh observation scope or adopt a merely existing native session. */
  acquireRetained(target: OpenCodeRuntimeTarget): OpenCodeNativePort {
    this.#assertOpen();
    let authority: OpenCodeNativeAuthority;
    try { authority = openCodeNativeAuthoritySchema.parse({ ...this.owner, ...target }); }
    catch { throw denied(); }
    const existing = this.#scopes.get(configurationFingerprint(authority));
    if (!authority.session || !existing || existing.port.lifetime.aborted) throw denied();
    existing.references++; return existing.port;
  }

  /** Release one acquired reference. In-flight calls, observations and retained
   * native outcomes independently keep their exact scope alive. */
  release(port: OpenCodeNativePort): void {
    const scope = this.#scopes.get(configurationFingerprint(port.authority));
    if (!scope || scope.port !== port || scope.references === 0) return;
    scope.references--;
    this.#collectScope(port.authority);
  }

  async read<K extends OpenCodeReadMethod>(authority: OpenCodeNativeAuthority, method: K, input: OpenCodeReadInput<K>,
    options: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<OpenCodeReadOutput<K>> {
    const scope = this.#assertAuthority(authority);
    scope.operations++;
    try {
      input = parseOpenCodeReadInput(method, input);
      this.#assertInput(authority, input, false);
      // Workspace discovery may inspect session metadata (whose returned path is
      // checked below), but history, activity and interactions require a binding.
      if (!authority.session && "sessionID" in input && method !== "getSession") throw denied();
      if (options.deadlineAt !== undefined && (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt <= Date.now())) {
        throw new OpenCodeRuntimeError("opencode_request_aborted");
      }
      const signal = AbortSignal.any([this.#lifetime.signal, ...(options.signal ? [options.signal] : []),
        ...(options.deadlineAt === undefined ? [] : [AbortSignal.timeout(Math.min(2_147_483_647, Math.max(1, options.deadlineAt - Date.now())))])]);
      const result = await this.adapter.read(method, input, signal);
      this.#assertAuthority(authority);
      if (method === "getSession") {
        const session = result as OpenCodeReadOutput<"getSession">;
        if (session.location.directory !== authority.directory) throw new OpenCodeRuntimeError("opencode_session_location_changed");
      }
      if (method === "listSessions") {
        for (const session of (result as OpenCodeReadOutput<"listSessions">).data) {
          if (session.location.directory !== authority.directory) throw denied();
        }
      }
      if (method === "getActivity") this.#routes.get(configurationFingerprint(authority))?.seed(result as OpenCodeNativeActivity);
      if (method === "getActive") {
        // The native endpoint is global. A session port receives only its own
        // foreground state; child activity is read by the scoped getActivity path.
        const active = result as OpenCodeReadOutput<"getActive">;
        const id = authority.session?.nativeSessionID;
        return (id && active[id] ? { [id]: active[id] } : {}) as OpenCodeReadOutput<K>;
      }
      return result;
    } finally { scope.operations--; this.#collectScope(authority); }
  }

  async mutate<K extends OpenCodeMutationMethod>(authority: OpenCodeNativeAuthority, method: K,
    input: OpenCodeMutationInput<K>, control: OpenCodeMutationControl, signal?: AbortSignal): Promise<OpenCodeMutationOutput<K>> {
    // A retired owner cannot prove an earlier attempt was never dispatched.
    if (this.#lifetime.signal.aborted) throw new OpenCodeNativeMutationDeliveryError("sent_outcome_unknown", "opencode_mutation_owner_closed");
    try {
      this.#assertAuthority(authority);
      input = parseOpenCodeMutationInput(method, input); control = parseOpenCodeMutationControl(control);
      this.#assertInput(authority, input, true);
      if (method === "createSession" && authority.session &&
          (input as OpenCodeMutationInput<"createSession">).id !== authority.session.nativeSessionID) throw denied();
    } catch (error) {
      if (error instanceof OpenCodeNativeMutationInputError || error instanceof OpenCodeNativeMutationDeliveryError) throw error;
      throw new OpenCodeNativeMutationDeliveryError("not_sent", error instanceof OpenCodeRuntimeError ? error.code : "opencode_native_mutation_input_invalid");
    }
    const scope = this.#assertAuthority(authority); scope.operations++;
    try { return await this.#journal.mutate(authority, method, input, control, async (captured, deadline) => {
      const budget = AbortSignal.any([deadline, this.#lifetime.signal]);
      try { await this.hooks.assertCurrent(budget); this.#assertAuthority(authority); }
      catch { throw new OpenCodeNativeMutationDeliveryError("not_sent", "opencode_runtime_unavailable"); }
      if (!OPENCODE_CONTROL_MUTATIONS.has(method)) {
        try { await this.#hub.ensureListening(AbortSignal.any([budget, AbortSignal.timeout(5_000)])); }
        catch { throw new OpenCodeNativeMutationDeliveryError("not_sent", "opencode_event_ready_timeout"); }
      }
      if (method === "installSessionEnvironment") {
        await this.hooks.installSessionEnvironment(authority, captured as OpenCodeMutationInput<"installSessionEnvironment">, budget);
        return { ok: true } as OpenCodeMutationOutput<K>;
      }
      if (method === "ensureMcpRegistration") {
        await this.hooks.ensureMcpRegistration(authority, captured as OpenCodeMutationInput<"ensureMcpRegistration">, budget);
        return { ok: true } as OpenCodeMutationOutput<K>;
      }
      const leaf = method as Exclude<OpenCodeMutationMethod, "installSessionEnvironment" | "ensureMcpRegistration">;
      const inputId = method === "prompt" || method === "compact"
        ? (captured as OpenCodeMutationInput<"prompt"> | OpenCodeMutationInput<"compact">).id : undefined;
      // Admission and its durable receipt can precede the first native event.
      // Pin the scope before dispatch so a carrier close cannot lose that event.
      if (inputId) {
        try { this.#hub.beginInput(authority, inputId); }
        catch (error) { throw new OpenCodeNativeMutationDeliveryError("not_sent",
          error instanceof OpenCodeRuntimeError ? error.code : "opencode_observation_retention_full"); }
      }
      try {
        return await this.adapter.mutate(leaf, captured as OpenCodeMutationInput<typeof leaf>, budget) as OpenCodeMutationOutput<K>;
      } catch (error) {
        if (inputId && error instanceof OpenCodeNativeMutationDeliveryError && error.delivery === "not_sent") {
          this.#hub.refuseInput(authority, inputId);
        }
        throw error;
      }
    }, signal); }
    finally { scope.operations--; this.#collectScope(authority); }
  }

  observe(authority: OpenCodeNativeAuthority, input: Parameters<OpenCodeNativePort["observe"]>[0]): OpenCodePortObservation {
    const scope = this.#assertAuthority(authority);
    if (!authority.session) throw denied();
    const raw = this.#hub.subscribe(authority, { ...input,
      signal: AbortSignal.any([this.#lifetime.signal, ...(input.signal ? [input.signal] : [])]) });
    scope.observations++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; this.#observations.delete(observation); scope.observations--;
      this.#collectScope(authority);
    };
    const observation: OpenCodePortObservation = { ...raw,
      get failure() { return raw.failure; },
      close: async () => { try { await raw.close(); } finally { release(); } },
    };
    void observation.ready.catch(() => undefined);
    this.#observations.add(observation);
    void observation.ended.then(release, release);
    return observation;
  }

  freezeAdmission(): void { this.#frozen = true; this.#journal.freeze(); }
  restoreAdmission(): void { if (!this.#lifetime.signal.aborted) { this.#frozen = false; this.#journal.restore(); } }
  hasAdmittedTarget(target: OpenCodeRuntimeTarget): boolean {
    return this.#scopes.has(configurationFingerprint({ ...this.owner, ...target }));
  }
  retentionSnapshot() {
    const journal = this.#journal.snapshot(), observation = this.#hub.retentionSnapshot();
    const inventory = this.#inventory?.observationRevision === observation.revision && this.#inventory.journalRevision === journal.revision ? this.#inventory : undefined;
    return {
      revision: configurationFingerprint({ journal: journal.revision, observation: observation.revision, inventory: inventory ?? null }),
      threadIds: [...new Set([...observation.retainedThreadIds, ...journal.operations.flatMap(item => item.authority.session ? [item.authority.session.applicationThreadId] : [])])],
      pendingMutationCount: journal.operations.filter(item => item.status === "pending").length,
      retainedMutationCount: journal.operations.length,
      observation: { pendingEvidenceCount: observation.evidenceRecords, nativeConnected: observation.nativeConnected,
        currentInputCount: observation.currentInputScopes, retentionExhausted: observation.retentionExhausted },
      pendingInteractionCount: inventory?.pendingInteractions ?? null,
      activeWorkCount: inventory?.activeWork ?? null,
    };
  }
  /** Bounded read-only refresh; this never claims complete background inventory. */
  async prepareRetirement(): Promise<void> {
    this.#assertOpen(); this.#inventory = undefined;
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(5_000)]);
    const observationRevision = this.#hub.retentionSnapshot().revision, journalRevision = this.#journal.snapshot().revision;
    const scopes = [...this.#scopes.values()].filter(item => item.port.authority.session);
    let pendingInteractions = 0, activeWork = 0;
    try {
      await this.hooks.assertCurrent(signal);
      for (let start = 0; start < scopes.length; start += 16) {
        await Promise.all(scopes.slice(start, start + 16).map(async ({ port }) => {
          const sessionID = port.authority.session!.nativeSessionID;
          const [activity, interactions] = await Promise.all([
            port.read("getActivity", { sessionID, directory: port.authority.directory }, { signal }),
            port.read("getInteractions", { sessionID }, { signal }),
          ]);
          pendingInteractions += interactions.permissions.length + interactions.forms.length;
          activeWork += Number(activity.active) + activity.activeChildren.length + activity.shells.filter(item => item.status === "running").length;
        }));
      }
      signal.throwIfAborted();
      this.#inventory = { observationRevision, journalRevision, pendingInteractions, activeWork };
    } catch { /* Unknown inventory remains an explicit lifecycle blocker. */ }
  }

  snapshot() { return this.#journal.snapshot(); }
  close(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort(); this.#journal.close(); this.#hub.close();
    for (const observer of this.#observations) void observer.close();
    this.#scopes.clear(); this.#routes.clear();
  }
  #assertOpen(): void { if (this.#lifetime.signal.aborted) throw new OpenCodeRuntimeError("opencode_runtime_unavailable"); }
  #assertAuthority(authority: OpenCodeNativeAuthority): NativeScope {
    this.#assertOpen();
    for (const key of ["tenantId", "principalId", "executionEnvironmentId", "backendInstanceId", "runtimeId", "nativeGeneration"] as const) {
      if (authority[key] !== this.owner[key]) throw denied();
    }
    const scope = this.#scopes.get(configurationFingerprint(authority));
    // A released local port must not regain authority when the same logical
    // target is acquired again. Carrier handlers use their admitted scope port.
    if (!scope || scope.port.authority !== authority) throw denied();
    return scope;
  }
  #collectScope(authority: OpenCodeNativeAuthority): void {
    const key = configurationFingerprint(authority), scope = this.#scopes.get(key);
    if (!scope || scope.references || scope.operations || scope.observations ||
        this.#journal.hasRetainedAuthority(authority)) return;
    this.#hub.releaseScope(authority);
    if (this.#hub.hasRetainedAuthority(authority)) return;
    this.#scopes.delete(key); this.#routes.delete(key);
    scope.lifetime.abort();
  }
  #assertInput(authority: OpenCodeNativeAuthority, input: object, mutation: boolean): void {
    if ("directory" in input && input.directory !== authority.directory) throw denied();
    if ("location" in input && (input.location as { directory?: unknown })?.directory !== authority.directory) throw denied();
    if ("sessionID" in input) {
      if (authority.session && input.sessionID !== authority.session.nativeSessionID &&
          (mutation || !this.#routes.get(configurationFingerprint(authority))?.hasSession(input.sessionID))) throw denied();
      if (mutation && !authority.session) throw denied();
    }
  }
}

function eventFilter(root: string) {
  const children = new Set<string>(), shells = new Set<string>();
  const within = (id: unknown) => id === root || typeof id === "string" && children.has(id);
  const remember = (set: Set<string>, id: string) => {
    if (set.has(id)) return;
    if (set.size >= 10_000) throw new OpenCodeRuntimeError("opencode_native_scope_capacity");
    set.add(id);
  };
  return { hasSession: within, seed(activity: OpenCodeNativeActivity) {
    for (const child of activity.children) remember(children, child.id);
    for (const shell of activity.shells) remember(shells, shell.id);
  }, accept(event: OpenCodeNativeEvent): boolean {
    if ((event.type === "session.created" || event.type === "session.forked") && within(event.data.parentID)) {
      remember(children, event.data.sessionID); return true;
    }
    if (event.type === "form.created" && (event.data.form.sessionID === "global" || within(event.data.form.sessionID))) return true;
    if ("sessionID" in event.data && within(event.data.sessionID)) return true;
    if (event.type === "shell.created" && within(event.data.info.metadata.sessionID)) {
      remember(shells, event.data.info.id); return true;
    }
    if ((event.type === "shell.exited" || event.type === "shell.deleted") && shells.has(event.data.id)) {
      return true;
    }
    return false;
  } };
}
function denied(): OpenCodeRuntimeError { return new OpenCodeRuntimeError("opencode_request_authority_mismatch"); }
