import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, open, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireStartupLock, assertPreviousServiceRetired, ensurePersistentSidecar, preparePersistentSidecarNamespace, recordPersistentSidecar } from "../../src/server/sidecar/persistent-sidecar-bootstrap.js";
import { sidecarProcessOwnership } from "../../src/server/sidecar/sidecar-process-ownership.js";
import { REMOTE_SERVICE_MANAGEMENT_PROXY_SOURCE } from "../../src/server/sidecar/ssh-sidecar-management-proxy.js";
import { persistentSidecarPaths } from "../../src/server/sidecar/persistent-sidecar-paths.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile), readlink: vi.fn(actual.readlink) };
});
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:os", async (importOriginal) => ({ ...await importOriginal<typeof import("node:os")>(), homedir: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "sd-boot-")); roots.push(home);
  vi.mocked(homedir).mockReturnValue(home);
  const scope = { installationId: randomUUID(), tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment" };
  const paths = persistentSidecarPaths(home, process.getuid!(), scope); roots.push(paths.socketDirectory);
  await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
  await preparePersistentSidecarNamespace(scope);
  const executablePath = path.join(home, "sedes");
  const bytes = "process.exit(1)";
  await writeFile(executablePath, bytes, { mode: 0o500 });
  return { paths, scope, input: { scope, configuration: { environmentRevision: 1, operationsRevision: 1 },
    executablePath, expectedBuild: "test-build", expectedDigest: createHash("sha256").update(bytes).digest("hex"), agentToolEndpointKey: "a".repeat(32) } };
}

describe("persistent service bootstrap ownership", () => {
  it("cancels before spawn after ownership I/O without launching a daemon", async () => {
    const { input, paths } = await fixture();
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof readFile>) => {
      const bytes = await actual.readFile(...args);
      if (String(args[0]) === input.executablePath) controller.abort(new Error("pairing_revoked"));
      return bytes;
    });
    vi.mocked(spawn).mockClear();
    await expect(ensurePersistentSidecar({ ...input, signal: controller.signal })).rejects.toThrow("pairing_revoked");
    expect(spawn).not.toHaveBeenCalled();
    await expect(actual.readFile(paths.descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(actual.readFile(path.join(paths.lockDirectory, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles a recorded startup intent when cancellation arrives before spawn", async () => {
    const { input, paths } = await fixture();
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]).startsWith(`${paths.descriptorPath}.`) && !controller.signal.aborted) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...input) => { await write(...input); controller.abort(new Error("pairing_revoked")); };
      }
      return handle;
    });
    vi.mocked(spawn).mockClear();
    await expect(ensurePersistentSidecar({ ...input, signal: controller.signal })).rejects.toThrow("pairing_revoked");
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(paths.descriptorPath, "utf8"))).toMatchObject({ state: "stopped" });
  });

  it("keeps uncertain launched ownership fenced when cancellation stops readiness waiting", async () => {
    const { input, paths } = await fixture();
    const controller = new AbortController();
    vi.mocked(spawn).mockImplementation(() => {
      controller.abort(new Error("pairing_revoked"));
      return Object.assign(new EventEmitter(), { unref: vi.fn(), exitCode: null, signalCode: null }) as unknown as ReturnType<typeof spawn>;
    });
    await expect(ensurePersistentSidecar({ ...input, signal: controller.signal })).rejects.toThrow("pairing_revoked");
    expect(JSON.parse(await readFile(paths.descriptorPath, "utf8"))).toMatchObject({ state: "starting" });
    await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).rejects.toThrow("sidecar_service_owner_unreachable");
  });

  it.each(["throw", "error", "exit"])("settles its own starting intent after a proven spawn %s", async (failure) => {
    const { input, paths } = await fixture();
    vi.mocked(spawn).mockImplementation(() => {
      if (failure === "throw") throw new Error("spawn_failed");
      const child = Object.assign(new EventEmitter(), { unref: vi.fn(), exitCode: null as number | null, signalCode: null });
      queueMicrotask(() => { if (failure === "error") child.emit("error", new Error("spawn_failed")); else child.exitCode = 1; });
      return child as unknown as ReturnType<typeof spawn>;
    });
    await expect(ensurePersistentSidecar(input)).rejects.toThrow(failure === "exit" ? "sidecar_service_start_failed" : "sidecar_service_spawn_failed");
    expect(JSON.parse(await readFile(paths.descriptorPath, "utf8"))).toMatchObject({ state: "stopped" });
  });

  it("does not clear a daemon-owned descriptor after early child exit", async () => {
    const { input, paths, scope } = await fixture();
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn(), exitCode: null as number | null, signalCode: null });
      void recordPersistentSidecar(scope, "daemon-incarnation", "running").then(() => { child.exitCode = 1; });
      return child as unknown as ReturnType<typeof spawn>;
    });
    await expect(ensurePersistentSidecar(input)).rejects.toThrow("sidecar_service_start_failed");
    expect(JSON.parse(await readFile(paths.descriptorPath, "utf8"))).toMatchObject({ state: "running", serviceIncarnation: "daemon-incarnation" });
    await expect(ensurePersistentSidecar(input)).rejects.toThrow("sidecar_service_owner_unreachable");
  });

  it("atomically replaces an empty orphan lock and serializes contenders", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sd-lock-")); roots.push(root);
    const lock = path.join(root, "startup.lock");
    await mkdir(lock, { mode: 0o700 });
    const first = await acquireStartupLock(lock);
    expect(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"))).toMatchObject({ version: 3, process: { pid: process.pid } });
    let acquired = false;
    const second = acquireStartupLock(lock).then((release) => { acquired = true; return release; });
    await vi.waitFor(async () => expect((await readdir(root)).some(entry => entry.endsWith(".candidate"))).toBe(true));
    expect(acquired).toBe(false);
    await first();
    await (await second)();
    expect(await readdir(root)).toEqual([]);
  });
  it("blocks a missing supervisor without namespace lifetime evidence", async () => {
    const { paths, scope } = await fixture();
    await recordPersistentSidecar(scope, "old-daemon", "running");
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, "utf8"));
    descriptor.process.pid = 2147483647;
    await writeFile(paths.descriptorPath, JSON.stringify(descriptor));
    await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).rejects.toThrow("sidecar_service_orphan_cleanup_unproven");
  });

  it.each(["live", "dead"])("diagnoses a %s owner consistently without changing stale ownership", async owner => {
    const { input, paths, scope } = await fixture();
    await recordPersistentSidecar(scope, "unavailable-daemon", "running");
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, "utf8"));
    if (owner === "dead") descriptor.process.pid = 2147483647;
    const bytes = JSON.stringify(descriptor);
    await writeFile(paths.descriptorPath, bytes);
    const code = owner === "live" ? "sidecar_service_owner_unreachable" : "sidecar_service_orphan_cleanup_unproven";
    await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).rejects.toThrow(code);
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const source = REMOTE_SERVICE_MANAGEMENT_PROXY_SOURCE.replace("o.userInfo().homedir", JSON.stringify(path.dirname(input.executablePath)));
    const argument = Buffer.from(JSON.stringify({ scope, requestId: randomUUID() })).toString("base64url");
    const result = await new Promise<string>((resolve, reject) => {
      actual.execFile(process.execPath, ["-e", source, argument], { timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    expect(JSON.parse(result)).toMatchObject({ outcome: "error", code });
    expect(await readFile(paths.descriptorPath, "utf8")).toBe(bytes);
  });

  it("admits replacement only after the shared lifetime probe confirms retirement", async () => {
    const { paths, scope } = await fixture();
    await recordPersistentSidecar(scope, "old-container", "running");
    const proof = vi.spyOn(sidecarProcessOwnership, "lifetimeEnded").mockResolvedValue(true);
    await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).resolves.toBeUndefined();
    expect(proof).toHaveBeenCalledWith(expect.objectContaining({ bootId: expect.any(String), pidNamespace: expect.any(String), namespaceInitStartTime: expect.any(String) }));
  });

  it("fails closed on old descriptors and lock records without the new identity contract", async () => {
    const { paths, scope } = await fixture();
    await recordPersistentSidecar(scope, "old-daemon", "running");
    const descriptor = JSON.parse(await readFile(paths.descriptorPath, "utf8"));
    delete descriptor.version; delete descriptor.lifetime; delete descriptor.process.pidNamespace;
    await writeFile(paths.descriptorPath, JSON.stringify(descriptor));
    await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).rejects.toThrow("sidecar_service_recovery_required");
    await mkdir(paths.lockDirectory, { mode: 0o700 });
    await writeFile(path.join(paths.lockDirectory, "owner.json"), JSON.stringify(descriptor.process), { mode: 0o600 });
    await expect(acquireStartupLock(paths.lockDirectory)).rejects.toThrow("sidecar_service_recovery_required");
  });

  it("rejects a lock whose process identity and target lifetime disagree", async () => {
    const { paths } = await fixture();
    const release = await acquireStartupLock(paths.lockDirectory);
    const ownerPath = path.join(paths.lockDirectory, "owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    owner.process.pidNamespace = "pid:[9999999]";
    await writeFile(ownerPath, JSON.stringify(owner));
    await expect(acquireStartupLock(paths.lockDirectory)).rejects.toThrow("sidecar_service_recovery_required");
    await expect(release()).rejects.toThrow();
  });

  it("reclaims the startup lock after the same SSH target enters a new PID namespace", async () => {
    const { paths } = await fixture();
    await acquireStartupLock(paths.lockDirectory);
    const ownerPath = path.join(paths.lockDirectory, "owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    owner.process.pidNamespace = "pid:[9999999]";
    owner.lifetime.pidNamespace = owner.process.pidNamespace;
    await writeFile(ownerPath, JSON.stringify(owner));
    const release = await acquireStartupLock(paths.lockDirectory);
    await release();
  });

  it("a delayed stale-lock reclaimer cannot unlink a contender's newly acquired lock", async () => {
    const { paths } = await fixture();
    await acquireStartupLock(paths.lockDirectory);
    const ownerPath = path.join(paths.lockDirectory, "owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    owner.process.bootId = "previous-boot";
    owner.lifetime.bootId = owner.process.bootId;
    await writeFile(ownerPath, JSON.stringify(owner));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let resumeDelayed!: () => void;
    let pinned!: () => void;
    const pinnedPromise = new Promise<void>(resolve => { pinned = resolve; });
    const resumedPromise = new Promise<void>(resolve => { resumeDelayed = resolve; });
    let held = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === paths.lockDirectory && !held) {
        held = true; pinned(); await resumedPromise;
      }
      return handle;
    });
    let delayedAcquired = false;
    const delayed = acquireStartupLock(paths.lockDirectory).then(release => { delayedAcquired = true; return release; });
    await pinnedPromise;
    const firstRelease = await acquireStartupLock(paths.lockDirectory);
    const current = await readFile(ownerPath, "utf8");
    resumeDelayed();
    await vi.waitFor(() => expect(vi.mocked(open).mock.calls.filter(args => args[0] === paths.lockDirectory).length).toBeGreaterThan(1));
    expect(delayedAcquired).toBe(false);
    expect(await readFile(ownerPath, "utf8")).toBe(current);
    await firstRelease();
    await (await delayed)();
  });

  it.each(["stopped descriptor", "startup lock"])("retires a %s when its PID belongs to a different inaccessible process", async recordKind => {
    const { paths, scope } = await fixture();
    if (recordKind === "stopped descriptor") await recordPersistentSidecar(scope, "retired", "stopped");
    else await acquireStartupLock(paths.lockDirectory);
    const recordPath = recordKind === "stopped descriptor" ? paths.descriptorPath : path.join(paths.lockDirectory, "owner.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.process.pid = 1;
    const initStat = await readFile("/proc/1/stat", "utf8");
    record.process.startTime = String(BigInt(initStat.slice(initStat.lastIndexOf(")") + 2).split(" ")[19]!) + 1n);
    await writeFile(recordPath, JSON.stringify(record));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(readlink).mockImplementation(async (file, ...options) => {
      if (file === "/proc/1/ns/pid") throw Object.assign(new Error("denied"), { code: "EACCES" });
      return actual.readlink(file, ...options);
    });
    if (recordKind === "stopped descriptor") await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).resolves.toBeUndefined();
    else await (await acquireStartupLock(paths.lockDirectory))();
    expect(vi.mocked(readlink).mock.calls.some(([file]) => file === "/proc/1/ns/pid")).toBe(false);
  });

  it.each(["stopped descriptor", "startup lock"])("preserves a %s with matching but inaccessible process identity", async recordKind => {
    const { paths, scope } = await fixture();
    if (recordKind === "stopped descriptor") await recordPersistentSidecar(scope, "retired", "stopped");
    else await acquireStartupLock(paths.lockDirectory);
    const recordPath = recordKind === "stopped descriptor" ? paths.descriptorPath : path.join(paths.lockDirectory, "owner.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.process.pid = 1;
    const initStat = await readFile("/proc/1/stat", "utf8");
    record.process.startTime = initStat.slice(initStat.lastIndexOf(")") + 2).split(" ")[19]!;
    const retained = JSON.stringify(record);
    await writeFile(recordPath, retained);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(readlink).mockImplementation(async (file, ...options) => {
      if (file === "/proc/1/ns/pid") throw Object.assign(new Error("denied"), { code: "EPERM" });
      return actual.readlink(file, ...options);
    });
    await expect(recordKind === "stopped descriptor" ? assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath) : acquireStartupLock(paths.lockDirectory))
      .rejects.toThrow("sidecar_service_recovery_required");
    expect(await readFile(recordPath, "utf8")).toBe(retained);
  });

  it.each([
    ["stopped descriptor", 1], ["stopped descriptor", 2],
    ["startup lock", 1], ["startup lock", 2],
  ] as const)("handles a zombie %s with %i thread(s) without confusing leader exit with group exit", async (recordKind, threads) => {
    const { paths, scope } = await fixture();
    if (recordKind === "stopped descriptor") await recordPersistentSidecar(scope, "retired", "stopped");
    else await acquireStartupLock(paths.lockDirectory);
    const recordPath = recordKind === "stopped descriptor" ? paths.descriptorPath : path.join(paths.lockDirectory, "owner.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.process.pid = 2147483647;
    const retained = JSON.stringify(record);
    await writeFile(recordPath, retained);
    const fields = ["Z", "1", ...Array<string>(17).fill("0"), record.process.startTime];
    fields[17] = String(threads);
    const zombieStat = `${record.process.pid} (unreaped owner) ${fields.join(" ")}`;
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(readFile).mockImplementation(async (file, ...options) => {
      if (file === `/proc/${record.process.pid}/stat`) return zombieStat;
      return actual.readFile(file, ...options);
    });
    const result = recordKind === "stopped descriptor" ? assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath) : acquireStartupLock(paths.lockDirectory);
    if (threads === 1) {
      const release = await result;
      if (release) await release();
    } else {
      await expect(result).rejects.toThrow("sidecar_service_recovery_required");
      expect(await readFile(recordPath, "utf8")).toBe(retained);
    }
  });

  it.each(["starting", "running", "stopped", "startup lock"].flatMap(state => [
    { state, subTick: true }, { state, subTick: false },
  ]))("fences changed clock offsets for $state (subTick=$subTick) before checking process PIDs", async ({ state, subTick }) => {
    const { paths, scope } = await fixture();
    if (state === "startup lock") await acquireStartupLock(paths.lockDirectory);
    else await recordPersistentSidecar(scope, "previous-target", state as "starting" | "running" | "stopped");
    const recordPath = state === "startup lock" ? path.join(paths.lockDirectory, "owner.json") : paths.descriptorPath;
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    if (subTick) record.lifetime.boottimeOffset.nanoseconds = (record.lifetime.boottimeOffset.nanoseconds + 1) % 1_000_000_000;
    else {
      record.lifetime.boottimeOffset.seconds = String(BigInt(record.lifetime.boottimeOffset.seconds) + 1n);
      record.lifetime.namespaceInitStartTime = String(BigInt(record.lifetime.namespaceInitStartTime) + 1n);
    }
    record.process.pid = 2147483647;
    await writeFile(recordPath, JSON.stringify(record));
    const matching = vi.spyOn(sidecarProcessOwnership, "processMatches");
    await expect(state === "startup lock" ? acquireStartupLock(paths.lockDirectory) : assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath))
      .rejects.toThrow("sidecar_service_recovery_required");
    expect(matching).not.toHaveBeenCalled();
  });

  it.each(["starting", "running", "stopped"])("retires %s ownership after the target PID namespace changes on the same host boot", async state => {
    const { paths, scope } = await fixture();
    await recordPersistentSidecar(scope, "previous-target", state as "starting" | "running" | "stopped");
    const record = JSON.parse(await readFile(paths.descriptorPath, "utf8"));
    record.process.pidNamespace = "pid:[9999999]";
    record.lifetime.pidNamespace = record.process.pidNamespace;
    await writeFile(paths.descriptorPath, JSON.stringify(record));
    const matching = vi.spyOn(sidecarProcessOwnership, "processMatches");
    await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).resolves.toBeUndefined();
    expect(matching).not.toHaveBeenCalled();
  });

  it.each(["missing incarnation", "extra field", "extra scope field", "obsolete version", "missing clock offset"])("rejects a descriptor with %s consistently in bootstrap and the standalone management proxy", async corruption => {
    const { input, paths, scope } = await fixture();
    await recordPersistentSidecar(scope, "stopped-target", "stopped");
    const record = JSON.parse(await readFile(paths.descriptorPath, "utf8"));
    if (corruption === "missing incarnation") delete record.serviceIncarnation;
    else if (corruption === "extra field") record.unrecognized = true;
    else if (corruption === "extra scope field") record.scope.unrecognized = "other";
    else if (corruption === "missing clock offset") delete record.lifetime.boottimeOffset;
    else record.version = 2;
    await writeFile(paths.descriptorPath, JSON.stringify(record));
    await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).rejects.toThrow("sidecar_service_recovery_required");
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const source = REMOTE_SERVICE_MANAGEMENT_PROXY_SOURCE.replace("o.userInfo().homedir", JSON.stringify(path.dirname(input.executablePath)));
    const argument = Buffer.from(JSON.stringify({ scope, requestId: randomUUID() })).toString("base64url");
    const result = await new Promise<string>((resolve, reject) => {
      actual.execFile(process.execPath, ["-e", source, argument], { timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    expect(JSON.parse(result)).toMatchObject({ outcome: "error", code: "sidecar_service_recovery_required" });
  });

  it.each(["exited", "live"])("retires a predecessor's clean legacy stopped record once its %s daemon is gone", async daemon => {
    const { input, paths, scope } = await fixture();
    const identity = await sidecarProcessOwnership.readProcess(process.pid);
    const legacy = { scope, state: "stopped", serviceIncarnation: "legacy-incarnation",
      process: daemon === "live" ? { pid: identity!.pid, startTime: identity!.startTime, bootId: identity!.bootId } : { pid: 2147483647, startTime: "1", bootId: identity!.bootId } };
    await writeFile(paths.descriptorPath, JSON.stringify(legacy), { mode: 0o600 });
    const lifetime = vi.spyOn(sidecarProcessOwnership, "lifetimeEnded");
    if (daemon === "live") await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).rejects.toThrow("sidecar_service_retirement_in_progress");
    else await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).resolves.toBeUndefined();
    expect(lifetime).not.toHaveBeenCalled();
    // The artifact-independent management carrier reports the same clean stop
    // as absent, so Start and Upgrade and restart proceed through bootstrap.
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const source = REMOTE_SERVICE_MANAGEMENT_PROXY_SOURCE.replace("o.userInfo().homedir", JSON.stringify(path.dirname(input.executablePath)));
    const proxy = async (requestScope: typeof scope) => {
      const argument = Buffer.from(JSON.stringify({ scope: requestScope, requestId: randomUUID() })).toString("base64url");
      return JSON.parse(await new Promise<string>((resolve, reject) => {
        actual.execFile(process.execPath, ["-e", source, argument], { timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
      }));
    };
    expect(await proxy(scope)).toMatchObject({ outcome: "absent" });
    // A legacy record naming another scope is never proof for this directory.
    await writeFile(paths.descriptorPath, JSON.stringify({ ...legacy, scope: { ...scope, executionEnvironmentId: "other-environment" } }), { mode: 0o600 });
    expect(await proxy(scope)).toMatchObject({ outcome: "error", code: "sidecar_service_recovery_required" });
  });

  it.each(["running", "starting"])("keeps a legacy %s record fail-closed in bootstrap and the management proxy", async state => {
    const { input, paths, scope } = await fixture();
    await writeFile(paths.descriptorPath, JSON.stringify({ scope, state, serviceIncarnation: "legacy-incarnation", process: { pid: 2147483647, startTime: "1", bootId: "boot" } }), { mode: 0o600 });
    await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).rejects.toThrow("sidecar_service_recovery_required");
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const source = REMOTE_SERVICE_MANAGEMENT_PROXY_SOURCE.replace("o.userInfo().homedir", JSON.stringify(path.dirname(input.executablePath)));
    const argument = Buffer.from(JSON.stringify({ scope, requestId: randomUUID() })).toString("base64url");
    const result = await new Promise<string>((resolve, reject) => {
      actual.execFile(process.execPath, ["-e", source, argument], { timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    expect(JSON.parse(result)).toMatchObject({ outcome: "error", code: "sidecar_service_recovery_required" });
  });

  it.each(["starting", "running", "stopped", "startup lock"])("retires %s after namespace inode reuse with comparable init timestamps", async state => {
    const { paths, scope } = await fixture();
    if (state === "startup lock") await acquireStartupLock(paths.lockDirectory);
    else await recordPersistentSidecar(scope, "previous-target", state as "starting" | "running" | "stopped");
    const recordPath = state === "startup lock" ? path.join(paths.lockDirectory, "owner.json") : paths.descriptorPath;
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.lifetime.namespaceInitStartTime = String(BigInt(record.lifetime.namespaceInitStartTime) + 1n);
    await writeFile(recordPath, JSON.stringify(record));
    const matching = vi.spyOn(sidecarProcessOwnership, "processMatches");
    if (state === "startup lock") await (await acquireStartupLock(paths.lockDirectory))();
    else await expect(assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath)).resolves.toBeUndefined();
    expect(matching).not.toHaveBeenCalled();
  });

});
