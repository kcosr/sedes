import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { attachmentDiagnostic } from "../../../../diagnostics/attachment-diagnostics.js";
import { mergeResolvedEnvironment, resolveEnvironmentVariables, type ResolvedEnvironmentVariables } from "../../../../environment-variables/runtime-environment.js";
import type { EnvironmentOwnedProcessChannel, ExecutionEnvironmentChannelProvider, PreparedEnvironmentOwnedProcess } from "../../../../execution/environment-channel.js";
import { OwnedNdjsonStdioTransportFactory } from "../../../../provider-protocol/transport/owned-ndjson-stdio-transport.js";
import type { PiNativeRuntimeConfiguration, PiNativeSessionIdentity } from "../port.js";
import { PiNativeError } from "../port.js";
import { PiRpcClient, type PiNativeDiagnosticContext } from "./pi-rpc-client.js";
import { PI_RPC_VERSION } from "./pi-rpc-wire.js";
import { PiManagedBridge } from "./pi-managed-bridge.js";
import { installPiManagedExtension } from "./pi-managed-extension.js";

export interface PiNativeSessionProcess {
  readonly rpc: PiRpcClient;
  readonly bridge: PiManagedBridge;
  readonly version: string;
  close(reason?: string): Promise<void>;
}
export interface PiNativeLaunchInput {
  readonly runtime: PiNativeRuntimeConfiguration;
  readonly session?: PiNativeSessionIdentity;
  readonly cwd: string;
  readonly channels: ExecutionEnvironmentChannelProvider;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly executionEnvironment?: ResolvedEnvironmentVariables;
  readonly bridgeDirectory: string;
  readonly authenticationKey: Uint8Array;
  readonly signal?: AbortSignal;
  readonly diagnostic?: Pick<PiNativeDiagnosticContext, "runtimeId" | "handleId" | "handleGeneration">;
  readonly onEvent?: (event: { kind: "rpc" | "companion"; payload: Readonly<Record<string, unknown>> }) => void;
}

export function buildPiNativeChildEnvironment(environment: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const names = ["HOME", "USERPROFILE", "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TZ", "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "PI_CODING_AGENT_DIR"];
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && (names.includes(name) || /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE|AWS|BEDROCK|MISTRAL|GROQ|XAI|OPENROUTER|CEREBRAS|DEEPSEEK|TOGETHER|HUGGINGFACE)_[A-Z0-9_]+$/u.test(name))) result[name] = value;
  }
  result.HOME ??= homedir(); result.NO_COLOR = "1"; result.TERM = "dumb";
  return result;
}

export async function createPiNativeSessionProcess(input: PiNativeLaunchInput): Promise<PiNativeSessionProcess> {
  const diagnostic: PiNativeDiagnosticContext = { ...input.diagnostic, attachmentId: randomUUID(),
    backendInstanceId: input.runtime.backendInstanceId, executionEnvironmentId: input.runtime.executionEnvironmentId,
    role: input.session ? "session" : "catalog" };
  attachmentDiagnostic("pi_native_launch_started", diagnostic);
  try { return await launch(input, diagnostic); }
  catch (error) { attachmentDiagnostic("pi_native_launch_failed", diagnostic, error); throw error; }
}

async function launch(input: PiNativeLaunchInput, diagnostic: PiNativeDiagnosticContext): Promise<PiNativeSessionProcess> {
  const scope = input.runtime;
  if (input.authenticationKey.byteLength < 32 || input.channels.scope.tenantId !== scope.tenantId || input.channels.scope.principalId !== scope.principalId || input.channels.executionEnvironmentId !== scope.executionEnvironmentId) throw new Error("pi_native_launch_scope_invalid");
  if (!input.channels.resolveOwnedProcessExecutable) throw new Error("pi_native_executable_resolution_unsupported");
  const executable = await input.channels.resolveOwnedProcessExecutable(scope, { commandName: "pi", ...(scope.executablePath ? { configuredPath: scope.executablePath } : {}) });
  const prepared = await input.channels.prepareOwnedProcess(scope, { executablePath: executable.canonicalPath, workingDirectory: input.cwd });
  const environment = { ...mergeResolvedEnvironment(mergeResolvedEnvironment(buildPiNativeChildEnvironment(input.environment), await resolveEnvironmentVariables(scope.startupEnvironmentVariables ?? {}, input.environment)), input.executionEnvironment ?? {}) };
  // Managed bootstrap values are never caller-supplied or inherited. In
  // particular, evidence keys and bearer tokens must not enter /proc/*/environ.
  for (const name of Object.keys(environment)) if (name.startsWith("SEDES_PI_")) delete environment[name];
  const before = await executableIdentity(executable.canonicalPath);
  await verifyVersion(input, prepared, environment);
  if (before !== await executableIdentity(executable.canonicalPath)) throw new Error("pi_native_executable_changed");
  const extension = await installPiManagedExtension(input.bridgeDirectory);
  const bridge = await PiManagedBridge.listen(input.bridgeDirectory, input.authenticationKey, diagnostic);
  let rpc: PiRpcClient | undefined;
  try {
    const timeout = AbortSignal.timeout(scope.initializationTimeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const factory = new OwnedNdjsonStdioTransportFactory({ scope, channels: input.channels, process: prepared,
      environment: { ...environment, ...(scope.agentDirectory ? { PI_CODING_AGENT_DIR: scope.agentDirectory } : {}),
        SEDES_PI_BOOTSTRAP_FILE: bridge.bootstrapPath },
      commandArguments: ["--mode", "rpc", "--no-extensions", "-e", extension, scope.projectTrusted ? "--approve" : "--no-approve", ...(input.session ? ["--session", input.session.sessionFile] : ["--no-session"])],
      retainStderr: false, assuranceDiagnosticPrefix: "pi_native", transportDiagnosticPrefix: "pi_native",
      onProcessClosed: closure => attachmentDiagnostic("pi_native_process_exited", { ...diagnostic,
        reason: closure.reason, exitCode: closure.exitCode, signal: closure.signal }, closure.cause),
    });
    const transport = await factory.open(scope, 1, signal);
    rpc = new PiRpcClient({ transport, scope, connectionGeneration: 1, diagnostic });
    rpc.subscribe((payload) => input.onEvent?.({ kind: "rpc", payload }));
    bridge.subscribe((payload) => input.onEvent?.({ kind: "companion", payload }));
    const abort = new Promise<never>((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    const state = await Promise.race([bridge.ready, abort, rpc.closed.then(() => { throw new Error("pi_native_initialization_exited"); })]);
    if (input.session && (state.sessionId !== input.session.sessionId || state.sessionFile !== input.session.sessionFile)) throw new Error("pi_native_session_identity_mismatch");
    const client = rpc;
    void bridge.closed.then(() => client.close("pi_native_companion_closed")).catch(() => undefined);
    void rpc.closed.then(() => bridge.close("pi_native_process_closed")).catch(() => undefined);
    attachmentDiagnostic("pi_native_launch_ready", diagnostic);
    return { rpc, bridge, version: PI_RPC_VERSION, async close(reason = "pi_native_closed") {
      const results = await Promise.allSettled([client.close(reason), bridge.close(reason)]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } };
  } catch (error) {
    const cleanup = await Promise.allSettled([rpc?.close("pi_native_initialization_failed"), bridge.close("pi_native_initialization_failed")]);
    if (cleanup.some((result) => result.status === "rejected")) throw new PiNativeError("pi_native_cleanup_unproven", "sent_outcome_unknown", { cause: error });
    throw error;
  }
}

async function executableIdentity(filename: string): Promise<string> {
  const identity = await stat(filename, { bigint: true });
  if (!identity.isFile()) throw new Error("pi_native_executable_invalid");
  return [identity.dev, identity.ino, identity.size, identity.mtimeNs, identity.ctimeNs, identity.mode].join(":");
}
async function verifyVersion(input: PiNativeLaunchInput, prepared: PreparedEnvironmentOwnedProcess, environment: Readonly<Record<string, string>>): Promise<void> {
  const timeout = AbortSignal.timeout(Math.min(input.runtime.initializationTimeoutMs, 5_000));
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let channel: EnvironmentOwnedProcessChannel | undefined;
  async function read(source: AsyncIterable<Uint8Array>): Promise<string> {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of source) { bytes += chunk.byteLength; if (bytes > 4096) throw new Error("pi_native_version_output_limit"); chunks.push(Buffer.from(chunk)); }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  }
  try {
    channel = await input.channels.openOwnedProcess(input.runtime, { prepared, arguments: ["--version"], environment, cleanup: { gracefulCloseMilliseconds: 250, terminateMilliseconds: 500, killMilliseconds: 500 } }, signal);
    const stdout = read(channel.stdout); const stderr = read(channel.stderr);
    const abort = new Promise<never>((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    const [closure, output] = await Promise.race([Promise.all([channel.closed, stdout, stderr]), abort]);
    if (closure.exitCode !== 0 || output.trim() !== PI_RPC_VERSION) throw new Error("pi_native_version_unsupported");
  } finally {
    try { await channel?.close("pi_native_version_probe_complete"); }
    catch (cause) { throw new PiNativeError("pi_native_cleanup_unproven", "sent_outcome_unknown", { cause }); }
  }
}
