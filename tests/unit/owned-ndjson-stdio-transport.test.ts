import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { isValidFramedTransportAssurance } from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import { OwnedNdjsonStdioTransportFactory } from "../../src/server/provider-protocol/transport/owned-ndjson-stdio-transport.js";

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const fixture = path.join(
  repositoryRoot,
  "tests/fixtures/provider-protocol/owned-ndjson-stdio-child.mjs",
);
const topLevelCleanupFixture = path.join(
  repositoryRoot,
  "tests/fixtures/provider-protocol/owned-ndjson-top-level-cleanup.ts",
);
const execFileAsync = promisify(execFile);
const scope = Object.freeze({
  tenantId: "tenant-provider-transport",
  principalId: "principal-provider-transport",
  backendInstanceId: "backend-provider-transport",
  executionEnvironmentId: "environment-provider-transport",
});

describe("owned NDJSON stdio transport diagnostics", () => {
  it("continuously drains stderr while retaining only bounded redacted text", async () => {
    const transport = await openRedactionFixture("stderr", {
      limits: { maximumStderrTailBytes: 80 },
      environment: {
        CODEX_STDIO_FIXTURE_SECRET: "secret-one",
        CODEX_STDIO_FIXTURE_BEARER: "secret-two",
        CODEX_HOME: "/private/codex-home",
      },
    });
    let diagnostics = transport.diagnostics();
    for (let attempt = 0; diagnostics.stderrBytesRead === 0; attempt += 1) {
      if (attempt === 100) throw new Error("fixture_stderr_not_observed");
      await new Promise((resolve) => setTimeout(resolve, 10));
      diagnostics = transport.diagnostics();
    }
    expect(diagnostics.stderrBytesRead).toBeGreaterThan(0);
    expect(diagnostics.stderrTailBytes).toBeLessThanOrEqual(80);
    expect(diagnostics.stderrTail).not.toContain("secret-one");
    expect(diagnostics.stderrTail).not.toContain("secret-two");
    expect(diagnostics.stderrTail).not.toContain("/private/codex-home");
    expect(diagnostics.stderrTail).toContain("[REDACTED]");
    await transport.close("test_complete");
  });

  it("redacts configured and patterned secrets split across stderr chunks", async () => {
    const transport = await openRedactionFixture("stderr_split", {
      limits: { maximumStderrTailBytes: 512 },
    });
    for (
      let attempt = 0;
      !transport.diagnostics().stderrTail.includes("[REDACTED]");
      attempt += 1
    ) {
      if (attempt === 100) throw new Error("fixture_stderr_not_observed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const diagnostics = transport.diagnostics();
    expect(diagnostics.stderrTail).not.toContain("secret-one");
    expect(diagnostics.stderrTail).not.toContain("secret-two");
    expect(diagnostics.stderrTail).not.toContain("/private/codex-home");
    expect(diagnostics.stderrTail).toContain("authorization=[REDACTED]");
    expect(diagnostics.stderrTail).toContain("Bearer [REDACTED]");
    await transport.close("test_complete");
  });


  it.each([
    "windows_job_open_cleanup_unconfirmed",
    "windows_job_cleanup_unconfirmed",
    "windows_job_close_deadline_exceeded",
  ])("preserves the native-store ownership gate after %s", async (message) => {
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: scope.executionEnvironmentId,
    });
    const prepared = await channels.prepareOwnedProcess(scope, {
      executablePath: process.execPath,
      workingDirectory: repositoryRoot,
    });
    const failure = new Error(message);
    vi.spyOn(channels, "openOwnedProcess").mockRejectedValueOnce(failure);
    const factory = new OwnedNdjsonStdioTransportFactory({
      scope,
      channels,
      process: prepared,
      environment: {},
      commandArguments: [],
      assuranceDiagnosticPrefix: "provider_test_assurance",
      transportDiagnosticPrefix: "provider_test_stdio",
    });
    const lifecycle = {
      launchStarted: vi.fn(),
      cleanupProven: vi.fn(),
      cleanupFailed: vi.fn(),
    };
    await expect(
      factory.open(scope, 1, new AbortController().signal, lifecycle),
    ).rejects.toBe(failure);
    expect(lifecycle.launchStarted).toHaveBeenCalledOnce();
    expect(lifecycle.cleanupFailed).toHaveBeenCalledWith(failure);
    expect(lifecycle.cleanupProven).not.toHaveBeenCalled();
  });

  it("counts partial non-newline stdout monotonically without exposing content", async () => {
    const transport = await openFixture("partial");
    await waitFor(() => transport.diagnostics().stdoutBytesRead > 0);
    const beforeClose = transport.diagnostics();

    expect(beforeClose.stdoutBytesRead).toBe(
      Buffer.byteLength("partial-without-newline"),
    );
    expect(Object.keys(beforeClose).sort()).toEqual([
      "inboundFramesRead",
      "outboundFramesAccepted",
      "outboundFramesWritten",
      "processExitDisposition",
      "stderrBytesRead",
      "stderrTail",
      "stderrTailBytes",
      "stdoutBytesRead",
      "streamsDrained",
    ]);
    expect(JSON.stringify(beforeClose)).not.toContain(
      "partial-without-newline",
    );

    await transport.close("test_complete");
    await transport.closed;
    expect(transport.diagnostics().stdoutBytesRead).toBe(
      beforeClose.stdoutBytesRead,
    );
    expect(transport.diagnostics().streamsDrained).toBe(true);
    expect(transport.diagnostics().processExitDisposition).toBe("zero_exit");
    expect(isValidFramedTransportAssurance(transport.assurance)).toBe(false);
    expect(transport.diagnostics().processExitDisposition).toBe("zero_exit");
    expect(transport.diagnostics().streamsDrained).toBe(true);
  });

  it("counts complete frame bytes including the delimiter and preserves frame/close behavior", async () => {
    const transport = await openFixture("frame");
    const iterator = transport.frames[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      value: { text: '{"sequence":1}', byteLength: 14 },
      done: false,
    });
    expect(transport.diagnostics().stdoutBytesRead).toBe(
      Buffer.byteLength('{"sequence":1}\n'),
    );
    await transport.close("test_complete");
    await expect(transport.closed).resolves.toMatchObject({
      reason: "test_complete",
    });
    expect(isValidFramedTransportAssurance(transport.assurance)).toBe(false);
  });

  it("keeps a top-level controller alive until post-exit process-group cleanup settles", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "owned-ndjson-top-level-cleanup-"),
    );
    const markerPath = path.join(directory, "cleanup-settled");
    try {
      const { stderr } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", topLevelCleanupFixture, markerPath],
        {
          cwd: repositoryRoot,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          timeout: 5_000,
        },
      );
      expect(stderr).not.toContain("unsettled top-level await");
      await expect(readFile(markerPath, "utf8")).resolves.toBe(
        "cleanup-settled\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function openFixture(mode: "partial" | "frame") {
  const channels = new LocalEnvironmentChannelProvider({
    scope,
    executionEnvironmentId: scope.executionEnvironmentId,
  });
  const prepared = await channels.prepareOwnedProcess(scope, {
    executablePath: process.execPath,
    workingDirectory: repositoryRoot,
  });
  const factory = new OwnedNdjsonStdioTransportFactory({
    scope,
    channels,
    process: prepared,
    environment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PROVIDER_STDIO_FIXTURE_MODE: mode,
    },
    commandArguments: [fixture],
    assuranceDiagnosticPrefix: "provider_test_assurance",
    transportDiagnosticPrefix: "provider_test_stdio",
  });
  return await factory.open(scope, 1, new AbortController().signal);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("provider_transport_fixture_timeout");
}

async function openRedactionFixture(mode: string, input?: { limits?: { maximumStderrTailBytes: number }; environment?: Record<string, string> }) {
  const channels = new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: scope.executionEnvironmentId });
  const prepared = await channels.prepareOwnedProcess(scope, { executablePath: process.execPath, workingDirectory: repositoryRoot });
  const factory = new OwnedNdjsonStdioTransportFactory({ scope, channels, process: prepared,
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", CODEX_STDIO_FIXTURE_MODE: mode, ...input?.environment },
    commandArguments: [path.join(repositoryRoot, "tests/fixtures/codex-owned-stdio-child.mjs")],
    limits: input?.limits, sensitiveValues: ["secret-one", "secret-two", "/private/codex-home"],
    assuranceDiagnosticPrefix: "provider_test_assurance", transportDiagnosticPrefix: "provider_test_stdio",
  });
  return await factory.open(scope, 1, new AbortController().signal);
}
