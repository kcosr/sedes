import { SEDES_VERSION } from "../../src/shared/version.js";
import { authenticatedProductionFetch } from "../helpers/authenticated-production-client.js";
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizedApplicationSessionSchema,
  normalizedApplicationSnapshotSchema,
} from "../../src/shared/protocol/application.js";
import {
  configurationSnapshotSchema,
  configurationLifecycleImpactSchema,
  configurationLifecycleResultSchema,
  type ConfigurationLifecycleRequest,
} from "../../src/shared/protocol/configuration-admin.js";
import { loadBackendConfigurationFile } from "../../src/server/config/backend-configuration.js";
import { resolveBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import {
  deriveSidecarInstallationIdentity,
  loadOrCreateToolProvenanceKey,
} from "../../src/server/security/installation-secret.js";
import { persistentSidecarPaths } from "../../src/server/sidecar/persistent-sidecar-paths.js";
import { inspectAtEndpoint } from "../../src/server/sidecar/persistent-sidecar-bootstrap.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import {
  readSidecarManagementRecord,
  writeSidecarManagementRecord,
} from "../../src/internal/sidecar-protocol/service-management-channel.js";
import {
  sidecarManagementResponseSchema,
  type SidecarServiceScope,
} from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { prepareBackendNormalizedDatabase } from "../../src/server/db/backend-normalized-startup.js";
import {
  startProductionApplication,
  type RunningApplication,
} from "../../src/server/production-application.js";
import {
  SIDECAR_ARTIFACT_ID,
  SIDECAR_ARTIFACT_MODES,
  SIDECAR_MINIMUM_NODE_VERSION,
  type SidecarArtifactRegistration,
} from "../../src/server/sidecar/sidecar-artifact.js";
import {
  RawUdsWebSocketServer,
  type RawWebSocketConnection,
} from "../support/raw-uds-websocket-server.js";

const SSH = "/usr/bin/ssh";
const SSHD = "/usr/sbin/sshd";
const SSH_KEYGEN = "/usr/bin/ssh-keygen";
const execFile = promisify(execFileCallback);
const LOCAL_ENVIRONMENT_ID = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const SSH_ENVIRONMENT_ID = "019196f7-a0a8-7bc4-a89b-8cf013978406";
const fixtures: ProductionSshFixture[] = [];

async function readApplicationSession(fixture: ProductionSshFixture) {
  const response = await fixture.fetch(
    `http://127.0.0.1:${fixture.httpPort}/api/application/session`,
  );
  expect(response.status).toBe(200);
  return normalizedApplicationSessionSchema.parse(await response.json());
}

async function readApplicationSnapshot(fixture: ProductionSshFixture) {
  const response = await fixture.fetch(
    `http://127.0.0.1:${fixture.httpPort}/api/application/snapshot`,
  );
  expect(response.status).toBe(200);
  return normalizedApplicationSnapshotSchema.parse(await response.json());
}

const openSshAvailable = [SSH, SSHD, SSH_KEYGEN].every((executable) => {
  try {
    accessSync(executable, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
});

afterEach(async () => {
  await Promise.allSettled(
    fixtures.splice(0).map((fixture) => fixture.close()),
  );
});

describe.skipIf(!openSshAvailable)(
  "production SSH UDS composition over disposable OpenSSH",
  () => {
    it("preserves the principal-scoped Codex runtime until an explicit Settings stop", async () => {
      const fixture = await ProductionSshFixture.create();
      fixtures.push(fixture);
      const provider = new MinimalCodexAppServer(fixture.peer);
      const originalPath = process.env.PATH;
      process.env.PATH = originalPath
        ? `${fixture.binDirectory}${path.delimiter}${originalPath}`
        : fixture.binDirectory;
      let application: RunningApplication | undefined;

      try {
        application = await startProductionApplication({
          ...process.env,
          APP_STATE_DIR: fixture.stateDirectory,
          SEDES_CONFIG_FILE: fixture.configurationPath,
          PORT: String(fixture.httpPort),
        }, {
          sidecarArtifactRegistration: fixture.artifact,
          sidecarAccountHomeForTests: fixture.remoteAccountHome,
        });
        await fixture.authenticate(application);
        await provider.waitUntilInitialized();
        await fixture.waitUntilTargetAvailable();
        const firstService = await fixture.serviceStatus();
        expect(firstService?.state).toBe("ready");

        const snapshot = await readApplicationSnapshot(fixture);
        expect(snapshot.environments).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: SSH_ENVIRONMENT_ID,
              available: true,
            }),
          ]),
        );
        expect(snapshot.executionTargets).toHaveLength(1);
        expect(snapshot.executionTargets[0]).toMatchObject({
          environmentId: SSH_ENVIRONMENT_ID,
          label: { text: "Disposable remote Codex" },
          backend: {
            label: { text: "Disposable Codex app server" },
            brand: "codex",
          },
          available: true,
        });
        expect(snapshot.defaultNewThreadTargetId).toBe(
          snapshot.executionTargets[0]!.id,
        );

        const shutdownDiagnostics: string[] = [];
        const stderr = vi
          .spyOn(process.stderr, "write")
          .mockImplementation((chunk: string | Uint8Array) => {
            shutdownDiagnostics.push(String(chunk));
            return true;
          });
        try {
          await application.close();
        } finally {
          stderr.mockRestore();
        }
        application = undefined;
        expect(shutdownDiagnostics.join("\n")).not.toContain(
          "application_snapshot_publication_boundary_closed",
        );
        await expect(Promise.race([
          fixture.peer.latestConnection.closed.then(() => false),
          delay(50).then(() => true),
        ])).resolves.toBe(true);
        expect((await fixture.serviceStatus())?.state).toBe("ready");
        expect(fixture.peer.listening).toBe(true);
        expect((await lstat(fixture.remoteSocket)).isSocket()).toBe(true);
        expect(fixture.sshdRunning).toBe(true);

        expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(firstService?.serviceIncarnation);
        application = await startProductionApplication({
          ...process.env,
          APP_STATE_DIR: fixture.stateDirectory,
          SEDES_CONFIG_FILE: fixture.configurationPath,
          PORT: String(fixture.httpPort),
        }, {
          sidecarArtifactRegistration: fixture.artifact,
          sidecarAccountHomeForTests: fixture.remoteAccountHome,
        });
        await fixture.authenticate(application);
        await fixture.waitUntilTargetAvailable();
        expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(firstService?.serviceIncarnation);
        expect(fixture.peer.connections).toHaveLength(1);

        const initialDesiredConfiguration = (await fixture.configuration()).configuration;
        const retainedNativeConnection = fixture.peer.latestConnection;
        const disconnected = await fixture.lifecycleEnvironment("disconnect");
        expect(disconnected.runtime.connectionState).toBe("disconnected");
        expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(firstService?.serviceIncarnation);
        await expect(Promise.race([
          retainedNativeConnection.closed.then(() => false),
          delay(50).then(() => true),
        ])).resolves.toBe(true);

        const stopped = await fixture.lifecycleEnvironment("stop");
        expect(stopped.runtime).toMatchObject({ preference: "stopped", connectionState: "stopped" });
        await withTimeout(retainedNativeConnection.closed, 5_000);
        await waitFor(async () => (await fixture.serviceStatus()) === undefined, 5_000);
        expect(fixture.peer.listening).toBe(true);

        await fixture.lifecycleEnvironment("restart");
        await fixture.waitUntilTargetAvailable();
        expect((await fixture.serviceStatus())?.serviceIncarnation).not.toBe(firstService?.serviceIncarnation);
        expect(fixture.peer.connections).toHaveLength(2);
        expect((await fixture.configuration()).configuration).toEqual(initialDesiredConfiguration);

        await application.close();
        application = undefined;

        const database = new Database(
          path.join(fixture.stateDirectory, "overlay.sqlite"),
          { readonly: true },
        );
        try {
          const environment = database
            .prepare(
              `
                SELECT tenant_id AS tenantId,
                  owner_principal_id AS principalId,
                  id, kind, availability
                FROM execution_environments
                WHERE id = ?
              `,
            )
            .get(SSH_ENVIRONMENT_ID) as
            | {
                readonly tenantId: string;
                readonly principalId: string;
                readonly id: string;
                readonly kind: string;
                readonly availability: string;
              }
            | undefined;
          expect(environment).toMatchObject({
            id: SSH_ENVIRONMENT_ID,
            kind: "ssh",
            availability: "available",
            tenantId: expect.any(String),
            principalId: expect.any(String),
          });
          expect(environment?.tenantId).not.toBe("");
          expect(environment?.principalId).not.toBe("");

          const profile = database
            .prepare(
              `
                SELECT tenant_id AS tenantId,
                  owner_principal_id AS principalId,
                  execution_environment_id AS environmentId
                FROM agent_connection_profiles
                WHERE template_id = 'codex-ssh-production'
              `,
            )
            .get() as
            | {
                readonly tenantId: string;
                readonly principalId: string;
                readonly environmentId: string;
              }
            | undefined;
          expect(profile).toEqual({
            tenantId: environment?.tenantId,
            principalId: environment?.principalId,
            environmentId: SSH_ENVIRONMENT_ID,
          });
        } finally {
          database.close();
        }
      } finally {
        try {
          await application?.close().catch(() => undefined);
          await fixture.stopService();
          await provider.close();
        } finally {
          if (originalPath === undefined) delete process.env.PATH;
          else process.env.PATH = originalPath;
        }
      }
    }, 60_000);

    it("uses the persistent Codex service for opted-in Files without another carrier", async () => {
      const fixture = await ProductionSshFixture.create({ sidecar: true });
      fixtures.push(fixture);
      await writeFile(
        path.join(fixture.workspaceRoot, "remote.txt"),
        "remote files\n",
      );
      const artifact = fixture.artifact;
      const provider = new MinimalCodexAppServer(fixture.peer);
      const originalPath = process.env.PATH;
      process.env.PATH = originalPath
        ? `${fixture.binDirectory}${path.delimiter}${originalPath}`
        : fixture.binDirectory;
      let application: RunningApplication | undefined;

      try {
        application = await startProductionApplication(
          {
            ...process.env,
            APP_STATE_DIR: fixture.stateDirectory,
            SEDES_CONFIG_FILE: fixture.configurationPath,
            PORT: String(fixture.httpPort),
          },
          {
            sidecarArtifactRegistration: artifact,
            sidecarAccountHomeForTests: fixture.remoteAccountHome,
          },
        );
        await fixture.authenticate(application);
        await provider.waitUntilInitialized();
        await fixture.waitUntilTargetAvailable();
        expect((await fixture.sshInvocations()).filter(command => command.includes("service connect"))).toHaveLength(1);
        expect((await fixture.sshInvocations()).some(command => command.includes("serve --stdio"))).toBe(false);

        const session = await readApplicationSession(fixture);
        const opened = await fixture.fetch(
          `http://127.0.0.1:${fixture.httpPort}/api/workspaces/open`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": session.csrfToken,
            },
            body: JSON.stringify({
              environmentId: SSH_ENVIRONMENT_ID,
              path: fixture.workspaceRoot,
            }),
          },
        );
        expect(opened.status).toBe(201);
        const workspaceId = ((await opened.json()) as { readonly id: string })
          .id;
        expect((await fixture.sshInvocations()).filter(command => command.includes("service connect"))).toHaveLength(1);

        const files = await fixture.fetch(
          `http://127.0.0.1:${fixture.httpPort}/api/workspaces/${workspaceId}/files?rootId=primary`,
        );
        expect(files.status).toBe(200);
        const filesBody = await files.json();
        expect(filesBody).toMatchObject({
          availability: "available",
          rootId: "primary",
          entries: ["remote.txt"],
        });
        await waitFor(
          async () =>
            (await fixture.sshInvocations()).some((invocation) =>
              invocation.includes("service connect"),
            ),
          5_000,
        );
        await expect(
          Promise.race([
            fixture.peer.latestConnection.closed.then(() => false),
            delay(50).then(() => true),
          ]),
        ).resolves.toBe(true);
        expect(fixture.peer.listening).toBe(true);

        await application.close();
        application = undefined;
        await expect(Promise.race([
          fixture.peer.latestConnection.closed.then(() => false),
          delay(50).then(() => true),
        ])).resolves.toBe(true);
        expect((await fixture.serviceStatus())?.state).toBe("ready");
        expect(fixture.peer.listening).toBe(true);
        expect((await lstat(fixture.remoteSocket)).isSocket()).toBe(true);
        expect(fixture.sshdRunning).toBe(true);
      } finally {
        try {
          await application?.close().catch(() => undefined);
          await fixture.stopService();
          await provider.close();
        } finally {
          if (originalPath === undefined) delete process.env.PATH;
          else process.env.PATH = originalPath;
        }
      }
    }, 60_000);

    it("browses remote directories only through the opted-in managed sidecar", async () => {
      const fixture = await ProductionSshFixture.create({
        directoryBrowser: true,
      });
      fixtures.push(fixture);
      await Promise.all([
        mkdir(path.join(fixture.workspaceRoot, "alpha")),
        mkdir(path.join(fixture.workspaceRoot, "zeta")),
        writeFile(path.join(fixture.workspaceRoot, "file.txt"), "file\n"),
      ]);
      const artifact = fixture.artifact;
      const provider = new MinimalCodexAppServer(fixture.peer);
      const originalPath = process.env.PATH;
      process.env.PATH = originalPath
        ? `${fixture.binDirectory}${path.delimiter}${originalPath}`
        : fixture.binDirectory;
      let application: RunningApplication | undefined;
      try {
        application = await startProductionApplication(
          {
            ...process.env,
            APP_STATE_DIR: fixture.stateDirectory,
            SEDES_CONFIG_FILE: fixture.configurationPath,
            PORT: String(fixture.httpPort),
          },
          {
            sidecarArtifactRegistration: artifact,
            sidecarAccountHomeForTests: fixture.remoteAccountHome,
          },
        );
        await fixture.authenticate(application);
        await provider.waitUntilInitialized();
        await fixture.waitUntilTargetAvailable();
        expect((await fixture.sshInvocations()).filter(command => command.includes("service connect"))).toHaveLength(1);

        const [session, snapshot] = await Promise.all([
          readApplicationSession(fixture),
          readApplicationSnapshot(fixture),
        ]);
        expect(
          snapshot.environments.find(({ id }) => id === SSH_ENVIRONMENT_ID)
            ?.directoryBrowsing,
        ).toBe("available");
        const response = await fixture.fetch(
          `http://127.0.0.1:${fixture.httpPort}/api/execution-environments/${SSH_ENVIRONMENT_ID}/directories/browse`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": session.csrfToken,
            },
            body: JSON.stringify({
              location: {
                kind: "directory",
                path: fixture.workspaceRoot,
              },
              pageSize: 50,
            }),
          },
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          location: { kind: "directory", path: fixture.workspaceRoot },
          entries: [
            { name: "alpha", path: path.join(fixture.workspaceRoot, "alpha") },
            { name: "zeta", path: path.join(fixture.workspaceRoot, "zeta") },
          ],
          truncated: false,
        });
        await waitFor(
          async () =>
            (await fixture.sshInvocations()).some((invocation) =>
              invocation.includes("service connect"),
            ),
          5_000,
        );
      } finally {
        try {
          await application?.close().catch(() => undefined);
          await fixture.stopService();
          await provider.close();
        } finally {
          if (originalPath === undefined) delete process.env.PATH;
          else process.env.PATH = originalPath;
        }
      }
    }, 60_000);

    it("validates a Pi-only SSH environment on its first sidecar operation", async () => {
      const fixture = await ProductionSshFixture.create({
        directoryBrowser: true,
        piOnly: true,
      });
      fixtures.push(fixture);
      await mkdir(path.join(fixture.workspaceRoot, "alpha"));
      const artifact = fixture.artifact;
      const originalPath = process.env.PATH;
      process.env.PATH = originalPath
        ? `${fixture.binDirectory}${path.delimiter}${originalPath}`
        : fixture.binDirectory;
      let application: RunningApplication | undefined;
      try {
        application = await startProductionApplication(
          {
            ...process.env,
            APP_STATE_DIR: fixture.stateDirectory,
            SEDES_CONFIG_FILE: fixture.configurationPath,
            PORT: String(fixture.httpPort),
          },
          {
            sidecarArtifactRegistration: artifact,
            sidecarAccountHomeForTests: fixture.remoteAccountHome,
          },
        );
        await fixture.authenticate(application);
        const [session, snapshot] = await Promise.all([
          readApplicationSession(fixture),
          readApplicationSnapshot(fixture),
        ]);
        expect(
          snapshot.environments.find(({ id }) => id === SSH_ENVIRONMENT_ID),
        ).toMatchObject({
          available: false,
        });
        expect(
          snapshot.environments.find(
            ({ id }) => id === SSH_ENVIRONMENT_ID,
          ),
        ).toHaveProperty("diagnostic.text", "configuration_apply_pending");

        const response = await fixture.fetch(
          `http://127.0.0.1:${fixture.httpPort}/api/execution-environments/${SSH_ENVIRONMENT_ID}/directories/browse`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": session.csrfToken,
            },
            body: JSON.stringify({
              location: { kind: "directory", path: fixture.workspaceRoot },
              pageSize: 50,
            }),
          },
        );
        expect(response.status).toBe(200);
        await waitFor(async () => {
          const current = await readApplicationSnapshot(fixture);
          return (
            current.environments.find(({ id }) => id === SSH_ENVIRONMENT_ID)
              ?.available === true
          );
        }, 5_000);
      } finally {
        try {
          await application?.close().catch(() => undefined);
        } finally {
          if (originalPath === undefined) delete process.env.PATH;
          else process.env.PATH = originalPath;
        }
      }
    }, 60_000);

    it("composes the exact remote agent-tool CLI grant on the persistent Codex service", async () => {
      const fixture = await ProductionSshFixture.create({
        agentToolsCli: true,
      });
      fixtures.push(fixture);
      const artifact = fixture.artifact;
      const provider = new MinimalCodexAppServer(fixture.peer);
      const originalPath = process.env.PATH;
      process.env.PATH = originalPath
        ? `${fixture.binDirectory}${path.delimiter}${originalPath}`
        : fixture.binDirectory;
      let application: RunningApplication | undefined;

      try {
        application = await startProductionApplication(
          {
            ...process.env,
            APP_STATE_DIR: fixture.stateDirectory,
            SEDES_CONFIG_FILE: fixture.configurationPath,
            PORT: String(fixture.httpPort),
          },
          {
            sidecarArtifactRegistration: artifact,
            sidecarAccountHomeForTests: fixture.remoteAccountHome,
          },
        );
        await fixture.authenticate(application);
        await provider.waitUntilInitialized();
        await fixture.waitUntilTargetAvailable();

        const invocations = await fixture.sshInvocations();
        expect(invocations.filter(command => command.includes("service connect"))).toHaveLength(1);
        expect(invocations.some(command => command.includes("serve --stdio"))).toBe(false);
        expect(fixture.peer.listening).toBe(true);
      } finally {
        try {
          await application?.close().catch(() => undefined);
          await fixture.stopService();
          await provider.close();
        } finally {
          if (originalPath === undefined) delete process.env.PATH;
          else process.env.PATH = originalPath;
        }
      }
    }, 60_000);
  },
);

class MinimalCodexAppServer {
  readonly #server: RawUdsWebSocketServer;
  readonly #initialized: Promise<void>;
  readonly #resolveInitialized: () => void;
  readonly #rejectInitialized: (error: Error) => void;
  readonly #run: Promise<void>;
  #stopping = false;
  #initializedSettled = false;
  #failure: Error | undefined;

  constructor(server: RawUdsWebSocketServer) {
    this.#server = server;
    let resolveInitialized!: () => void;
    let rejectInitialized!: (error: Error) => void;
    this.#initialized = new Promise<void>((resolve, reject) => {
      resolveInitialized = resolve;
      rejectInitialized = reject;
    });
    void this.#initialized.catch(() => undefined);
    this.#resolveInitialized = resolveInitialized;
    this.#rejectInitialized = rejectInitialized;
    this.#run = this.#serve().catch((error: unknown) => {
      const failure =
        error instanceof Error
          ? error
          : new Error("minimal_codex_app_server_failed", { cause: error });
      this.#failure = failure;
      if (!this.#initializedSettled) {
        this.#initializedSettled = true;
        this.#rejectInitialized(failure);
      }
      for (const connection of this.#server.connections) connection.destroy();
    });
  }

  async waitUntilInitialized(): Promise<void> {
    await withTimeout(this.#initialized, 10_000);
  }

  async close(): Promise<void> {
    this.#stopping = true;
    await this.#run;
    if (this.#failure) throw this.#failure;
  }

  async #serve(): Promise<void> {
    const cursors = new Map<RawWebSocketConnection, number>();
    while (!this.#stopping) {
      for (const connection of this.#server.connections) {
        let cursor = cursors.get(connection) ?? 0;
        while (cursor < connection.frames.length) {
          const frame = connection.frames[cursor++]!;
          cursors.set(connection, cursor);
          if (frame.opcode !== 0x1) continue;
          const envelope = JSON.parse(frame.payload.toString("utf8")) as {
            readonly id?: unknown;
            readonly method?: unknown;
            readonly params?: unknown;
          };
          if (envelope.method === "initialize") {
            const clientName = nestedString(
              envelope.params,
              "clientInfo",
              "name",
            );
            if (clientName !== "sedes_web" || envelope.id === undefined) {
              throw new Error("minimal_codex_initialize_invalid");
            }
            await connection.sendText(
              JSON.stringify({
                id: envelope.id,
                result: {
                  userAgent:
                    `sedes_web/0.153.0 (Linux 6.8; x86_64) fixture (sedes_web; ${SEDES_VERSION})`,
                  codexHome: "/fixture/codex-home",
                  platformFamily: "unix",
                  platformOs: "linux",
                },
              }),
            );
            continue;
          }
          if (envelope.method === "initialized") {
            if (!this.#initializedSettled) {
              this.#initializedSettled = true;
              this.#resolveInitialized();
            }
            continue;
          }
          if (envelope.method === "thread/loaded/list" && envelope.id !== undefined) {
            await connection.sendText(JSON.stringify({ id: envelope.id, result: { data: [], nextCursor: null } }));
            continue;
          }
          if (envelope.method === "thread/list" && envelope.id !== undefined) {
            await connection.sendText(
              JSON.stringify({
                id: envelope.id,
                result: { data: [], nextCursor: null, backwardsCursor: null },
              }),
            );
            continue;
          }
          throw new Error(
            `minimal_codex_method_unexpected:${String(envelope.method)}`,
          );
        }
      }
      await delay(5);
    }
  }
}

class ProductionSshFixture {
  fetch: typeof fetch = () => { throw new Error("fixture_not_authenticated"); };

  async authenticate(application: RunningApplication): Promise<void> {
    this.fetch = await authenticatedProductionFetch(application);
  }

  readonly directory: string;
  readonly binDirectory: string;
  readonly stateDirectory: string;
  readonly configurationPath: string;
  readonly workspaceRoot: string;
  readonly remoteAccountHome: string;
  readonly remoteSocket: string;
  readonly httpPort: number;
  readonly peer: RawUdsWebSocketServer;
  readonly artifact: SidecarArtifactRegistration;
  readonly serviceScope: SidecarServiceScope;
  readonly #sshInvocationLog: string;
  readonly #sshd: ChildProcess;
  #closed = false;

  private constructor(input: {
    readonly directory: string;
    readonly binDirectory: string;
    readonly stateDirectory: string;
    readonly configurationPath: string;
    readonly workspaceRoot: string;
    readonly remoteAccountHome: string;
    readonly remoteSocket: string;
    readonly httpPort: number;
    readonly peer: RawUdsWebSocketServer;
    readonly artifact: SidecarArtifactRegistration;
    readonly serviceScope: SidecarServiceScope;
    readonly sshInvocationLog: string;
    readonly sshd: ChildProcess;
  }) {
    this.directory = input.directory;
    this.binDirectory = input.binDirectory;
    this.stateDirectory = input.stateDirectory;
    this.configurationPath = input.configurationPath;
    this.workspaceRoot = input.workspaceRoot;
    this.remoteAccountHome = input.remoteAccountHome;
    this.remoteSocket = input.remoteSocket;
    this.httpPort = input.httpPort;
    this.peer = input.peer;
    this.artifact = input.artifact;
    this.serviceScope = input.serviceScope;
    this.#sshInvocationLog = input.sshInvocationLog;
    this.#sshd = input.sshd;
  }

  get sshdRunning(): boolean {
    return this.#sshd.exitCode === null && this.#sshd.signalCode === null;
  }

  static async create(
    options: {
      readonly sidecar?: boolean;
      readonly agentToolsCli?: boolean;
      readonly directoryBrowser?: boolean;
      readonly piOnly?: boolean;
    } = {},
  ): Promise<ProductionSshFixture> {
    const directory = await mkdtemp(path.join(tmpdir(), "h-prod-ssh-"));
    await chmod(directory, 0o700);
    const binDirectory = path.join(directory, "bin");
    const stateDirectory = path.join(directory, "state");
    const workspaceRoot = path.join(directory, "workspaces");
    const remoteParent = path.join(directory, "remote-private");
    // Keep the agent-tool ingress socket within the Unix path byte limit.
    const remoteHome = path.join(directory, "h");
    for (const item of [
      binDirectory,
      workspaceRoot,
      remoteParent,
      remoteHome,
    ]) {
      await mkdir(item, { recursive: true, mode: 0o700 });
      await chmod(item, 0o700);
    }

    const hostKey = path.join(directory, "host-key");
    const clientKey = path.join(directory, "client-key");
    await generateKey(hostKey);
    await generateKey(clientKey);
    const authorizedKeys = path.join(directory, "authorized_keys");
    await writeFile(authorizedKeys, await readFile(`${clientKey}.pub`));
    await chmod(authorizedKeys, 0o600);

    const sshPort = await unusedLoopbackPort();
    const httpPort = await unusedLoopbackPort();
    const hostPublicKey = await readFile(`${hostKey}.pub`, "utf8");
    const knownHosts = path.join(directory, "known_hosts");
    await writeKnownHost(knownHosts, sshPort, hostPublicKey);
    const sshConfig = path.join(directory, "ssh_config");
    await writeFile(
      sshConfig,
      [
        "Host sedes-production-fixture",
        "  HostName 127.0.0.1",
        `  Port ${sshPort}`,
        `  User ${userInfo().username}`,
        `  IdentityFile ${clientKey}`,
        `  UserKnownHostsFile ${knownHosts}`,
        "  GlobalKnownHostsFile /dev/null",
        "  StrictHostKeyChecking yes",
        "  IdentitiesOnly yes",
        "  IdentityAgent none",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        "  PubkeyAuthentication yes",
        "  CheckHostIP no",
        "  SendEnv -LANG -LC_*",
        "  LogLevel ERROR",
        "",
      ].join("\n"),
    );
    await chmod(sshConfig, 0o600);
    const sshWrapper = path.join(binDirectory, "ssh");
    const sshInvocationLog = path.join(directory, "ssh-invocations.log");
    await writeFile(sshInvocationLog, "");
    await writeFile(
      sshWrapper,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> ${shellQuote(sshInvocationLog)}\nargs=("$@")\nlast_index=$((\${#args[@]} - 1))\nlast="\${args[$last_index]}"\nif [[ "$last" == "exec node "* ]]; then\n  args[$last_index]="export PATH=${binDirectory}:/usr/local/bin:/usr/bin:/bin; export HOME=${remoteHome}; $last"\nfi\nexec ${SSH} -F ${shellQuote(sshConfig)} "\${args[@]}"\n`,
    );
    await chmod(sshWrapper, 0o700);
    const nodeWrapper = path.join(binDirectory, "node");
    await writeFile(
      nodeWrapper,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`,
    );
    await chmod(nodeWrapper, 0o700);

    const sshdConfig = path.join(directory, "sshd_config");
    await writeFile(
      sshdConfig,
      [
        `Port ${sshPort}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `AuthorizedKeysFile ${authorizedKeys}`,
        `PidFile ${path.join(directory, "sshd.pid")}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PubkeyAuthentication yes",
        "AuthenticationMethods publickey",
        "UsePAM no",
        "StrictModes no",
        `AllowUsers ${userInfo().username}`,
        "AllowAgentForwarding no",
        "AllowTcpForwarding yes",
        "AllowStreamLocalForwarding yes",
        "GatewayPorts no",
        "PermitTTY no",
        "X11Forwarding no",
        "PermitUserEnvironment no",
        "LogLevel ERROR",
        "",
      ].join("\n"),
    );
    const sshd = spawn(SSHD, ["-D", "-e", "-f", sshdConfig], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let sshdStderr = "";
    sshd.stderr?.on("data", (chunk: Buffer) => {
      sshdStderr += chunk.toString("utf8");
    });

    const remoteSocket = path.join(remoteParent, "codex.sock");
    const peer = new RawUdsWebSocketServer({ socketPath: remoteSocket });
    try {
      await waitForLoopbackServer(sshPort, sshd, () => sshdStderr);
      await peer.listen();
      const configurationPath = path.join(directory, "backend.json");
      const legacyConfigurationPath = path.join(directory, "legacy-import.json");
      await writeFile(
        legacyConfigurationPath,
        JSON.stringify(
          productionConfiguration(
            workspaceRoot,
            remoteSocket,
            options.piOnly
              ? ([
                  "directory_browser",
                  "workspace_tools",
                  "workspace_context",
                ] as const)
              : options.agentToolsCli
                ? (["agent_tools_cli"] as const)
                : options.directoryBrowser
                  ? (["directory_browser"] as const)
                  : options.sidecar
                    ? (["workspace_files"] as const)
                    : false,
            options.piOnly === true,
          ),
          undefined,
          2,
        ),
      );
      const imported = await prepareBackendNormalizedDatabase({
        stateDirectory,
        legacyImport: {
          localWorkspaceRoots: [workspaceRoot],
          configuration: resolveBackendConfiguration(await loadBackendConfigurationFile(legacyConfigurationPath)),
          sourceLabel: "Disposable SSH fixture",
        },
        locksHeld: true,
        quiescentCutoverConfirmed: false,
      });
      const principalScope = new SingleUserIdentityProvider(imported.database).getScope();
      const installationKey = await loadOrCreateToolProvenanceKey(stateDirectory);
      const serviceScope = {
        ...principalScope,
        installationId: deriveSidecarInstallationIdentity(installationKey),
        executionEnvironmentId: SSH_ENVIRONMENT_ID,
      };
      imported.database.close();
      const artifact = await buildSidecarArtifact(directory);
      await writeFile(configurationPath, JSON.stringify({ schemaVersion: 11, packagedClients: [] }));
      return new ProductionSshFixture({
        directory,
        binDirectory,
        stateDirectory,
        configurationPath,
        workspaceRoot,
        remoteAccountHome: remoteHome,
        remoteSocket,
        httpPort,
        peer,
        artifact,
        serviceScope,
        sshInvocationLog,
        sshd,
      });
    } catch (error) {
      await peer.close().catch(() => undefined);
      await terminateChild(sshd);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async sshInvocations(): Promise<readonly string[]> {
    return (await readFile(this.#sshInvocationLog, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
  }

  async configuration() {
    const response = await this.fetch(`http://127.0.0.1:${this.httpPort}/api/configuration`);
    expect(response.status).toBe(200);
    return configurationSnapshotSchema.parse(await response.json());
  }

  async lifecycleEnvironment(action: ConfigurationLifecycleRequest["action"]) {
    const session = await readApplicationSession(this);
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken };
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.configuration();
      const impactResponse = await this.fetch(`http://127.0.0.1:${this.httpPort}/api/configuration/lifecycle/impact`, {
        method: "POST", headers,
        body: JSON.stringify({ resourceKind: "environment", resourceId: SSH_ENVIRONMENT_ID, action, expectedRevision: snapshot.revision }),
      });
      expect(impactResponse.status).toBe(200);
      const impact = configurationLifecycleImpactSchema.parse(await impactResponse.json());
      expect(impact.configurationRevision).toBe(snapshot.revision);
      const mutationId = randomUUID();
      const response = await this.fetch(`http://127.0.0.1:${this.httpPort}/api/configuration/lifecycle`, {
        method: "POST", headers,
        body: JSON.stringify({ mutationId, resourceKind: "environment", resourceId: SSH_ENVIRONMENT_ID, action,
          expectedRevision: snapshot.revision, expectedIncarnation: impact.incarnation, impactToken: impact.token }),
      });
      expect(response.status).toBe(200);
      const result = configurationLifecycleResultSchema.parse(await response.json());
      const receiptResponse = await this.fetch(`http://127.0.0.1:${this.httpPort}/api/configuration/lifecycle/${mutationId}`);
      expect(receiptResponse.status).toBe(200);
      expect(configurationLifecycleResultSchema.parse(await receiptResponse.json())).toEqual(result);
      // Authoritative activity can change after impact inspection. A rejected
      // mutation requires a fresh impact, revision, token and mutation identity.
      if (result.state === "rejected") {
        expect(result.runtime.lastError).toMatch(/changed|inspect|confirm/i);
        expect((await this.serviceStatus())?.serviceIncarnation).toBe(impact.incarnation);
        continue;
      }
      expect(result.state, JSON.stringify(result)).toBe("applied");
      return result;
    }
    throw new Error("fixture_configuration_lifecycle_confirmation_unstable");
  }

  async waitUntilTargetAvailable(): Promise<void> {
    await waitFor(async () =>
      (await readApplicationSnapshot(this)).executionTargets[0]?.available === true,
    10_000);
  }

  serviceStatus() {
    const paths = persistentSidecarPaths(this.remoteAccountHome, process.getuid!(), this.serviceScope);
    return inspectAtEndpoint(paths.endpointPath, this.serviceScope);
  }

  async stopService(): Promise<void> {
    const paths = persistentSidecarPaths(this.remoteAccountHome, process.getuid!(), this.serviceScope);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.serviceStatus();
      if (!current || current.state === "stopped") return;
      const socket = createConnection(paths.endpointPath);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const stream = sidecarSocketByteStream(socket);
      try {
        await writeSidecarManagementRecord(stream, {
          managementVersion: 1,
          requestId: randomUUID(),
          scope: this.serviceScope,
          operation: "stop",
          expectedServiceIncarnation: current.serviceIncarnation,
          controllerEpoch: current.controllerEpoch,
          expectedConfiguration: current.desiredConfiguration,
          expectedResourcesFingerprint: current.resourcesFingerprint,
          force: false,
        });
        const result = await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, AbortSignal.timeout(15_000));
        // Native activity inspection can establish new idle evidence. Confirm
        // that exact new snapshot before retrying the fixture's explicit stop.
        if (result.value.outcome === "error" && result.value.code === "sidecar_service_confirmation_stale") continue;
        if (result.value.outcome !== "ok" || result.value.status.state !== "stopped") {
          throw new Error(`fixture_persistent_service_stop_unconfirmed: ${JSON.stringify(result.value)}`);
        }
      } finally {
        await stream.close("fixture_service_stopped");
      }
      await waitFor(async () => {
        try { await lstat(paths.endpointPath); return false; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
          throw error;
        }
      }, 5_000);
      await rm(paths.socketDirectory, { recursive: true, force: true });
      return;
    }
    throw new Error("fixture_persistent_service_stop_confirmation_stale");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.stopService();
    await this.peer.close();
    await terminateChild(this.#sshd);
    await rm(this.directory, { recursive: true, force: true });
  }
}

function productionConfiguration(
  workspaceRoot: string,
  socketPath: string,
  sidecarCapabilities:
    | false
    | readonly (
        | "directory_browser"
        | "workspace_files"
        | "agent_tools_cli"
        | "workspace_tools"
        | "workspace_context"
      )[] = false,
  piOnly = false,
) {
  return {
    schemaVersion: 10,
    executionEnvironments: [
      { id: LOCAL_ENVIRONMENT_ID, kind: "local", label: "Local" },
      {
        id: SSH_ENVIRONMENT_ID,
        kind: "ssh",
        label: "Disposable SSH",
        hostAlias: "sedes-production-fixture",
        workspaceRoots: [workspaceRoot],
        operations: sidecarCapabilities
          ? {
              kind: "sidecar",
              deployment: "managed",
              carrier: { kind: "ssh_stdio" },
              enabledCapabilities: sidecarCapabilities,
            }
          : { kind: "none" },
      },
    ],
    backends: piOnly
      ? [
          {
            id: "pi-ssh-production-backend",
            kind: "pi",
            label: "Disposable Pi SDK",
            enabled: true,
            modelPolicy: { type: "catalog" },
          },
        ]
      : [
          {
            id: "codex-ssh-production-backend",
            kind: "codex_app_server",
            label: "Disposable Codex app server",
            enabled: true,
            modelPolicy: { type: "catalog" },
            moduleConfiguration: {
              connection: {
                ownership: "external",
                channel: { type: "unix_websocket", socketPath },
              },
              policy: {
                allowedSandboxModes: ["read-only"],
                allowedNetworkAccess: ["disabled"],
                allowedApprovalPolicies: ["never"],
                allowedApprovalReviewers: ["user"],
              },
            },
          },
        ],
    targets: piOnly
      ? [
          {
            id: "pi-ssh-production",
            kind: "pi_sdk",
            label: "Disposable remote Pi",
            backendInstanceId: "pi-ssh-production-backend",
            executionEnvironmentId: SSH_ENVIRONMENT_ID,
            enabled: true,
          },
        ]
      : [
          {
            id: "codex-ssh-production",
            kind: "codex_app_server",
            label: "Disposable remote Codex",
            backendInstanceId: "codex-ssh-production-backend",
            executionEnvironmentId: SSH_ENVIRONMENT_ID,
            enabled: true,
            moduleConfiguration: {
              defaults: {
                sandboxMode: "read-only",
                networkAccess: "disabled",
                approvalPolicy: "never",
                approvalReviewer: "user",
                model: { type: "catalogDefault" },
              },
            },
          },
        ],
    defaultTargetId: piOnly ? "pi-ssh-production" : "codex-ssh-production",
  };
}

function nestedString(
  value: unknown,
  objectKey: string,
  valueKey: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[objectKey];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    return undefined;
  }
  const result = (nested as Record<string, unknown>)[valueKey];
  return typeof result === "string" ? result : undefined;
}

async function generateKey(file: string): Promise<void> {
  await execFile(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", file]);
}

async function buildSidecarArtifact(
  directory: string,
): Promise<SidecarArtifactRegistration> {
  const executablePath = path.join(directory, "sedes");
  const buildId = "production-composition-test";
  await build({
    entryPoints: [path.resolve("src/server/sidecar/sedes-sidecar-main.ts")],
    outfile: executablePath,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    target: "node22",
    alias: { yaml: path.resolve("node_modules/yaml/browser/index.js") },
    define: {
      __SEDES_SIDECAR_BUILD_ID__: JSON.stringify(buildId),
    },
    logLevel: "silent",
  });
  await chmod(executablePath, 0o500);
  const bytes = await readFile(executablePath);
  return Object.freeze({
    artifactId: SIDECAR_ARTIFACT_ID,
    modes: SIDECAR_ARTIFACT_MODES,
    executableDirectory: directory,
    executablePath,
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    artifactBytes: bytes.byteLength,
    buildId,
    minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION,
    nativeAssets: [],
  });
}

async function writeKnownHost(
  file: string,
  port: number,
  publicKey: string,
): Promise<void> {
  const [kind, encoded] = publicKey.trim().split(/\s+/, 3);
  if (!kind || !encoded) throw new Error("fixture_public_key_invalid");
  await writeFile(file, `[127.0.0.1]:${port} ${kind} ${encoded}\n`);
  await chmod(file, 0o600);
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fixture_port_unavailable");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForLoopbackServer(
  port: number,
  child: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`fixture_sshd_exited:${stderr()}`);
    }
    const connected = await new Promise<boolean>((resolve) => {
      const client = createConnection({ host: "127.0.0.1", port });
      client.once("connect", () => {
        client.destroy();
        resolve(true);
      });
      client.once("error", () => resolve(false));
    });
    if (connected) return;
    await delay(20);
  }
  throw new Error(`fixture_sshd_start_timeout:${stderr()}`);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(1_000).then(() => false),
  ]);
  if (graceful) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(1_000)]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("fixture_operation_timeout")),
        milliseconds,
      ),
    ),
  ]);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  milliseconds: number,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("fixture_condition_timeout");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
