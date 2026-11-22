import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { RunningApplication } from "../../src/server/production-application.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { deriveSidecarInstallationIdentity, loadOrCreateToolProvenanceKey } from "../../src/server/security/installation-secret.js";
import type { SidecarArtifactRegistration } from "../../src/server/sidecar/sidecar-artifact.js";
import { inspectAtEndpoint } from "../../src/server/sidecar/persistent-sidecar-bootstrap.js";
import { persistentSidecarPaths } from "../../src/server/sidecar/persistent-sidecar-paths.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import { readSidecarManagementRecord, writeSidecarManagementRecord } from "../../src/internal/sidecar-protocol/service-management-channel.js";
import { sidecarManagementResponseSchema, type SidecarServiceScope } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { configurationSnapshotSchema } from "../../src/shared/protocol/configuration-admin.js";
import { normalizedApplicationSessionSchema, normalizedApplicationSnapshotSchema } from "../../src/shared/protocol/application.js";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { createThreadResultSchema } from "../../src/shared/protocol/api.js";
import { buildProductionSidecarArtifact, productionOpenSshAvailable, shellQuote, startProductionSshServer, terminateChild } from "./production-carrier-fixture.js";

export type AntigravityProductionTopology = "local" | "ssh";
const SSH_CAPABILITIES = ["directory_browser", "workspace_files", "workspace_tools", "workspace_context", "workspace_skills", "composer_attachments", "agent_tools_cli"] as const;

/** A real production composition with disposable application and workspace state.
 * The default peer is offline; live callers must explicitly select their CLI.
 */
export class AntigravityProductionFixture {
  readonly environmentId = randomUUID();
  readonly backendId = "antigravity-fixture";
  readonly targetTemplateId = "antigravity-fixture-target";
  targetId = "";
  workspaceId = "";
  application!: RunningApplication;
  ssh?: Awaited<ReturnType<typeof startProductionSshServer>>;
  serviceScope?: SidecarServiceScope;
  private artifact?: SidecarArtifactRegistration;
  private previousPath?: string;
  readonly streams = new Map<AbortController, Promise<void>>();
  readonly streamErrors: string[] = [];
  private constructor(readonly directory: string, readonly topology: AntigravityProductionTopology) {}
  get workspace() { return path.join(this.directory, "workspace"); }
  get hostHome() { return path.join(this.directory, "host-home"); }
  get binDirectory() { return path.join(this.directory, "bin"); }
  get url() { return `http://127.0.0.1:${this.application.listening.port}`; }

  static async create(options: {
    readonly parentDirectory?: string;
    readonly topology?: AntigravityProductionTopology;
    readonly executablePath?: string;
    readonly geminiDirectory?: string;
    readonly defaults?: { modelId?: string; thinkingLevel?: string; modeId?: string };
  } = {}) {
    const parent = options.parentDirectory ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const fixture = new AntigravityProductionFixture(await mkdtemp(path.join(parent, "antigravity-production-")), options.topology ?? "local");
    try {
      await mkdir(fixture.workspace);
      if (fixture.topology === "ssh") {
        if (!productionOpenSshAvailable) throw new Error("antigravity_fixture_openssh_unavailable");
        for (const directory of [fixture.hostHome, fixture.binDirectory, path.join(fixture.directory, "main-home")]) await mkdir(directory, { mode: 0o700 });
        fixture.artifact = await buildProductionSidecarArtifact(path.join(fixture.directory, "artifact"));
        fixture.ssh = await startProductionSshServer({ directory: fixture.directory, binDirectory: fixture.binDirectory, remoteHome: fixture.hostHome,
          environment: { LANG: "C.UTF-8", SHELL: "/bin/sh" } });
        // Production resolves the SSH executable from the process PATH. Every
        // invocation uses only this fixture's pinned keys and account home.
        fixture.previousPath = process.env.PATH;
        process.env.PATH = `${fixture.binDirectory}:${process.env.PATH ?? ""}`;
      }
      const configPath = path.join(fixture.directory, "server.json");
      await writeFile(configPath, JSON.stringify({ schemaVersion: 11, packagedClients: [] }));
      // Use the built composition so static assets, sidecar and agent-tool CLI
      // resolve exactly as they do in the packaged server.
      const { startProductionApplication } = await import(new URL("../../dist/server/production-application.js", import.meta.url).href) as typeof import("../../src/server/production-application.js");
      const environment = fixture.topology === "local" ? process.env : { PATH: process.env.PATH,
        HOME: path.join(fixture.directory, "main-home"), LANG: "C.UTF-8", SHELL: "/bin/sh" };
      fixture.application = await startProductionApplication({
        ...environment, APP_STATE_DIR: path.join(fixture.directory, "main"), SEDES_CONFIG_FILE: configPath,
        SEDES_AUTH_REQUIRED: "false", SEDES_BIND_HOST: "127.0.0.1", PORT: "0",
        XDG_RUNTIME_DIR: path.join(fixture.directory, "runtime"),
      }, fixture.artifact ? { sidecarArtifactRegistration: fixture.artifact, sidecarAccountHomeForTests: fixture.hostHome } : {});
      if (fixture.topology === "ssh") {
        const database = new Database(path.join(fixture.directory, "main", "overlay.sqlite"), { readonly: true });
        try { fixture.serviceScope = { ...new SingleUserIdentityProvider(database).getScope(), executionEnvironmentId: fixture.environmentId,
          installationId: deriveSidecarInstallationIdentity(await loadOrCreateToolProvenanceKey(path.join(fixture.directory, "main"))) }; }
        finally { database.close(); }
      }
      const snapshot = configurationSnapshotSchema.parse(await fixture.json("/api/configuration"));
      await fixture.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: snapshot.revision,
        configuration: {
          executionEnvironments: [fixture.topology === "local"
            ? { id: fixture.environmentId, kind: "local", label: "Antigravity host", workspaceRoots: [fixture.workspace],
              workspaceIsolation: { kind: "bubblewrap", networkProfiles: ["isolated"] } }
            : { id: fixture.environmentId, kind: "ssh", label: "Antigravity SSH host", hostAlias: "sedes-production-fixture", connectionCompression: true,
              workspaceRoots: [fixture.workspace], operations: { kind: "sidecar", enabledCapabilities: [...SSH_CAPABILITIES] } }],
          backends: [{ id: fixture.backendId, kind: "antigravity", label: "Antigravity", enabled: true, modelPolicy: { type: "catalog" },
            moduleConfiguration: {
              executablePath: options.executablePath ?? fileURLToPath(new URL("../fixtures/antigravity/fake-antigravity-acp-peer.mjs", import.meta.url)),
              ...((options.geminiDirectory || !options.executablePath) ? { geminiDirectory: options.geminiDirectory ?? path.join(fixture.directory, "gemini") } : {}),
            } }],
          targets: [{ id: fixture.targetTemplateId, kind: "antigravity_acp", backendInstanceId: fixture.backendId,
            executionEnvironmentId: fixture.environmentId, label: "Antigravity", enabled: true,
            moduleConfiguration: { defaults: options.defaults ?? (options.executablePath ? {} : { modelId: "fixture-model", thinkingLevel: "low" }) } }],
          defaultTargetId: fixture.targetTemplateId, webSearch: null,
        } });
      const readyDeadline = Date.now() + 30_000;
      do {
        const application = normalizedApplicationSnapshotSchema.parse(await fixture.json("/api/application/snapshot"));
        const target = application.executionTargets.find(value => value.environmentId === fixture.environmentId);
        if (target?.available) { fixture.targetId = target.id; break; }
        if (fixture.topology === "local") break;
        await delay(100);
      } while (Date.now() < readyDeadline);
      if (!fixture.targetId) throw new Error(`antigravity_fixture_target_unavailable:${JSON.stringify((await fixture.json("/api/configuration")))}`);
      const workspace = await fixture.json("/api/workspaces/open", "POST", { path: fixture.workspace, environmentId: fixture.environmentId,
        project: { kind: "new", name: "Antigravity qualification" } }) as { id: string };
      fixture.workspaceId = workspace.id;
      return fixture;
    } catch (error) {
      await fixture.close();
      throw error;
    }
  }

  async json(route: string, method = "GET", body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      headers["X-CSRF-Token"] = normalizedApplicationSessionSchema.parse(await this.json("/api/application/session")).csrfToken;
    }
    const response = await fetch(`${this.url}${route}`, { method, headers, signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(`antigravity_fixture_http:${method}:${route}:${response.status}:${JSON.stringify(result)}`);
    return result;
  }
  async createThread(options: { title?: string; toolPolicySelection?: unknown; toolPresentation?: unknown } = {}) {
    return createThreadResultSchema.parse(await this.json("/api/threads", "POST", {
      workspaceId: this.workspaceId, title: options.title ?? "Antigravity qualification", executionWorkspace: { kind: "direct" },
      configuration: { kind: "custom", targetId: this.targetId },
      ...(options.toolPolicySelection ? { toolPolicySelection: options.toolPolicySelection } : {}),
      ...(options.toolPresentation ? { toolPresentation: options.toolPresentation } : {}),
    })).threadId;
  }
  async thread(threadId: string) { return normalizedThreadSnapshotSchema.parse(await this.json(`/api/threads/${threadId}?activityDetail=full`)); }
  async send(threadId: string, text: string) {
    let snapshot = await this.thread(threadId);
    await this.json(`/api/threads/${threadId}/draft`, "PUT", { text, contextExcerpts: [], attachmentIds: [], taskReferenceIds: [], expectedRevision: snapshot.draft.revision });
    snapshot = await this.thread(threadId);
    return this.json(`/api/threads/${threadId}/operations`, "POST", { kind: "deliver", mode: "submit", mutationId: randomUUID(),
      expectedThreadRevision: snapshot.thread.threadRevision, expectedDraftRevision: snapshot.draft.revision });
  }
  async openStream(threadId: string) {
    const controller = new AbortController();
    const response = await fetch(`${this.url}/api/threads/${threadId}/events?activityDetail=full`, { signal: controller.signal });
    if (!response.ok || !response.body) { controller.abort(); throw new Error("antigravity_fixture_stream_unavailable"); }
    const task = (async () => { try { for await (const _chunk of response.body!) { /* Keep the real application subscription attached. */ } }
      catch (error) { if (!controller.signal.aborted) this.streamErrors.push(String(error)); }
      finally { this.streams.delete(controller); } })();
    this.streams.set(controller, task);
  }
  async closeStreams() {
    const streams = [...this.streams]; for (const [controller] of streams) controller.abort();
    await Promise.all(streams.map(([, task]) => task));
  }
  async serviceStatus() {
    return this.serviceScope ? inspectAtEndpoint(persistentSidecarPaths(this.hostHome, process.getuid!(), this.serviceScope).endpointPath, this.serviceScope) : undefined;
  }
  async toolCommand(threadId: string): Promise<string> {
    let executable = fileURLToPath(new URL("../../dist/cli/provider-bin/sedes", import.meta.url));
    let inheritedPath = process.env.PATH ?? "";
    if (this.topology === "ssh") {
      const status = await this.serviceStatus();
      if (!status || status.state !== "ready" || !status.attached || status.artifactSha256 !== this.artifact?.artifactSha256)
        throw new Error("antigravity_fixture_remote_service_unavailable");
      executable = path.join(this.hostHome, ".local", "state", "sedes", "sidecar", "artifacts", "sha256", status.artifactSha256, "sedes");
      inheritedPath = `${this.binDirectory}:/usr/local/bin:/usr/bin:/bin`;
    }
    return `PATH=${shellQuote(inheritedPath)} ${shellQuote(executable)} tool invoke thread.status --input-json ${shellQuote(JSON.stringify({ threadId }))} --json`;
  }
  private async stopService() {
    const scope = this.serviceScope;
    if (!scope) return;
    const paths = persistentSidecarPaths(this.hostHome, process.getuid!(), scope);
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await this.serviceStatus();
      if (status?.state === "stopped") return;
      if (!status) {
        // A missing endpoint alone is not proof of provider cleanup. A stopped
        // descriptor, or no service ever created in this private scope, is.
        try {
          const descriptor = JSON.parse(await readFile(paths.descriptorPath, "utf8")) as { state?: string; scope?: SidecarServiceScope };
          if (descriptor.state === "stopped" && Object.entries(scope).every(([key, value]) => descriptor.scope?.[key as keyof SidecarServiceScope] === value)) return;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        throw new Error("antigravity_fixture_service_cleanup_unproven");
      }
      const stream = sidecarSocketByteStream(connect(paths.endpointPath));
      try {
        await writeSidecarManagementRecord(stream, { managementVersion: 1, requestId: randomUUID(), scope, operation: "stop",
          expectedServiceIncarnation: status.serviceIncarnation, controllerEpoch: status.controllerEpoch, expectedConfiguration: status.desiredConfiguration,
          expectedResourcesFingerprint: status.resourcesFingerprint, force: true });
        const response = await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, AbortSignal.timeout(30_000));
        if (response.value.outcome === "ok" && response.value.status.state === "stopped") return;
        if (response.value.outcome !== "error" || response.value.code !== "sidecar_service_confirmation_stale")
          throw new Error("antigravity_fixture_service_stop_unconfirmed");
      } finally { await stream.close("antigravity_fixture_cleanup"); }
      await delay(50);
    }
    throw new Error("antigravity_fixture_service_stop_unconfirmed");
  }
  async close(beforeRemove?: () => Promise<void>) {
    const failures: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); } catch (error) { failures.push(error); } };
    await attempt(() => this.closeStreams());
    await attempt(() => this.application?.close());
    await attempt(() => this.stopService());
    // Delete only the exact freshly-created native sessions, after both main
    // and the persistent host have positively completed their cleanup.
    if (!failures.length) await attempt(async () => { await beforeRemove?.(); });
    if (this.ssh) {
      await attempt(() => terminateChild(this.ssh!.child));
      if (this.previousPath === undefined) delete process.env.PATH; else process.env.PATH = this.previousPath;
    }
    if (!failures.length) {
      if (this.serviceScope) await rm(persistentSidecarPaths(this.hostHome, process.getuid!(), this.serviceScope).socketDirectory, { recursive: true, force: true });
      await rm(this.directory, { recursive: true, force: true });
    }
    if (failures.length) throw new AggregateError(failures, `Antigravity fixture cleanup unproven; evidence retained at ${this.directory}`);
  }
}
