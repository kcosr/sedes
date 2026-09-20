import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIDECAR_ARTIFACT_ID,
  SIDECAR_ARTIFACT_MODES,
  SIDECAR_MINIMUM_NODE_VERSION,
  type SidecarArtifactRegistration,
} from "../../src/server/sidecar/sidecar-artifact.js";
import {
  REMOTE_BOOTSTRAP_SOURCE,
  SshSidecarArtifactCleanupError,
  SshSidecarArtifactInstaller,
  SshSidecarConnectionError,
} from "../../src/server/sidecar/ssh-sidecar-artifact-installer.js";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";
import type { SidecarServiceControlBoundary } from "../../src/server/sidecar/sidecar-provisioner.js";
import {
  sidecarManagementRequestSchema,
  type SidecarManagementRequest,
  type SidecarServiceStatus,
} from "../../src/internal/sidecar-protocol/service-management-v1.js";

const serviceScope = {
  installationId: "installation", tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment",
};
const configuration = { environmentRevision: 3, operationsRevision: 7 };
const temporaryDirectories: string[] = [];
const AGENT_TOOL_ENDPOINT_KEY = "0123456789abcdef01234567";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SshSidecarArtifactInstaller", () => {
  it.each(["install", "inspect", "attachExisting"] as const)(
    "classifies SSH connection loss during %s as retryable observation failure",
    async (operation) => {
      const artifact = await artifactFixture(Buffer.from("connection bundle"));
      const child = fakeChild();
      const installer = new SshSidecarArtifactInstaller({
        serviceScope, configuration, host: "srv", artifact,
        agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
        spawnProcess: captureSpawn([], child, () => complete(child, 255)),
      });
      const signal = new AbortController().signal;
      if (operation === "attachExisting") {
        vi.spyOn(installer, "inspect").mockResolvedValue({
          scope: serviceScope, serviceIncarnation: "original-service",
          runtimeWireVersion: SIDECAR_WIRE_VERSION,
          buildId: "fixture", artifactSha256: "a".repeat(64),
          controllerEpoch: 1, attached: false, attachmentMode: "recovery", state: "ready",
          desiredConfiguration: configuration, effectiveConfiguration: configuration,
          configurationState: "applied", resources: [], resourcesFingerprint: "b".repeat(64),
        });
      }
      const result = operation === "attachExisting"
        ? installer.attachExisting(1, "n".repeat(48), signal)
        : installer[operation](signal);
      await expect(result).rejects.toBeInstanceOf(SshSidecarConnectionError);
    },
  );

  it.each([
    { output: "", diagnostic: "", exitCode: 1, expected: "sidecar_install_output_incomplete" },
    { output: "", diagnostic: "sidecar_service_scope_mismatch\n", exitCode: 255, expected: "sidecar_install_output_incomplete" },
    { output: "untrusted proof\n", diagnostic: "", exitCode: 255, expected: "sidecar_install_response_invalid" },
  ])("does not classify remote rejection or invalid proof as connection loss ($expected)", async (input) => {
    const artifact = await artifactFixture(Buffer.from("rejected bundle"));
    const child = fakeChild();
    const installer = new SshSidecarArtifactInstaller({
      serviceScope, configuration, host: "srv", artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess: captureSpawn([], child, () => {
        child.stdout.write(input.output);
        child.stderr.write(input.diagnostic);
        complete(child, input.exitCode);
      }),
    });
    await expect(installer.install(new AbortController().signal)).rejects.toThrow(input.expected);
  });

  it("preserves an explicit abort when SSH also exits with a connection error", async () => {
    const artifact = await artifactFixture(Buffer.from("aborted bundle"));
    const child = fakeChild();
    const controller = new AbortController();
    const reason = new Error("explicit_disconnect");
    const installer = new SshSidecarArtifactInstaller({
      serviceScope, configuration, host: "srv", artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess: captureSpawn([], child, () => {
        controller.abort(reason);
        complete(child, 255);
      }),
    });
    await expect(installer.inspect(controller.signal)).rejects.toBe(reason);
  });

  it("preserves management identity rejection even if SSH subsequently exits with 255", async () => {
    const artifact = await artifactFixture(Buffer.from("wrong identity bundle"));
    const child = fakeChild();
    child.stdin.on("data", () => {
      child.stdout.write(`${JSON.stringify({ managementVersion: 1, requestId: "wrong-request", outcome: "absent" })}\n`);
      complete(child, 255);
    });
    const installer = new SshSidecarArtifactInstaller({
      serviceScope, configuration, host: "srv", artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess: captureSpawn([], child, () => undefined),
    });
    await expect(installer.inspect(new AbortController().signal)).rejects.toThrow("sidecar_management_response_identity_invalid");
  });

  it("distinguishes a staging failure from an unconfirmed shutdown", async () => {
    const artifact = await artifactFixture(Buffer.from("new bundle"));
    const spawnProcess = vi.fn();
    const installer = new SshSidecarArtifactInstaller({ serviceScope, configuration,
      host: "remote-builder", artifact, agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY, spawnProcess });
    const failure = new Error("sidecar_install_timeout");
    const install = vi.spyOn(installer, "install").mockRejectedValue(failure);
    const boundary = vi.fn<SidecarServiceControlBoundary>(effect => effect());
    try {
      await expect(installer.control({ mutationId: "upgrade-attempt", operation: "upgrade", expectedServiceIncarnation: "running-service",
        controllerEpoch: 1, expectedConfiguration: configuration, expectedResourcesFingerprint: "a".repeat(64), force: true },
      new AbortController().signal, boundary)).rejects.toMatchObject({ name: "SidecarServiceStagingError", cause: failure });
      expect(boundary).not.toHaveBeenCalled();
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally { install.mockRestore(); }
  });

  it("enters the interruption boundary once after staging and keeps management and replacement observation inside", async () => {
    const artifact = await artifactFixture(Buffer.from("staged bundle"));
    const order: string[] = [];
    const replacement: SidecarServiceStatus = { scope: serviceScope, serviceIncarnation: "replacement", buildId: artifact.buildId,
      artifactSha256: artifact.artifactSha256, runtimeWireVersion: SIDECAR_WIRE_VERSION, controllerEpoch: 2,
      attached: false, attachmentMode: "none", state: "ready", desiredConfiguration: configuration, effectiveConfiguration: configuration,
      configurationState: "applied", resources: [], resourcesFingerprint: "b".repeat(64) };
    const child = fakeChild();
    let incoming = "";
    child.stdin.on("data", (bytes: Buffer) => {
      incoming += bytes.toString();
      if (!incoming.includes("\n")) return;
      const request = sidecarManagementRequestSchema.parse(JSON.parse(incoming));
      order.push(request.operation);
      child.stdout.write(`${JSON.stringify({ managementVersion: 1, requestId: request.requestId, outcome: "ok", status: { ...replacement, serviceIncarnation: "old", state: "stopped" } })}\n`);
    });
    child.stdin.on("finish", () => complete(child, 0));
    const installer = new SshSidecarArtifactInstaller({ serviceScope, configuration, host: "srv", artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY, spawnProcess: captureSpawn([], child, () => undefined) });
    vi.spyOn(installer, "install").mockImplementation(async () => {
      order.push("stage");
      return { accountHome: "/home/client", nodeExecutable: "/usr/bin/node", envExecutable: "/usr/bin/env", stateRoot: "/state", environment: {}, executableDirectory: "/artifact", executablePath: "/artifact/sedes" };
    });
    vi.spyOn(installer, "inspect").mockImplementation(async () => { order.push("inspect"); return replacement; });
    const boundary = vi.fn<SidecarServiceControlBoundary>(async effect => {
      order.push("enter"); const result = await effect(); order.push("leave"); return result;
    });
    await expect(installer.control({ mutationId: "restart", operation: "restart", expectedServiceIncarnation: "old", controllerEpoch: 1,
      expectedConfiguration: configuration, expectedResourcesFingerprint: "a".repeat(64), force: true }, new AbortController().signal, boundary)).resolves.toEqual(replacement);
    expect(order).toEqual(["stage", "enter", "restart", "inspect", "leave"]);
    expect(boundary).toHaveBeenCalledOnce();
  });

  it("settles a stop whose service is already absent and whose command was never admitted", async () => {
    const artifact = await artifactFixture(Buffer.from("absent bundle"));
    const mutationId = "stop-never-admitted";
    const answer = (child: FakeChild, respond: (request: SidecarManagementRequest) => object) => {
      let input = "";
      child.stdin.on("data", (bytes: Buffer) => {
        input += bytes.toString("utf8");
        if (!input.includes("\n")) return;
        const request = sidecarManagementRequestSchema.parse(JSON.parse(input));
        child.stdout.write(`${JSON.stringify({ managementVersion: 1, requestId: request.requestId, ...respond(request) })}\n`);
      });
      child.stdin.on("finish", () => complete(child, 0));
    };
    const stopChild = fakeChild();
    answer(stopChild, () => ({ outcome: "absent" }));
    const receiptChild = fakeChild();
    const statusChild = fakeChild();
    answer(statusChild, () => ({ outcome: "absent" }));
    const children = [stopChild, receiptChild, statusChild];
    const receiptCommands: string[] = [];
    const installer = new SshSidecarArtifactInstaller({ serviceScope, configuration, host: "srv", artifact, agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess: effectiveConfigAware((_executable, arguments_) => {
        const child = children.shift();
        if (!child) throw new Error("unexpected_spawn");
        queueMicrotask(() => {
          child.emit("spawn");
          // The receipt carrier answers from durable state without reading stdin.
          if (child === receiptChild) {
            const command = arguments_.at(-1) ?? "";
            receiptCommands.push(command);
            const encoded = /'([A-Za-z0-9_-]+)'$/u.exec(command)?.[1] ?? "";
            const carried = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { requestId: string; receipt?: string };
            expect(carried.receipt).toBe(mutationId);
            child.stdout.write(`${JSON.stringify({ managementVersion: 1, requestId: carried.requestId, outcome: "receipt", receipt: null })}\n`);
            complete(child, 0);
          }
        });
        return child as unknown as ChildProcess;
      }),
    });
    await expect(installer.control({ mutationId, operation: "stop", expectedServiceIncarnation: "gone-service", controllerEpoch: 3,
      expectedConfiguration: configuration, expectedResourcesFingerprint: "c".repeat(64), force: true }, new AbortController().signal)).resolves.toBeUndefined();
    expect(children).toHaveLength(0);
    expect(receiptCommands).toHaveLength(1);
    expect(receiptCommands[0]).toContain("exec node -e");
  });

  it("surfaces the remote bootstrap's diagnostic instead of a bare carrier failure", async () => {
    const artifact = await artifactFixture(Buffer.from("diagnostic bundle"));
    const installChild = fakeChild();
    installChild.stdin.on("finish", () => { installChild.stdout.end(installationProofLine(artifact.artifactSha256)); complete(installChild, 0); });
    const statusChild = fakeChild();
    statusChild.stdin.on("data", (bytes: Buffer) => {
      const request = sidecarManagementRequestSchema.parse(JSON.parse(bytes.toString("utf8")));
      statusChild.stdout.write(`${JSON.stringify({ managementVersion: 1, requestId: request.requestId, outcome: "absent" })}\n`);
    });
    statusChild.stdin.on("finish", () => complete(statusChild, 0));
    const launchChild = fakeChild();
    launchChild.stdin.once("data", () => {
      launchChild.stderr.write("Warning: Permanently added 'srv' to the list of known hosts.\nsidecar_service_recovery_required\n");
      complete(launchChild, 1);
    });
    const children = [installChild, statusChild, launchChild];
    const installer = new SshSidecarArtifactInstaller({ serviceScope, configuration, host: "srv", artifact, agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess: effectiveConfigAware(() => {
        const child = children.shift();
        if (!child) throw new Error("unexpected_spawn");
        queueMicrotask(() => { child.emit("spawn"); if (child === installChild) setTimeout(() => child.stdout.write("send\n"), 0); });
        return child as unknown as ChildProcess;
      }),
    });
    await installer.install(new AbortController().signal);
    await expect(installer.launch(1, "a_secure_session_nonce_0123456789abcdef", new AbortController().signal))
      .rejects.toMatchObject({ name: "SidecarServiceManagementError", code: "sidecar_service_recovery_required" });
  });

  it("uses the hardened foreground command and skips upload for an exact cached artifact", async () => {
    const artifact = await artifactFixture(Buffer.from("cached bundle"));
    const calls: SpawnCall[] = [];
    const child = fakeChild();
    child.stdin.on("data", (bytes) => child.received.push(Buffer.from(bytes)));

    const installer = new SshSidecarArtifactInstaller({
      serviceScope, configuration,
      host: "remote-builder",
      artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      sshExecutable: "/usr/bin/ssh",
      spawnProcess: captureSpawn(calls, child, () => {
        child.stdout.end(installationProofLine(artifact.artifactSha256));
        complete(child, 0);
      }),
    });

    await expect(
      installer.install(new AbortController().signal),
    ).resolves.toMatchObject({
      executableDirectory: `/home/test/.local/state/sedes/sidecar/artifacts/sha256/${artifact.artifactSha256}`,
      executablePath: `/home/test/.local/state/sedes/sidecar/artifacts/sha256/${artifact.artifactSha256}/sedes`,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.arguments).toContain("-G");
    expect(calls[1]?.executable).toBe("/usr/bin/ssh");
    expect(calls[1]?.arguments).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "ForwardAgent=no",
        "ClearAllForwardings=yes",
        "SendEnv=-*",
        "ControlMaster=no",
        "RequestTTY=no",
        "remote-builder",
      ]),
    );
    expect(calls[1]?.arguments).not.toContain("-N");
    expect(calls[1]?.arguments.at(-1)).toContain("exec node -e");
    expect(calls[1]?.arguments.at(-1)).toContain(artifact.artifactSha256);
    expect(calls[1]?.arguments.at(-1)).toContain(artifact.buildId);
    expect(Buffer.concat(child.received)).toHaveLength(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("uploads the verified bundle and attaches with exact management and runtime identity", async () => {
    const bundle = Buffer.from("bundle requiring installation");
    const artifact = await artifactFixture(bundle);
    const calls: SpawnCall[] = [];
    const installChild = fakeChild();
    installChild.stdin.on("data", (bytes) =>
      installChild.received.push(Buffer.from(bytes)),
    );
    installChild.stdin.on("finish", () => {
      installChild.stdout.end(installationProofLine(artifact.artifactSha256));
      complete(installChild, 0);
    });
    const statusChild = fakeChild();
    statusChild.stdin.on("finish", () => complete(statusChild, 0));
    const launchChild = fakeChild();
    launchChild.stdin.on("finish", () => complete(launchChild, 0));
    const status: SidecarServiceStatus = {
      scope: serviceScope, serviceIncarnation: "service-1",
      buildId: artifact.buildId, artifactSha256: artifact.artifactSha256,
      runtimeWireVersion: SIDECAR_WIRE_VERSION, controllerEpoch: 1,
      attached: true, attachmentMode: "normal", state: "ready",
      desiredConfiguration: configuration, effectiveConfiguration: configuration,
      configurationState: "applied", resources: [], resourcesFingerprint: "b".repeat(64),
    };
    const requests: SidecarManagementRequest[] = [];
    for (const child of [statusChild, launchChild]) {
      let input = "";
      child.stdin.on("data", (bytes: Buffer) => {
        input += bytes.toString("utf8");
        if (!input.includes("\n")) return;
        const request = sidecarManagementRequestSchema.parse(JSON.parse(input));
        requests.push(request);
        child.stdout.write(`${JSON.stringify({
          managementVersion: 1, requestId: request.requestId,
          ...(child === statusChild ? { outcome: "absent" } : { outcome: "ok", status }),
        })}\n`);
      });
    }
    const children = [installChild, statusChild, launchChild];
    let effectiveConfigurationChecks = 0;

    const installer = new SshSidecarArtifactInstaller({
      serviceScope, configuration,
      host: "srv",
      artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess: effectiveConfigAware(
        (executable, arguments_) => {
          const child = children.shift();
          if (!child) throw new Error("unexpected_spawn");
          calls.push({ executable, arguments: [...arguments_] });
          queueMicrotask(() => {
            child.emit("spawn");
            if (child === installChild) {
              setTimeout(() => child.stdout.write("send\n"), 0);
            }
          });
          return child as unknown as ChildProcess;
        },
        () => {
          effectiveConfigurationChecks += 1;
        },
      ),
    });

    await installer.install(new AbortController().signal);
    expect(Buffer.concat(installChild.received)).toEqual(bundle);

    const nonce = "a_secure_session_nonce_0123456789abcdef";
    const stream = await installer.launch(
      7,
      nonce,
      new AbortController().signal,
    );
    expect(effectiveConfigurationChecks).toBe(3);
    expect(requests).toEqual([
      { managementVersion: 1, requestId: expect.any(String), scope: serviceScope, operation: "status" },
      {
        managementVersion: 1, requestId: expect.any(String), scope: serviceScope,
        operation: "attach", expectedBuildId: artifact.buildId,
        expectedArtifactSha256: artifact.artifactSha256,
        runtimeWireVersion: SIDECAR_WIRE_VERSION, sessionNonce: nonce,
        carrierGeneration: 7, configuration, mode: "normal",
      },
    ]);
    expect(stream.serviceStatus).toEqual(status);
    const launchCommand = calls[2]?.arguments.at(-1);
    expect(calls[2]?.arguments).not.toContain("-N");
    expect(launchCommand).toContain("exec '/usr/bin/env' -i");
    expect(launchCommand).toContain("'HOME=/home/test'");
    expect(launchCommand).toContain("'/usr/bin/node'");
    expect(launchCommand).toContain("service connect");
    expect(launchCommand).toContain(
      `/home/test/.local/state/sedes/sidecar/artifacts/sha256/${artifact.artifactSha256}/sedes`,
    );
    expect(launchCommand).toContain(artifact.artifactSha256);
    expect(launchCommand).toContain(artifact.buildId);
    expect(launchCommand).toContain(`--service-scope '${Buffer.from(JSON.stringify(serviceScope)).toString("base64url")}'`);
    expect(launchCommand).toContain(`--configuration '${Buffer.from(JSON.stringify(configuration)).toString("base64url")}'`);
    expect(launchCommand).toContain(
      `--agent-tool-endpoint-key '${AGENT_TOOL_ENDPOINT_KEY}'`,
    );
    await stream.close("test_complete");
    await expect(stream.closed).resolves.toMatchObject({
      reason: "ssh_sidecar_exited",
    });
  });

  it("uses an older service's exact artifact in its recovery request without starting it", async () => {
    const artifact = await artifactFixture(Buffer.from("new bundle"));
    const child = fakeChild();
    const installChild = fakeChild();
    const children = [installChild, child];
    child.stdin.on("finish", () => complete(child, 0));
    const status: SidecarServiceStatus = { scope: serviceScope, serviceIncarnation: "old-service", buildId: "old-build", artifactSha256: "c".repeat(64),
      runtimeWireVersion: SIDECAR_WIRE_VERSION, controllerEpoch: 1, attached: true, attachmentMode: "recovery", state: "ready",
      desiredConfiguration: configuration, effectiveConfiguration: configuration, configurationState: "applied", resources: [], resourcesFingerprint: "b".repeat(64) };
    const requests: SidecarManagementRequest[] = [];
    child.stdin.on("data", (bytes: Buffer) => {
      const request = sidecarManagementRequestSchema.parse(JSON.parse(bytes.toString("utf8")));
      requests.push(request);
      child.stdout.write(`${JSON.stringify({ managementVersion: 1, requestId: request.requestId, outcome: "ok", status })}\n`);
    });
    const installer = new SshSidecarArtifactInstaller({ serviceScope, configuration, host: "srv", artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY, spawnProcess: effectiveConfigAware(() => {
        const process = children.shift();
        if (!process) throw new Error("unexpected_spawn");
        queueMicrotask(() => {
          process.emit("spawn");
          if (process === installChild) setTimeout(() => {
            installChild.stdout.end(installationProofLine(artifact.artifactSha256));
            complete(installChild, 0);
          }, 0);
        });
        return process as unknown as ChildProcess;
      }) });
    await installer.install(AbortSignal.timeout(2000));
    vi.spyOn(installer, "inspect").mockResolvedValue(status);
    const stream = await installer.attachExisting(1, "n".repeat(48), AbortSignal.timeout(2000));
    expect(requests).toEqual([expect.objectContaining({ operation: "attach", mode: "recovery", expectedBuildId: "old-build", expectedArtifactSha256: "c".repeat(64) })]);
    expect(stream.serviceStatus).toEqual(status);
    expect(stream.installation.executablePath).toBe(`/home/test/.local/state/sedes/sidecar/artifacts/sha256/${status.artifactSha256}/sedes`);
    await stream.close("test_complete");
  });

  it("attaches normally to a busy outdated predecessor using that service's exact identity", async () => {
    const artifact = await artifactFixture(Buffer.from("new bundle"));
    const installChild = fakeChild();
    const launchChild = fakeChild();
    launchChild.stdin.on("finish", () => complete(launchChild, 0));
    const status: SidecarServiceStatus = {
      scope: serviceScope, serviceIncarnation: "old-service", buildId: "old-build", artifactSha256: "c".repeat(64),
      runtimeWireVersion: SIDECAR_WIRE_VERSION, controllerEpoch: 1, attached: false, attachmentMode: "normal", state: "ready",
      desiredConfiguration: configuration, effectiveConfiguration: configuration, configurationState: "applied",
      resources: [{ resourceId: "terminal", kind: "terminal", state: "active", revision: "1", blockers: ["live_terminal"] }],
      resourcesFingerprint: "b".repeat(64),
    };
    const requests: SidecarManagementRequest[] = [];
    launchChild.stdin.on("data", (bytes: Buffer) => {
      const request = sidecarManagementRequestSchema.parse(JSON.parse(bytes.toString("utf8")));
      requests.push(request);
      launchChild.stdout.write(`${JSON.stringify({ managementVersion: 1, requestId: request.requestId, outcome: "ok", status })}\n`);
    });
    const children = [installChild, launchChild];
    const installer = new SshSidecarArtifactInstaller({ serviceScope, configuration, host: "srv", artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY, spawnProcess: effectiveConfigAware(() => {
        const child = children.shift();
        if (!child) throw new Error("unexpected_spawn");
        queueMicrotask(() => {
          child.emit("spawn");
          if (child === installChild) {
            setTimeout(() => { installChild.stdout.end(installationProofLine(artifact.artifactSha256)); complete(installChild, 0); }, 0);
          }
        });
        return child as unknown as ChildProcess;
      }) });
    await installer.install(new AbortController().signal);
    vi.spyOn(installer, "inspect").mockResolvedValue(status);
    const control = vi.spyOn(installer, "control");
    const stream = await installer.launch(1, "n".repeat(48), AbortSignal.timeout(2000));
    expect(control).not.toHaveBeenCalled();
    expect(requests).toEqual([expect.objectContaining({
      operation: "attach", mode: "normal", expectedBuildId: "old-build", expectedArtifactSha256: "c".repeat(64),
      runtimeWireVersion: SIDECAR_WIRE_VERSION,
    })]);
    expect(stream.serviceStatus).toEqual(status);
    await stream.close("test_complete");
  });

  it("attaches with the new artifact's identity when no service exists", async () => {
    const artifact = await artifactFixture(Buffer.from("new bundle"));
    const installChild = fakeChild();
    const launchChild = fakeChild();
    launchChild.stdin.on("finish", () => complete(launchChild, 0));
    const status: SidecarServiceStatus = {
      scope: serviceScope, serviceIncarnation: "service-1", buildId: artifact.buildId, artifactSha256: artifact.artifactSha256,
      runtimeWireVersion: SIDECAR_WIRE_VERSION, controllerEpoch: 1, attached: true, attachmentMode: "normal", state: "ready",
      desiredConfiguration: configuration, effectiveConfiguration: configuration, configurationState: "applied",
      resources: [], resourcesFingerprint: "b".repeat(64),
    };
    const requests: SidecarManagementRequest[] = [];
    launchChild.stdin.on("data", (bytes: Buffer) => {
      const request = sidecarManagementRequestSchema.parse(JSON.parse(bytes.toString("utf8")));
      requests.push(request);
      launchChild.stdout.write(`${JSON.stringify({ managementVersion: 1, requestId: request.requestId, outcome: "ok", status })}\n`);
    });
    const children = [installChild, launchChild];
    const installer = new SshSidecarArtifactInstaller({ serviceScope, configuration, host: "srv", artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY, spawnProcess: effectiveConfigAware(() => {
        const child = children.shift();
        if (!child) throw new Error("unexpected_spawn");
        queueMicrotask(() => {
          child.emit("spawn");
          if (child === installChild) {
            setTimeout(() => { installChild.stdout.end(installationProofLine(artifact.artifactSha256)); complete(installChild, 0); }, 0);
          }
        });
        return child as unknown as ChildProcess;
      }) });
    await installer.install(new AbortController().signal);
    vi.spyOn(installer, "inspect").mockResolvedValue(undefined);
    const stream = await installer.launch(1, "n".repeat(48), AbortSignal.timeout(2000));
    expect(requests).toEqual([expect.objectContaining({
      operation: "attach", mode: "normal", expectedBuildId: artifact.buildId, expectedArtifactSha256: artifact.artifactSha256,
    })]);
    expect(stream.serviceStatus).toEqual(status);
    await stream.close("test_complete");
  });

  it("does not mint failed controls for an already blocked automatic upgrade", async () => {
    const artifact = await artifactFixture(Buffer.from("new bundle"));
    const installer = new SshSidecarArtifactInstaller({ serviceScope, configuration, host: "srv", artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY, spawnProcess: vi.fn() });
    vi.spyOn(installer, "inspect").mockResolvedValue({
      scope: serviceScope, serviceIncarnation: "old-service", buildId: "old-build", artifactSha256: "c".repeat(64),
      runtimeWireVersion: SIDECAR_WIRE_VERSION, controllerEpoch: 1, attached: false, attachmentMode: "normal", state: "ready",
      desiredConfiguration: configuration, effectiveConfiguration: configuration, configurationState: "applied",
      resources: [{ resourceId: "terminal", kind: "terminal", state: "active", revision: "1", blockers: ["live_terminal"] }],
      resourcesFingerprint: "b".repeat(64),
    });
    const control = vi.spyOn(installer, "control");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // A compatible outdated service keeps serving: launch proceeds straight to
      // attachment (which here fails only because nothing was installed).
      await expect(installer.launch(1, "n".repeat(48), AbortSignal.timeout(2000))).rejects.toThrow("sidecar_artifact_not_installed");
    }
    expect(control).not.toHaveBeenCalled();
  });

  it.each([8, SIDECAR_WIRE_VERSION + 1])("refuses wire v%s that still owns work without minting controls", async runtimeWireVersion => {
    const artifact = await artifactFixture(Buffer.from("new bundle"));
    const installer = new SshSidecarArtifactInstaller({ serviceScope, configuration, host: "srv", artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY, spawnProcess: vi.fn() });
    vi.spyOn(installer, "inspect").mockResolvedValue({
      scope: serviceScope, serviceIncarnation: "old-service", buildId: "old-build", artifactSha256: "c".repeat(64),
      runtimeWireVersion, controllerEpoch: 1, attached: false, attachmentMode: "normal", state: "ready",
      desiredConfiguration: configuration, effectiveConfiguration: configuration, configurationState: "applied",
      resources: [{ resourceId: "terminal", kind: "terminal", state: "active", revision: "1", blockers: ["live_terminal"] }],
      resourcesFingerprint: "b".repeat(64),
    });
    const control = vi.spyOn(installer, "control");
    await expect(installer.launch(1, "n".repeat(48), AbortSignal.timeout(2000))).rejects.toThrow("sidecar_runtime_upgrade_required");
    expect(control).not.toHaveBeenCalled();
  });

  it("retains verified installation proof while a concurrent install fails", async () => {
    const artifact = await artifactFixture(Buffer.from("bundle"));
    const installChild = fakeChild();
    const installer = new SshSidecarArtifactInstaller({ serviceScope, configuration, host: "srv", artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY, spawnProcess: captureSpawn([], installChild, () => {
        installChild.stdout.end(installationProofLine(artifact.artifactSha256)); complete(installChild, 0);
      }) });
    await installer.install(AbortSignal.timeout(2000));
    await chmod(artifact.executablePath, 0o600);
    await writeFile(artifact.executablePath, "changed");
    await expect(installer.install(AbortSignal.timeout(2000))).rejects.toThrow(/sidecar_artifact_/u);
    vi.spyOn(installer, "inspect").mockResolvedValue(undefined);
    // Launch reaches SSH validation using its existing installation proof.
    const controller = new AbortController(); controller.abort(new Error("test_aborted"));
    await expect(installer.launch(1, "n".repeat(48), controller.signal)).rejects.not.toThrow("sidecar_artifact_not_installed");
  });

  it("rejects a changed local artifact before spawning ssh", async () => {
    const artifact = await artifactFixture(Buffer.from("original"));
    await chmod(artifact.executablePath, 0o600);
    await writeFile(artifact.executablePath, "modified");
    const spawnProcess = vi.fn();
    const installer = new SshSidecarArtifactInstaller({
      serviceScope, configuration,
      host: "srv",
      artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess,
    });

    await expect(
      installer.install(new AbortController().signal),
    ).rejects.toThrow(/sidecar_artifact_(file_invalid|digest_mismatch)/u);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects an unproved remote executable path", async () => {
    const artifact = await artifactFixture(Buffer.from("bundle"));
    const child = fakeChild();
    const installer = new SshSidecarArtifactInstaller({
      serviceScope, configuration,
      host: "srv",
      artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess: captureSpawn([], child, () => {
        child.stdout.end(
          `ready ${JSON.stringify({
            executableDirectory: "/remote/artifact",
            executablePath: "/remote/other/harness",
          })}\n`,
        );
        complete(child, 0);
      }),
    });

    await expect(
      installer.install(new AbortController().signal),
    ).rejects.toThrow("sidecar_install_response_invalid");
  });

  it("does not launch before installation returns executable proof", async () => {
    const installer = new SshSidecarArtifactInstaller({
      serviceScope, configuration,
      host: "srv",
      artifact: await artifactFixture(Buffer.from("bundle")),
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess: vi.fn(),
    });
    vi.spyOn(installer, "inspect").mockResolvedValue(undefined);

    await expect(
      installer.launch(
        1,
        "a_secure_session_nonce_0123456789abcdef",
        new AbortController().signal,
      ),
    ).rejects.toThrow("sidecar_artifact_not_installed");
  });

  it("fails closed and cleans up when bootstrap stdio ends without a response", async () => {
    const artifact = await artifactFixture(Buffer.from("bundle"));
    const child = fakeChild();
    const installer = new SshSidecarArtifactInstaller({
      serviceScope, configuration,
      host: "srv",
      artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess: captureSpawn([], child, () => {
        child.stderr.write("bounded diagnostic");
        child.stdout.end();
      }),
    });

    await expect(
      installer.install(new AbortController().signal),
    ).rejects.toThrow("sidecar_install_output_incomplete");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects a remote Node release below the exact sidecar floor", async () => {
    const bundle = Buffer.from("bundle");
    const artifact = await artifactFixture(bundle);
    const home = await mkdtemp(path.join(tmpdir(), "sedes-sidecar-home-"));
    temporaryDirectories.push(home);

    await expect(
      runRealBootstrap(home, artifact, bundle, {
        reportedNodeVersion: "22.18.9",
      }),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "sidecar_node_version_unsupported",
    });
  });

  it("admits a foreign-owned launcher chain in a rootless container", async () => {
    const bundle = Buffer.from("rootless-compatible bundle");
    const artifact = await artifactFixture(bundle);
    const home = await mkdtemp(path.join(tmpdir(), "sedes-sidecar-home-"));
    temporaryDirectories.push(home);
    const launcherPath = await realpath("/usr/bin/env");
    const foreignUid = effectiveUid() === 65_534 ? 65_533 : 65_534;

    const result = await runRealBootstrap(home, artifact, bundle, {
      metadataOverrides: Object.fromEntries(
        launcherChain(launcherPath).map((entry) => [
          entry,
          { uid: foreignUid },
        ]),
      ),
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("send\nready ");
  });

  it.each([
    ["launcher", (launcherPath: string) => launcherPath],
    ["launcher parent", (launcherPath: string) => path.dirname(launcherPath)],
  ])(
    "rejects a %s owned by the SSH account even when it is not writable by mode",
    async (_label, selectedPath) => {
      const bundle = Buffer.from("account-owned launcher bundle");
      const artifact = await artifactFixture(bundle);
      const home = await mkdtemp(path.join(tmpdir(), "sedes-sidecar-home-"));
      temporaryDirectories.push(home);
      const launcherPath = await realpath("/usr/bin/env");

      await expect(
        runRealBootstrap(home, artifact, bundle, {
          metadataOverrides: {
            [selectedPath(launcherPath)]: {
              uid: effectiveUid(),
              mode: 0o555,
            },
          },
        }),
      ).resolves.toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "sidecar_launcher_env_invalid",
      });
    },
  );

  it.each([
    ["group-writable launcher", (launcherPath: string) => launcherPath, 0o575],
    [
      "world-writable launcher parent",
      (launcherPath: string) => path.dirname(launcherPath),
      0o557,
    ],
  ])("rejects a %s", async (_label, selectedPath, mode) => {
    const bundle = Buffer.from("writable launcher bundle");
    const artifact = await artifactFixture(bundle);
    const home = await mkdtemp(path.join(tmpdir(), "sedes-sidecar-home-"));
    temporaryDirectories.push(home);
    const launcherPath = await realpath("/usr/bin/env");

    await expect(
      runRealBootstrap(home, artifact, bundle, {
        metadataOverrides: {
          [selectedPath(launcherPath)]: { mode },
        },
      }),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "sidecar_launcher_env_invalid",
    });
  });

  it("rejects a symlink in the resolved launcher parent chain", async () => {
    const bundle = Buffer.from("symlinked launcher bundle");
    const artifact = await artifactFixture(bundle);
    const home = await mkdtemp(path.join(tmpdir(), "sedes-sidecar-home-"));
    temporaryDirectories.push(home);
    const launcherPath = await realpath("/usr/bin/env");

    await expect(
      runRealBootstrap(home, artifact, bundle, {
        metadataOverrides: {
          [path.dirname(launcherPath)]: { isSymbolicLink: true },
        },
      }),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "sidecar_launcher_env_invalid",
    });
  });

  it("preserves proof failure when a bootstrap child survives cleanup", async () => {
    const artifact = await artifactFixture(Buffer.from("bundle"));
    const child = fakeChild();
    child.kill.mockImplementation(() => true);
    const installer = new SshSidecarArtifactInstaller({
      serviceScope, configuration,
      host: "srv",
      artifact,
      agentToolEndpointKey: AGENT_TOOL_ENDPOINT_KEY,
      spawnProcess: captureSpawn([], child, () => {
        child.stdout.end("invalid\n");
      }),
    });

    await expect(
      installer.install(new AbortController().signal),
    ).rejects.toMatchObject({
      name: SshSidecarArtifactCleanupError.name,
      cause: { diagnosticCode: "ssh_child_survived_cleanup" },
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  }, 10_000);

  it("atomically repairs an incomplete digest target left by a prior crash", async () => {
    const bundle = Buffer.from("complete atomic bundle");
    const artifact = await artifactFixture(bundle);
    const home = await mkdtemp(path.join(tmpdir(), "sedes-sidecar-home-"));
    temporaryDirectories.push(home);
    const target = path.join(
      home,
      "/.local/state/sedes/sidecar/artifacts/sha256",
      artifact.artifactSha256,
    );
    await mkdir(target, { recursive: true, mode: 0o700 });
    await chmod(target, 0o700);
    const incompleteBundle = path.join(target, "sedes");
    await writeFile(incompleteBundle, bundle, { mode: 0o500 });
    await chmod(incompleteBundle, 0o500);

    const result = await runRealBootstrap(home, artifact, bundle);

    expect(result).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("send\nready ");
    expect(result.stdout).toContain(JSON.stringify(home));
    expect(result.stdout).toContain(JSON.stringify(target));
    await expect(readFile(path.join(target, "sedes"))).resolves.toEqual(bundle);
    await expect(readFile(path.join(target, "build-id"), "utf8")).resolves.toBe(
      artifact.buildId,
    );
  });

  it("securely revalidates namespace directories created by a concurrent installer", async () => {
    const bundle = Buffer.from("concurrently installed bundle");
    const artifact = await artifactFixture(bundle);
    const home = await mkdtemp(path.join(tmpdir(), "sedes-sidecar-home-"));
    temporaryDirectories.push(home);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => runRealBootstrap(home, artifact, bundle)),
    );

    expect(results.every((result) => result.exitCode === 0)).toBe(true);
    expect(results.every((result) => result.stderr === "")).toBe(true);
    await expect(
      readFile(
        path.join(
          home,
          "/.local/state/sedes/sidecar/artifacts/sha256",
          artifact.artifactSha256,
          "sedes",
        ),
      ),
    ).resolves.toEqual(bundle);
  });

  it("preserves and rejects existing digest and build integrity violations", async () => {
    const bundle = Buffer.from("trusted bundle");
    const artifact = await artifactFixture(bundle);
    const digestHome = await mkdtemp(
      path.join(tmpdir(), "sedes-sidecar-home-"),
    );
    const buildHome = await mkdtemp(path.join(tmpdir(), "sedes-sidecar-home-"));
    temporaryDirectories.push(digestHome, buildHome);

    const digestTarget = await existingTarget(digestHome, artifact);
    await writeFile(path.join(digestTarget, "sedes"), "tampered", {
      mode: 0o500,
    });
    await chmod(path.join(digestTarget, "sedes"), 0o500);
    await writeFile(path.join(digestTarget, "build-id"), artifact.buildId, {
      mode: 0o400,
    });
    await chmod(path.join(digestTarget, "build-id"), 0o400);
    const digestResult = await runRealBootstrap(digestHome, artifact, bundle);
    expect(digestResult).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "sidecar_install_digest_mismatch",
    });
    await expect(
      readFile(path.join(digestTarget, "sedes"), "utf8"),
    ).resolves.toBe("tampered");

    const buildTarget = await existingTarget(buildHome, artifact);
    await writeFile(path.join(buildTarget, "sedes"), bundle, {
      mode: 0o500,
    });
    await chmod(path.join(buildTarget, "sedes"), 0o500);
    await writeFile(path.join(buildTarget, "build-id"), "other-build", {
      mode: 0o400,
    });
    await chmod(path.join(buildTarget, "build-id"), 0o400);
    const buildResult = await runRealBootstrap(buildHome, artifact, bundle);
    expect(buildResult).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "sidecar_install_build_mismatch",
    });
    await expect(
      readFile(path.join(buildTarget, "build-id"), "utf8"),
    ).resolves.toBe("other-build");
  });
});

interface SpawnCall {
  readonly executable: string;
  readonly arguments: string[];
}

function captureSpawn(
  calls: SpawnCall[],
  child: FakeChild,
  afterSpawn: () => void,
) {
  return (executable: string, arguments_: readonly string[]) => {
    calls.push({ executable, arguments: [...arguments_] });
    if (arguments_.includes("-G")) {
      return effectiveConfigurationChild() as unknown as ChildProcess;
    }
    queueMicrotask(() => {
      child.emit("spawn");
      setTimeout(afterSpawn, 0);
    });
    return child as unknown as ChildProcess;
  };
}

function effectiveConfigAware(
  delegate: (executable: string, arguments_: readonly string[]) => ChildProcess,
  onEffectiveConfiguration?: () => void,
) {
  return (executable: string, arguments_: readonly string[]) => {
    if (arguments_.includes("-G")) {
      onEffectiveConfiguration?.();
      return effectiveConfigurationChild() as unknown as ChildProcess;
    }
    return delegate(executable, arguments_);
  };
}

function effectiveConfigurationChild() {
  const child = fakeChild();
  queueMicrotask(() => {
    child.emit("spawn");
    child.stdout.end("clearallforwardings yes\nforwardagent no\n");
    complete(child, 0);
    child.emit("close", 0, null);
  });
  return child;
}

type FakeChild = ReturnType<typeof fakeChild>;

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    received: [] as Buffer[],
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.signalCode = signal;
        queueMicrotask(() => child.emit("exit", null, signal));
      }
      return true;
    }),
  });
  return child;
}

function complete(child: FakeChild, exitCode: number): void {
  child.exitCode = exitCode;
  child.stdout.end();
  child.stderr.end();
  child.emit("exit", exitCode, null);
}

function installationProofLine(
  artifactSha256: string,
  accountHome = "/home/test",
  nodeExecutable = "/usr/bin/node",
): string {
  const executableDirectory = path.posix.join(
    accountHome,
    "/.local/state/sedes/sidecar/artifacts/sha256",
    artifactSha256,
  );
  return `ready ${JSON.stringify({
    accountHome,
    nodeExecutable,
    envExecutable: "/usr/bin/env",
    stateRoot: path.posix.join(accountHome, "/.local/state/sedes/sidecar"),
    environment: {
      HOME: accountHome,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
    },
    executableDirectory,
    executablePath: path.posix.join(executableDirectory, "sedes"),
  })}\n`;
}

async function artifactFixture(
  bytes: Buffer,
): Promise<SidecarArtifactRegistration> {
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-sidecar-"));
  temporaryDirectories.push(directory);
  const executablePath = path.join(directory, "sedes");
  await writeFile(executablePath, bytes);
  await chmod(executablePath, 0o500);
  return Object.freeze({
    artifactId: SIDECAR_ARTIFACT_ID,
    modes: SIDECAR_ARTIFACT_MODES,
    executableDirectory: directory,
    executablePath,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    artifactBytes: bytes.byteLength,
    buildId: "test-build",
    minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION,
    nativeAssets: [],
  });
}

async function existingTarget(
  home: string,
  artifact: SidecarArtifactRegistration,
): Promise<string> {
  const target = path.join(
    home,
    "/.local/state/sedes/sidecar/artifacts/sha256",
    artifact.artifactSha256,
  );
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  return target;
}

async function runRealBootstrap(
  home: string,
  artifact: SidecarArtifactRegistration,
  bytes: Buffer,
  options: BootstrapOverrideOptions = {},
): Promise<{
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const launcherPath = await realpath("/usr/bin/env");
  const foreignUid = effectiveUid() === 65_534 ? 65_533 : 65_534;
  const resolvedOptions: BootstrapOverrideOptions = {
    ...options,
    metadataOverrides: {
      ...Object.fromEntries(
        launcherChain(launcherPath).map((entry) => [
          entry,
          { uid: foreignUid },
        ]),
      ),
      ...options.metadataOverrides,
    },
  };
  const child = spawn(
    process.execPath,
    [
      "-e",
      REMOTE_BOOTSTRAP_SOURCE,
      artifact.artifactSha256,
      artifact.buildId,
      String(artifact.artifactBytes),
      Buffer.from(JSON.stringify(artifact.nativeAssets)).toString("base64url"),
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        NODE_OPTIONS: bootstrapOverrides(home, resolvedOptions),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let sent = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(Buffer.from(chunk));
    if (!sent && Buffer.concat(stdout).toString("utf8").includes("send\n")) {
      sent = true;
      child.stdin.end(bytes);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

interface BootstrapMetadataOverride {
  readonly uid?: number;
  readonly mode?: number;
  readonly isFile?: boolean;
  readonly isDirectory?: boolean;
  readonly isSymbolicLink?: boolean;
}

interface BootstrapOverrideOptions {
  readonly reportedNodeVersion?: string;
  readonly metadataOverrides?: Readonly<
    Record<string, BootstrapMetadataOverride>
  >;
}

function launcherChain(launcherPath: string): readonly string[] {
  const entries = [launcherPath];
  for (
    let current = path.dirname(launcherPath);
    ;
    current = path.dirname(current)
  ) {
    entries.push(current);
    if (current === path.parse(current).root) break;
  }
  return entries;
}

function effectiveUid(): number {
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error("effective_uid_unavailable");
  return uid;
}

function bootstrapOverrides(
  home: string,
  options: BootstrapOverrideOptions,
): string {
  const source = [
    `const os=await import("node:os")`,
    `os.default.userInfo=()=>({uid:process.getuid(),gid:process.getgid(),username:"test",homedir:${JSON.stringify(home)},shell:"/bin/bash"})`,
    ...(options.reportedNodeVersion
      ? [
          `Object.defineProperty(process.versions,"node",{value:${JSON.stringify(options.reportedNodeVersion)}})`,
        ]
      : []),
    ...(options.metadataOverrides
      ? [
          `const fs=await import("node:fs")`,
          `const originalLstat=fs.default.promises.lstat.bind(fs.default.promises)`,
          `const metadataOverrides=${JSON.stringify(options.metadataOverrides)}`,
          `fs.default.promises.lstat=async value=>{const stats=await originalLstat(value);const override=metadataOverrides[String(value)];if(!override)return stats;if(override.uid!==undefined)stats.uid=override.uid;if(override.mode!==undefined)stats.mode=(stats.mode&~0o777)|override.mode;if(override.isFile!==undefined)stats.isFile=()=>override.isFile;if(override.isDirectory!==undefined)stats.isDirectory=()=>override.isDirectory;if(override.isSymbolicLink!==undefined)stats.isSymbolicLink=()=>override.isSymbolicLink;return stats}`,
        ]
      : []),
  ].join(";");
  return `--import=data:text/javascript,${encodeURIComponent(source)}`;
}
