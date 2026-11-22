import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sidecarServiceScopeSchema } from "../../internal/sidecar-protocol/service-management-v1.js";
import { prepareDarwinSidecarLaunchHelper } from "./sidecar-darwin-platform.js";
import { sidecarProcessOwnership, type SidecarProcessIdentity, type SidecarTargetLifetime } from "./sidecar-process-ownership.js";

export const sidecarLaunchOwnerSchema = z.strictObject({
  scope: sidecarServiceScopeSchema,
  serviceIncarnation: z.string().min(1).max(160),
  process: z.custom<SidecarProcessIdentity>(sidecarProcessOwnership.validProcess),
  lifetime: z.custom<SidecarTargetLifetime>(sidecarProcessOwnership.validLifetime),
}).refine(owner => sidecarProcessOwnership.lifetimeMatchesProcess(owner.lifetime, owner.process));
export type SidecarLaunchOwner = z.infer<typeof sidecarLaunchOwnerSchema>;

export interface SidecarLaunchRecorder {
  readonly serviceDirectory: string;
  readonly owner: SidecarLaunchOwner;
  armOwnedProcess(): Promise<{ recordSpawn(pid: number): Promise<void> }>;
  markUnsupported(kind: string): Promise<void>;
}

type Ownership = Pick<typeof sidecarProcessOwnership, "validProcess" | "processMatches" | "readProcess" | "readTargetLifetime" | "lifetimeMatchesProcess">;

/** Also serialized into the SSH management carrier. Reads evidence but never publishes retirement. */
export function createSidecarLaunchProof(files: typeof fs, paths: typeof path, hash: typeof createHash, ownership: Ownership) {
  const invalid = () => new Error("sidecar_service_launch_evidence_invalid");
  const failed = () => new Error("sidecar_service_inspection_failed");
  const hasCode = (error: unknown, code: string) => typeof error === "object" && error !== null && "code" in error && error.code === code;
  const directory = (serviceDirectory: string, incarnation: string) =>
    paths.join(serviceDirectory, "launch-" + hash("sha256").update(incarnation).digest("hex"));
  // Canonical order is independent of JSON property order in a descriptor or Codex lock.
  const lifetimeKey = (v: SidecarTargetLifetime) => [v.bootId, v.pidNamespace, v.namespaceInitStartTime, v.boottimeOffset.seconds, v.boottimeOffset.nanoseconds];
  const ownerBytes = (owner: SidecarLaunchOwner) => JSON.stringify({
    version: 1, scope: [owner.scope.installationId, owner.scope.tenantId, owner.scope.principalId, owner.scope.executionEnvironmentId],
    incarnation: owner.serviceIncarnation, process: [owner.process.pid, owner.process.startTime, owner.process.bootId, owner.process.pidNamespace],
    lifetime: lifetimeKey(owner.lifetime),
  });
  const privateDirectory = async (name: string) => {
    const m = await files.lstat(name);
    if (!m.isDirectory() || m.uid !== process.getuid?.() || (m.mode & 0o777) !== 0o700) throw invalid();
  };
  const read = async (name: string) => {
    const handle = await files.open(name, files.constants.O_RDONLY | files.constants.O_NOFOLLOW | files.constants.O_NONBLOCK);
    try {
      const m = await handle.stat({ bigint: true });
      if (!m.isFile() || m.uid !== BigInt(process.getuid!()) || m.nlink !== 1n || (m.mode & 0o777n) !== 0o600n || m.size < 1n || m.size > 8192n) throw invalid();
      const buffer = Buffer.alloc(Number(m.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (length !== Number(m.size) || after.ctimeNs !== m.ctimeNs || after.mtimeNs !== m.mtimeNs) throw invalid();
      return buffer.toString("utf8", 0, length);
    } finally { await handle.close(); }
  };
  const readIfPresent = async (name: string) => {
    try { return await read(name); } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  };
  const inspectUsed = async (entries: string[], records: string, owner: SidecarLaunchOwner) => {
    let reason = "sidecar_service_containment_unproven";
    if (!entries.length) throw invalid();
    const sessions = new Set<number>();
    for (const entry of entries) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(entry)) throw invalid();
      const r = JSON.parse(await read(paths.join(records, entry)));
      if (r?.version !== 1 || r.id + ".json" !== entry) throw invalid();
      if (r.state === "unsupported" && typeof r.kind === "string") throw new Error("sidecar_service_unsupported_launch_kind");
      if (r.state === "armed") { reason = "sidecar_service_launch_identity_unrecorded"; continue; }
      if (r.state !== "identified" || !ownership.validProcess(r.process) || !ownership.lifetimeMatchesProcess(owner.lifetime, r.process) ||
        (r.sessionId !== null && r.sessionId !== r.process.pid) || (r.groupId !== null && r.groupId !== r.process.pid)) throw invalid();
      if (await ownership.processMatches(r.process)) throw new Error("sidecar_service_live_child");
      if (process.platform === "linux" && r.sessionId !== null) {
        // A new leader at this PID retired the recorded session. Missing
        // leaders may still have live children in other groups of the session.
        try {
          const leader = await files.readFile("/proc/" + r.process.pid + "/stat", "utf8");
          if (leader.slice(leader.lastIndexOf(")") + 2).split(" ")[19] !== r.process.startTime) continue;
        } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
        sessions.add(r.sessionId);
      }
    }
    if (sessions.size) {
      for (const pid of await files.readdir("/proc")) {
        if (!/^[0-9]+$/u.test(pid)) continue;
        try {
          const stat = await files.readFile("/proc/" + pid + "/stat", "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (!/^[0-9]+$/u.test(fields[3] ?? "")) throw failed();
          if (fields[0] !== "Z" && fields[0] !== "X" && sessions.has(Number(fields[3]))) throw new Error("sidecar_service_live_child");
        } catch (error) { if (!hasCode(error, "ENOENT") && !hasCode(error, "ESRCH")) throw error; }
      }
    }
    // An unrestricted descendant can call setsid() and reparent between any
    // two inspections. An empty session cannot authorize a new sidecar.
    throw new Error(reason);
  };
  const assertRetired = async (serviceDirectory: string, owner: SidecarLaunchOwner) => {
    try {
      if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("sidecar_service_orphan_cleanup_unproven");
      const current = await ownership.readTargetLifetime();
      if (JSON.stringify(lifetimeKey(current)) !== JSON.stringify(lifetimeKey(owner.lifetime))) throw failed();
      if (await ownership.processMatches(owner.process)) throw new Error("sidecar_service_owner_unreachable");
      const dir = directory(serviceDirectory, owner.serviceIncarnation);
      try { await privateDirectory(dir); }
      catch (error) { if (hasCode(error, "ENOENT")) throw new Error("sidecar_service_orphan_cleanup_unproven"); throw error; }
      const rootEntries = await files.readdir(dir);
      if (rootEntries.some(name => !["launches", "unused.json", "used.json", "maintenance.json", "retired.json"].includes(name) &&
        !/^codex-claim-[a-f0-9-]{36}\.json$/u.test(name) && !/^\.[a-f0-9-]{36}$/u.test(name))) throw invalid();
      const records = paths.join(dir, "launches");
      await privateDirectory(records);
      const unused = await readIfPresent(paths.join(dir, "unused.json"));
      const used = await readIfPresent(paths.join(dir, "used.json"));
      const expected = ownerBytes(owner);
      const entries = await files.readdir(records);
      if (unused === expected && used === undefined && entries.length === 0) {
        // Linux uses only procfs for identity and fixed maintenance with an
        // unused ledger. Darwin also starts non-detaching libproc/ps helpers.
        const maintenance = JSON.parse(await read(paths.join(dir, "maintenance.json")));
        if (maintenance.owner !== expected) throw invalid();
        if (process.platform === "linux" && maintenance.kind === "procfs") return;
        if (process.platform !== "darwin" || maintenance.kind !== "inherited_group" || maintenance.privateGroup !== owner.process.pid) {
          throw new Error("sidecar_service_containment_unproven");
        }
        try { process.kill(-owner.process.pid, 0); }
        catch (error) { if (hasCode(error, "ESRCH")) return; throw error; }
        // The kernel reserves group and session IDs even after leader exit.
        // Positive reuse in this target proves the old group no longer exists.
        const holder = await ownership.readProcess(owner.process.pid);
        if (holder && ownership.lifetimeMatchesProcess(current, holder) && holder.startTime !== owner.process.startTime) return;
        throw new Error("sidecar_service_containment_unproven");
      }
      if (used !== expected || unused !== undefined) throw invalid();
      await inspectUsed(entries, records, owner);
    } catch (error) {
      if (error instanceof Error && /^sidecar_service_(?:launch_evidence_invalid|owner_unreachable|orphan_cleanup_unproven|unsupported_launch_kind|launch_identity_unrecorded|live_child|containment_unproven|inspection_failed)$/u.test(error.message)) throw error;
      throw failed();
    }
  };
  return { directory, ownerBytes, privateDirectory, read, assertRetired };
}

const proof = createSidecarLaunchProof(fs, path, createHash, sidecarProcessOwnership);
export const sidecarLaunchLedgerDirectory = proof.directory;
export const assertSidecarLaunchesRetired = proof.assertRetired;

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publish(directory: string, name: string, bytes: string): Promise<void> {
  const temporary = path.join(directory, "." + randomUUID());
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, path.join(directory, name));
    await syncDirectory(directory);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Sample while JS still owns the direct child and libuv cannot reap or reuse its PID. */
function processFacts(pid: number, darwinHelper: string | undefined) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("sidecar_service_inspection_failed");
  if (darwinHelper) {
    const row = execFileSync(darwinHelper, [String(pid)], {
      encoding: "utf8", timeout: 5000, maxBuffer: 4096, env: { LC_ALL: "C" },
    }).trim();
    const match = /^(\d+) (\d+) ([01]) ([01]) (\d{7,26})$/u.exec(row);
    if (!match) throw new Error("sidecar_service_inspection_failed");
    return { parentPid: Number(match[1]), groupId: Number(match[2]), sessionLeader: match[3] === "1",
      dead: match[4] === "1", startTime: match[5]!, pidNamespace: "macos" };
  }
  const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (!/^\d+$/u.test(fields[19] ?? "") || !/^\d+$/u.test(fields[3] ?? "")) throw new Error("sidecar_service_inspection_failed");
  return { parentPid: Number(fields[1]), groupId: Number(fields[2]), sessionLeader: Number(fields[3]) === pid,
    dead: fields[0] === "Z" || fields[0] === "X", startTime: fields[19]!, pidNamespace: readlinkSync("/proc/" + pid + "/ns/pid") };
}

export async function createSidecarLaunchLedger(serviceDirectory: string, descriptor: SidecarLaunchOwner): Promise<SidecarLaunchRecorder> {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("sidecar_service_platform_unsupported");
  const { scope, serviceIncarnation, process: identity, lifetime } = descriptor;
  const owner = sidecarLaunchOwnerSchema.parse({ scope, serviceIncarnation, process: identity, lifetime });
  const directory = proof.directory(serviceDirectory, serviceIncarnation);
  const records = path.join(directory, "launches");
  const darwinHelper = process.platform === "darwin" ? await prepareDarwinSidecarLaunchHelper() : undefined;
  // Exclusive create: an older used incarnation must never be reset to unused,
  // even if its individual launch records went missing.
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.mkdir(records, { mode: 0o700 });
  const maintenance = { owner: proof.ownerBytes(owner), kind: "procfs" };
  if (darwinHelper) {
    const daemon = processFacts(owner.process.pid, darwinHelper);
    const privateGroup = daemon.startTime === owner.process.startTime && daemon.pidNamespace === owner.process.pidNamespace &&
      !daemon.dead && daemon.groupId === owner.process.pid && daemon.sessionLeader ? owner.process.pid : null;
    await publish(directory, "maintenance.json", JSON.stringify({ ...maintenance, kind: "inherited_group", privateGroup }));
  } else {
    await publish(directory, "maintenance.json", JSON.stringify(maintenance));
  }
  await publish(directory, "unused.json", proof.ownerBytes(owner));
  await syncDirectory(serviceDirectory);
  let used: Promise<void> | undefined;
  const markUsed = () => used ??= (async () => {
    await fs.rename(path.join(directory, "unused.json"), path.join(directory, "used.json"));
    await syncDirectory(directory);
  })();
  const arm = async (state: "armed" | "unsupported", kind: string) => {
    const id = randomUUID();
    await markUsed();
    await publish(records, id + ".json", JSON.stringify({ version: 1, id, state, kind }));
    return id;
  };
  const unsupported = new Map<string, Promise<void>>();
  // Retain bounded detail. Once filled, the first overflow writes a permanent
  // unsupported-kind fence before further untracked launches can proceed.
  const maxDetailedLaunches = 128;
  let reserved = 0;
  const markUnsupported = async (kind: string) => {
    if (!/^[a-zA-Z0-9_.:-]{1,120}$/u.test(kind)) throw new Error("sidecar_service_unsupported_launch_kind");
    const pending = unsupported.get(kind) ?? arm("unsupported", kind).then(() => undefined);
    unsupported.set(kind, pending);
    await pending;
  };
  return {
    owner, serviceDirectory,
    markUnsupported,
    async armOwnedProcess() {
      if (reserved >= maxDetailedLaunches) {
        await markUnsupported("launch_record_limit");
        return { async recordSpawn() { /* The durable overflow fence covers this launch. */ } };
      }
      reserved++;
      const id = await arm("armed", "owned_process");
      return {
        async recordSpawn(pid) {
          const facts = processFacts(pid, darwinHelper);
          if (facts.parentPid !== owner.process.pid || facts.pidNamespace !== owner.process.pidNamespace ||
            (!facts.dead && (facts.groupId !== pid || !facts.sessionLeader))) throw new Error("sidecar_service_inspection_failed");
          const child = { pid, startTime: facts.startTime, bootId: owner.process.bootId, pidNamespace: facts.pidNamespace };
          // Darwin may have cleared its session-leader flag when this exact
          // unreaped child exited. Store the missing observation explicitly.
          const groupId = facts.groupId === pid ? pid : null;
          const sessionId = facts.sessionLeader ? pid : null;
          await publish(records, id + ".json", JSON.stringify({ version: 1, id, state: "identified", kind: "owned_process",
            process: child, groupId, sessionId }));
        },
      };
    },
  };
}

export async function recordSidecarLaunchRetirement(serviceDirectory: string, owner: SidecarLaunchOwner, revalidateDescriptor?: () => Promise<void>): Promise<void> {
  await assertSidecarLaunchesRetired(serviceDirectory, owner);
  const directory = proof.directory(serviceDirectory, owner.serviceIncarnation);
  // The startup lock serializes writers, including a successor after a crash.
  // Only identical bytes may exist at this incarnation's receipt path.
  const filename = path.join(directory, "retired.json");
  const receipt = JSON.stringify({ version: 1, retiredOwner: JSON.parse(proof.ownerBytes(owner)) });
  const recorded = await proof.read(filename).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (recorded !== undefined && recorded !== receipt) throw new Error("sidecar_service_launch_evidence_invalid");
  await revalidateDescriptor?.();
  if (recorded === undefined) await publish(directory, "retired.json", receipt);
}

export async function assertSidecarLaunchRetirementRecorded(serviceDirectory: string, owner: SidecarLaunchOwner): Promise<void> {
  await assertSidecarLaunchesRetired(serviceDirectory, owner);
  const filename = path.join(proof.directory(serviceDirectory, owner.serviceIncarnation), "retired.json");
  const recorded = await proof.read(filename).catch((error: NodeJS.ErrnoException) => {
    throw new Error(error.code === "ENOENT" ? "sidecar_service_launch_evidence_invalid" : "sidecar_service_inspection_failed", { cause: error });
  });
  if (recorded !== JSON.stringify({ version: 1, retiredOwner: JSON.parse(proof.ownerBytes(owner)) })) {
    throw new Error("sidecar_service_launch_evidence_invalid");
  }
}

/** Call only after this daemon has fenced admission, completed cleanup and published stopped. */
export async function cleanupStoppedSidecarLaunchLedger(serviceDirectory: string, owner: SidecarLaunchOwner): Promise<void> {
  if (owner.process.pid !== process.pid || !await sidecarProcessOwnership.processMatches(owner.process)) return;
  const directory = proof.directory(serviceDirectory, owner.serviceIncarnation);
  await proof.privateDirectory(directory);
  const entries = await fs.readdir(directory);
  const witness = entries.includes("unused.json") ? "unused.json" : "used.json";
  const expected = new Set([witness, "maintenance.json", "launches"]);
  // Any Codex claim, crash receipt, or unknown evidence retains the whole incarnation.
  if (entries.length !== expected.size || entries.some(entry => !expected.has(entry))) return;
  if (await proof.read(path.join(directory, witness)) !== proof.ownerBytes(owner)) return;
  const records = path.join(directory, "launches");
  await proof.privateDirectory(records);
  const details = await fs.readdir(records);
  if (details.some(name => !/^[a-f0-9-]{36}\.json$/u.test(name))) return;
  // Remove named records only. A foreign or outstanding claim is never recursively deleted.
  for (const name of details) await fs.unlink(path.join(records, name));
  await fs.rmdir(records);
  await fs.unlink(path.join(directory, witness));
  await fs.unlink(path.join(directory, "maintenance.json"));
  await fs.rmdir(directory);
  await syncDirectory(serviceDirectory);
}
