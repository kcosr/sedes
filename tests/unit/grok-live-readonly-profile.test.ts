import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { OwnedNdjsonStdioTransportFactory } from "../../src/server/provider-protocol/transport/owned-ndjson-stdio-transport.js";
import { GrokLiveReadonlyConnection } from "../../scripts/grok-probes/grok-live-readonly-profile.js";
import { buildDisposableGrokProbeChildEnvironment } from "../../scripts/grok-probes/grok-probe-child-environment.js";
import {
  AbsoluteDeadline,
  closeOwned,
  runGrokLiveReadonlyGate,
} from "../../scripts/grok-probes/run-grok-live-readonly-gate.js";

const fixture = fileURLToPath(
  new URL(
    "../fixtures/grok-probes/fake-grok-live-readonly-peer.mjs",
    import.meta.url,
  ),
);
const scope = Object.freeze({
  tenantId: "grok-live-readonly-tenant",
  principalId: "grok-live-readonly-principal",
  backendInstanceId: "grok-live-readonly-backend",
  executionEnvironmentId: "grok-live-readonly-local",
});
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Grok live read-only probe profile", () => {
  it("keeps disposable provider homes inside the probe-only environment helper", () => {
    expect(
      buildDisposableGrokProbeChildEnvironment(
        {
          PATH: "/usr/bin:/bin",
          HOME: "/home/operator",
          GROK_HOME: "/home/operator/.grok",
          XAI_API_KEY: "must-not-leak",
          SEDES_ADMIN_TOKEN: "must-not-leak",
        },
        "/probe/grok-home",
        "/probe/process-home",
      ),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/probe/process-home",
      GROK_HOME: "/probe/grok-home",
      NO_COLOR: "1",
      TERM: "dumb",
      GROK_OAUTH2_REFERRER: "sedes-probe",
    });
  });

  it("publishes a separately opt-in live command", async () => {
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["probe:grok-live-readonly"]).toBe(
      "tsx scripts/grok-probes/run-grok-live-readonly-gate.ts",
    );
  });

  it("uses the assured ACP stack and projects only read-only evidence", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "grok-live-profile-test-"),
    );
    roots.push(root);
    await chmod(root, 0o700);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: scope.executionEnvironmentId,
      environment: {},
    });
    const prepared = await channels.prepareOwnedProcess(scope, {
      executablePath: process.execPath,
      workingDirectory: workspace,
    });
    const factory = new OwnedNdjsonStdioTransportFactory({
      scope,
      channels,
      process: prepared,
      environment: {},
      commandArguments: [fixture],
      limits: {
        maximumFrameBytes: 1_048_576,
      },
      assuranceDiagnosticPrefix: "grok_live_readonly_test",
      transportDiagnosticPrefix: "grok_live_readonly_test_stdio",
    });
    const controller = new AbortController();
    const transport = await factory.open(scope, 1, controller.signal);
    const connection = new GrokLiveReadonlyConnection({
      transport,
      expectedScope: scope,
      connectionGeneration: 1,
    });
    try {
      const result = await connection.run({
        cwd: workspace,
      });
      expect(result.sessions).toEqual({ sessions: [] });
      expect(result.diagnostics).toMatchObject({
        initialized: true,
        ignoredNotifications: 1,
        deniedReverseRequests: 0,
        protocolFailures: 0,
      });
    } finally {
      await connection.close();
      await transport.close("test_complete");
      channels.close();
    }
  });

  it("runs the bounded orchestrator and publishes only sanitized evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-live-gate-test-"));
    roots.push(root);
    await chmod(root, 0o700);
    const credentialSource = path.join(root, "auth.json");
    await writeFile(
      credentialSource,
      `${JSON.stringify({
        "https://auth.x.ai/test": {
          key: "fixture-access-secret",
          auth_mode: "oidc",
          create_time: "2026-01-01T00:00:00Z",
          user_id: "fixture-user",
          email: "fixture@example.invalid",
          principal_type: "User",
          principal_id: "fixture-principal",
          refresh_token: "fixture-refresh-secret",
          expires_at: "2099-01-01T00:00:00Z",
          oidc_issuer: "https://auth.x.ai",
          oidc_client_id: "fixture-client",
        },
      })}\n`,
      { mode: 0o600 },
    );
    const evidenceRoot = path.join(root, "protocol/grok-acp/1.0.4/evidence");
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const outputPath = path.join(evidenceRoot, "l-readonly/capture.json");
    const workspace = path.join(root, "peer-workspace");
    await mkdir(workspace);
    let channels: LocalEnvironmentChannelProvider | undefined;
    try {
      const result = await runGrokLiveReadonlyGate({
        credentialSource,
        outputPath,
        environment: { SEDES_GROK_LIVE_READONLY: "1" },
        testTransportFactory: async (gateScope, signal, context) => {
          const policy = await readFile(
            path.join(context.grokHome, "config.toml"),
            "utf8",
          );
          expect(policy).toContain("codebase_indexing = false");
          expect(policy).toContain("managed_config = false");
          expect(policy).toContain("remote_fetch = false");
          const stagedAuth = JSON.parse(
            await readFile(path.join(context.grokHome, "auth.json"), "utf8"),
          ) as Record<string, unknown>;
          expect(Object.keys(stagedAuth)).toEqual(["https://auth.x.ai/test"]);
          channels = new LocalEnvironmentChannelProvider({
            scope: gateScope,
            executionEnvironmentId: gateScope.executionEnvironmentId,
            environment: {},
          });
          const prepared = await channels.prepareOwnedProcess(gateScope, {
            executablePath: process.execPath,
            workingDirectory: workspace,
          });
          return await new OwnedNdjsonStdioTransportFactory({
            scope: gateScope,
            channels,
            process: prepared,
            environment: {},
            commandArguments: [fixture],
            limits: {
              maximumFrameBytes: 1_048_576,
            },
            assuranceDiagnosticPrefix: "grok_live_gate_test",
            transportDiagnosticPrefix: "grok_live_gate_test_stdio",
          }).open(gateScope, 1, signal);
        },
      });
      const serialized = await readFile(outputPath, "utf8");
      const evidence = JSON.parse(serialized) as Record<string, unknown>;
      expect(result.outputBytes).toBe(Buffer.byteLength(serialized));
      expect(serialized).not.toContain("fixture-access-secret");
      expect(serialized).not.toContain("fixture-refresh-secret");
      expect(serialized).not.toContain("fixture@example.invalid");
      expect(serialized).not.toContain("\n  ");
      expect(evidence).toMatchObject({
        tranche: "L-readonly-local-credential-empty-session-list",
        authority: {
          localCredentialContinuity: {
            singleFreshOidcEntry: true,
            stablePrincipalIdentifierPresent: true,
            originalCredentialSourceUnchanged: true,
          },
          managedConfigFetch: false,
          sessionModelToolMutations: false,
        },
        sessionList: { sessions: 0, nextCursorPresent: false },
        cleanup: { disposableRootRemoved: true },
      });
      expect(evidence).not.toHaveProperty("catalog");
      expect(evidence).not.toHaveProperty("bundledCatalogStructure");
    } finally {
      await channels?.close();
    }
  });

  it("cleans up and retains no evidence when the disposable session store is not empty", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "grok-live-gate-failure-test-"),
    );
    roots.push(root);
    await chmod(root, 0o700);
    const credentialSource = path.join(root, "auth.json");
    await writeFile(
      credentialSource,
      `${JSON.stringify({
        "https://auth.x.ai/test": {
          key: "failure-access-secret",
          auth_mode: "oidc",
          create_time: "2026-01-01T00:00:00Z",
          user_id: "fixture-user",
          principal_type: "User",
          principal_id: "fixture-principal",
          expires_at: "2099-01-01T00:00:00Z",
        },
      })}\n`,
      { mode: 0o600 },
    );
    const evidenceRoot = path.join(root, "protocol/grok-acp/1.0.4/evidence");
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const outputPath = path.join(evidenceRoot, "l-readonly/capture.json");
    const workspace = path.join(root, "peer-workspace");
    await mkdir(workspace);
    let channels: LocalEnvironmentChannelProvider | undefined;
    try {
      await expect(
        runGrokLiveReadonlyGate({
          credentialSource,
          outputPath,
          environment: { SEDES_GROK_LIVE_READONLY: "1" },
          testTransportFactory: async (gateScope, signal) => {
            channels = new LocalEnvironmentChannelProvider({
              scope: gateScope,
              executionEnvironmentId: gateScope.executionEnvironmentId,
              environment: {},
            });
            const prepared = await channels.prepareOwnedProcess(gateScope, {
              executablePath: process.execPath,
              workingDirectory: workspace,
            });
            return await new OwnedNdjsonStdioTransportFactory({
              scope: gateScope,
              channels,
              process: prepared,
              environment: { FAKE_GROK_NEXT_CURSOR: "1" },
              commandArguments: [fixture],
              limits: {
                maximumFrameBytes: 1_048_576,
              },
              assuranceDiagnosticPrefix: "grok_live_gate_failure_test",
              transportDiagnosticPrefix: "grok_live_gate_failure_test_stdio",
            }).open(gateScope, 1, signal);
          },
        }),
      ).rejects.toThrow("grok_live_readonly_disposable_store_not_empty");
      await expect(readFile(outputPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await channels?.close();
    }
  });

  it("rejects a token that could cross the provider refresh margin during the gate", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "grok-live-freshness-test-"),
    );
    roots.push(root);
    await chmod(root, 0o700);
    const credentialSource = path.join(root, "auth.json");
    await writeFile(
      credentialSource,
      `${JSON.stringify({
        "https://auth.x.ai/test": {
          key: "boundary-access-secret",
          auth_mode: "oidc",
          create_time: new Date().toISOString(),
          user_id: "fixture-user",
          principal_id: "fixture-principal",
          expires_at: new Date(Date.now() + 5 * 60_000 + 30_000).toISOString(),
        },
      })}\n`,
      { mode: 0o600 },
    );
    const evidenceRoot = path.join(root, "protocol/grok-acp/1.0.4/evidence");
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const outputPath = path.join(evidenceRoot, "l-readonly/capture.json");
    await expect(
      runGrokLiveReadonlyGate({
        credentialSource,
        outputPath,
        environment: { SEDES_GROK_LIVE_READONLY: "1" },
        testTransportFactory: async () => {
          throw new Error("transport_must_not_start");
        },
      }),
    ).rejects.toThrow("grok_live_readonly_credential_not_fresh");
    await expect(readFile(outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves the credential-source mutation diagnostic through emergency cleanup", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "grok-live-credential-change-test-"),
    );
    roots.push(root);
    await chmod(root, 0o700);
    const credentialSource = path.join(root, "auth.json");
    const credential = {
      "https://auth.x.ai/test": {
        key: "mutation-access-secret",
        auth_mode: "oidc",
        create_time: "2026-01-01T00:00:00Z",
        user_id: "fixture-user",
        principal_id: "fixture-principal",
        expires_at: "2099-01-01T00:00:00Z",
      },
    };
    await writeFile(credentialSource, `${JSON.stringify(credential)}\n`, {
      mode: 0o600,
    });
    const evidenceRoot = path.join(root, "protocol/grok-acp/1.0.4/evidence");
    await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    const outputPath = path.join(evidenceRoot, "l-readonly/capture.json");
    const workspace = path.join(root, "peer-workspace");
    await mkdir(workspace);
    let channels: LocalEnvironmentChannelProvider | undefined;
    try {
      await expect(
        runGrokLiveReadonlyGate({
          credentialSource,
          outputPath,
          environment: { SEDES_GROK_LIVE_READONLY: "1" },
          testTransportFactory: async (gateScope, signal) => {
            channels = new LocalEnvironmentChannelProvider({
              scope: gateScope,
              executionEnvironmentId: gateScope.executionEnvironmentId,
              environment: {},
            });
            const prepared = await channels.prepareOwnedProcess(gateScope, {
              executablePath: process.execPath,
              workingDirectory: workspace,
            });
            const transport = await new OwnedNdjsonStdioTransportFactory({
              scope: gateScope,
              channels,
              process: prepared,
              environment: {},
              commandArguments: [fixture],
              limits: {
                maximumFrameBytes: 1_048_576,
              },
              assuranceDiagnosticPrefix: "grok_live_credential_change_test",
              transportDiagnosticPrefix:
                "grok_live_credential_change_test_stdio",
            }).open(gateScope, 1, signal);
            credential["https://auth.x.ai/test"].key = "changed-access-secret";
            await writeFile(
              credentialSource,
              `${JSON.stringify(credential)}\n`,
              { mode: 0o600 },
            );
            return transport;
          },
        }),
      ).rejects.toThrow("grok_live_readonly_credential_source_changed");
      await expect(readFile(outputPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await channels?.close();
    }
  });

  it("registers acquired authority when abort wins at the fulfillment boundary", async () => {
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

      await expect(acquisition).rejects.toThrow(
        "grok_live_readonly_deadline_exceeded",
      );
      expect(trackedResource).toBe(resource);
      trackedResource!.cleanupCalls += 1;
      expect(resource.cleanupCalls).toBe(1);
    } finally {
      deadline.dispose();
    }
  });

  it("registers an evidence publication for rollback when abort wins at fulfillment", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "grok-live-publication-test-"),
    );
    roots.push(root);
    const outputPath = path.join(root, "capture.json");
    const deadline = new AbsoluteDeadline(1);
    let trackedPublication:
      Readonly<{ outputPath: string; rollback(): Promise<void> }> | undefined;
    try {
      const installedAtAbort = resolveOnAbort(deadline.signal, async () => {
        await writeFile(outputPath, '{"status":"sanitized"}\n', {
          mode: 0o600,
        });
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
        "grok_live_readonly_deadline_exceeded",
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

  it("retries emergency cleanup after the staged executable is already removed", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "grok-live-cleanup-retry-test-"),
    );
    roots.push(root);
    const stagedExecutable = path.join(root, "already-removed-grok");
    let reverifyCalls = 0;
    let cleanupCalls = 0;
    const deadline = new AbsoluteDeadline(1_000);
    try {
      const result = await closeOwned(
        undefined,
        undefined,
        undefined,
        {
          executablePath: stagedExecutable,
          expectedSha256: "fixture",
          async reverify() {
            reverifyCalls += 1;
            throw new Error("removed executable cannot be reverified");
          },
          async cleanup() {
            cleanupCalls += 1;
          },
        },
        root,
        deadline,
        { skipStagedReverify: true },
      );

      expect(reverifyCalls).toBe(0);
      expect(cleanupCalls).toBe(1);
      expect(result.disposition).toMatchObject({
        stagedExecutableRemoved: true,
        disposableRootRemoved: true,
      });
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      deadline.dispose();
    }
  });
});

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
