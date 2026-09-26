import { CLAUDE_RUNTIME_WORKER_MINIMUM_NODE_VERSION } from "../../src/server/backends/claude/worker/claude-runtime-host-support.js";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindClaudeSupervisorToWorkerLifetime,
  ClaudeChildProcessSupervisor,
} from "../../src/server/backends/claude/worker/claude-child-process-supervisor.js";
import {
  CLAUDE_RUNTIME_WORKER_ARTIFACT_ID,
  CLAUDE_RUNTIME_WORKER_FILENAME,
  CLAUDE_RUNTIME_WORKER_KIND,
  loadClaudeRuntimeWorkerArtifact,
} from "../../src/server/backends/claude/worker/claude-runtime-worker-artifact.js";
import { managedWorkerLaunchArguments } from "../../src/server/managed-workers/artifact.js";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { ClaudeOuterProcessSupervisor } from "../../src/server/backends/claude/worker/claude-outer-process-supervisor.js";
import type {
  ClaudeQueryInput,
  ClaudeSdkFacade,
} from "../../src/server/backends/claude/claude-sdk-facade.js";
import { TrackedClaudeSdkFacade } from "../../src/server/backends/claude/worker/tracked-claude-sdk-facade.js";
import { readProcessEntrySync } from "../../src/server/runtime/process-table.js";

const roots: string[] = [];
const sessionDescendants: number[] = [];
afterEach(async () => {
  // Never leak a test grandchild, even when an assertion failed first.
  for (const pid of sessionDescendants.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * A leader that starts a grandchild in a new session, as Claude Code does for
 * each Bash tool shell (pgid = sid = pid), so the leader's group signal cannot
 * reach it. Both ignore SIGTERM; the leader exits on "exit" or stdin EOF.
 */
const SESSION_DESCENDANT_LEADER = [
  "const{spawn}=require('child_process')",
  "process.on('SIGTERM',()=>{})",
  "const g=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{detached:true,stdio:'ignore'})",
  "process.stdout.write(String(g.pid)+'\\n')",
  "process.stdin.on('data',d=>{if(String(d).includes('exit'))process.exit(0)})",
  // Like Claude, exit on stdin EOF; this also ends a leader orphaned by a failed test.
  "process.stdin.on('end',()=>process.exit(0))",
  "setInterval(()=>{},1000)",
].join(";");

const describeWithProcessTable =
  process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

function processAlive(pid: number): boolean {
  const entry = readProcessEntrySync(pid);
  return entry !== undefined && !entry.exited;
}

async function sessionDescendantPid(stdout: NodeJS.ReadableStream): Promise<number> {
  const pid = Number(await firstLine(stdout));
  expect(pid).toBeGreaterThan(1);
  sessionDescendants.push(pid);
  const entry = readProcessEntrySync(pid);
  // The grandchild leads its own session and group, outside the leader group.
  expect(entry).toMatchObject({ pid, processGroupId: pid });
  return pid;
}

describe("Claude child process supervisor", () => {
  it("keeps exact argv stopped while writes buffer until the outer ACK", async () => {
    let acknowledge!: () => void;
    const supervisor = new ClaudeChildProcessSupervisor({
      gracefulCloseMilliseconds: 100,
      terminateMilliseconds: 100,
      killMilliseconds: 500,
      processGroupRegistrar: {
        register: async () =>
          await new Promise<void>((resolve) => {
            acknowledge = resolve;
          }),
        unregister: () => undefined,
        close: () => undefined,
      },
    });
    const child = supervisor.spawn({
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.once('data',value=>process.stdout.write(JSON.stringify([process.argv[1],value.toString()])+'\\n'))",
        "; touch /tmp/must-not-run",
      ],
      env: {},
      signal: new AbortController().signal,
    });
    let observedOutput = false;
    child.stdout.once("data", () => {
      observedOutput = true;
    });
    const line = firstLine(child.stdout);
    child.stdin.write("buffered-before-ack");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(observedOutput).toBe(false);
    acknowledge();
    await expect(line).resolves.toBe(
      JSON.stringify(["; touch /tmp/must-not-run", "buffered-before-ack"]),
    );
    await supervisor.close();
  });

  it("kills the stopped gate and surfaces outer ACK failure", async () => {
    let processGroupId = 0;
    const supervisor = new ClaudeChildProcessSupervisor({
      gracefulCloseMilliseconds: 25,
      terminateMilliseconds: 25,
      killMilliseconds: 500,
      processGroupRegistrar: {
        register: async (value) => {
          processGroupId = value;
          throw new Error("outer unavailable");
        },
        unregister: () => undefined,
        close: () => undefined,
      },
    });
    const child = supervisor.spawn({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: {},
      signal: new AbortController().signal,
    });
    await expect(
      new Promise<Error>((resolve) => child.once("error", resolve)),
    ).resolves.toMatchObject({
      message: "claude_worker_process_group_registration_failed",
    });
    await supervisor.close();
    expect(() => process.kill(-processGroupId, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  it("settles registration before unregistering and closing the registrar", async () => {
    let acknowledge!: () => void;
    const actions: string[] = [];
    const supervisor = new ClaudeChildProcessSupervisor({
      gracefulCloseMilliseconds: 25,
      terminateMilliseconds: 25,
      killMilliseconds: 500,
      processGroupRegistrar: {
        register: async () => {
          actions.push("register");
          await new Promise<void>((resolve) => {
            acknowledge = resolve;
          });
        },
        unregister: () => actions.push("unregister"),
        close: () => actions.push("close"),
      },
    });
    supervisor.spawn({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: {},
      signal: new AbortController().signal,
    });
    const closing = supervisor.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    expect(actions).toEqual(["register"]);
    acknowledge();
    await closing;
    expect(actions).toEqual(["register", "unregister", "close"]);
  });

  it("gives stdin EOF a bounded graceful-close opportunity", async () => {
    const supervisor = shortSupervisor();
    const child = supervisor.spawn({
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.once('end',()=>process.exit(0))",
      ],
      env: {},
      signal: new AbortController().signal,
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    await supervisor.close();
    await exited;
    expect(supervisor.trackedProcessCount).toBe(0);
  });

  it("kills and proves cleanup of a stubborn complete process group", async () => {
    const supervisor = shortSupervisor();
    const child = supervisor.spawn({
      command: process.execPath,
      args: [
        "-e",
        [
          "const{spawn}=require('child_process')",
          "process.on('SIGTERM',()=>{})",
          "process.stdin.resume()",
          "spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
          "process.stdout.write(String(process.pid)+'\\n')",
          "setInterval(()=>{},1000)",
        ].join(";"),
      ],
      env: {},
      signal: new AbortController().signal,
    });
    const pid = Number(await firstLine(child.stdout));
    await supervisor.close();
    expect(() => process.kill(-pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  it("reaps descendants and unregisters after their group leader closes", async () => {
    let registeredGroup = 0;
    const unregistered: number[] = [];
    const supervisor = new ClaudeChildProcessSupervisor({
      gracefulCloseMilliseconds: 25,
      terminateMilliseconds: 50,
      killMilliseconds: 500,
      processGroupRegistrar: {
        register: async (processGroupId) => {
          registeredGroup = processGroupId;
        },
        unregister: (processGroupId) => unregistered.push(processGroupId),
        close: () => undefined,
      },
    });
    const child = supervisor.spawn({
      command: process.execPath,
      args: [
        "-e",
        [
          "const{spawn}=require('child_process')",
          "spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
          "process.exit(0)",
        ].join(";"),
      ],
      env: {},
      signal: new AbortController().signal,
    });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await waitUntil(() => unregistered.includes(registeredGroup), 2_000);
    expect(registeredGroup).toBeGreaterThan(1);
    expect(() => process.kill(-registeredGroup, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    expect(supervisor.trackedProcessCount).toBe(0);
    await expect(supervisor.close()).resolves.toBeUndefined();
  });

  it("terminates the exact tracked probe group on caller cancellation", async () => {
    const supervisor = shortSupervisor();
    const controller = new AbortController();
    const cancelled = new Error("caller cancelled probe");
    const probing = supervisor.executeProbe({
      executablePath: process.execPath,
      arguments: ["-e", "setInterval(()=>{},1000)"],
      timeoutMilliseconds: 5_000,
      signal: controller.signal,
    });
    await waitUntil(() => supervisor.trackedProcessCount === 1, 2_000);

    controller.abort(cancelled);
    await expect(probing).rejects.toBe(cancelled);
    await waitUntil(() => supervisor.trackedProcessCount === 0, 2_000);
    await expect(supervisor.close()).resolves.toBeUndefined();
  });

  it("reports automatic per-record cleanup uncertainty as worker-fatal", async () => {
    const cleanupFailures = vi.fn();
    const unregisterFailure = new Error("outer unregister failed");
    const supervisor = new ClaudeChildProcessSupervisor({
      gracefulCloseMilliseconds: 25,
      terminateMilliseconds: 25,
      killMilliseconds: 500,
      processGroupRegistrar: {
        register: async () => undefined,
        unregister: () => {
          throw unregisterFailure;
        },
        close: () => undefined,
      },
      onCleanupFailure: cleanupFailures,
    });
    const child = supervisor.spawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      env: {},
      signal: new AbortController().signal,
    });
    const processFailure = new Promise<Error>((resolve) =>
      child.once("error", resolve),
    );

    await expect(processFailure).resolves.toMatchObject({
      message: "claude_worker_closed_leader_cleanup_failed",
      cause: unregisterFailure,
    });
    expect(cleanupFailures).toHaveBeenCalledOnce();
    expect(cleanupFailures.mock.calls[0]?.[0]).toMatchObject({
      message: "claude_worker_closed_leader_cleanup_failed",
      cause: unregisterFailure,
    });
    await expect(supervisor.close()).rejects.toThrow(
      "claude_worker_child_cleanup_unproven",
    );
  });

  it("cleans children when the owning stdio carrier closes", async () => {
    const supervisor = shortSupervisor();
    const carrier = new PassThrough();
    const child = supervisor.spawn({
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      env: {},
      signal: new AbortController().signal,
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    const unbind = bindClaudeSupervisorToWorkerLifetime({
      supervisor,
      carrier,
    });
    carrier.resume();
    carrier.end();
    await exited;
    unbind();
    await waitUntil(() => supervisor.trackedProcessCount === 0, 2_000);
    expect(supervisor.trackedProcessCount).toBe(0);
  });
});

describeWithProcessTable("Claude child process supervisor descendant sessions", () => {
  it("terminates and proves a new-session grandchild when closing a live leader", async () => {
    const supervisor = shortSupervisor();
    const child = supervisor.spawn({
      command: process.execPath,
      args: ["-e", SESSION_DESCENDANT_LEADER],
      env: {},
      signal: new AbortController().signal,
    });
    const grandchild = await sessionDescendantPid(child.stdout);
    await supervisor.close();
    expect(processAlive(grandchild)).toBe(false);
  });

  it("keeps an orphaned new-session grandchild owned until its cleanup is proven", async () => {
    const unregistered: number[] = [];
    let registeredGroup = 0;
    const supervisor = new ClaudeChildProcessSupervisor({
      gracefulCloseMilliseconds: 100,
      terminateMilliseconds: 100,
      killMilliseconds: 500,
      descendantObservationMilliseconds: 25,
      processGroupRegistrar: {
        register: async (processGroupId) => {
          registeredGroup = processGroupId;
        },
        unregister: (processGroupId) => unregistered.push(processGroupId),
        close: () => undefined,
      },
    });
    const child = supervisor.spawn({
      command: process.execPath,
      args: ["-e", SESSION_DESCENDANT_LEADER],
      env: {},
      signal: new AbortController().signal,
    });
    const grandchild = await sessionDescendantPid(child.stdout);
    await waitUntil(() => supervisor.observedDescendantCount >= 1, 2_000);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.write("exit\n");
    await exited;
    // The leader is gone and the grandchild was reparented; ownership remains.
    await waitUntil(() => unregistered.includes(registeredGroup), 3_000);
    expect(processAlive(grandchild)).toBe(false);
    expect(supervisor.trackedProcessCount).toBe(0);
    await expect(supervisor.close()).resolves.toBeUndefined();
  });

  it("records descendants before an SDK kill without waiting for an observation tick", async () => {
    const supervisor = new ClaudeChildProcessSupervisor({
      gracefulCloseMilliseconds: 100,
      terminateMilliseconds: 100,
      killMilliseconds: 500,
      descendantObservationMilliseconds: 60_000,
      processGroupRegistrar: {
        register: async () => undefined,
        unregister: () => undefined,
        close: () => undefined,
      },
    });
    const child = supervisor.spawn({
      command: process.execPath,
      args: ["-e", SESSION_DESCENDANT_LEADER],
      env: {},
      signal: new AbortController().signal,
    });
    const grandchild = await sessionDescendantPid(child.stdout);
    expect(supervisor.observedDescendantCount).toBe(0);
    expect(child.kill("SIGKILL")).toBe(true);
    await waitUntil(() => !processAlive(grandchild), 2_000);
    await waitUntil(() => supervisor.trackedProcessCount === 0, 3_000);
    await expect(supervisor.close()).resolves.toBeUndefined();
  });
});

describeWithProcessTable("Claude outer process supervisor descendant sessions", () => {
  it("terminates a registered leader's new-session grandchild after the inner worker crashes", async () => {
    const leader = spawn(process.execPath, ["-e", SESSION_DESCENDANT_LEADER], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const grandchild = await sessionDescendantPid(leader.stdout!);
    const supervisor = new ClaudeOuterProcessSupervisor({
      gracefulMilliseconds: 25,
      terminateMilliseconds: 50,
      killMilliseconds: 500,
    });
    supervisor.accept({
      type: "process_group_registered",
      token: "t".repeat(43),
      processGroupId: leader.pid!,
    });
    await supervisor.close();
    expect(processAlive(grandchild)).toBe(false);
    expect(() => process.kill(-leader.pid!, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  it("refuses a live non-leader and accepts a gate that exited before registration", async () => {
    const member = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    try {
      await waitUntil(() => processAlive(member.pid!), 2_000);
      const supervisor = new ClaudeOuterProcessSupervisor({
        gracefulMilliseconds: 25,
        terminateMilliseconds: 25,
        killMilliseconds: 100,
      });
      expect(() => supervisor.accept({
        type: "process_group_registered",
        token: "t".repeat(43),
        processGroupId: member.pid!,
      })).toThrow("claude_runtime_worker_process_group_registration_invalid");
      supervisor.accept({
        type: "process_group_registered",
        token: "t".repeat(43),
        processGroupId: 2_147_483_646,
      });
      supervisor.accept({
        type: "process_group_unregistered",
        token: "t".repeat(43),
        processGroupId: 2_147_483_646,
      });
      await expect(supervisor.close()).resolves.toBeUndefined();
      expect(processAlive(member.pid!)).toBe(true);
    } finally {
      member.kill("SIGKILL");
    }
  });
});

describe("Claude outer process supervisor", () => {
  it("kills a registered stubborn group after the inner worker crashes", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000)",
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const pid = Number(await firstLine(child.stdout));
    const supervisor = new ClaudeOuterProcessSupervisor({
      gracefulMilliseconds: 25,
      terminateMilliseconds: 50,
      killMilliseconds: 500,
    });
    supervisor.accept({
      type: "process_group_registered",
      token: "t".repeat(43),
      processGroupId: pid,
    });
    await supervisor.close();
    expect(() => process.kill(-pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });
});

describe("tracked Claude SDK facade", () => {
  it("injects the owned spawn hook and rejects executable substitution", async () => {
    const supervisor = shortSupervisor();
    let captured: ClaudeQueryInput | undefined;
    const delegate = {
      createQuery: (input: ClaudeQueryInput) => {
        captured = input;
        return {};
      },
    } as unknown as ClaudeSdkFacade;
    const facade = new TrackedClaudeSdkFacade({ delegate, supervisor });
    facade.createQuery({
      prompt: "test",
      options: { pathToClaudeCodeExecutable: process.execPath },
    });
    const hook = captured?.options.spawnClaudeCodeProcess;
    expect(hook).toBeTypeOf("function");
    expect(() =>
      hook?.({
        command: "/bin/false",
        args: [],
        env: {},
        signal: new AbortController().signal,
      }),
    ).toThrow("claude_worker_query_executable_mismatch");
    const child = hook!({
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      env: {},
      signal: new AbortController().signal,
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    await supervisor.close();
    await exited;
  });

  it("runs release and redacted auth probes through tracked process groups", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-claude-probe-"));
    roots.push(root);
    const executablePath = path.join(root, "claude");
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        "if(process.argv[2]==='--version')process.stdout.write('2.1.283 (Claude Code)\\n')",
        "else process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'oauth',apiProvider:'firstParty',subscriptionType:'max',email:'secret@example.test'}))",
      ].join("\n"),
    );
    await chmod(executablePath, 0o500);
    const supervisor = shortSupervisor();
    const facade = new TrackedClaudeSdkFacade({
      delegate: {} as ClaudeSdkFacade,
      supervisor,
    });
    await expect(facade.readCliRelease(executablePath, 1_000)).resolves.toBe(
      "2.1.283",
    );
    await expect(
      facade.readCliAuthStatus(executablePath, 1_000),
    ).resolves.toEqual({
      loggedIn: true,
      authMethod: "oauth",
      apiProvider: "firstParty",
      subscriptionType: "max",
    });
    await supervisor.close();
  });
});

describe("Claude runtime worker artifact", () => {
  it("loads only its exact digest-verified owner-mode manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-claude-worker-"));
    roots.push(root);
    const artifact = Buffer.from("#!/usr/bin/env node\n", "utf8");
    const artifactPath = path.join(root, CLAUDE_RUNTIME_WORKER_FILENAME);
    await writeFile(artifactPath, artifact);
    await chmod(artifactPath, 0o500);
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        artifactId: CLAUDE_RUNTIME_WORKER_ARTIFACT_ID,
        filename: CLAUDE_RUNTIME_WORKER_FILENAME,
        modes: ["claude_runtime"],
        sha256: createHash("sha256").update(artifact).digest("hex"),
        bytes: artifact.byteLength,
        buildId: "fixture-build",
        minimumNodeVersion: CLAUDE_RUNTIME_WORKER_MINIMUM_NODE_VERSION,
      }),
    );
    await chmod(manifestPath, 0o400);
    await expect(
      loadClaudeRuntimeWorkerArtifact(manifestPath),
    ).resolves.toMatchObject({
      executablePath: artifactPath,
      buildId: "fixture-build",
    });
    await chmod(artifactPath, 0o700);
    await expect(loadClaudeRuntimeWorkerArtifact(manifestPath)).rejects.toThrow(
      "managed_worker_artifact_invalid",
    );
  });

  it("renders only the static Claude worker mode and launch identity", () => {
    expect(
      managedWorkerLaunchArguments(CLAUDE_RUNTIME_WORKER_KIND, {
        carrierGeneration: 7,
        sessionNonce: "n".repeat(32),
      }),
    ).toEqual([
      "supervise",
      "--carrier-generation",
      "7",
      "--session-nonce",
      "n".repeat(32),
    ]);
  });
});

function shortSupervisor(): ClaudeChildProcessSupervisor {
  return new ClaudeChildProcessSupervisor({
    gracefulCloseMilliseconds: 100,
    terminateMilliseconds: 100,
    killMilliseconds: 500,
    processGroupRegistrar: {
      register: async () => undefined,
      unregister: () => undefined,
      close: () => undefined,
    },
  });
}

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffered = "";
    stream.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline >= 0) resolve(buffered.slice(0, newline));
    });
    stream.once("error", reject);
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test_wait_timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
