import * as fs from "node:fs/promises";
import { windowsSidecarPlatform } from "./sidecar-windows-platform.js";
import { darwinSidecarPlatform } from "./sidecar-darwin-platform.js";

export interface SidecarProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly bootId: string;
  readonly pidNamespace: string;
}
export interface SidecarTargetLifetime {
  readonly bootId: string;
  readonly pidNamespace: string;
  readonly namespaceInitStartTime: string;
  readonly boottimeOffset: { readonly seconds: string; readonly nanoseconds: number };
}
/** Process identity written by the pre-lifetime (unversioned) descriptor format. */
export interface SidecarLegacyProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly bootId: string;
}
export interface SidecarLegacyStoppedDescriptor {
  readonly scope: Record<string, string>;
  readonly state: "stopped";
  readonly process: SidecarLegacyProcessIdentity;
  readonly serviceIncarnation: string;
}

/**
 * This closure is also serialized into the artifact-independent SSH management
 * carrier. Keep dependencies explicit and all helpers inside the closure.
 */
export interface SidecarPlatformOwnership {
  readProcess(pid: number): Promise<SidecarProcessIdentity | undefined>;
  readTargetLifetime(): Promise<SidecarTargetLifetime>;
}

export function createSidecarProcessOwnership(files: typeof fs, platform?: SidecarPlatformOwnership) {
  const code = (error: unknown, value: string) => typeof error === "object" && error !== null && "code" in error && error.code === value;
  const invalid = () => new Error("sidecar_service_target_identity_unavailable");
  const readStat = async (pid: number | "self", root: string) => {
    const text = await files.readFile(`${root}/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    if (!/^[0-9]+$/u.test(fields[19] ?? "")) throw invalid();
    return { parentPid: Number(fields[1]), threadCount: /^[0-9]+$/u.test(fields[17] ?? "") ? Number(fields[17]) : undefined, startTime: fields[19]!, dead: fields[0] === "Z" || fields[0] === "X" };
  };
  const namespace = async (pid: number | "self", root: string) => {
    const value = await files.readlink(`${root}/${pid}/ns/pid`);
    if (!/^pid:\[[0-9]+\]$/u.test(value)) throw invalid();
    return value;
  };
  const boot = async () => {
    const value = (await files.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!/^[a-zA-Z0-9-]{1,80}$/u.test(value)) throw invalid();
    return value;
  };
  const validOffset = (value: unknown): value is SidecarTargetLifetime["boottimeOffset"] => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().join(",") === "nanoseconds,seconds" && typeof record.seconds === "string" &&
      record.seconds.length <= 20 && /^-?(?:0|[1-9][0-9]*)$/u.test(record.seconds) && record.seconds !== "-0" &&
      BigInt(record.seconds) >= -9223372036854775808n && BigInt(record.seconds) <= 9223372036854775807n &&
      typeof record.nanoseconds === "number" && Number.isInteger(record.nanoseconds) && record.nanoseconds >= 0 && record.nanoseconds < 1_000_000_000;
  };
  const sameOffset = (left: SidecarTargetLifetime["boottimeOffset"], right: SidecarTargetLifetime["boottimeOffset"]) =>
    left.seconds === right.seconds && left.nanoseconds === right.nanoseconds;
  const readBoottimeOffset = async (): Promise<SidecarTargetLifetime["boottimeOffset"]> => {
    const optional = async (read: () => Promise<string>) => read().catch(error => { if (code(error, "ENOENT")) return undefined; throw error; });
    const [active, children, offsets] = await Promise.all([
      optional(() => files.readlink("/proc/self/ns/time")), optional(() => files.readlink("/proc/self/ns/time_for_children")),
      optional(() => files.readFile("/proc/self/timens_offsets", "utf8")),
    ]);
    // Kernels built without CONFIG_TIME_NS expose none of these entries and
    // have no time offset. Partial/inaccessible proc views are not that case.
    if (active === undefined && children === undefined && offsets === undefined) return { seconds: "0", nanoseconds: 0 };
    if (!active || !/^time:\[[0-9]+\]$/u.test(active) || children !== active || offsets === undefined || offsets.length > 4096) throw invalid();
    // timens_offsets describes time_ns_for_children, whereas proc stat uses the
    // caller's active time namespace. Require them to be the same namespace.
    const rows = offsets.split("\n").filter(line => line.startsWith("boottime"));
    const fields = rows.length === 1 ? /^boottime[ \t]+(-?(?:0|[1-9][0-9]{0,18}))[ \t]+(0|[1-9][0-9]{0,8})[ \t]*$/u.exec(rows[0]!) : null;
    const value = { seconds: fields?.[1], nanoseconds: Number(fields?.[2]) };
    if (!validOffset(value) || await files.readlink("/proc/self/ns/time") !== active || await files.readlink("/proc/self/ns/time_for_children") !== active) throw invalid();
    return value;
  };
  const readProcess = async (pid: number, root = "/proc"): Promise<SidecarProcessIdentity | undefined> => {
    try {
      if (platform) return await platform.readProcess(pid);
      const stat = await readStat(pid, root);
      if (stat.dead) return undefined;
      return { pid, startTime: stat.startTime, bootId: await boot(), pidNamespace: await namespace(pid, root) };
    } catch (error) { if (code(error, "ENOENT")) return undefined; throw error; }
  };
  const processMatches = async (expected: SidecarProcessIdentity): Promise<boolean> => {
    try {
      if (platform) return sameProcess(await platform.readProcess(expected.pid), expected);
      if (await boot() !== expected.bootId) return false;
      const stat = await readStat(expected.pid, "/proc").catch(error => { if (code(error, "ENOENT")) return undefined; throw error; });
      if (!stat || stat.startTime !== expected.startTime) return false;
      // An unreaped owner with no sibling threads cannot execute further work.
      // This retires only a lock owner/already-stopped daemon; namespace lifetime
      // cleanup below deliberately never accepts a zombie init as proof.
      if (stat.dead && stat.threadCount === 1) return false;
      // A recycled PID may belong to root or a non-dumpable process. Start-time
      // reuse proves this is not our owner before a ptrace-gated namespace read.
      try { return await namespace(expected.pid, "/proc") === expected.pidNamespace; }
      catch (error) {
        if (code(error, "ENOENT")) {
          const current = await readStat(expected.pid, "/proc").catch(statError => { if (code(statError, "ENOENT")) return undefined; throw statError; });
          if (!current || current.startTime !== expected.startTime) return false;
        }
        // Permission denial (or an absent namespace link with a matching stat)
        // does not prove process death. Keep that uncertainty actionable.
        throw error;
      }
    } catch (error) { throw new Error("sidecar_service_recovery_required", { cause: error }); }
  };
  /**
   * The deployed predecessor wrote an unversioned descriptor without a target
   * lifetime. Its "stopped" state was recorded only after proven resource
   * cleanup, so a clean upgrade needs just proof that the old daemon exited.
   * Legacy "starting"/"running" records still require explicit recovery.
   */
  const validLegacyStoppedDescriptor = (value: unknown): value is SidecarLegacyStoppedDescriptor => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "process,scope,serviceIncarnation,state" || record.state !== "stopped") return false;
    if (typeof record.serviceIncarnation !== "string" || record.serviceIncarnation.length < 1 || record.serviceIncarnation.length > 160) return false;
    if (!record.scope || typeof record.scope !== "object" || Object.keys(record.scope).sort().join(",") !== "executionEnvironmentId,installationId,principalId,tenantId" ||
      Object.values(record.scope).some(entry => typeof entry !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(entry))) return false;
    const identity = record.process as Record<string, unknown> | null;
    return !!identity && typeof identity === "object" && Object.keys(identity).sort().join(",") === "bootId,pid,startTime" &&
      Number.isSafeInteger(identity.pid) && Number(identity.pid) > 0 && typeof identity.startTime === "string" && /^[0-9]+$/u.test(identity.startTime) &&
      typeof identity.bootId === "string" && /^[a-zA-Z0-9-]{1,80}$/u.test(identity.bootId);
  };
  const legacyProcessMatches = async (expected: SidecarLegacyProcessIdentity): Promise<boolean> => {
    try {
      if (await boot() !== expected.bootId) return false;
      const stat = await readStat(expected.pid, "/proc").catch(error => { if (code(error, "ENOENT")) return undefined; throw error; });
      if (!stat || stat.startTime !== expected.startTime) return false;
      return !(stat.dead && stat.threadCount === 1);
    } catch (error) { throw new Error("sidecar_service_recovery_required", { cause: error }); }
  };
  const sameProcess = (left: SidecarProcessIdentity | undefined, right: SidecarProcessIdentity) => !!left &&
    left.pid === right.pid && left.startTime === right.startTime && left.bootId === right.bootId && left.pidNamespace === right.pidNamespace;
  const validPlatformBoot = (record: Record<string, unknown>) =>
    record.pidNamespace === "macos" ? typeof record.bootId === "string" && /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/u.test(record.bootId) :
    record.pidNamespace === "windows" ? typeof record.bootId === "string" && /^windows-[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/u.test(record.bootId) : true;
  const validProcess = (value: unknown): value is SidecarProcessIdentity => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return validPlatformBoot(record) && Object.keys(record).sort().join(",") === "bootId,pid,pidNamespace,startTime" &&
      Number.isSafeInteger(record.pid) && Number(record.pid) > 0 && typeof record.startTime === "string" && /^[0-9]+$/u.test(record.startTime) &&
      typeof record.bootId === "string" && /^[a-zA-Z0-9-]{1,80}$/u.test(record.bootId) &&
      typeof record.pidNamespace === "string" && (/^pid:\[[0-9]+\]$/u.test(record.pidNamespace) || ["macos", "windows"].includes(record.pidNamespace));
  };
  const validLifetime = (value: unknown): value is SidecarTargetLifetime => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return validPlatformBoot(record) && Object.keys(record).sort().join(",") === "bootId,boottimeOffset,namespaceInitStartTime,pidNamespace" && validOffset(record.boottimeOffset) &&
      typeof record.bootId === "string" && /^[a-zA-Z0-9-]{1,80}$/u.test(record.bootId) &&
      typeof record.namespaceInitStartTime === "string" && /^[0-9]+$/u.test(record.namespaceInitStartTime) &&
      typeof record.pidNamespace === "string" && (/^pid:\[[0-9]+\]$/u.test(record.pidNamespace) ||
        (["macos", "windows"].includes(record.pidNamespace) && record.namespaceInitStartTime === "0" && sameOffset(record.boottimeOffset as SidecarTargetLifetime["boottimeOffset"], { seconds: "0", nanoseconds: 0 })));
  };
  const sameLifetime = (left: SidecarTargetLifetime, right: SidecarTargetLifetime) => left.bootId === right.bootId &&
    left.pidNamespace === right.pidNamespace && left.namespaceInitStartTime === right.namespaceInitStartTime && sameOffset(left.boottimeOffset, right.boottimeOffset);
  const readTargetLifetime = async (): Promise<SidecarTargetLifetime> => {
    try {
      if (platform) {
        const value = await platform.readTargetLifetime();
        if (!validLifetime(value) || !sameLifetime(value, await platform.readTargetLifetime())) throw invalid();
        return value;
      }
      if ((await files.statfs("/proc")).type !== 0x9fa0) throw invalid();
      const read = async () => {
        const [bootId, pidNamespace, init, status, boottimeOffset] = await Promise.all([
          boot(), namespace("self", "/proc"), readStat(1, "/proc"), files.readFile("/proc/self/status", "utf8"), readBoottimeOffset(),
        ]);
        // A procfs mounted for an ancestor namespace gives our process multiple
        // NSpid entries. It cannot supply comparable target-local PID identities.
        const ids = /^NSpid:\s+([0-9\t ]+)$/mu.exec(status)?.[1]?.trim().split(/\s+/u);
        if (ids?.length !== 1 || ids[0] !== String(process.pid)) throw invalid();
        return { bootId, pidNamespace, namespaceInitStartTime: init.startTime, boottimeOffset };
      };
      const target = await read();
      if (!sameLifetime(target, await read())) throw invalid();
      return target;
    } catch { throw invalid(); }
  };
  const lifetimeEnded = async (recorded: SidecarTargetLifetime): Promise<boolean> => {
    if (!validLifetime(recorded)) throw new Error("sidecar_service_recovery_required");
    const current = await readTargetLifetime();
    // Every invocation for one service scope enters the same authoritative SSH
    // target. Replacing that target requires ending its previous incarnation;
    // simultaneous targets sharing this ownership scope are unsupported.
    if (current.bootId !== recorded.bootId || current.pidNamespace !== recorded.pidNamespace) return true;
    // Compare the exact clock offset before any timestamp. Even sub-tick
    // changes can alter a process start time without changing the init tick.
    if (!sameOffset(current.boottimeOffset, recorded.boottimeOffset)) throw new Error("sidecar_service_recovery_required");
    // Namespace inode numbers are recycled. With comparable clocks, a changed
    // init identity proves the previous target lifetime ended despite reuse.
    return current.namespaceInitStartTime !== recorded.namespaceInitStartTime;
  };
  /** Missing management endpoints need distinct guidance, never weaker ownership proof. */
  const unavailableServiceCode = async (identity: SidecarProcessIdentity): Promise<string> =>
    await processMatches(identity) ? "sidecar_service_owner_unreachable" : "sidecar_service_orphan_cleanup_unproven";
  const lifetimeMatchesProcess = (lifetime: SidecarTargetLifetime, identity: SidecarProcessIdentity) =>
    lifetime.bootId === identity.bootId && lifetime.pidNamespace === identity.pidNamespace;
  return { readProcess, processMatches, sameProcess, validProcess, validLifetime, lifetimeMatchesProcess, readTargetLifetime, lifetimeEnded,
    validLegacyStoppedDescriptor, legacyProcessMatches, unavailableServiceCode };
}

export const sidecarProcessOwnership = createSidecarProcessOwnership(fs, process.platform === "darwin" ? darwinSidecarPlatform : process.platform === "win32" ? windowsSidecarPlatform : undefined);
