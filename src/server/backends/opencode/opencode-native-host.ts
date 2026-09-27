import { randomUUID } from "node:crypto";
import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import { OpenCodeHttpNativeAdapter } from "./opencode-http-native-adapter.js";
import { OpenCodeMutationJournal } from "./opencode-mutation-journal.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import { openCodeNativeAuthoritySchema, parseOpenCodeReadInput, parseOpenCodeMutationInput,
  parseOpenCodeMutationControl, OpenCodeNativeMutationInputError, OpenCodeNativeMutationDeliveryError, type OpenCodeNativeEvent, type OpenCodeNativeActivity } from "./opencode-native-codecs.js";
import type { OpenCodeMutationControl, OpenCodeMutationInput, OpenCodeMutationMethod, OpenCodeMutationOutput,
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

/** One provider-private dispatcher on the execution host. Local clients enter
 * directly; sidecar handlers enter the same closed methods after carrier scope
 * admission. The HTTP adapter and resolved host credentials never leave here. */
export class OpenCodeNativeHost {
  readonly #journal = new OpenCodeMutationJournal();
  readonly #ports = new Map<string, OpenCodeNativePort>();
  readonly #routes = new Map<string, ReturnType<typeof eventFilter>>();
  readonly #lifetime = new AbortController();
  readonly #observations = new Set<OpenCodePortObservation>();
  constructor(readonly owner: OpenCodeNativeOwner, readonly adapter: OpenCodeHttpNativeAdapter,
    readonly hooks: OpenCodeNativeHostHooks, nativeLifetime: AbortSignal) {
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
    const existing = this.#ports.get(key); if (existing) return existing;
    if (this.#ports.size >= 4_096) throw new OpenCodeRuntimeError("opencode_native_scope_capacity");
    const port: OpenCodeNativePort = Object.freeze({ authority, ownerKey: `${this.owner.runtimeId}:${this.owner.nativeGeneration}`,
      lifetime: this.#lifetime.signal,
      read: <K extends OpenCodeReadMethod>(method: K, input: OpenCodeReadInput<K>, options?: { signal?: AbortSignal; deadlineAt?: number }) =>
        this.read(authority, method, input, options),
      mutate: <K extends OpenCodeMutationMethod>(method: K, input: OpenCodeMutationInput<K>, control: OpenCodeMutationControl, options?: { signal?: AbortSignal }) =>
        this.mutate(authority, method, input, control, options?.signal),
      outcome: async <K extends OpenCodeMutationMethod>(method: K, identity: OpenCodeMutationControl["identity"]) => {
        this.#assertAuthority(authority); return this.#journal.outcome(authority, method, identity);
      },
      acknowledgeMutation: async (method: OpenCodeMutationMethod, identity: OpenCodeMutationControl["identity"]) => {
        this.#assertAuthority(authority); this.#journal.acknowledge(authority, method, identity);
      },
      observe: (input?: Parameters<OpenCodeNativePort["observe"]>[0]) => this.observe(authority, input),
    });
    this.#ports.set(key, port);
    if (authority.session) this.#routes.set(key, eventFilter(authority.session.nativeSessionID));
    return port;
  }

  async read<K extends OpenCodeReadMethod>(authority: OpenCodeNativeAuthority, method: K, input: OpenCodeReadInput<K>,
    options: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<OpenCodeReadOutput<K>> {
    this.#assertAuthority(authority);
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
    await this.hooks.assertCurrent(signal); this.#assertAuthority(authority);
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
    return this.#journal.mutate(authority, method, input, control, async (captured, deadline) => {
      const budget = AbortSignal.any([deadline, this.#lifetime.signal]);
      try { await this.hooks.assertCurrent(budget); this.#assertAuthority(authority); }
      catch { throw new OpenCodeNativeMutationDeliveryError("not_sent", "opencode_runtime_unavailable"); }
      if (method === "installSessionEnvironment") {
        await this.hooks.installSessionEnvironment(authority, captured as OpenCodeMutationInput<"installSessionEnvironment">, budget);
        return { ok: true } as OpenCodeMutationOutput<K>;
      }
      if (method === "ensureMcpRegistration") {
        await this.hooks.ensureMcpRegistration(authority, captured as OpenCodeMutationInput<"ensureMcpRegistration">, budget);
        return { ok: true } as OpenCodeMutationOutput<K>;
      }
      const leaf = method as Exclude<OpenCodeMutationMethod, "installSessionEnvironment" | "ensureMcpRegistration">;
      return this.adapter.mutate(leaf, captured as OpenCodeMutationInput<typeof leaf>, budget) as Promise<OpenCodeMutationOutput<K>>;
    }, signal);
  }

  observe(authority: OpenCodeNativeAuthority, input: Parameters<OpenCodeNativePort["observe"]>[0] = {}): OpenCodePortObservation {
    this.#assertAuthority(authority);
    if (!authority.session) throw denied();
    // R1 local composition retains the native subscription lifetime. Persistent
    // host replay is installed before remote capability admission in R2.
    if (input.after) throw new OpenCodeRuntimeError("opencode_observation_continuity_lost");
    const filter = this.#routes.get(configurationFingerprint(authority))!;
    const raw = this.adapter.observe({ signal: AbortSignal.any([this.#lifetime.signal, ...(input.signal ? [input.signal] : [])]) });
    const continuity = randomUUID(); let sequence = 0, acknowledged = 0;
    const observation: OpenCodePortObservation = {
      ready: raw.ready.then(() => ({ continuity, baselineSequence: 0 })), ended: raw.ended,
      get failure() { return raw.failure; },
      drain: () => raw.drain().filter(({ event }) => filter.accept(event)).map(event => ({ ...event, continuity, sequence: ++sequence })),
      wait: signal => raw.wait(signal),
      acknowledge: async value => {
        if (!Number.isSafeInteger(value) || value < acknowledged || value > sequence) throw denied();
        acknowledged = value;
      },
      close: async () => { this.#observations.delete(observation); await raw.close(); },
    };
    void observation.ready.catch(() => undefined);
    this.#observations.add(observation);
    void observation.ended.then(() => this.#observations.delete(observation));
    return observation;
  }

  snapshot() { return this.#journal.snapshot(); }
  close(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort(); this.#journal.close();
    for (const observer of this.#observations) void observer.close();
    this.#ports.clear(); this.#routes.clear();
  }
  #assertOpen(): void { if (this.#lifetime.signal.aborted) throw new OpenCodeRuntimeError("opencode_runtime_unavailable"); }
  #assertAuthority(authority: OpenCodeNativeAuthority): void {
    this.#assertOpen();
    for (const key of ["tenantId", "principalId", "executionEnvironmentId", "backendInstanceId", "runtimeId", "nativeGeneration"] as const) {
      if (authority[key] !== this.owner[key]) throw denied();
    }
    if (!this.#ports.has(configurationFingerprint(authority))) throw denied();
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
