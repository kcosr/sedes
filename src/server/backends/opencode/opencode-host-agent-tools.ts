import type { AgentToolCatalogSummary } from "../../agent-tools/contracts/agent-tool-contracts.js";
import type { OpenCodeMcpRequest } from "../../../internal/opencode-mcp/contracts.js";

export interface OpenCodeHostToolTarget {
  readonly directory: string;
  readonly session: { readonly applicationThreadId: string; readonly nativeSessionID: string; readonly bindingFingerprint: string };
}
/** Opaque source capabilities are issued by main; all endpoints and helper paths are host-owned. */
export interface OpenCodeHostToolAdmission {
  readonly sourceCapability: string;
  readonly catalog: readonly AgentToolCatalogSummary[];
  readonly cli?: { readonly sourceCapability: string; readonly mode: "individual" | "progressive" };
}
export interface OpenCodeHostToolAdmissionResult {
  readonly registrationAdmissionId: string;
  readonly registrationName: string;
  readonly registrationControl: import("./opencode-native-port.js").OpenCodeMutationControl;
  readonly cliAdmissionId: string | null;
}
/** The same router calls a local facade or the authenticated sidecar reverse relay. */
export type OpenCodeHostToolInvoker = (sourceCapability: string, request: OpenCodeMcpRequest, signal: AbortSignal,
  stamp: OpenCodeToolInvocationStamp | undefined) => Promise<unknown>;

import type { OpenCodeToolInvocationStamp } from "./opencode-tool-invocation.js";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { agentToolCatalogSummarySchema } from "../../../internal/agent-tool-cli-protocol/contracts.js";
import { OPENCODE_MCP_WATCHDOG_MS } from "../../../internal/opencode-mcp/contracts.js";
import { OpenCodeHttpNativeAdapter } from "./opencode-http-native-adapter.js";
import { OpenCodeMcpIngress, type OpenCodeMcpChannel } from "./opencode-mcp-ingress.js";
import { BackendAgentToolRequestError } from "../../agent-tools/adapters/backend-facade.js";
import { openCodeNativeAuthoritySchema, openCodeMutationControlSchema, OpenCodeNativeMutationDeliveryError } from "./opencode-native-codecs.js";

export const openCodeHostToolTargetSchema = openCodeNativeAuthoritySchema.pick({ directory: true, session: true }).required({ session: true });
export const openCodeHostToolAdmissionSchema = z.strictObject({ sourceCapability: z.string().min(1).max(16_384),
  catalog: z.array(agentToolCatalogSummarySchema).max(256),
  cli: z.strictObject({ sourceCapability: z.string().min(1).max(16_384), mode: z.enum(["individual", "progressive"]) }).optional() });
export const openCodeHostToolAdmissionResultSchema = z.strictObject({
  registrationAdmissionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  registrationName: z.string().regex(/^sedes_[a-f0-9]{48}$/u),
  registrationControl: openCodeMutationControlSchema.refine(control => control.identity.origin === "host" && control.identity.step === "register-mcp"),
  cliAdmissionId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).nullable(),
});
interface HostSession { readonly target: OpenCodeHostToolTarget; readonly admission: OpenCodeHostToolAdmission;
  readonly result: OpenCodeHostToolAdmissionResult; readonly owner: AbortController; }
interface HostRegistration { readonly channel: OpenCodeMcpChannel; readonly ready: Promise<void>; }
interface HostLocation { name: string; admissionId: string; admissionCount: number; retryAfter: number;
  registration?: HostRegistration; task?: Promise<void>; failed?: boolean; }
export interface OpenCodeHostToolEndpoint {
  readonly endpoint: string;
  readonly executableDirectory: string;
}

/** Execution-host owner: shared native registration and its bridge never live on main by accident. */
export class OpenCodeHostAgentTools {
  readonly #ingress = new OpenCodeMcpIngress();
  readonly #sessions = new Map<string, HostSession>();
  readonly #cliCapabilities = new Map<string, HostSession>();
  readonly #locations = new Map<string, HostLocation>();
  #closed = false;
  #admissions = 0;
  constructor(readonly options: { readonly adapter: OpenCodeHttpNativeAdapter;
    readonly cli: () => OpenCodeHostToolEndpoint | undefined;
    readonly capture: (target: OpenCodeHostToolTarget) => OpenCodeToolInvocationStamp;
    readonly invoke: OpenCodeHostToolInvoker;
    readonly assertCurrent: (signal?: AbortSignal) => Promise<void>;
  }) {}

  async admit(target: OpenCodeHostToolTarget, value: OpenCodeHostToolAdmission, signal?: AbortSignal): Promise<OpenCodeHostToolAdmissionResult> {
    target = openCodeHostToolTargetSchema.parse(target);
    const admission = openCodeHostToolAdmissionSchema.parse(value);
    if (admission.cli) {
      const known = this.#cliCapabilities.get(admission.cli.sourceCapability);
      if (known && !sameTarget(known.target, target) || !known && this.#cliCapabilities.size >= 4_096) throw denied();
    }
    await this.#assertTarget(target, signal);
    if (admission.cli) {
      // Concurrent admission can change the capability index during validation.
      const known = this.#cliCapabilities.get(admission.cli.sourceCapability);
      if (known && !sameTarget(known.target, target) || !known && this.#cliCapabilities.size >= 4_096) throw denied();
      // CLI authority needs no native MCP registration, catalogue or workspace
      // slot. Keep its exact session bound and subject to the same live limit.
      const key = target.session.applicationThreadId, previous = this.#sessions.get(key);
      if (previous && sameTarget(previous.target, target) && JSON.stringify(previous.admission) === JSON.stringify(admission)) return previous.result;
      if (!previous && this.#sessions.size >= 1_000) throw denied();
      previous?.owner.abort();
      const result = Object.freeze({ registrationAdmissionId: randomBytes(32).toString("base64url"),
        registrationName: registrationName(), registrationControl: registrationControl(randomBytes(32).toString("base64url")),
        cliAdmissionId: randomBytes(32).toString("base64url") });
      const entry = { target: structuredClone(target), admission, result, owner: new AbortController() };
      this.#sessions.set(key, entry); this.#cliCapabilities.set(admission.cli.sourceCapability, entry);
      return result;
    }
    let location = this.#locations.get(target.directory);
    if (!location) {
      if (this.#locations.size >= 64) throw denied();
      const admissionId = randomBytes(32).toString("base64url");
      location = { name: registrationName(), admissionId, admissionCount: 0, retryAfter: 0 };
      this.#locations.set(target.directory, location);
    }
    if (!location.task && (location.failed || location.registration?.channel.revoked)) {
      if (location.registration?.channel.revoked) {
        location.retryAfter = Math.max(location.retryAfter, location.registration.channel.revokedAt! + OPENCODE_MCP_WATCHDOG_MS);
        if (Date.now() >= location.retryAfter) { location.registration = undefined; location.name = registrationName(); }
      }
      location.admissionId = randomBytes(32).toString("base64url");
      location.failed = false;
    }
    const key = target.session.applicationThreadId;
    const previous = this.#sessions.get(key);
    if (previous && previous.result.registrationAdmissionId === location.admissionId && sameTarget(previous.target, target) && JSON.stringify(previous.admission) === JSON.stringify(admission)) return previous.result;
    if (previous) previous.owner.abort();
    if (!previous && this.#sessions.size >= 1_000) throw denied();
    const result = Object.freeze({ registrationAdmissionId: location.admissionId, registrationName: location.name, registrationControl: registrationControl(randomBytes(32).toString("base64url")),
      cliAdmissionId: admission.cli ? randomBytes(32).toString("base64url") : null });
    this.#sessions.set(key, { target: structuredClone(target), admission, result, owner: new AbortController() });
    return result;
  }

  async ensureRegistration(target: OpenCodeHostToolTarget, registrationAdmissionId: string, signal?: AbortSignal): Promise<void> {
    let entry: HostSession;
    const location = this.#locations.get(target.directory);
    try {
      entry = this.#require(target);
      if (!location || registrationAdmissionId !== location.admissionId || entry.result.registrationAdmissionId !== registrationAdmissionId) throw denied();
    } catch { throw new OpenCodeNativeMutationDeliveryError("not_sent", "opencode_agent_tools_unavailable"); }
    if (location.task) return location.task;
    const task = this.#register(entry, location, signal).catch(error => { location.failed = true; throw error; }).finally(() => { if (location.task === task) location.task = undefined; });
    location.task = task; return task;
  }

  cliEnvironment(target: OpenCodeHostToolTarget, cliAdmissionId: string): { readonly generated: Readonly<Record<string, string>>; readonly executableDirectory: string } {
    const entry = this.#require(target);
    const cli = entry.admission.cli, endpoint = this.options.cli();
    if (!cli || entry.result.cliAdmissionId !== cliAdmissionId || !endpoint || !path.posix.isAbsolute(endpoint.executableDirectory)) throw denied();
    return { generated: Object.freeze({ SEDES_AGENT_TOOL_ENDPOINT: endpoint.endpoint,
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: cli.sourceCapability, SEDES_AGENT_TOOL_CLI_MODE: cli.mode }), executableDirectory: endpoint.executableDirectory };
  }

  ownsCliCapability(sourceCapability: string): boolean { return this.#cliCapabilities.has(sourceCapability); }

  /** Native CLI callers supply only an opaque admitted capability, never a session ID. */
  captureCliInvocation(sourceCapability: string): OpenCodeToolInvocationStamp | undefined {
    const entry = this.#cliCapabilities.get(sourceCapability);
    if (!entry) return undefined;
    // Keep revoked capability recognition until owner retirement. Otherwise an
    // old route could fall through to another backend's generic CLI relay.
    this.#require(entry.target);
    if (this.#sessions.get(entry.target.session.applicationThreadId) !== entry || entry.owner.signal.aborted) throw denied();
    return this.options.capture(entry.target);
  }

  release(target: OpenCodeHostToolTarget): void {
    const entry = this.#sessions.get(target.session.applicationThreadId);
    if (!entry || !sameTarget(entry.target, target)) return;
    this.#sessions.delete(target.session.applicationThreadId); entry.owner.abort();
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const entry of this.#sessions.values()) entry.owner.abort();
    this.#sessions.clear(); this.#cliCapabilities.clear();
    for (const location of this.#locations.values()) location.registration?.channel.revoke();
    await this.#ingress.close();
    await Promise.allSettled([...this.#locations.values()].flatMap(location => location.task ? [location.task] : []));
    this.#locations.clear();
  }
  #require(target: OpenCodeHostToolTarget): HostSession {
    const entry = this.#sessions.get(target.session.applicationThreadId);
    if (this.#closed || this.options.adapter.client.lifetime.aborted || !entry || entry.owner.signal.aborted || !sameTarget(entry.target, target)) throw denied();
    return entry;
  }
  async #assertTarget(target: OpenCodeHostToolTarget, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#closed || !path.posix.isAbsolute(target.directory) || path.posix.normalize(target.directory) !== target.directory ||
        !target.session.applicationThreadId || !/^[a-f0-9]{64}$/u.test(target.session.bindingFingerprint)) throw denied();
    await this.options.assertCurrent(signal);
    const session = await this.options.adapter.read("getSession", { sessionID: target.session.nativeSessionID }, signal);
    await this.options.assertCurrent(signal); signal?.throwIfAborted();
    if (this.#closed || session.parentID || session.fork || session.location.directory !== target.directory) throw denied();
  }
  async #call(directory: string, request: OpenCodeMcpRequest, signal: AbortSignal): Promise<unknown> {
    const entries = [...this.#sessions.values()].filter(entry => entry.target.directory === directory && entry.target.session.nativeSessionID === request.sessionID);
    if (entries.length !== 1) throw denied();
    const entry = entries[0]!;
    this.#require(entry.target);
    const stamp = request.operation === "invoke" ? this.options.capture(entry.target) : undefined;
    const invocationSignal = AbortSignal.any([signal, entry.owner.signal]);
    await this.#assertTarget(entry.target, invocationSignal);
    if (this.#require(entry.target) !== entry) throw denied();
    invocationSignal.throwIfAborted();
    return this.options.invoke(entry.admission.sourceCapability, request, invocationSignal, stamp);
  }
  async #register(entry: HostSession, location: HostLocation, signal?: AbortSignal): Promise<void> {
    let nativeWritePossible = location.registration !== undefined;
    try {
      this.#require(entry.target);
      if (location.registration && !location.registration.channel.revoked) {
        try { await location.registration.ready; } catch (error) { if (!location.registration.channel.connected) throw error; }
        return;
      }
      if (location.registration) {
        location.retryAfter = Math.max(location.retryAfter, location.registration.channel.revokedAt! + OPENCODE_MCP_WATCHDOG_MS);
        location.registration = undefined;
        // A revoked registration is never overwritten; later admission gets a fresh native name.
        location.name = registrationName();
      }
      if (Date.now() < location.retryAfter || location.admissionCount >= 8 || this.#admissions >= 64) throw denied();
      const cli = this.options.cli(), client = this.options.adapter.client, directory = entry.target.directory;
      if (!cli || !path.posix.isAbsolute(cli.executableDirectory)) throw denied();
      const adapter = this.options.adapter;
      const inventory = await adapter.listMcp(directory, signal);
      if (inventory.location.directory !== directory || inventory.data.some(item => item.name === location.name)) throw denied();
      await this.#assertTarget(entry.target, signal); this.#require(entry.target);
      const channel = await this.#ingress.admit({ catalog: entry.admission.catalog,
        invoke: (request, signal) => this.#call(directory, request, signal) });
      try { await this.#assertTarget(entry.target, signal); this.#require(entry.target); }
      catch (error) { channel.revoke(); throw error; }
      location.admissionCount++; this.#admissions++;
      nativeWritePossible = true;
      const ready = adapter.addMcp({ name: location.name, directory,
        command: [path.posix.join(cli.executableDirectory, "sedes"), "opencode-mcp"], environment: { ...channel.environment } }, signal);
      location.registration = { channel, ready };
      client.lifetime.addEventListener("abort", () => channel.revoke(), { once: true });
      await ready;
    } catch (error) {
      if (!nativeWritePossible) throw new OpenCodeNativeMutationDeliveryError("not_sent", "opencode_agent_tools_unavailable");
      throw error;
    }
  }
}
function sameTarget(a: OpenCodeHostToolTarget, b: OpenCodeHostToolTarget): boolean {
  return a.directory === b.directory && a.session.applicationThreadId === b.session.applicationThreadId &&
    a.session.nativeSessionID === b.session.nativeSessionID && a.session.bindingFingerprint === b.session.bindingFingerprint;
}
function registrationName(): string { return `sedes_${randomBytes(24).toString("hex")}`; }
function denied(): BackendAgentToolRequestError { return new BackendAgentToolRequestError({ code: "permission_denied", retryable: false, message: "This OpenCode session is not admitted to Sedes tools." }); }

function registrationControl(operationId: string): import("./opencode-native-port.js").OpenCodeMutationControl {
  return Object.freeze({ identity: Object.freeze({ origin: "host", operationId, step: "register-mcp" }), deadlineAt: Date.now() + 60_000 });
}
