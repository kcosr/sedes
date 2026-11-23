import {AsyncLocalStorage} from "node:async_hooks";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { environmentVariableOverridesSchema, mergeEnvironmentVariableOverrides, type EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import { authorizeVariableResolutionOperation,environmentVariablesResolveOperation, resolvedEnvironmentVariablesSchema } from "../../internal/sidecar-protocol/environment-variables-v1.js";
import type { BackendModuleConfigurationInput, BackendModuleRuntimeContext } from "../backends/module.js";

/** null is an explicit deletion, including a value inherited by the child. */
export type ResolvedEnvironmentVariables = Readonly<Record<string, string | null>>;
export type ThreadEnvironmentResolver = ((threadId: string) => Promise<ResolvedEnvironmentVariables>) & {
  /** Immutable definitions only; never resolved credentials. */
  readonly fingerprint?: (threadId: string) => string;
};
const maximumSecretBytes = 16_384;

export function mergeResolvedEnvironment(
  baseline: Readonly<Record<string, string | undefined>>,
  overrides: ResolvedEnvironmentVariables,
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(baseline)) if (value !== undefined) result[name] = value;
  for (const [name, value] of Object.entries(overrides)) {
    if (platform === "win32") for (const existing of Object.keys(result)) if (existing.toUpperCase() === name.toUpperCase()) delete result[existing];
    if (value === null) delete result[name];
    else result[name] = value;
  }
  return Object.freeze(result);
}

/** Resolves only on the host that owns execution. Errors never contain values. */
export async function resolveEnvironmentVariables(
  overrides: EnvironmentVariableOverrides,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResolvedEnvironmentVariables> {
  const parsed = environmentVariableOverridesSchema.parse(overrides);
  const result: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  for (const [name, entry] of Object.entries(parsed)) {
    if (entry.kind === "unset") { result[name] = null; continue; }
    let value: string;
    if (entry.kind === "literal") value = entry.value;
    else if (entry.source.kind === "environment") {
      const secret = environment[entry.source.name];
      if (secret === undefined) throw new Error("environment_variable_secret_unavailable");
      value = secret;
    } else value = await readProtectedSecret(entry.source.path);
    if (Buffer.byteLength(value, "utf8") > maximumSecretBytes || value.includes("\0")) throw new Error("environment_variable_value_invalid");
    result[name] = value;
  }
  if (!resolvedEnvironmentVariablesSchema.safeParse(result).success) throw new Error("environment_variable_value_limits_exceeded");
  return Object.freeze(result);
}

async function readProtectedSecret(filename: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!path.isAbsolute(filename) || path.normalize(filename) !== filename || await realpath(filename) !== filename) throw new Error();
    const parent = await lstat(path.dirname(filename));
    const before = await lstat(filename);
    const uid = process.geteuid?.() ?? process.getuid?.();
    if (uid === undefined || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022) !== 0 || !before.isFile() || before.isSymbolicLink()) throw new Error();
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await file.stat();
    if (!opened.isFile() || opened.uid !== uid || (opened.mode & 0o077) !== 0 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximumSecretBytes + 2) throw new Error();
    const buffer = Buffer.alloc(maximumSecretBytes + 3);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    const current = await lstat(filename);
    if (bytesRead > maximumSecretBytes + 2 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || current.ino !== opened.ino || current.dev !== opened.dev || current.isSymbolicLink()) throw new Error();
    const value = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    return value.replace(/\r?\n$/u, "");
  } catch { throw new Error("environment_variable_secret_file_unavailable"); }
  finally { await file?.close().catch(() => undefined); }
}

const approvedVariableRequest = new AsyncLocalStorage<{backendInstanceId:string,threadId:string,digest:string}>();
/** Only the resolver of an immutable, main-owned thread snapshot can request a disclosure ticket. */
export function assertApprovedVariableRequest(request:unknown):void {
  const approval=approvedVariableRequest.getStore();
  if(!approval || !request || typeof request!=="object" || !("backendInstanceId" in request) ||
     !("threadId" in request) || !("digest" in request) || request.backendInstanceId!==approval.backendInstanceId ||
     request.threadId!==approval.threadId || request.digest!==approval.digest)throw new Error("sidecar_policy_variable_approval_required");
}
export function createThreadEnvironmentResolver(context: BackendModuleRuntimeContext): ThreadEnvironmentResolver {
  const resolve = async (threadId: string) => {
    const overrides = context.executionEnvironmentVariables?.(threadId) ?? {};
    if (Object.keys(overrides).length === 0) return Object.freeze({});
    if (context.environmentOperations.environmentKind === "local") return resolveEnvironmentVariables(overrides);
    if (!context.sidecarRuntime) throw new Error("environment_variable_host_unavailable");
    const lease = await context.sidecarRuntime.acquire();
    try {
      if (!lease.channel.supportsOperation(environmentVariablesResolveOperation)) throw new Error("environment_variable_host_unsupported");
      const owner={backendInstanceId:context.instance.id,threadId};
      const approved={...owner,digest:configurationFingerprint(overrides)};
      const {ticket}=await approvedVariableRequest.run(approved,()=>lease.channel.call(authorizeVariableResolutionOperation,approved));
      return (await lease.channel.call(environmentVariablesResolveOperation,{...owner,ticket,overrides})).values;
    } finally { lease.release(); }
  };
  return Object.assign(resolve, { fingerprint: (threadId: string) => configurationFingerprint(context.executionEnvironmentVariables?.(threadId) ?? {}) });
}

export function backendStartupEnvironmentVariables(input: BackendModuleConfigurationInput): EnvironmentVariableOverrides {
  const environmentIds = new Set(input.connections.filter(connection => connection.enabled).map(connection => connection.executionEnvironmentId));
  const environment = input.executionEnvironments.find(candidate => environmentIds.has(candidate.id));
  return mergeEnvironmentVariableOverrides(environment?.environmentVariables?.startup ?? {}, input.backend.environmentVariables?.startup ?? {});
}
