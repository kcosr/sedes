import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { promisify } from "node:util";

interface ProbeResult {
  mode: string;
  sandbox: {
    userNamespace: boolean;
    pidNamespace: boolean;
    networkNamespace: boolean;
    hostRootMounted: boolean;
    runtimeMountsReadOnly: boolean;
    hostHomesHidden: boolean;
    environmentNames: string[];
  };
  exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  };
  stdout: { bytes: number; frameCount: number; frames: unknown[] };
  stderr: { bytes: number; redactedTail: string; truncated: boolean };
  filesystem: {
    after: { entries: Array<{ path: string; type: string }> };
    changes: Array<{ kind: string; entry?: { path: string } }>;
  };
  cleanup: {
    temporaryRoot?: string;
    processGroupId?: number;
    processGroupTerminated: boolean;
    temporaryRootRemovedOnReturn: boolean;
  };
  violation?: string;
}

interface ProbeInput {
  mode: string;
  executablePath: string;
  retainedFileDescriptor?: number;
  expectedSha256?: string;
  expectedBytes?: number;
  scriptPath?: string;
  arguments?: string[];
  environment?: Record<string, string>;
  sensitiveValues?: string[];
  inputFrames?: unknown[];
  offlineScenarioIds?: string[];
  o2aReviewEvidence?: { status: "accepted"; evidenceId: string };
  limits?: Record<string, number>;
  signal?: AbortSignal;
}

interface ProbeModule {
  GROK_PROBE_MODES: {
    O1_NO_INITIALIZE: string;
    O2A_INITIALIZE_ONLY: string;
    O2B_OFFLINE: string;
  };
  GrokProbeSandboxError: new (...args: never[]) => Error & {
    code: string;
    result?: ProbeResult;
  };
  runGrokProbe(input: ProbeInput): Promise<ProbeResult>;
  createGrokProbeSandboxLaunchPlan(input: ProbeInput): Promise<{
    mode: string;
    launch: {
      executablePath: string;
      workingDirectory: string;
      commandArguments: readonly string[];
      environment: Readonly<Record<string, string>>;
      sensitiveValues: readonly string[];
    };
    protocolAdmission: {
      maximumOutboundFrames?: number;
      maximumInboundFrames?: number;
      allowedMethods: readonly string[];
      authenticate: boolean;
      providerCapacity: boolean;
      filesystemCapability: boolean;
      terminalCapability: boolean;
    };
    filesystemBefore: unknown;
    finalize(options?: { signal?: AbortSignal }): Promise<{
      cleanup: { temporaryRootRemoved: boolean };
    }>;
  }>;
  runGrokStaticProbe(input: {
    executablePath: string;
    retainedFileDescriptor: number;
    expectedSha256: string;
    expectedBytes: number;
    command: "version_json" | "root_help" | "agent_help" | "agent_stdio_help";
    limits?: Record<string, number>;
    signal?: AbortSignal;
  }): Promise<ProbeResult & { stdout: ProbeResult["stdout"] & { sanitizedText: string } }>;
}

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixturePath = path.join(
  rootDirectory,
  "tests/fixtures/grok-probes/fake-grok-acp-child.mjs",
);
const staticFixtureSource = path.join(
  rootDirectory,
  "tests/fixtures/grok-probes/fake-grok-static.c",
);
const execFileAsync = promisify(execFile);
// The production probe is deliberately a standalone Node script rather than a
// compiled application module.
// @ts-expect-error TypeScript does not synthesize declarations for .mjs scripts.
const probe = (await import("../../scripts/grok-probes/grok-probe-sandbox.mjs")) as ProbeModule;

function fakeInput(overrides: Partial<ProbeInput> = {}): ProbeInput {
  return {
    mode: probe.GROK_PROBE_MODES.O1_NO_INITIALIZE,
    executablePath: process.execPath,
    scriptPath: fixturePath,
    arguments: ["report"],
    limits: {
      timeoutMs: 2_000,
      observationMs: 150,
      terminateGraceMs: 200,
      killGraceMs: 500,
    },
    ...overrides,
  };
}

async function expectRemoved(directory: string): Promise<void> {
  await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
}

async function createStaticStage() {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-static-stage-"));
  const executablePath = path.join(root, "grok");
  await execFileAsync("cc", [
    "-static",
    "-Os",
    staticFixtureSource,
    "-o",
    executablePath,
  ]);
  await chmod(executablePath, 0o500);
  const bytes = await readFile(executablePath);
  const handle = await open(
    executablePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  return {
    root,
    executablePath,
    retainedFileDescriptor: handle.fd,
    expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    expectedBytes: bytes.length,
    async cleanup() {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const describeGrokProbe = describe.runIf(process.platform === "linux");

describeGrokProbe("Grok offline probe sandbox", () => {
  it("runs O1 without initialize inside isolated, read-only host authority", async () => {
    const hostHome = await mkdtemp(path.join(os.homedir(), ".sedes-probe-test-"));
    const homeCanary = path.join(hostHome, "host-only-canary");
    try {
      await writeFile(homeCanary, "host-home-canary\n", { mode: 0o600 });
      expect(await readFile(homeCanary, "utf8")).toBe("host-home-canary\n");
      const result = await probe.runGrokProbe(
        fakeInput({ arguments: ["report", homeCanary] }),
      );
      const frame = result.stdout.frames[0] as {
        event: string;
        cwd: string;
        uid: number;
        environment: Record<string, string>;
        networkInterfaces: string[];
        hostCanary: { ok: boolean; code: string };
        hostHome: { ok: boolean; code: string };
        ambientCanaries: Array<{
          file: string;
          result: { ok: boolean; value?: string; code?: string };
        }>;
        baselineConfig: { ok: boolean; value?: string; code?: string };
        rootWrite: { ok: boolean; code: string };
        executableWrite: { ok: boolean; code: string };
      };

      expect(result).toMatchObject({
        mode: probe.GROK_PROBE_MODES.O1_NO_INITIALIZE,
        sandbox: {
          userNamespace: true,
          pidNamespace: true,
          networkNamespace: true,
          hostRootMounted: false,
          runtimeMountsReadOnly: true,
          hostHomesHidden: true,
        },
        exit: { timedOut: false },
        stdout: { frameCount: 1 },
        stderr: { bytes: 0 },
        cleanup: {
          processGroupTerminated: true,
          temporaryRootRemovedOnReturn: true,
        },
      });
      expect(frame).toMatchObject({
        event: "startup",
        cwd: "/mnt/workspace",
        uid: 0,
        environment: {
          ALL_PROXY: "socks5://127.0.0.1:9",
          DISABLE_TELEMETRY: "1",
          DO_NOT_TRACK: "1",
          GROK_DISABLE_AUTOUPDATER: "1",
          HOME: "/home/probe",
          GROK_HOME: "/home/probe/.grok",
          GROK_PROMPT_SUGGESTIONS: "false",
          GROK_TELEMETRY_ENABLED: "false",
          GROK_TURN_SUMMARY: "0",
          HTTPS_PROXY: "http://127.0.0.1:9",
          HTTP_PROXY: "http://127.0.0.1:9",
          NO_COLOR: "1",
          NO_PROXY: "",
          OTEL_SDK_DISABLED: "true",
          TMPDIR: "/tmp",
        },
        networkInterfaces: ["lo"],
        hostCanary: { ok: false, code: "ENOENT" },
        hostHome: { ok: false, code: "ENOENT" },
        rootWrite: { ok: false, code: "EROFS" },
        executableWrite: { ok: false },
      });
      expect(frame.ambientCanaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: "/etc/grok/.sedes-grok-probe-canary",
            result: {
              ok: true,
              value: "sedes-grok-probe-ambient-marker-v1\n",
            },
          }),
          expect.objectContaining({
            file: "/mnt/workspace/.sedes-grok-probe-mcp-canary",
            result: {
              ok: true,
              value: "sedes-grok-probe-ambient-marker-v1\n",
            },
          }),
        ]),
      );
      expect(frame.baselineConfig).toEqual({
        ok: true,
        value: [
          "[cli]",
          "auto_update = false",
          "use_leader = false",
          "",
          "[features]",
          "telemetry = false",
          "feedback = false",
          "remote_fetch = false",
          "web_fetch = false",
          "",
          "[telemetry]",
          "trace_upload = false",
          "mixpanel_enabled = false",
          "",
          "[ui]",
          "yolo = false",
          "",
        ].join("\n"),
      });
      expect(frame.environment).not.toHaveProperty(
        "SEDES_GROK_PROBE_HOST_SECRET",
      );
      expect(
        result.filesystem.changes.map((change) => change.entry?.path),
      ).toEqual(
        expect.arrayContaining([
          "home/home-created",
          "home/.grok/grok-created",
          "home/.local/state/state-created",
          "workspace/workspace-created",
          "tmp/tmp-created",
        ]),
      );
      await expectRemoved(result.cleanup.temporaryRoot!);
    } finally {
      await rm(hostHome, { recursive: true, force: true });
    }
  });

  it("allows only one authority-free initialize request in O2a", async () => {
    const result = await probe.runGrokProbe(
      fakeInput({
        mode: probe.GROK_PROBE_MODES.O2A_INITIALIZE_ONLY,
        arguments: ["initialize"],
        inputFrames: [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: 1,
              clientInfo: { name: "sedes-g0", version: "0" },
              clientCapabilities: {},
            },
          },
        ],
      }),
    );

    expect(result.stdout.frames).toEqual([
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 1,
        result: expect.objectContaining({
          protocolVersion: 1,
          observedMethod: "initialize",
        }),
      }),
    ]);
    await expectRemoved(result.cleanup.temporaryRoot!);

    await expect(
      probe.runGrokProbe(
        fakeInput({
          mode: probe.GROK_PROBE_MODES.O2A_INITIALIZE_ONLY,
          arguments: ["initialize"],
          inputFrames: [
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { clientCapabilities: { terminal: true } },
            },
          ],
        }),
      ),
    ).rejects.toThrow("no filesystem or terminal authority");
  });

  it("requires an exact reviewed O2b offline method allowlist", async () => {
    const result = await probe.runGrokProbe(
      fakeInput({
        mode: probe.GROK_PROBE_MODES.O2B_OFFLINE,
        arguments: ["echo-input"],
        offlineScenarioIds: ["models_list"],
        o2aReviewEvidence: { status: "accepted", evidenceId: "review-o2a-1" },
        inputFrames: [
          {
            jsonrpc: "2.0",
            id: "initialize-1",
            method: "initialize",
            params: { clientCapabilities: {} },
          },
          {
            jsonrpc: "2.0",
            id: "list-1",
            method: "x.ai/models/list",
            params: {},
          },
        ],
      }),
    );
    expect(result.stdout.frames).toEqual([
      {
        jsonrpc: "2.0",
        id: "initialize-1",
        result: { method: "initialize" },
      },
      {
        jsonrpc: "2.0",
        id: "list-1",
        result: { method: "x.ai/models/list" },
      },
    ]);
    await expectRemoved(result.cleanup.temporaryRoot!);

    await expect(
      probe.runGrokProbe(
        fakeInput({
          mode: probe.GROK_PROBE_MODES.O2B_OFFLINE,
          arguments: ["echo-input"],
          offlineScenarioIds: ["prompt"],
          o2aReviewEvidence: {
            status: "accepted",
            evidenceId: "review-o2a-1",
          },
          inputFrames: [
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { clientCapabilities: {} },
            },
            { jsonrpc: "2.0", id: 2, method: "session/prompt", params: {} },
          ],
        }),
      ),
    ).rejects.toThrow("Unknown reviewed O2b scenario");
  });

  it("redacts caller canaries and removes every raw capture", async () => {
    const canary = "do-not-persist-this-grok-probe-secret";
    const result = await probe.runGrokProbe(
      fakeInput({
        arguments: ["echo-argument", canary],
        sensitiveValues: [canary],
      }),
    );
    expect(result.stdout.frames).toEqual([{ value: "<redacted>" }]);
    expect(JSON.stringify(result)).not.toContain(canary);
    await expectRemoved(result.cleanup.temporaryRoot!);
  });

  it("waits for stdout close before hashing and returning frames", async () => {
    const result = await probe.runGrokProbe(
      fakeInput({ arguments: ["trailing-output"] }),
    );
    expect(result.stdout.frames).toEqual([{ sequence: 1 }, { sequence: 2 }]);
    await expectRemoved(result.cleanup.temporaryRoot!);
  });

  it.each([
    [
      "stdout-flood",
      { maxStdoutBytes: 4_096, maxFrameBytes: 4_096 },
      "stdout_limit_exceeded",
    ],
    ["stderr-flood", { maxStderrBytes: 4_096 }, "stderr_limit_exceeded"],
  ])(
    "hard-stops %s and cleans the process group",
    async (scenario, limits, code) => {
      let failure:
        (Error & { code?: string; result?: ProbeResult }) | undefined;
      try {
        await probe.runGrokProbe(
          fakeInput({
            arguments: [scenario],
            limits: { ...fakeInput().limits, ...limits },
          }),
        );
      } catch (error) {
        failure = error as Error & { code?: string; result?: ProbeResult };
      }
      expect(failure?.code).toBe(code);
      expect(failure?.result?.cleanup.processGroupTerminated).toBe(true);
      expect(
        (failure?.result?.stdout.bytes ?? 0) +
          (failure?.result?.stderr.bytes ?? 0),
      ).toBeGreaterThan(0);
      await expectRemoved(failure!.result!.cleanup.temporaryRoot!);
    },
  );

  it("kills a signal-resistant child and all descendants after the O1 bound", async () => {
    const result = await probe.runGrokProbe(
      fakeInput({
        arguments: ["hang-with-descendant"],
        limits: {
          timeoutMs: 2_000,
          observationMs: 40,
          terminateGraceMs: 50,
          killGraceMs: 500,
        },
      }),
    );
    expect(result.exit.timedOut).toBe(false);
    expect(["SIGTERM", "SIGKILL"]).toContain(result.exit.signal);
    expect(result.cleanup.processGroupTerminated).toBe(true);
    expect(result.filesystem.after.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "workspace/descendant.pid",
          type: "file",
        }),
      ]),
    );
    await expectRemoved(result.cleanup.temporaryRoot!);
  });

  it("rejects protocol input in O1 before starting a process", async () => {
    await expect(
      probe.runGrokProbe(
        fakeInput({
          inputFrames: [
            { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          ],
        }),
      ),
    ).rejects.toThrow("O1 forbids all ACP input");
  });

  it("builds an exact-binary plan for the shared owned NDJSON transport", async () => {
    const stage = await createStaticStage();
    try {
      const exactInput = {
        mode: probe.GROK_PROBE_MODES.O1_NO_INITIALIZE,
        executablePath: stage.executablePath,
        retainedFileDescriptor: stage.retainedFileDescriptor,
        expectedSha256: stage.expectedSha256,
        expectedBytes: stage.expectedBytes,
        arguments: ["--no-auto-update", "agent", "--no-leader", "stdio"],
      };
      const plan = await probe.createGrokProbeSandboxLaunchPlan(exactInput);
      expect(plan.launch).toMatchObject({
        executablePath: "/usr/bin/bwrap",
        workingDirectory: "/",
        environment: {},
        inheritedFileDescriptors: [
          {
            sourceFd: stage.retainedFileDescriptor,
            targetFd: 3,
            disposition: "read_only_executable_bytes",
          },
        ],
      });
      expect(plan.protocolAdmission).toMatchObject({
        maximumOutboundFrames: 0,
        allowedMethods: [],
        authenticate: false,
        providerCapacity: false,
      });
      const command = plan.launch.commandArguments;
      expect(command).toContain("--unshare-net");
      expect(command).toContain("--unshare-pid");
      expect(command).toContain("--unshare-user");
      expect(command).toContain("--clearenv");
      expect(command).toContain("--tmpfs");
      expect(command).toContain("--ro-bind-fd");
      expect(command).toContain("3");
      expect(command).not.toContain(stage.executablePath);
      expect(command).not.toContain(`/proc/self/fd/${stage.retainedFileDescriptor}`);
      expect(command).not.toContain("/usr");
      expect(command.join(" ")).not.toContain("--ro-bind / /");
      expect(command).not.toContain("/srv");
      expect(command).not.toContain("/opt");
      expect(command).not.toContain("/var");
      expect(command).not.toContain(os.homedir());
      const etcGrokMount = command.lastIndexOf("/etc/grok");
      expect(etcGrokMount).toBeGreaterThan(1);
      expect(command[etcGrokMount - 2]).toBe("--ro-bind");
      const secondPlan = await probe.createGrokProbeSandboxLaunchPlan(exactInput);
      expect(secondPlan.filesystemBefore).toEqual(plan.filesystemBefore);
      await secondPlan.finalize();
      const finalized = await plan.finalize();
      expect(finalized.cleanup.temporaryRootRemoved).toBe(true);
      await expect(plan.finalize()).resolves.toBe(finalized);
    } finally {
      await stage.cleanup();
    }
  });

  it("keeps launch planning separate from ACP frame ownership", async () => {
    const plan = await probe.createGrokProbeSandboxLaunchPlan({
      mode: probe.GROK_PROBE_MODES.O2A_INITIALIZE_ONLY,
      executablePath: process.execPath,
      scriptPath: fixturePath,
      arguments: ["--no-auto-update", "agent", "--no-leader", "stdio"],
    });
    expect(plan.protocolAdmission).toEqual({
      maximumOutboundFrames: 1,
      maximumInboundFrames: 2,
      allowedMethods: ["initialize"],
      authenticate: false,
      providerCapacity: false,
      filesystemCapability: false,
      terminalCapability: false,
    });
    await plan.finalize();

    await expect(
      probe.createGrokProbeSandboxLaunchPlan({
        mode: probe.GROK_PROBE_MODES.O2A_INITIALIZE_ONLY,
        executablePath: process.execPath,
        scriptPath: fixturePath,
        arguments: ["--no-auto-update", "agent", "--no-leader", "stdio"],
        inputFrames: [
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        ],
      }),
    ).rejects.toThrow("AcpBinding is the sole protocol writer");
  });

  it("honors launch and finalize abort signals without stranding sandbox state", async () => {
    const preAborted = new AbortController();
    preAborted.abort(new Error("launch deadline"));
    await expect(
      probe.createGrokProbeSandboxLaunchPlan(
        fakeInput({ signal: preAborted.signal }),
      ),
    ).rejects.toThrow("launch deadline");

    const plan = await probe.createGrokProbeSandboxLaunchPlan(
      fakeInput({ mode: probe.GROK_PROBE_MODES.O1_NO_INITIALIZE }),
    );
    const firstWritableBind = plan.launch.commandArguments.indexOf("--bind");
    const sandboxHome = plan.launch.commandArguments[firstWritableBind + 1];
    if (sandboxHome === undefined) throw new Error("sandbox home bind missing");
    const temporaryRoot = path.dirname(path.dirname(sandboxHome));
    const finalizeAbort = new AbortController();
    finalizeAbort.abort(new Error("finalize deadline"));
    await expect(
      plan.finalize({ signal: finalizeAbort.signal }),
    ).rejects.toThrow("finalize deadline");
    await expectRemoved(temporaryRoot);
  });

  it("runs only a verified private staged O0 executable with bounded raw capture", async () => {
    const stage = await createStaticStage();
    try {
      const result = await probe.runGrokStaticProbe({
        executablePath: stage.executablePath,
        retainedFileDescriptor: stage.retainedFileDescriptor,
        expectedSha256: stage.expectedSha256,
        expectedBytes: stage.expectedBytes,
        command: "version_json",
        limits: {
          timeoutMs: 2_000,
          terminateGraceMs: 1_000,
          killGraceMs: 500,
        },
      });
      expect(result).toMatchObject({
        mode: "o0_version_json",
        exit: { code: 0, timedOut: false },
        stdout: {
          frameCount: 0,
          sanitizedText: '{"version":"fixture","build":"static"}\n',
        },
        cleanup: {
          processGroupTerminated: true,
          temporaryRootRemovedOnReturn: true,
        },
      });
      expect(result.cleanup).not.toHaveProperty("temporaryRoot");
      expect(result.cleanup).not.toHaveProperty("processGroupId");

      const reused = await probe.runGrokStaticProbe({
        executablePath: stage.executablePath,
        retainedFileDescriptor: stage.retainedFileDescriptor,
        expectedSha256: stage.expectedSha256,
        expectedBytes: stage.expectedBytes,
        command: "root_help",
        limits: {
          timeoutMs: 2_000,
          terminateGraceMs: 1_000,
          killGraceMs: 500,
        },
      });
      expect(reused.stdout.sanitizedText).toBe("fake grok root help\n");
    } finally {
      await stage.cleanup();
    }
  });

  it("executes retained bytes and rejects a same-uid staged-path replacement", async () => {
    const stage = await createStaticStage();
    try {
      const running = probe.runGrokStaticProbe({
        executablePath: stage.executablePath,
        retainedFileDescriptor: stage.retainedFileDescriptor,
        expectedSha256: stage.expectedSha256,
        expectedBytes: stage.expectedBytes,
        command: "version_json",
        limits: {
          timeoutMs: 2_000,
          terminateGraceMs: 1_000,
          killGraceMs: 500,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const replacement = path.join(stage.root, "replacement");
      await writeFile(replacement, "not the retained executable\n", { mode: 0o500 });
      await rename(replacement, stage.executablePath);

      let failure:
        | (Error & { code?: string; result?: ProbeResult & { stdout: { sanitizedText?: string } } })
        | undefined;
      try {
        await running;
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure?.code).toBe("staged_executable_identity_mismatch");
      expect(failure?.result?.stdout.sanitizedText).toBe(
        '{"version":"fixture","build":"static"}\n',
      );
      expect(failure?.result?.cleanup.processGroupTerminated).toBe(true);
    } finally {
      await stage.cleanup();
    }
  });
});
