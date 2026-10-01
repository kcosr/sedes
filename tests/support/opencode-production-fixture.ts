import { boundedOpenCodeProcessFile } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { savedAgentOptionsResultSchema } from "../../src/shared/protocol/saved-agents.js";
import { qualifiedOpenCodeModelId } from "../../src/server/backends/opencode/opencode-model-selection.js";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { AuthenticationRepository } from "../../src/server/authentication/authentication-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { startProductionApplication, type RunningApplication } from "../../src/server/production-application.js";
import { deriveSidecarInstallationIdentity, loadOrCreateToolProvenanceKey } from "../../src/server/security/installation-secret.js";
import type { SidecarArtifactRegistration } from "../../src/server/sidecar/sidecar-artifact.js";
import { inspectAtEndpoint } from "../../src/server/sidecar/persistent-sidecar-bootstrap.js";
import { persistentSidecarPaths } from "../../src/server/sidecar/persistent-sidecar-paths.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import { readSidecarManagementRecord, writeSidecarManagementRecord } from "../../src/internal/sidecar-protocol/service-management-channel.js";
import { sidecarManagementResponseSchema, type SidecarServiceScope } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { normalizedApplicationSessionSchema, normalizedApplicationSnapshotSchema } from "../../src/shared/protocol/application.js";
import { configurationSnapshotSchema, configurationLifecycleImpactSchema, configurationLifecycleResultSchema } from "../../src/shared/protocol/configuration-admin.js";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { acceptHostRegistrationResultSchema, hostPairingListSchema } from "../../src/shared/protocol/host-pairing.js";
import { prepareOpencodeNativeAccount, startOpencodeNativeFixture, type OpenCodeNativeAccount, type OpenCodeNativeFixture } from "./opencode-native-fixture.js";
import { startOpencodeModelFixture } from "./opencode-model-fixture.js";
import { vi } from "vitest";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import type { OpenCodeBackendModule } from "../../src/server/backends/opencode/opencode-backend-module.js";
import { OpenCodeRuntime } from "../../src/server/backends/opencode/opencode-runtime.js";
import { buildProductionSidecarArtifact, buildProductionOutboundConnector, startProductionSshServer, terminateChild } from "./production-carrier-fixture.js";
import { terminateProcessesReferencing } from "./process-cleanup.js";

const execFile = promisify(execFileCallback);
const PASSWORD_VARIABLE = "SEDES_OPENCODE_FIXTURE_PASSWORD";
export type OpenCodeProductionTopology = "local" | "ssh" | "outbound";
export type OpenCodeProductionOwnership = "owned" | "external";
const CAPABILITIES = ["directory_browser", "workspace_files", "workspace_tools", "workspace_context", "workspace_skills", "composer_attachments", "agent_tools_cli"] as const;

/** Runs the actual production app, stock native binary and (when remote) real carrier and release sidecar. */
export class OpenCodeProductionFixture {
  application: RunningApplication | undefined;
  connector: ChildProcess | undefined;
  ssh: Awaited<ReturnType<typeof startProductionSshServer>> | undefined;
  serviceScope: SidecarServiceScope | undefined;
  environmentId: string = randomUUID();
  readonly backendId = "stock-opencode";
  readonly targetTemplateId = "stock-opencode-target";
  targetId = "";
  readonly authentication: AuthenticationRepository;
  readonly credential: string;
  readonly streams = new Map<AbortController, Promise<void>>();
  readonly streamErrors: string[] = [];
  readonly lifecycleAttempts: Array<{ action: string; attempts: number }> = [];
  logs = "";
  streamText = "";
  port = 0;
  private connectorEnrolled = false;
  private previousPath: string | undefined;
  private restoreNativeRuntimeFactory: (() => void) | undefined;
  private constructor(readonly topology: OpenCodeProductionTopology, readonly ownership: OpenCodeProductionOwnership,
    readonly directory: string, readonly account: OpenCodeNativeAccount,
    readonly native: OpenCodeNativeFixture | undefined, readonly model: Awaited<ReturnType<typeof startOpencodeModelFixture>>,
    readonly artifact: SidecarArtifactRegistration, readonly connectorPath: string, readonly hostNodeExecutable: string) {
    this.authentication = new AuthenticationRepository(this.stateDirectory);
    const pairing = this.authentication.createPairing({ kind: "management" });
    this.credential = this.authentication.exchangePairing({ token: pairing.token, clientName: "OpenCode stock qualification", kind: "device" })!.credential;
  }
  get stateDirectory() { return path.join(this.directory, "main"); }
  get configurationPath() { return path.join(this.directory, "server.json"); }
  get workspace() { return this.account.workspace; }
  get hostHome() { return this.account.environment.HOME!; }
  get url() { return `http://127.0.0.1:${this.port}`; }
  get hostEnvironment(): NodeJS.ProcessEnv {
    const { OPENCODE_PASSWORD: _nativeCredential, ...environment } = this.account.environment;
    return { ...environment, ...(this.topology === "local" ? { [PASSWORD_VARIABLE]: this.account.password } : {}) };
  }

  static async create(topology: OpenCodeProductionTopology, ownership: OpenCodeProductionOwnership, options: {
    readonly beforeBackend?: (fixture: OpenCodeProductionFixture) => Promise<void>;
    readonly waitReady?: boolean;
  } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oc-prod-"));
    const model = await startOpencodeModelFixture();
    let account: OpenCodeNativeAccount | undefined;
    let native: OpenCodeNativeFixture | undefined;
    let fixture: OpenCodeProductionFixture | undefined;
    try {
      if (ownership === "external") { native = await startOpencodeNativeFixture({ config: model.config }); account = native.account; }
      else account = await prepareOpencodeNativeAccount({ config: model.config });
      await writeFile(path.join(account.rootDirectory, "http-password"), account.password, { mode: 0o600 });
      await execFile("git", ["init", "--quiet", account.workspace]);
      await writeFile(path.join(account.workspace, "fixture.txt"), "isolated OpenCode carrier qualification\n");
      await writeFile(path.join(directory, "server.json"), JSON.stringify({ schemaVersion: 11, packagedClients: [] }));
      const artifact = await buildProductionSidecarArtifact(path.join(directory, "artifact"));
      const connectorPath = path.join(directory, "connector.mjs");
      if (topology === "outbound") await buildProductionOutboundConnector(connectorPath);
      fixture = new OpenCodeProductionFixture(topology, ownership, directory, account, native, model, artifact, connectorPath, process.env.SEDES_REAL_OPENCODE_HOST_NODE_EXECUTABLE ?? process.execPath);
      if (topology === "ssh") {
        const binDirectory = path.join(directory, "bin"); await mkdir(binDirectory, { mode: 0o700 });
        fixture.ssh = await startProductionSshServer({ directory, binDirectory, remoteHome: fixture.hostHome, environment: fixture.hostEnvironment, nodeExecutable: fixture.hostNodeExecutable });
        fixture.previousPath = process.env.PATH; process.env.PATH = `${binDirectory}:${process.env.PATH ?? ""}`;
      }
      await fixture.startMain();
      if (topology === "outbound") await fixture.enroll();
      else await fixture.addEnvironment();
      await options.beforeBackend?.(fixture);
      await fixture.addBackend(options.waitReady ?? true);
      return fixture;
    } catch (error) {
      if (fixture) await fixture.close();
      else { await native?.stop(); if (!native) await account?.close(); await model.stop(); await rm(directory, { recursive: true, force: true }); }
      throw error;
    }
  }

  async startMain() {
    if (this.topology === "local" && !this.restoreNativeRuntimeFactory) {
      // Source production composition runs in the Vitest process. Isolate its
      // Sedes ownership files independently of the provider HOME without
      // changing the process environment or replacing the native runtime.
      const module = compiledBackendModuleCatalog.requireModule("opencode") as OpenCodeBackendModule;
      const factory = vi.spyOn(module, "createNativeRuntime").mockImplementation(input => new OpenCodeRuntime({
        ...input, ownershipDirectory: path.join(this.directory, "main-owners"),
      }));
      this.restoreNativeRuntimeFactory = () => factory.mockRestore();
    }
    // Remote fixtures use a distinct main account baseline. The matrix also
    // denies main native identity/secret APIs because the OS UID is shared.
    const environment = this.topology === "local" ? this.hostEnvironment : {
      PATH: process.env.PATH, HOME: path.join(this.directory, "main-home"), LANG: "C.UTF-8", SHELL: "/bin/sh",
    };
    await mkdir(environment.HOME!, { recursive: true, mode: 0o700 });
    this.application = await startProductionApplication({ ...environment, APP_STATE_DIR: this.stateDirectory,
      SEDES_CONFIG_FILE: this.configurationPath, PORT: String(this.port) }, {
      sidecarArtifactRegistration: this.artifact,
      ...(this.topology === "ssh" ? { sidecarAccountHomeForTests: this.hostHome } : {}),
    });
    this.port = this.application.listening.port;
  }
  async stopMain() { await this.closeStreams(); const app = this.application; this.application = undefined; await app?.close(); }
  async addEnvironment() {
    const snapshot = await this.configuration(); const configuration = snapshot.configuration;
    configuration.executionEnvironments.push(this.topology === "local"
      ? { id: this.environmentId, kind: "local", label: "Isolated local", workspaceRoots: [this.workspace], workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }
      : { id: this.environmentId, kind: "ssh", label: "Actual OpenSSH", hostAlias: "sedes-production-fixture", workspaceRoots: [this.workspace], operations: { kind: "sidecar", enabledCapabilities: [...CAPABILITIES] } });
    await this.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    if (this.topology === "ssh") {
      const db = new Database(path.join(this.stateDirectory, "overlay.sqlite"));
      try { this.serviceScope = { ...new SingleUserIdentityProvider(db).getScope(),
        installationId: deriveSidecarInstallationIdentity(await loadOrCreateToolProvenanceKey(this.stateDirectory)), executionEnvironmentId: this.environmentId }; }
      finally { db.close(); }
    }
  }
  async enroll() {
    this.startConnector();
    await this.waitFor(async () => (await this.pairings()).registrations.length === 1);
    const pending = (await this.pairings()).registrations[0]!;
    const accepted = acceptHostRegistrationResultSchema.parse(await this.json("/api/host-registrations/accept", "POST", {
      mutationId: randomUUID(), registrationId: pending.id, expectedRegistrationRevision: pending.revision,
      expectedConfigurationRevision: (await this.configuration()).revision,
      label: "Actual outbound connector", workspaceRoots: [this.workspace], operations: { kind: "sidecar", enabledCapabilities: [...CAPABILITIES] },
    }));
    this.environmentId = accepted.pairing.executionEnvironmentId;
    await this.waitFor(async () => {
      try { const value = JSON.parse(await readFile(path.join(this.hostHome, "connector", "identity.json"), "utf8")); this.serviceScope = value.binding.scope; return true; }
      catch { return false; }
    });
    await this.waitFor(async () => (await this.snapshot()).environments.some(item => item.id === this.environmentId && item.available));
  }
  startConnector() {
    if (this.connector) throw new Error("fixture_connector_running");
    const enrollment = this.connectorEnrolled ? [] : ["--pairing-code", this.authentication.createPairing({ kind: "sidecar" }).token];
    this.connectorEnrolled = true;
    this.connector = spawn(this.hostNodeExecutable, [this.connectorPath, "connect", "--server", this.url, "--state-directory", path.join(this.hostHome, "connector"), ...enrollment],
      { env: this.hostEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    for (const output of [this.connector.stdout, this.connector.stderr]) output?.on("data", data => { this.logs = (this.logs + String(data)).slice(-16_384); });
  }
  async stopConnector() { const child = this.connector; this.connector = undefined; if (child) await terminateChild(child); }
  async addBackend(waitReady = true) {
    const snapshot = await this.configuration(); const configuration = snapshot.configuration;
    configuration.backends.push({ id: this.backendId, kind: "opencode", label: "Stock OpenCode v2", enabled: true, modelPolicy: { type: "catalog" },
      ...(this.ownership === "owned" ? { environmentVariables: { execution: {}, startup: Object.fromEntries(
        ["OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_MODELS_PATH", "OPENCODE_DISABLE_FFF", "OPENCODE_FILEWATCHER_DISABLE", "OPENCODE_PRODUCTION_FIXTURE_OWNER"]
          .map(name => [name, { kind: "literal" as const, value: this.account.environment[name]! }])) } } : {}), moduleConfiguration: {
      nativeStorePath: this.account.nativeStorePath, configDirectory: this.account.configDirectory,
      connection: this.ownership === "owned" ? { ownership: "owned", channel: { type: "process_stdio", executablePath: this.account.executable, workingDirectory: this.workspace } }
        : { ownership: "external", channel: { type: "http", url: this.native!.url,
          authentication: { type: "basic", username: "opencode", secret: this.topology === "local" ? { source: "environment", variable: PASSWORD_VARIABLE } : { source: "protected_file", path: path.join(this.account.rootDirectory, "http-password") } } } },
    } });
    configuration.targets.push({ id: this.targetTemplateId, kind: "opencode_http", label: "Stock OpenCode target", backendInstanceId: this.backendId,
      executionEnvironmentId: this.environmentId, enabled: true, moduleConfiguration: { defaults: { model: { type: "fixed", modelId: qualifiedOpenCodeModelId({ providerID: "probe", id: "probe-model" }) }, variant: { type: "modelDefault" } } } });
    configuration.defaultTargetId = this.targetTemplateId;
    await this.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    if (waitReady) await this.waitReady();
  }
  async waitReady() { await this.waitFor(async () => {
    const snapshot = await this.snapshot();
    const target = snapshot.executionTargets.find(item => item.id === snapshot.defaultNewThreadTargetId && item.environmentId === this.environmentId);
    if (!target?.available) return false;
    this.targetId = target.id; return true;
  }); }
  async createThread() {
    const workspace = await this.json("/api/workspaces/open", "POST", { path: this.workspace, environmentId: this.environmentId }) as { id: string };
    // Stock provider plugins settle asynchronously after native startup. Use
    // the same fresh editor catalog read as the UI, not a synthetic session.
    await this.waitFor(async () => {
      const response = await this.request("/api/agents/options", "POST", { workspaceId: workspace.id, targetId: this.targetId });
      const value: unknown = await response.json();
      if (response.status === 400 && JSON.stringify(value).includes("invalid_transition")) return false;
      if (response.status !== 200) throw new Error(`fixture_catalog:${response.status}:${JSON.stringify(value)}`);
      const options = savedAgentOptionsResultSchema.parse(value);
      return options.kind === "configuration" && options.configuration.fields.some(field => field.id === "model" && field.options.some(option => option.available && String(option.value) === qualifiedOpenCodeModelId({ providerID: "probe", id: "probe-model" })));
    });
    const created = await this.json("/api/threads", "POST", { workspaceId: workspace.id, title: "Stock OpenCode qualification", executionWorkspace: { kind: "direct" }, configuration: { kind: "custom", targetId: this.targetId, sedesTools: { enabled: true, enabledToolIds: ["thread.status"], presentation: { surface: "native", mode: "progressive" }, accessBoundary: "thread" } } }) as { threadId: string };
    await this.openStream(created.threadId);
    return created.threadId;
  }
  async send(threadId: string, text: string) {
    let snapshot = await this.thread(threadId);
    await this.json(`/api/threads/${threadId}/draft`, "PUT", { text, contextExcerpts: [], attachmentIds: [], taskReferenceIds: [], expectedRevision: snapshot.draft.revision });
    snapshot = await this.thread(threadId);
    return this.json(`/api/threads/${threadId}/operations`, "POST", { kind: "deliver", mode: "submit", mutationId: randomUUID(), expectedThreadRevision: snapshot.thread.threadRevision, expectedDraftRevision: snapshot.draft.revision });
  }
  async lifecycle(action: "connect" | "disconnect" | "start" | "stop", resourceKind: "backend" | "environment" = "backend") {
    const results: unknown[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const identity = { resourceKind, resourceId: resourceKind === "backend" ? this.backendId : this.environmentId, action, expectedRevision: (await this.configuration()).revision };
      const impact = configurationLifecycleImpactSchema.parse(await this.json("/api/configuration/lifecycle/impact", "POST", identity));
      const mutationId = randomUUID();
      let result = configurationLifecycleResultSchema.parse(await this.json("/api/configuration/lifecycle", "POST", { ...identity, mutationId, expectedIncarnation: impact.incarnation, impactToken: impact.token }));
      if (result.state === "pending" || result.state === "unknown") {
        // Stop can retire the management endpoint before its response arrives.
        // Recover the same durable command; never send another native effect.
        await this.waitFor(async () => {
          result = configurationLifecycleResultSchema.parse(await this.json(`/api/configuration/lifecycle/${mutationId}`));
          return result.state !== "pending" && result.state !== "unknown";
        });
      }
      if (JSON.stringify(await this.json(`/api/configuration/lifecycle/${mutationId}`)) !== JSON.stringify(result)) throw new Error("fixture_lifecycle_receipt_changed");
      if (result.state === "rejected") { results.push(result); continue; }
      if (result.state !== "applied") throw new Error(`fixture_lifecycle_not_applied:${JSON.stringify(result)}`);
      this.lifecycleAttempts.push({ action, attempts: attempt + 1 });
      return result;
    }
    throw new Error(`fixture_lifecycle_confirmation_unstable:${action}:${JSON.stringify(results)}:${JSON.stringify((await this.configuration()).runtimes)}`);
  }
  async openStream(threadId: string) {
    const controller = new AbortController();
    const response = await fetch(`${this.url}/api/threads/${threadId}/events?activityDetail=full`, { headers: { Authorization: `Bearer ${this.credential}` }, signal: controller.signal });
    if (response.status !== 200 || !response.body) throw new Error("fixture_thread_stream_unavailable");
    const task = (async () => { try { for await (const chunk of response.body!) { this.streamText = (this.streamText + new TextDecoder().decode(chunk)).slice(-256 * 1024); } }
      catch (error) { if (!controller.signal.aborted) this.streamErrors.push(String(error)); }
      finally { this.streams.delete(controller); } })();
    this.streams.set(controller, task);
  }
  async closeStreams() { const streams = [...this.streams]; for (const [controller] of streams) controller.abort(); await Promise.all(streams.map(([, task]) => task)); }
  async request(route: string, method = "GET", body?: unknown) {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.credential}` };
    if (method !== "GET") { headers["X-CSRF-Token"] = normalizedApplicationSessionSchema.parse(await this.json("/api/application/session")).csrfToken; headers["Content-Type"] = "application/json"; }
    return fetch(`${this.url}${route}`, { method, headers, signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async json(route: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await this.request(route, method, body); const value = await response.json();
    if (response.status !== 200 && response.status !== 201) throw new Error(`fixture_http:${route}:${response.status}:${JSON.stringify(value)}:${this.logs}`);
    return value;
  }
  async configuration() { return configurationSnapshotSchema.parse(await this.json("/api/configuration")); }
  async snapshot() { return normalizedApplicationSnapshotSchema.parse(await this.json("/api/application/snapshot")); }
  async pairings() { return hostPairingListSchema.parse(await this.json("/api/host-registrations")); }
  async thread(threadId: string) { return normalizedThreadSnapshotSchema.parse(await this.json(`/api/threads/${threadId}?activityDetail=full`)); }
  async serviceStatus() { return this.serviceScope ? inspectAtEndpoint(persistentSidecarPaths(this.hostHome, process.getuid!(), this.serviceScope).endpointPath, this.serviceScope) : undefined; }
  async hostNodeVersion(): Promise<string> {
    if (!this.serviceScope) throw new Error("fixture_service_scope_missing");
    const descriptor = JSON.parse(await readFile(persistentSidecarPaths(this.hostHome, process.getuid!(), this.serviceScope).descriptorPath, "utf8"));
    if (descriptor.state !== "running" || !Number.isSafeInteger(descriptor.process?.pid)) throw new Error("fixture_service_process_missing");
    const actual = await readlink(`/proc/${descriptor.process.pid}/exe`);
    if (actual !== await realpath(this.hostNodeExecutable)) throw new Error("fixture_service_node_mismatch");
    return (await execFile(actual, ["--version"])).stdout.trim();
  }
  async nativePid(): Promise<number> {
    if (this.native) return this.native.pid;
    for (const name of await readdir("/proc")) {
      if (!/^[1-9]\d*$/u.test(name)) continue;
      try {
        if (await readlink(`/proc/${name}/exe`) !== this.account.executable) continue;
        const environment = (await boundedOpenCodeProcessFile(`/proc/${name}/environ`, 1024 * 1024)).toString("utf8");
        if (environment.split("\0").includes(`OPENCODE_DB=${this.account.nativeStorePath}`)) return Number(name);
      } catch { /* The process may have exited or belong to another account. */ }
    }
    throw new Error("fixture_owned_native_missing");
  }
  async waitFor(predicate: () => Promise<boolean>, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
    throw new Error(`fixture_timeout:${this.logs}:${this.application ? JSON.stringify({ snapshot: await this.snapshot(), runtimes: (await this.configuration()).runtimes }) : "main_closed"}`);
  }
  async close() {
    const failures: unknown[] = []; const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { failures.push(error); } };
    await attempt(() => this.stopConnector()); await attempt(() => this.stopMain());
    const scope = this.serviceScope;
    if (scope) await attempt(async () => {
      for (let count = 0; count < 20; count++) {
        const status = await this.serviceStatus(); if (!status || status.state === "stopped") return;
        const stream = sidecarSocketByteStream(connect(persistentSidecarPaths(this.hostHome, process.getuid!(), scope).endpointPath));
        try {
          await writeSidecarManagementRecord(stream, { managementVersion: 1, requestId: randomUUID(), scope, operation: "stop",
            expectedServiceIncarnation: status.serviceIncarnation, controllerEpoch: status.controllerEpoch,
            expectedConfiguration: status.desiredConfiguration, expectedResourcesFingerprint: status.resourcesFingerprint, force: true });
          const response = await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, AbortSignal.timeout(10_000));
          if (response.value.outcome === "ok") return;
          if (response.value.outcome !== "error" || response.value.code !== "sidecar_service_confirmation_stale") throw new Error(`fixture_service_stop:${JSON.stringify(response.value)}`);
        } finally { await stream.close("fixture_cleanup"); }
        await delay(50);
      }
      throw new Error("fixture_service_stop_unconfirmed");
    });
    if (this.ssh) await attempt(() => terminateChild(this.ssh!.child));
    await attempt(() => terminateProcessesReferencing(this.directory));
    await attempt(() => this.native ? this.native.stop() : this.account.close());
    await attempt(() => this.model.stop()); this.authentication.close();
    this.restoreNativeRuntimeFactory?.(); this.restoreNativeRuntimeFactory = undefined;
    if (this.ssh) { if (this.previousPath === undefined) delete process.env.PATH; else process.env.PATH = this.previousPath; }
    if (scope) await attempt(() => rm(persistentSidecarPaths(this.hostHome, process.getuid!(), scope).socketDirectory, { recursive: true, force: true }));
    if (!failures.length) await rm(this.directory, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, "OpenCode production fixture cleanup failed; retained fixture directory");
  }
}

export async function fixtureProcessAlive(pid: number) {
  try { const value = await readFile(`/proc/${pid}/stat`, "utf8"); return !["Z", "X"].includes(value.slice(value.lastIndexOf(")") + 2).split(" ")[0]!); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
