import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AbsoluteDeadline,
  GrokOfflineTrancheFailure,
  runGrokOfflineTranche,
  serializeGrokOfflineCliFailure,
} from "../../scripts/grok-probes/run-grok-offline-tranche.js";
import { createHash } from "node:crypto";
import { readFile as readBinaryFile, stat } from "node:fs/promises";

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixture = path.join(
  rootDirectory,
  "tests/fixtures/grok-probes/offline-tranche-child.mjs",
);
const scope = Object.freeze({
  tenantId: "tenant-grok-offline",
  principalId: "principal-grok-offline",
  backendInstanceId: "backend-grok-offline",
  executionEnvironmentId: "environment-grok-offline",
});
const temporaryDirectories: string[] = [];
const itBubblewrap = it.runIf(process.platform === "linux");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Grok offline tranche orchestrator", () => {
  it("publishes one closed exact offline tranche command", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(rootDirectory, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["probe:grok-offline"]).toBe(
      "tsx scripts/grok-probes/run-grok-offline-tranche.ts",
    );
  });

  it("rejects exact-mode limit loosening before candidate verification", async () => {
    const outputPath = await output("exact-policy-override.json");
    await expect(
      runGrokOfflineTranche({
        tranche: "o1_no_initialize",
        scope,
        connectionGeneration: 1,
        outputPath,
        transportLimits: { maximumFrameBytes: 256 * 1024 * 1024 },
      }),
    ).rejects.toThrow("grok_probe_exact_policy_override_forbidden");
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itBubblewrap("runs O1 through bwrap with zero frames and installs only sanitized evidence", async () => {
    const outputPath = await output("o1.json");
    const result = await runGrokOfflineTranche(
      input("o1_no_initialize", "o1-quiet", outputPath),
    );
    const evidence = await evidenceAt(outputPath);

    expect(result).toMatchObject({ tranche: "o1_no_initialize", outputPath });
    expect(
      Object.keys(evidence.transport as Record<string, unknown>).sort(),
    ).toEqual([
      "assuranceKind",
      "assuranceRevoked",
      "inboundFramesRead",
      "outboundFramesAccepted",
      "outboundFramesWritten",
      "stderrBytesRead",
      "stdoutBytesRead",
      "streamsDrained",
    ]);
    expect(evidence).toMatchObject({
      tranche: "o1_no_initialize",
      protocolAdmission: {
        maximumOutboundFrames: 0,
        allowedMethods: [],
        authenticate: false,
        providerCapacity: false,
        filesystemCapability: false,
        terminalCapability: false,
      },
      observation: { quiet: true },
      operationDeadline: {
        disposition: "completed_within_absolute_deadline",
        coveredThrough: "sanitized_evidence_atomic_install",
        absoluteDeadlineMilliseconds: 3_000,
        quiescenceObservationMilliseconds: 250,
      },
      cleanup: {
        assuranceRevoked: true,
        sandboxTemporaryRootRemoved: true,
        stagedExecutableRemoved: true,
      },
      executableIdentity: {
        verifier: "fixture_callback",
        privateStagedArtifact: false,
        stagedMountedFileIdentityStable: false,
        fixtureMountedFileIdentityStable: true,
        mountIdentityMechanism: "fixture_verified_path",
        transportAssuranceSubject: "bubblewrap_carrier",
        productionGrokAssuranceClaimed: false,
      },
    });
  });

  itBubblewrap("runs exactly initialize in O2a, completes a bounded observation, and omits provider payloads", async () => {
    const outputPath = await output("o2a.json");
    await runGrokOfflineTranche(
      input("o2a_initialize_only", "o2a", outputPath),
    );
    const serialized = await readFile(outputPath, "utf8");
    const evidence = JSON.parse(serialized) as Record<string, unknown>;

    expect(evidence).toMatchObject({
      tranche: "o2a_initialize_only",
      protocolAdmission: {
        maximumOutboundFrames: 1,
        maximumInboundFrames: 2,
        allowedMethods: ["initialize"],
      },
      observation: {
        initializeCompleted: true,
        boundedObservationCompleted: true,
        boundedObservationMilliseconds: 250,
        ignoredNotifications: 0,
        ignoredNotificationBytes: 0,
      },
      operationDeadline: {
        disposition: "completed_within_absolute_deadline",
        coveredThrough: "sanitized_evidence_atomic_install",
        absoluteDeadlineMilliseconds: 3_000,
        boundedObservationMilliseconds: 250,
      },
      initialize: {
        protocolVersion: 1,
        agentInfoPresent: true,
        capabilities: {
          present: true,
          loadSession: true,
          promptCapabilities: {
            present: true,
            image: true,
            audio: false,
            embeddedContext: true,
          },
          mcp: { present: true, http: true, sse: false, acp: true },
          session: {
            present: true,
            list: true,
            fork: true,
            resume: true,
            close: true,
          },
          auth: { present: true, logout: true },
          providers: true,
          nes: false,
        },
        authentication: { methodCount: 2, kinds: ["agent", "env_var"] },
        metaKeys: {
          response: {
            encounteredKnownKeys: ["grokShell", "x.ai/pluginDirs"],
            unknownKeyCount: 1,
          },
          capabilities: {
            encounteredKnownKeys: ["x.ai/hooks"],
            unknownKeyCount: 1,
          },
          promptCapabilities: {
            encounteredKnownKeys: [],
            unknownKeyCount: 1,
          },
        },
      },
      transport: {
        inboundFramesRead: 1,
        outboundFramesAccepted: 1,
        outboundFramesWritten: 1,
      },
      binding: {
        initialized: true,
        pendingRequests: 0,
        ignoredNotifications: 0,
        ignoredNotificationBytes: 0,
        deniedReverseRequests: 0,
        protocolFailures: 0,
      },
      cleanup: { assuranceRevoked: true, sandboxTemporaryRootRemoved: true },
    });
    expect(serialized).not.toContain("fixture-provider-private-string");
    expect(serialized).not.toContain("fixture-provider-private-version");
    expect(serialized).not.toContain("jsonrpc");
    expect(serialized).not.toContain("private-agent-id");
    expect(serialized).not.toContain("PRIVATE_TOKEN");
    expect(serialized).not.toContain("not-projected");
    expect(serialized).not.toContain("unknown-response-secret-label");
    expect(serialized).not.toContain("unknown-capability-secret-label");
    expect(serialized).not.toContain("/private/provider/plugin");
    expect(serialized).not.toContain("quiescent");
  });

  itBubblewrap.each([
    ["after initialize", "o2a-unused-notification"],
    ["before initialize", "o2a-unused-notification-first"],
  ])(
    "ignores one bounded unused notification %s without capturing its route or payload",
    async (_label, scenario) => {
      const outputPath = await output(`${scenario}.json`);
      await runGrokOfflineTranche(
        input("o2a_initialize_only", scenario, outputPath),
      );
      const serialized = await readFile(outputPath, "utf8");
      const evidence = JSON.parse(serialized) as {
        observation: {
          ignoredNotifications: number;
          ignoredNotificationBytes: number;
        };
        transport: { inboundFramesRead: number };
      };

      expect(evidence.observation.ignoredNotifications).toBe(1);
      expect(evidence.observation.ignoredNotificationBytes).toBeGreaterThan(0);
      expect(evidence.observation.ignoredNotificationBytes).toBeLessThanOrEqual(
        65_536,
      );
      expect(evidence.transport.inboundFramesRead).toBe(2);
      expect(serialized).not.toContain("fixture/private-unused-notification");
      expect(serialized).not.toContain("fixture-private-unused-content");
      expect(serialized).not.toContain('"captures"');
    },
  );

  itBubblewrap("fails closed when unused notifications exceed the reviewed count bound", async () => {
    const outputPath = await output("o2a-unused-notification-overflow.json");
    await expect(
      runGrokOfflineTranche(
        input(
          "o2a_initialize_only",
          "o2a-unused-notification-overflow",
          outputPath,
        ),
      ),
    ).rejects.toThrow();
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itBubblewrap("rejects a swallowed extra cancel frame and installs no evidence", async () => {
    const outputPath = await output("extra-cancel.json");
    await expect(
      runGrokOfflineTranche(
        input("o2a_initialize_only", "o2a-extra-cancel", outputPath),
      ),
    ).rejects.toThrow();
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itBubblewrap("reports bounded structural diagnostics when the process exits after initialize", async () => {
    const outputPath = await output("o2a-early-close.json");
    let failure: unknown;
    try {
      await runGrokOfflineTranche(
        input("o2a_initialize_only", "o2a-exit-after-response", outputPath),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GrokOfflineTrancheFailure);
    expect(failure).toMatchObject({
      code: "grok_o2a_early_process_close",
      diagnostics: {
        phase: "post_initialize_bounded_observation",
        initializeResponseAdmitted: true,
        initializeCapabilityProjectionCompleted: true,
        closureDisposition: "process_exit",
        transport: {
          inboundFramesRead: 1,
          outboundFramesAccepted: 1,
          outboundFramesWritten: 1,
          streamsDrained: true,
          assuranceRevoked: true,
          processExitDisposition: "zero_exit",
        },
        binding: {
          initialized: true,
          pendingRequests: 0,
          protocolFailures: 0,
        },
        cleanup: {
          assuranceRevoked: true,
          sandboxTemporaryRootRemoved: true,
          stagedExecutableRemoved: true,
          evidenceInstalled: false,
          emergencyCleanupCompleted: true,
        },
      },
    });
    expect((failure as Error).message).toContain(
      '"processExitDisposition":"zero_exit"',
    );
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("fixture-provider-private-string");
    expect(serialized).not.toContain("fixture-provider-private-version");
    expect(serialized).not.toContain("private-agent-id");
    expect(serialized).not.toContain("not-projected");
    expect(serialized).not.toContain("jsonrpc");
    const cliFailure = serializeGrokOfflineCliFailure(failure);
    expect(JSON.parse(cliFailure)).toMatchObject({
      status: "failed",
      code: "grok_o2a_early_process_close",
      diagnostics: {
        cleanup: { evidenceInstalled: false },
      },
    });
    expect(cliFailure).not.toContain(rootDirectory);
    expect(cliFailure).not.toContain("GrokOfflineTrancheFailure");
    expect(cliFailure).not.toContain("at runO2a");
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itBubblewrap("applies one absolute deadline to a hung initialize and installs no evidence", async () => {
    const outputPath = await output("deadline.json");
    await expect(
      runGrokOfflineTranche({
        ...input("o2a_initialize_only", "o2a-hang", outputPath),
        observationMilliseconds: 50,
        deadlineMilliseconds: 100,
      }),
    ).rejects.toThrow("grok_probe_deadline_exceeded");
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itBubblewrap("applies the absolute deadline to candidate acquisition and joins its abort", async () => {
    const outputPath = await output("acquisition-deadline.json");
    let joined = false;
    await expect(
      runGrokOfflineTranche({
        ...input("o1_no_initialize", "o1-quiet", outputPath),
        observationMilliseconds: 50,
        deadlineMilliseconds: 100,
        candidateVerifier: {
          async verify(options): Promise<never> {
            try {
              await rejectOnAbort(options?.signal);
            } finally {
              joined = true;
            }
            throw new Error("test_candidate_acquisition_unexpected_return");
          },
          async cleanup() {
            joined = true;
          },
        },
      }),
    ).rejects.toThrow("grok_probe_deadline_exceeded");
    expect(joined).toBe(true);
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("registers an acquired resource when abort wins at the operation-fulfillment boundary", async () => {
    const deadline = new AbsoluteDeadline(1);
    let trackedResource: { cleanupCalls: number } | undefined;
    const resource = { cleanupCalls: 0 };
    try {
      const acquiredAtAbort = resolveOnAbort(deadline.signal, () => resource);
      const acquisition = deadline.run(
        async () => await acquiredAtAbort,
        (acquired) => {
          trackedResource = acquired;
        },
      );

      await expect(acquisition).rejects.toThrow("grok_probe_deadline_exceeded");
      expect(trackedResource).toBe(resource);
      trackedResource!.cleanupCalls += 1;
      expect(resource.cleanupCalls).toBe(1);
    } finally {
      deadline.dispose();
    }
  });

  it("registers an installed evidence publication for rollback when abort wins at fulfillment", async () => {
    const outputPath = await output("abort-after-evidence-install.json");
    const deadline = new AbsoluteDeadline(1);
    let trackedPublication:
      Readonly<{ outputPath: string; rollback(): Promise<void> }> | undefined;
    try {
      const installedAtAbort = resolveOnAbort(deadline.signal, () => {
        writeFileSync(outputPath, '{"status":"sanitized"}\n', { mode: 0o644 });
        return Object.freeze({
          outputPath,
          rollback: async () => await rm(outputPath),
        });
      });
      const installation = deadline.run(
        async () => await installedAtAbort,
        (publication) => {
          trackedPublication = publication;
        },
      );

      await expect(installation).rejects.toThrow(
        "grok_probe_deadline_exceeded",
      );
      await expect(access(outputPath)).resolves.toBeUndefined();
      await trackedPublication!.rollback();
      await expect(access(outputPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      deadline.dispose();
    }
  });

  itBubblewrap("bounds a stalled staged-lease cleanup, joins it, and installs no evidence", async () => {
    const outputPath = await output("cleanup-deadline.json");
    const verifier = fixtureCandidateVerifier();
    let cleanupCalls = 0;
    await expect(
      runGrokOfflineTranche({
        ...input("o1_no_initialize", "o1-quiet", outputPath),
        deadlineMilliseconds: 1_500,
        candidateVerifier: {
          verify: verifier.verify,
          async cleanup(options) {
            cleanupCalls += 1;
            if (cleanupCalls === 1) await rejectOnAbort(options?.signal);
          },
        },
      }),
    ).rejects.toThrow("grok_probe_deadline_exceeded");
    expect(cleanupCalls).toBe(2);
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itBubblewrap("joins finalize and lease cleanup after the shared emergency deadline expires", async () => {
    const outputPath = await output("emergency-expiry.json");
    const base = fixtureCandidateVerifier();
    let verificationCalls = 0;
    let stalledReverifyJoined = false;
    let cleanupJoined = false;
    await expect(
      runGrokOfflineTranche({
        ...input("o1_no_initialize", "o1-stdout", outputPath),
        emergencyCleanupMilliseconds: 50,
        candidateVerifier: {
          async verify(options) {
            verificationCalls += 1;
            if (verificationCalls === 1) return await base.verify(options);
            try {
              await rejectOnAbort(options?.signal);
            } finally {
              stalledReverifyJoined = true;
            }
            throw new Error("test_reverify_unexpected_return");
          },
          async cleanup(options) {
            await Promise.resolve();
            cleanupJoined = true;
            if (options?.signal?.aborted) throw options.signal.reason;
          },
        },
      }),
    ).rejects.toThrow("grok_probe_operation_and_cleanup_failed");
    expect(stalledReverifyJoined).toBe(true);
    expect(cleanupJoined).toBe(true);
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  itBubblewrap("counts unknown metadata keys without projecting their names or values", async () => {
    const outputPath = await output("unsafe-meta.json");
    await runGrokOfflineTranche(
      input("o2a_initialize_only", "o2a-unsafe-meta", outputPath),
    );
    const serialized = await readFile(outputPath, "utf8");
    expect(serialized).toContain('"unknownKeyCount":1');
    expect(serialized).not.toContain("unsafe key");
    expect(serialized).not.toContain("not-projected");
  });

  itBubblewrap("produces byte-identical evidence for repeated deterministic O1 probes", async () => {
    const first = await output("deterministic-a.json");
    const second = await output("deterministic-b.json");
    await runGrokOfflineTranche(input("o1_no_initialize", "o1-quiet", first));
    await runGrokOfflineTranche(input("o1_no_initialize", "o1-quiet", second));
    expect(await readFile(first, "utf8")).toBe(await readFile(second, "utf8"));
  });

  itBubblewrap.each([
    ["unexpected stdout", "o1-stdout", "grok_o1_unexpected_stdout"],
    [
      "partial stdout",
      "o1-partial-stdout",
      "grok_probe_transport_counts_invalid",
    ],
    ["early close", "exit", "grok_o1_early_process_close"],
  ])(
    "fails O1 on %s, cleans the sandbox, and leaves no evidence",
    async (_label, scenario, code) => {
      const outputPath = await output(`${scenario}.json`);
      await expect(
        runGrokOfflineTranche(input("o1_no_initialize", scenario, outputPath)),
      ).rejects.toThrow(code);
      await expect(access(outputPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

function input(
  tranche: "o1_no_initialize" | "o2a_initialize_only",
  scenario: string,
  outputPath: string,
) {
  return {
    tranche,
    scope,
    connectionGeneration: 1,
    outputPath,
    executablePath: process.execPath,
    scriptPath: fixture,
    arguments: [scenario],
    observationMilliseconds: 250,
    deadlineMilliseconds: 3_000,
    transportLimits: {
      maximumFrameBytes: 16 * 1024,
      maximumInboundQueueBytes: 32 * 1024,
      maximumInboundQueueFrames: 8,
      maximumOutboundQueueBytes: 32 * 1024,
      maximumOutboundQueueFrames: 4,
      maximumStderrTailBytes: 1024,
      gracefulCloseMilliseconds: 100,
      terminateMilliseconds: 200,
      killMilliseconds: 500,
    },
    sandboxLimits: {
      timeoutMs: 3_000,
      observationMs: 250,
      terminateGraceMs: 100,
      killGraceMs: 500,
    },
    candidateVerifier: fixtureCandidateVerifier(),
  } as const;
}

function fixtureCandidateVerifier() {
  return {
    async verify(_options?: { readonly signal?: AbortSignal }) {
      const [metadata, bytes] = await Promise.all([
        stat(process.execPath),
        readBinaryFile(process.execPath),
      ]);
      return {
        verifier: "fixture_callback" as const,
        executablePath: process.execPath,
        executableSha256: createHash("sha256").update(bytes).digest("hex"),
        immutableIdentity: JSON.stringify({
          device: metadata.dev,
          inode: metadata.ino,
          size: metadata.size,
          modifiedMilliseconds: metadata.mtimeMs,
        }),
      };
    },
  };
}

async function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) throw new Error("test_abort_signal_missing");
  if (signal.aborted) throw signal.reason;
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

async function resolveOnAbort<T>(
  signal: AbortSignal,
  acquire: () => T | Promise<T>,
): Promise<T> {
  if (signal.aborted) return await acquire();
  return await new Promise<T>((resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        try {
          const acquired = acquire();
          if (acquired instanceof Promise) acquired.then(resolve, reject);
          else resolve(acquired);
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
  });
}

async function output(name: string): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sedes-grok-tranche-test-"),
  );
  temporaryDirectories.push(directory);
  const outputDirectory = path.join(directory, "evidence");
  await mkdir(outputDirectory, { mode: 0o700 });
  return path.join(outputDirectory, name);
}

async function evidenceAt(
  outputPath: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(outputPath, "utf8")) as Record<
    string,
    unknown
  >;
}
