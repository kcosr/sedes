import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { SIDECAR_WIRE_VERSION } from "../../internal/sidecar-protocol/envelopes.js";
import { readSidecarManagementRecord, writeSidecarManagementRecord } from "../../internal/sidecar-protocol/service-management-channel.js";
import { SIDECAR_MANAGEMENT_VERSION, sidecarManagementResponseSchema, sidecarServiceScopeSchema,
  type SidecarServiceConfiguration, type SidecarServiceScope, type SidecarServiceStatus } from "../../internal/sidecar-protocol/service-management-v1.js";
import { darwinSidecarPlatform } from "./sidecar-darwin-platform.js";
import { windowsSidecarPlatform } from "./sidecar-windows-platform.js";
import { windowsSidecarIpc } from "./sidecar-windows-ipc.js";
import { persistentSidecarPaths } from "./persistent-sidecar-paths.js";
import { sidecarSocketByteStream } from "./sidecar-socket-byte-stream.js";
import { sidecarProcessOwnership, type SidecarLegacyStoppedDescriptor, type SidecarTargetLifetime, type SidecarProcessIdentity } from "./sidecar-process-ownership.js";

const processIdentitySchema = z.custom<SidecarProcessIdentity>(sidecarProcessOwnership.validProcess);
const descriptorFields = z.strictObject({
  version: z.literal(3),
  lifetime: z.custom<SidecarTargetLifetime>(sidecarProcessOwnership.validLifetime),
  scope: sidecarServiceScopeSchema,
  state: z.enum(["starting", "running", "stopped"]),
  process: processIdentitySchema,
  serviceIncarnation: z.string().min(1).max(160),
});
const ownershipMatches = (value: { lifetime: SidecarTargetLifetime; process: SidecarProcessIdentity }) => sidecarProcessOwnership.lifetimeMatchesProcess(value.lifetime, value.process);
const serviceDescriptorSchema = descriptorFields.refine(ownershipMatches);
const startupOwnerSchema = descriptorFields.pick({ version: true, process: true, lifetime: true }).extend({ lockId: z.uuid() }).refine(ownershipMatches);
type ServiceDescriptor = z.infer<typeof serviceDescriptorSchema>;

export interface PersistentSidecarBootstrapInput {
  readonly scope: SidecarServiceScope;
  readonly configuration: SidecarServiceConfiguration;
  readonly expectedDigest: string;
  readonly expectedBuild: string;
  readonly agentToolEndpointKey: string;
  readonly executablePath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export async function preparePersistentSidecarNamespace(scope: SidecarServiceScope) {
  if (!["linux", "darwin", "win32"].includes(process.platform)) throw new Error("sidecar_service_platform_unsupported");
  const uid = process.platform === "win32" ? 0 : process.getuid?.();
  if (uid === undefined) throw new Error("sidecar_service_account_unavailable");
  const accountHome = await realpath(homedir());
  const paths = persistentSidecarPaths(accountHome, uid, scope);
  // Install validates the higher account namespace. Recheck the service-owned
  // directories too; a symlink is never a shortcut to another authority scope.
  await assertOwnedDirectory(paths.stateRoot, false);
  await ensureOwnedDirectory(paths.servicesRoot);
  await ensureOwnedDirectory(paths.serviceDirectory);
  await ensureOwnedDirectory(paths.socketDirectory);
  return paths;
}

export async function ensurePersistentSidecar(input: PersistentSidecarBootstrapInput): Promise<string> {
  input.signal?.throwIfAborted();
  const paths = await preparePersistentSidecarNamespace(input.scope);
  const existing = await inspectAtEndpoint(paths.endpointPath, input.scope);
  input.signal?.throwIfAborted();
  if (existing && existing.state !== "stopped") return paths.endpointPath;
  const release = await acquireStartupLock(paths.lockDirectory, input.signal);
  try {
    const current = await inspectAtEndpoint(paths.endpointPath, input.scope);
    input.signal?.throwIfAborted();
    if (current && current.state !== "stopped") return paths.endpointPath;
    for (let attempt = 0; ; attempt += 1) {
      input.signal?.throwIfAborted();
      try { await assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath); break; }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "sidecar_service_retirement_in_progress" || attempt >= 149) throw error;
        // A daemon that recorded "stopped" already proved its resource cleanup;
        // only its own exit is outstanding. Prompt it after a grace period so a
        // straggling handle cannot block replacement.
        const pid = (error as { retiringPid?: number }).retiringPid;
        if (process.platform === "linux" && pid !== undefined && (attempt === 30 || attempt === 100)) {
          try { process.kill(pid, attempt === 30 ? "SIGTERM" : "SIGKILL"); } catch { /* already exited */ }
        }
        await pause(100);
      }
    }
    input.signal?.throwIfAborted();
    await verifyOwnArtifact(input.executablePath, input.expectedDigest);
    input.signal?.throwIfAborted();
    // Persist intent before spawn. A bootstrap crash in the spawn/ready window
    // must never make a second caller assume no children were launched.
    const startupIncarnation = randomUUID();
    await recordPersistentSidecar(input.scope, startupIncarnation, "starting");
    if (input.signal?.aborted) {
      await settleFailedStartup(input.scope, paths.descriptorPath, startupIncarnation);
      input.signal.throwIfAborted();
    }
    let child: ReturnType<typeof spawn>;
    try { child = spawn(process.execPath, [input.executablePath, "service", "daemon",
      "--expected-digest", input.expectedDigest, "--expected-build", input.expectedBuild,
      "--service-scope", encodeArgument(input.scope), "--configuration", encodeArgument(input.configuration),
      "--agent-tool-endpoint-key", input.agentToolEndpointKey], {
      detached: true, stdio: "ignore", env: input.environment ?? process.env,
    }); } catch (error) {
      await settleFailedStartup(input.scope, paths.descriptorPath, startupIncarnation);
      throw new Error("sidecar_service_spawn_failed", { cause: error });
    }
    let spawnFailure: Error | undefined;
    child.once("error", (error) => { spawnFailure = error; });
    child.unref();
    for (let attempt = 0; attempt < 150; attempt += 1) {
      input.signal?.throwIfAborted();
      if (spawnFailure) {
        await settleFailedStartup(input.scope, paths.descriptorPath, startupIncarnation);
        throw new Error("sidecar_service_spawn_failed", { cause: spawnFailure });
      }
      const status = await inspectAtEndpoint(paths.endpointPath, input.scope);
      input.signal?.throwIfAborted();
      if (status) return paths.endpointPath;
      if (child.exitCode !== null || child.signalCode !== null) {
        await settleFailedStartup(input.scope, paths.descriptorPath, startupIncarnation);
        throw new Error("sidecar_service_start_failed");
      }
      await pause(100);
    }
    // Never kill an uncertain startup merely because the bootstrap timed out.
    // The descriptor/lock proof prevents a following caller from duplicating it.
    throw new Error("sidecar_service_start_unconfirmed");
  } finally { await release(); }
}

// Called only with positive spawn failure/exit evidence while holding the
// startup lock. Once the daemon replaces our intent, its resources may exist;
// never overwrite that descriptor based only on an absent endpoint.
async function settleFailedStartup(scope: SidecarServiceScope, descriptorPath: string, startupIncarnation: string): Promise<void> {
  await assertPrivateFile(descriptorPath);
  const descriptor = serviceDescriptorSchema.parse(JSON.parse(await readFile(descriptorPath, "utf8")));
  const identity = await readProcessIdentity(process.pid);
  if (descriptor.state === "starting" && descriptor.serviceIncarnation === startupIncarnation && sameProcess(identity, descriptor.process)) {
    await recordPersistentSidecar(scope, startupIncarnation, "stopped");
  }
}

export async function recordPersistentSidecar(scope: SidecarServiceScope, serviceIncarnation: string, state: "starting" | "running" | "stopped"): Promise<void> {
  const paths = await preparePersistentSidecarNamespace(scope);
  const identity = await readProcessIdentity(process.pid);
  if (!identity) throw new Error("sidecar_service_process_identity_unavailable");
  const lifetime = await sidecarProcessOwnership.readTargetLifetime();
  const descriptor = serviceDescriptorSchema.parse({ version: 3, scope, state, process: identity, lifetime, serviceIncarnation });
  const temporary = `${paths.descriptorPath}.${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    if (process.platform === "win32") await windowsSidecarPlatform.privacy(temporary, "secure-file");
    await handle.writeFile(JSON.stringify(descriptor)); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await rename(temporary, paths.descriptorPath);
    if (process.platform !== "win32") {
      const directory = await open(paths.serviceDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  finally { await unlink(temporary).catch(() => undefined); }
}

export async function inspectAtEndpoint(endpointPath: string, scope: SidecarServiceScope): Promise<SidecarServiceStatus | undefined> {
  let endpointKey: Buffer | undefined;
  if (process.platform === "win32") {
    try { endpointKey = await windowsSidecarIpc.readKey(endpointPath); }
    catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  }
  const socket = connect(endpointPath);
  try {
    const connected = await new Promise<boolean>((resolve, reject) => {
      socket.once("connect", () => resolve(true));
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
        else reject(error);
      });
    });
    if (!connected) return undefined;
    if (endpointKey) await windowsSidecarIpc.authenticate(socket, endpointKey, "client");
    const stream = sidecarSocketByteStream(socket);
    const requestId = randomUUID();
    await writeSidecarManagementRecord(stream, { managementVersion: SIDECAR_MANAGEMENT_VERSION, requestId, scope, operation: "status" });
    const { value } = await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, AbortSignal.timeout(5_000));
    if (value.requestId !== requestId || value.outcome !== "ok") throw new Error("sidecar_service_identity_unproven");
    return value.status;
  } finally { socket.destroy(); }
}

export async function assertPreviousServiceRetired(descriptorPath: string, endpointPath: string): Promise<void> {
  let descriptor: ServiceDescriptor | undefined;
  let legacyStopped: SidecarLegacyStoppedDescriptor | undefined;
  try {
    await assertPrivateFile(descriptorPath);
    const raw: unknown = JSON.parse(await readFile(descriptorPath, "utf8"));
    const parsed = serviceDescriptorSchema.safeParse(raw);
    if (parsed.success) descriptor = parsed.data;
    else if (sidecarProcessOwnership.validLegacyStoppedDescriptor(raw)) legacyStopped = raw;
    else throw new Error("sidecar_service_recovery_required");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  if (legacyStopped) {
    // A predecessor's clean shutdown proved its resource cleanup before writing
    // "stopped"; only its own exit remains to be observed before replacement.
    if (await sidecarProcessOwnership.legacyProcessMatches(legacyStopped.process)) throw retirementInProgress(legacyStopped.process.pid);
  }
  if (descriptor) {
    const retired = await sidecarProcessOwnership.lifetimeEnded(descriptor.lifetime);
    if (!retired && (descriptor.state === "running" || descriptor.state === "starting")) {
      // A live owner with a broken management socket needs different recovery
      // from a dead owner whose descendants remain unproven. Neither permits
      // replacement until resource cleanup or target retirement is established.
      throw new Error(await sidecarProcessOwnership.unavailableServiceCode(descriptor.process));
    }
    if (!retired && descriptor.state === "stopped" && await sidecarProcessOwnership.processMatches(descriptor.process)) {
      throw retirementInProgress(descriptor.process.pid);
    }
  }
  if (process.platform === "win32") return; // Named pipes disappear with their owning server.
  const metadata = await lstat(endpointPath).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (metadata) {
    if (!metadata.isSocket() || metadata.uid !== process.getuid?.()) throw new Error("sidecar_service_endpoint_invalid");
    await unlink(endpointPath);
  }
}

export async function acquireStartupLock(directory: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  signal?.throwIfAborted();
  const identity = await readProcessIdentity(process.pid);
  if (!identity) throw new Error("sidecar_startup_owner_unproven");
  const lifetime = await sidecarProcessOwnership.readTargetLifetime();
  signal?.throwIfAborted();
  const lockId = randomUUID();
  const ownerPath = path.join(directory, "owner.json");
  const candidate = `${directory}.${randomUUID()}.candidate`;
  await ensureOwnedDirectory(candidate);
  try {
    const candidateOwnerPath = path.join(candidate, "owner.json");
    const candidateOwner = await open(candidateOwnerPath, "wx", 0o600);
    try {
      if (process.platform === "win32") await windowsSidecarPlatform.privacy(candidateOwnerPath, "secure-file");
      await candidateOwner.writeFile(JSON.stringify({ version: 3, process: identity, lifetime, lockId }));
      await candidateOwner.sync();
    } finally { await candidateOwner.close(); }
    for (let attempt = 0; attempt < 150; attempt += 1) {
      signal?.throwIfAborted();
      try {
        // A fully populated directory becomes visible in one rename. An empty
        // orphan from an interrupted older startup is also replaced atomically.
        await rename(candidate, directory);
        return async () => {
          const owner = startupOwnerSchema.parse(JSON.parse(await readFile(ownerPath, "utf8")));
          if (!sameProcess(identity, owner.process) || owner.lockId !== lockId) throw new Error("sidecar_startup_lock_changed");
          await retireStartupLock(directory, owner);
        };
      } catch (error) {
        if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY") && !(process.platform === "win32" && (hasCode(error, "EPERM") || hasCode(error, "EBUSY")))) throw error;
      }
      try { await assertOwnedDirectory(directory, true); }
      catch (error) { if (hasCode(error, "ENOENT")) continue; throw error; }
      let owner: z.infer<typeof startupOwnerSchema> | undefined;
      try { await assertPrivateFile(ownerPath); const parsed = startupOwnerSchema.safeParse(JSON.parse(await readFile(ownerPath, "utf8"))); if (!parsed.success) throw new Error("sidecar_service_recovery_required"); owner = parsed.data; }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      const lifetimeEnded = owner ? await sidecarProcessOwnership.lifetimeEnded(owner.lifetime) : false;
      if (owner && (lifetimeEnded || !await sidecarProcessOwnership.processMatches(owner.process))) {
        await retireStartupLock(directory, owner);
      }
      await pause(100);
    }
    throw new Error("sidecar_service_startup_locked");
  } finally { await rm(candidate, { recursive: true, force: true }); }
}

async function retireStartupLock(directory: string, expected: z.infer<typeof startupOwnerSchema>): Promise<void> {
  if (process.platform === "darwin" || process.platform === "win32") {
    const ownerPath = path.join(directory, "owner.json");
    let bytes: string;
    try { await assertPrivateFile(ownerPath); bytes = await readFile(ownerPath, "utf8"); }
    catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
    const owner = startupOwnerSchema.parse(JSON.parse(bytes));
    if (!sameProcess(owner.process, expected.process) || owner.lockId !== expected.lockId) return;
    if (process.platform === "darwin") await darwinSidecarPlatform.retireStartupLock(directory, bytes);
    else await windowsSidecarPlatform.retireStartupLock(directory, bytes);
    return;
  }
  // Pin the directory inode, so another reclaimer cannot redirect our unlink to
  // a newly acquired lock. rmdir never removes a replacement's owner.json.
  let handle;
  try { handle = await open(directory, "r"); }
  catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
  try {
    const pinnedOwnerPath = `/proc/self/fd/${handle.fd}/owner.json`;
    await assertPrivateFile(pinnedOwnerPath);
    const owner = startupOwnerSchema.parse(JSON.parse(await readFile(pinnedOwnerPath, "utf8")));
    if (!sameProcess(owner.process, expected.process) || owner.lockId !== expected.lockId) return;
    await unlink(pinnedOwnerPath);
    await rmdir(directory);
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTEMPTY")) throw error;
  } finally { await handle.close(); }
}

function retirementInProgress(retiringPid: number): Error {
  return Object.assign(new Error("sidecar_service_retirement_in_progress"), { retiringPid });
}
const readProcessIdentity = sidecarProcessOwnership.readProcess;
const sameProcess = sidecarProcessOwnership.sameProcess;
export async function assertOwnedDirectory(directory: string, strict: boolean): Promise<void> {
  if (process.platform === "win32") { await windowsSidecarPlatform.privacy(directory, "assert-directory"); return; }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o022) !== 0 || (strict && (metadata.mode & 0o777) !== 0o700)) throw new Error("sidecar_service_namespace_invalid");
}
export async function ensureOwnedDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") { await windowsSidecarPlatform.privacy(directory, "ensure-directory"); return; }
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  await assertOwnedDirectory(directory, true);
}
export async function assertPrivateFile(filename: string): Promise<void> {
  if (process.platform === "win32") {
    const metadata = await lstat(filename);
    await windowsSidecarPlatform.privacy(filename, "assert-file");
    if (metadata.size > 64 * 1024) throw new Error("sidecar_service_descriptor_invalid");
    return;
  }
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 || metadata.size > 64 * 1024) throw new Error("sidecar_service_descriptor_invalid");
}
async function verifyOwnArtifact(filename: string, expectedDigest: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/u.test(expectedDigest)) throw new Error("sidecar_artifact_digest_mismatch");
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (process.platform !== "win32" && (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o500)) || metadata.size > 32 * 1024 * 1024) throw new Error("sidecar_artifact_file_invalid");
  if (process.platform === "win32") await windowsSidecarPlatform.privacy(filename, "assert-executable");
  if (createHash("sha256").update(await readFile(filename)).digest("hex") !== expectedDigest) throw new Error("sidecar_artifact_digest_mismatch");
}
export function encodeArgument(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
function pause(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
